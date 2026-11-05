// Minimal PayPal REST client (sandbox) for the Orders v2 + Payments v2 APIs.
// Credentials come from Worker secrets; tokens are cached per isolate and never logged.
import type { Env } from './types.ts';

let cachedToken: { value: string; exp: number } | null = null;

export class PayPalError extends Error {
  constructor(
    message: string,
    public status: number,
    public debugId?: string,
    public issue?: string,
  ) {
    super(`PayPal: ${message}`);
    this.name = 'PayPalError';
  }
}

async function accessToken(env: Env): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.exp - 60_000 > now) return cachedToken.value;
  const res = await fetch(`${env.PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new PayPalError(`PayPal auth failed (${res.status})`, res.status, res.headers.get('paypal-debug-id') || undefined);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { value: data.access_token, exp: now + data.expires_in * 1000 };
  return data.access_token;
}

export interface PayPalResponse<T = any> {
  status: number;
  data: T;
  debugId?: string;
}

async function call<T = any>(
  env: Env,
  method: string,
  path: string,
  body?: unknown,
  opts: { requestId?: string } = {},
): Promise<PayPalResponse<T>> {
  const token = await accessToken(env);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };
  if (opts.requestId) headers['PayPal-Request-Id'] = opts.requestId;
  const res = await fetch(`${env.PAYPAL_API_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const debugId = res.headers.get('paypal-debug-id') || undefined;
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 200) };
  }
  if (res.status === 401) cachedToken = null;
  if (!res.ok) {
    const issue = data?.details?.[0]?.issue || data?.name;
    const msg = data?.details?.[0]?.description || data?.message || `PayPal ${method} ${path} failed`;
    throw new PayPalError(`${issue ? issue + ': ' : ''}${msg}`, res.status, debugId, issue);
  }
  return { status: res.status, data: data as T, debugId };
}

export const money = (cents: number) => ({ currency_code: 'USD', value: (cents / 100).toFixed(2) });

/** Step 1: an order with intent=AUTHORIZE for the whole allowance. Nothing is charged yet. */
export function createAllowanceOrder(env: Env, args: { mandateId: string; title: string; budgetCents: number; origin: string }) {
  return call(env, 'POST', '/v2/checkout/orders', {
    intent: 'AUTHORIZE',
    purchase_units: [
      {
        reference_id: args.mandateId,
        custom_id: args.mandateId,
        description: `Allowance for your AI agent: ${args.title}`.slice(0, 127),
        soft_descriptor: 'ALLOWANCE AI',
        amount: money(args.budgetCents),
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: 'Allowance',
          locale: 'en-US',
          shipping_preference: 'NO_SHIPPING',
          user_action: 'CONTINUE',
          return_url: `${args.origin}/?paypal=return&m=${args.mandateId}`,
          cancel_url: `${args.origin}/?paypal=cancel&m=${args.mandateId}`,
        },
      },
    },
  });
}

/** Step 2: after buyer approval, place the authorization hold. */
export function authorizeOrder(env: Env, orderId: string) {
  return call(env, 'POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`, {}, { requestId: `auth-${orderId}` });
}

/** Each agent purchase is a partial capture against the hold (final_capture=false keeps the rest available). */
export function captureFromAuthorization(
  env: Env,
  authorizationId: string,
  args: { amountCents: number; invoiceId: string; note: string; requestId: string },
) {
  return call(
    env,
    'POST',
    `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/capture`,
    {
      amount: money(args.amountCents),
      final_capture: false,
      invoice_id: args.invoiceId,
      note_to_payer: args.note.slice(0, 255),
    },
    { requestId: args.requestId },
  );
}

export function refundCapture(env: Env, captureId: string, args: { amountCents: number; invoiceId: string; note: string; requestId: string }) {
  return call(
    env,
    'POST',
    `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
    { amount: money(args.amountCents), invoice_id: args.invoiceId, note_to_payer: args.note.slice(0, 255) },
    { requestId: args.requestId },
  );
}

/** Release whatever the agent did not spend. */
export function voidAuthorization(env: Env, authorizationId: string) {
  return call(env, 'POST', `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/void`, undefined, {
    requestId: `void-${authorizationId}`,
  });
}

export function getOrder(env: Env, orderId: string) {
  return call(env, 'GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
}

export async function verifyWebhookSignature(env: Env, headers: Headers, event: unknown): Promise<boolean> {
  if (!env.PAYPAL_WEBHOOK_ID) return false;
  const res = await call<{ verification_status: string }>(env, 'POST', '/v1/notifications/verify-webhook-signature', {
    auth_algo: headers.get('paypal-auth-algo'),
    cert_url: headers.get('paypal-cert-url'),
    transmission_id: headers.get('paypal-transmission-id'),
    transmission_sig: headers.get('paypal-transmission-sig'),
    transmission_time: headers.get('paypal-transmission-time'),
    webhook_id: env.PAYPAL_WEBHOOK_ID,
    webhook_event: event,
  });
  return res.data?.verification_status === 'SUCCESS';
}
