import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPurchase, MAX_PURCHASES_PER_MANDATE, type PolicyContext } from '../src/guardrails.ts';
import { getProduct, listingInjection, CATALOG } from '../src/catalog.ts';
import { draftWithRules, clampTerms } from '../src/mandate.ts';
import { parseArgs } from '../src/ai.ts';
import type { MandateTerms } from '../src/types.ts';

const terms: MandateTerms = {
  title: 'Office kitchen restock',
  errand: 'Restock the office kitchen: coffee, oat milk, snacks for 12 people, two are vegan. Under $80.',
  budgetCents: 8000,
  perItemCapCents: 3000,
  maxQuantity: 4,
  allowedCategories: ['coffee-tea', 'milk', 'snacks'],
  shoppingList: ['coffee', 'oat milk', 'snacks'],
  notes: ['Two vegans'],
  expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
  currency: 'USD',
};

const ctx = (over: Partial<PolicyContext> = {}): PolicyContext => ({
  terms,
  status: 'active',
  authorizationStatus: 'CREATED',
  signatureValid: true,
  capturedCents: 0,
  reservedCents: 0,
  purchasedProductIds: new Set(),
  purchaseCount: 0,
  now: Date.now(),
  ...over,
});

test('allows a normal in-mandate purchase', () => {
  const v = checkPurchase(ctx(), 'CT01', 1);
  assert.equal(v.ok, true);
  assert.equal(v.amountCents, 1850);
  assert.equal(v.rule, 'ALL_CHECKS_PASSED');
});

test('blocks categories outside the mandate', () => {
  const v = checkPurchase(ctx(), 'CL01', 1);
  assert.equal(v.ok, false);
  assert.equal(v.rule, 'CATEGORY');
});

test('blocks restricted categories even if the mandate lists them', () => {
  const v = checkPurchase(ctx({ terms: { ...terms, allowedCategories: [...terms.allowedCategories, 'gift-cards' as any] } }), 'GC01', 1);
  assert.equal(v.ok, false);
  assert.equal(v.rule, 'PLATFORM_RULES');
});

test('blocks listings that try to instruct the agent (prompt injection)', () => {
  const v = checkPurchase(ctx({ terms: { ...terms, perItemCapCents: 8000 } }), 'SN07', 1);
  assert.equal(v.ok, false);
  assert.equal(v.rule, 'LISTING_SAFETY');
  assert.ok(listingInjection(getProduct('SN07')!));
  assert.equal(listingInjection(getProduct('CT01')!), null);
});

test('enforces the per-line cap and quantity limits', () => {
  assert.equal(checkPurchase(ctx(), 'CT01', 2).rule, 'LINE_CAP'); // 37.00 > 30.00
  assert.equal(checkPurchase(ctx(), 'CT02', 0).rule, 'QUANTITY');
  assert.equal(checkPurchase(ctx(), 'CT02', 5).rule, 'QUANTITY');
  assert.equal(checkPurchase(ctx(), 'CT02', 1.5).rule, 'QUANTITY');
});

test('enforces the remaining hold, including reserved lines', () => {
  assert.equal(checkPurchase(ctx({ capturedCents: 7000 }), 'MK01', 1).rule, 'BUDGET');
  assert.equal(checkPurchase(ctx({ capturedCents: 5000, reservedCents: 1700 }), 'MK01', 1).rule, 'BUDGET');
  assert.equal(checkPurchase(ctx({ capturedCents: 5000 }), 'MK01', 1).ok, true);
});

test('rejects unknown products, repeats, inactive or tampered mandates', () => {
  assert.equal(checkPurchase(ctx(), 'ZZ99', 1).rule, 'KNOWN_PRODUCT');
  assert.equal(checkPurchase(ctx({ purchasedProductIds: new Set(['CT02']) }), 'CT02', 1).rule, 'NO_REPEAT');
  assert.equal(checkPurchase(ctx({ authorizationStatus: 'VOIDED' }), 'CT02', 1).rule, 'MANDATE_ACTIVE');
  assert.equal(checkPurchase(ctx({ status: 'closed' }), 'CT02', 1).rule, 'MANDATE_ACTIVE');
  assert.equal(checkPurchase(ctx({ signatureValid: false }), 'CT02', 1).rule, 'SIGNATURE');
  assert.equal(checkPurchase(ctx({ now: Date.now() + 30 * 86400_000 }), 'CT02', 1).rule, 'NOT_EXPIRED');
  assert.equal(checkPurchase(ctx({ purchaseCount: MAX_PURCHASES_PER_MANDATE }), 'CT02', 1).rule, 'VELOCITY');
});

test('rules-only drafting extracts budget, categories and notes', () => {
  const t = draftWithRules('Restock our office kitchen: coffee, oat milk and snacks for 12 people, two of us are vegan. Keep it under $80.');
  assert.equal(t.budgetCents, 8000);
  assert.deepEqual([...t.allowedCategories].sort(), ['coffee-tea', 'milk', 'snacks']);
  assert.ok(t.notes.some((n) => /vegan/i.test(n)));
  assert.deepEqual(t.shoppingList, ['coffee', 'oat milk', 'snacks']);
});

test('mandate terms are clamped to safe limits', () => {
  const t = clampTerms({ errand: 'x', budgetCents: 999999, perItemCapCents: 999999, maxQuantity: 99, allowedCategories: ['alcohol' as any] });
  assert.equal(t.budgetCents, 20000);
  assert.equal(t.perItemCapCents, 20000);
  assert.equal(t.maxQuantity, 6);
  assert.deepEqual(t.allowedCategories, ['snacks']);
});

test('tool-call argument parser survives concatenated JSON', () => {
  assert.deepEqual(parseArgs('{"a":1}{"a":2}'), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(parseArgs({ a: 3 }), [{ a: 3 }]);
  assert.deepEqual(parseArgs('```json\n{"a":4}\n```'), [{ a: 4 }]);
});

test('catalog ids are unique', () => {
  assert.equal(new Set(CATALOG.map((p) => p.id)).size, CATALOG.length);
});
