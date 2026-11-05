// HTTP API for Allowance. Static assets (the AG Grid single-page app) are served by Workers
// Static Assets; everything under /api/* lands here first.
import { CATALOG, CATEGORIES, FEATURED, listingInjection } from './catalog.ts';
import { draftMandate, LIMITS } from './mandate.ts';
import { MandateDO } from './mandate-do.ts';
import { QuotaDO } from './quota-do.ts';
import { verifyWebhookSignature } from './paypal.ts';
import type { Env, MandateTerms } from './types.ts';

export { MandateDO, QuotaDO };

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });

const fail = (status: number, code: string, message: string) => json({ error: { code, message } }, status);

function errorResponse(e: unknown): Response {
  const msg = String((e as Error)?.message || e);
  const m = msg.match(/\[(\d{3}):([a-z_]+)\] (.*)$/s);
  if (m) return fail(Number(m[1]), m[2], m[3]);
  if ((e as any)?.name === 'PayPalError' || /PayPal|INSTRUMENT|AUTHORIZATION|ORDER_/i.test(msg)) return fail(502, 'paypal', msg.slice(0, 300));
  console.error('unhandled', msg);
  return fail(500, 'internal', 'Something went wrong. Please try again.');
}

async function ipHash(req: Request, env: Env): Promise<string> {
  const ip = req.headers.get('cf-connecting-ip') || 'local';
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${env.MANDATE_SIGNING_KEY}|${ip}`));
  return Array.from(new Uint8Array(d).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

const ID_RE = /^[a-f0-9]{32}$/;
const newId = () => crypto.randomUUID().replace(/-/g, '');

async function body(req: Request): Promise<any> {
  if (Number(req.headers.get('content-length') || 0) > 20_000) throw new Error('[413:too_large] Request too large');
  try {
    return await req.json();
  } catch {
    return {};
  }
}

const quotaStub = (env: Env) => env.QUOTA.get(env.QUOTA.idFromName('global'));
const mandateStub = (env: Env, id: string) => env.MANDATES.get(env.MANDATES.idFromName(id));

async function limit(req: Request, env: Env, kind: string, max: number) {
  const ok = await quotaStub(env).hit(await ipHash(req, env), kind, max);
  if (!ok) throw new Error(`[429:rate_limited] Daily demo limit reached for this action (${max}/day per visitor). Please try again tomorrow.`);
}

async function handleApi(req: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  const path = url.pathname.replace(/\/+$/, '');
  const method = req.method;

  if (method === 'GET' && path === '/api/health') return json({ ok: true });

  if (method === 'GET' && path === '/api/config') {
    return json({
      paypalClientId: env.PAYPAL_CLIENT_ID,
      paypalSdkUrl: env.PAYPAL_SDK_URL,
      environment: 'sandbox',
      aiModel: env.AI_MODEL,
      limits: LIMITS,
      categories: Object.entries(CATEGORIES).map(([id, c]) => ({ id, label: c.label, restricted: !!c.restricted, description: c.description })),
      webhooks: !!env.PAYPAL_WEBHOOK_ID,
      repoUrl: env.REPO_URL || null,
    });
  }

  if (method === 'GET' && path === '/api/quota') return json(await quotaStub(env).status());

  if (method === 'GET' && path === '/api/catalog') {
    return json(
      CATALOG.map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        categoryLabel: CATEGORIES[p.category].label,
        price: p.priceCents / 100,
        unit: p.unit,
        tags: p.tags,
        rating: p.rating,
        featured: FEATURED.includes(p.id),
        restricted: !!CATEGORIES[p.category].restricted,
        listing: p.listing || '',
        injection: listingInjection(p),
      })),
    );
  }

  if (method === 'POST' && path === '/api/mandates') {
    const b = await body(req);
    const errand = String(b.errand || '').trim();
    if (errand.length < 8) return fail(400, 'errand_required', 'Describe the errand in a sentence or two.');
    if (errand.length > 600) return fail(400, 'errand_too_long', 'Keep the errand under 600 characters.');
    await limit(req, env, 'create', 25);
    const id = newId();
    const { terms, by, aiError } = await draftMandate(env, errand);
    return json(await mandateStub(env, id).create(id, terms, by, aiError), 201);
  }

  if (method === 'POST' && path === '/api/mandates/batch') {
    const b = await body(req);
    const ids: string[] = (Array.isArray(b.ids) ? b.ids : []).filter((x: unknown) => typeof x === 'string' && ID_RE.test(x)).slice(0, 30);
    const results = await Promise.all(ids.map((id) => mandateStub(env, id).summary().catch(() => null)));
    return json(results.filter(Boolean));
  }

  if (method === 'POST' && path === '/api/paypal/webhook') {
    const raw = await req.text();
    let event: any;
    try {
      event = JSON.parse(raw);
    } catch {
      return fail(400, 'bad_json', 'Invalid JSON');
    }
    const verified = await verifyWebhookSignature(env, req.headers, event).catch(() => false);
    if (!verified) return fail(401, 'unverified', 'Webhook signature could not be verified');
    const res = event.resource || {};
    const ref: string = res.invoice_id || res.custom_id || res.supplementary_data?.related_ids?.order_id || '';
    const m = String(ref).match(/([a-f0-9]{32})/);
    if (m) ctx.waitUntil(mandateStub(env, m[1]).webhook(String(event.event_type || ''), res).catch(() => undefined));
    return json({ ok: true });
  }

  const mm = path.match(/^\/api\/mandates\/([a-f0-9]{32})(?:\/(.*))?$/);
  if (!mm) return fail(404, 'not_found', 'Unknown endpoint');
  const id = mm[1];
  const sub = mm[2] || '';
  const stub = mandateStub(env, id);

  if (method === 'GET' && sub === '') return json(await stub.view());

  if (method === 'PATCH' && sub === '') {
    const b = await body(req);
    const patch: Partial<MandateTerms> = {};
    if (b.title !== undefined) patch.title = String(b.title);
    if (b.budgetCents !== undefined) patch.budgetCents = Number(b.budgetCents);
    if (b.perItemCapCents !== undefined) patch.perItemCapCents = Number(b.perItemCapCents);
    if (b.maxQuantity !== undefined) patch.maxQuantity = Number(b.maxQuantity);
    if (Array.isArray(b.allowedCategories)) patch.allowedCategories = b.allowedCategories.map(String);
    if (Array.isArray(b.notes)) patch.notes = b.notes.map(String);
    if (Array.isArray(b.shoppingList)) patch.shoppingList = b.shoppingList.map(String);
    if (b.expiresAt !== undefined) patch.expiresAt = String(b.expiresAt);
    return json(await stub.updateTerms(patch));
  }

  if (method !== 'POST') return fail(405, 'method_not_allowed', 'Method not allowed');

  switch (true) {
    case sub === 'order':
      await limit(req, env, 'order', 40);
      return json(await stub.createOrder(url.origin));
    case sub === 'approve': {
      const b = await body(req);
      return json(await stub.approve(String(b.orderId || '')));
    }
    case sub === 'think': {
      const b = await body(req);
      await limit(req, env, 'think', 80);
      return json(await stub.think(typeof b.instruction === 'string' ? b.instruction : undefined));
    }
    case sub === 'release':
      return json(await stub.release());
    case sub === 'redteam':
      return json(await stub.redteam());
    case sub === 'sync':
      return json(await stub.sync());
    default: {
      const lm = sub.match(/^lines\/(L\d{1,4})\/(capture|approve|decline|refund)$/);
      if (!lm) return fail(404, 'not_found', 'Unknown endpoint');
      const [, rowId, action] = lm;
      if (action === 'capture') return json(await stub.capture(rowId));
      if (action === 'refund') return json(await stub.refund(rowId));
      return json(await stub.decide(rowId, action as 'approve' | 'decline'));
    }
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(req, env, url, ctx);
      } catch (e) {
        return errorResponse(e);
      }
    }
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
