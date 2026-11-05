// Deterministic policy firewall between the AI agent and the money.
// Every purchase the model proposes is checked here BEFORE any PayPal capture is attempted.
// Pure functions only, so the rules are easy to test and audit.
import { CATEGORIES, getProduct, listingInjection, type Product } from './catalog.ts';
import type { MandateStatus, MandateTerms, PolicyCheck } from './types.ts';

export const MAX_PURCHASES_PER_MANDATE = 12;

export interface PolicyContext {
  terms: MandateTerms;
  status: MandateStatus;
  authorizationStatus?: string;
  signatureValid: boolean;
  /** Money already captured against the authorization (refunds do not restore hold capacity). */
  capturedCents: number;
  /** Money reserved by lines approved earlier in the same turn or waiting for human approval. */
  reservedCents: number;
  purchasedProductIds: Set<string>;
  purchaseCount: number;
  now: number;
}

export interface PolicyVerdict {
  ok: boolean;
  rule: string;
  detail: string;
  checks: PolicyCheck[];
  product?: Product;
  amountCents: number;
}

export const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function checkPurchase(ctx: PolicyContext, productId: unknown, quantity: unknown): PolicyVerdict {
  const checks: PolicyCheck[] = [];
  const add = (rule: string, ok: boolean, detail: string) => checks.push({ rule, ok, detail });
  const { terms } = ctx;

  const authOk = ctx.status === 'active' && ['CREATED', 'PARTIALLY_CAPTURED', 'CAPTURED'].includes(String(ctx.authorizationStatus));
  add('MANDATE_ACTIVE', authOk, authOk ? 'PayPal authorization hold is active' : `Mandate is ${ctx.status}; authorization ${ctx.authorizationStatus || 'missing'}`);
  const notExpired = ctx.now < Date.parse(terms.expiresAt);
  add('NOT_EXPIRED', notExpired, notExpired ? `Valid until ${terms.expiresAt.slice(0, 10)}` : 'Mandate expired');
  add('SIGNATURE', ctx.signatureValid, ctx.signatureValid ? 'Mandate signature verified' : 'Mandate signature mismatch (terms were altered)');

  const product = getProduct(String(productId ?? ''));
  add('KNOWN_PRODUCT', !!product, product ? `${product.id} found in catalog` : `Unknown product id "${String(productId ?? '').slice(0, 20)}"`);

  const qty = Number(quantity);
  const amountCents = product && Number.isInteger(qty) && qty > 0 ? product.priceCents * qty : 0;

  if (product) {
    const cat = CATEGORIES[product.category];
    add('PLATFORM_RULES', !cat.restricted, cat.restricted ? `${cat.label} can never be bought by an agent` : 'Not a restricted category');
    const allowed = terms.allowedCategories.includes(product.category);
    const allowedLabels = terms.allowedCategories.map((c) => CATEGORIES[c]?.label || c).join(', ');
    add('CATEGORY', allowed, allowed ? `${cat.label} is allowed` : `${cat.label} is outside this mandate (allowed: ${allowedLabels})`);
    const inj = listingInjection(product);
    add('LISTING_SAFETY', !inj, inj ? `Seller text tries to instruct AI agents ("${inj}") - possible prompt injection` : 'No AI-directed text in listing');
    const qtyOk = Number.isInteger(qty) && qty >= 1 && qty <= terms.maxQuantity;
    add('QUANTITY', qtyOk, qtyOk ? `${qty} unit(s), max ${terms.maxQuantity}` : `Quantity ${String(quantity)} not within 1-${terms.maxQuantity}`);
    const capOk = qtyOk && amountCents <= terms.perItemCapCents;
    add('LINE_CAP', capOk, `${usd(amountCents)} vs ${usd(terms.perItemCapCents)} per-purchase cap`);
    const repeat = ctx.purchasedProductIds.has(product.id);
    add('NO_REPEAT', !repeat, repeat ? 'Already bought in this mandate (prevents runaway loops)' : 'First purchase of this item');
    const remaining = terms.budgetCents - ctx.capturedCents - ctx.reservedCents;
    const budgetOk = amountCents <= remaining;
    add('BUDGET', budgetOk, budgetOk ? `${usd(amountCents)} fits the ${usd(remaining)} left on the hold` : `Only ${usd(Math.max(0, remaining))} left on the ${usd(terms.budgetCents)} hold`);
    const velOk = ctx.purchaseCount < MAX_PURCHASES_PER_MANDATE;
    add('VELOCITY', velOk, velOk ? `${ctx.purchaseCount + 1} of ${MAX_PURCHASES_PER_MANDATE} purchases` : `Limit of ${MAX_PURCHASES_PER_MANDATE} purchases reached`);
  }

  const failed = checks.find((c) => !c.ok);
  return {
    ok: !failed,
    rule: failed ? failed.rule : 'ALL_CHECKS_PASSED',
    detail: failed ? failed.detail : `${checks.length} checks passed`,
    checks,
    product,
    amountCents,
  };
}
