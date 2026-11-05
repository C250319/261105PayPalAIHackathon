// Mandate drafting (AI with a rules-only fallback), validation and signing.
import { CATEGORIES, SELECTABLE_CATEGORIES, type CategoryId } from './catalog.ts';
import { chat, extractJson, AiQuotaError } from './ai.ts';
import type { Env, MandateTerms } from './types.ts';

export const LIMITS = {
  minBudgetCents: 500,
  maxBudgetCents: 20000, // keep sandbox holds small: $200 max
  maxQuantity: 6,
  maxExpiryDays: 14,
};

const ITEM_WORDS = /\b(coffee|tea|oat milk|almond milk|soy milk|milk|creamer|snacks?|chips|crackers|cookies|popcorn|trail mix|fruit|bananas?|apples?|sparkling water|water|juice|soda|dish soap|soap|sponges?|wipes|trash bags|paper towels|napkins|plates|cups|cutlery|pens|sticky notes|copy paper|markers)\b/gi;

const KEYWORDS: [RegExp, CategoryId][] = [
  [/coffee|espresso|tea\b|teas\b|caffeine|beans/i, 'coffee-tea'],
  [/milk|oat|almond|soy|creamer|half\s*&?\s*half/i, 'milk'],
  [/snack|chips|crackers|cookies|bars?\b|popcorn|trail mix|munchies/i, 'snacks'],
  [/fruit|banana|apple|clementine|orange(?!\s*juice)/i, 'fruit'],
  [/drink|water|sparkling|juice|soda|cold brew|beverage/i, 'drinks'],
  [/clean|soap|sponge|wipes|trash|garbage|detergent|dishwasher|spray/i, 'cleaning'],
  [/plate|napkin|paper towel|cups?\b|cutlery|tableware|forks/i, 'paper-goods'],
  [/pen\b|pens\b|sticky|copy paper|marker|stationery|office supplies/i, 'office'],
  [/kettle|espresso machine|container|appliance|equipment/i, 'kitchen'],
];

export function clampTerms(t: Partial<MandateTerms> & { errand: string }): MandateTerms {
  const budget = Math.round(Math.min(LIMITS.maxBudgetCents, Math.max(LIMITS.minBudgetCents, Number(t.budgetCents) || 6000)));
  let cap = Math.round(Number(t.perItemCapCents) || Math.round(budget * 0.4));
  cap = Math.min(budget, Math.max(100, cap));
  const qty = Math.min(LIMITS.maxQuantity, Math.max(1, Math.round(Number(t.maxQuantity) || 3)));
  const cats = Array.from(new Set((t.allowedCategories || []).filter((c): c is CategoryId => SELECTABLE_CATEGORIES.includes(c as CategoryId))));
  const now = Date.now();
  let exp = Date.parse(String(t.expiresAt || ''));
  if (!Number.isFinite(exp) || exp < now + 3600_000) exp = now + 7 * 86400_000;
  exp = Math.min(exp, now + LIMITS.maxExpiryDays * 86400_000);
  return {
    title: String(t.title || 'Errand').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Errand',
    errand: String(t.errand || '').trim().slice(0, 600),
    budgetCents: budget,
    perItemCapCents: cap,
    maxQuantity: qty,
    allowedCategories: cats.length ? cats : (['snacks'] as CategoryId[]),
    shoppingList: (t.shoppingList || []).map((n) => String(n).replace(/\s+/g, ' ').trim().slice(0, 60)).filter(Boolean).slice(0, 8),
    notes: (t.notes || []).map((n) => String(n).trim().slice(0, 120)).filter(Boolean).slice(0, 5),
    expiresAt: new Date(exp).toISOString(),
    currency: 'USD',
  };
}

/** Rules-only drafting used when the AI budget is exhausted or the model is unreachable. */
export function draftWithRules(errand: string): MandateTerms {
  const money = errand.match(/\$\s?(\d{1,4}(?:\.\d{1,2})?)/) || errand.match(/(\d{1,4})\s*(?:usd|dollars?)/i);
  const budgetCents = money ? Math.round(parseFloat(money[1]) * 100) : 6000;
  const cats = KEYWORDS.filter(([re]) => re.test(errand)).map(([, c]) => c);
  const notes: string[] = [];
  const vegan = errand.match(/(\w+|\d+)\s+(?:of us\s+)?(?:are\s+)?vegans?/i);
  if (/vegan/i.test(errand)) notes.push(vegan ? `Vegan options needed (${vegan[0].trim()})` : 'Include vegan options');
  const people = errand.match(/(\d+)[\s-]*(?:people|person|ppl|team|guests)/i);
  if (people) notes.push(`For about ${people[1]} people`);
  if (/no alcohol/i.test(errand)) notes.push('No alcohol');
  const title = errand.replace(/[^\w\s&'-]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 5).join(' ');
  const items = Array.from(new Set((errand.match(ITEM_WORDS) || []).map((w) => w.toLowerCase())));
  return clampTerms({
    errand,
    shoppingList: items,
    title: title ? title[0].toUpperCase() + title.slice(1) : 'Errand',
    budgetCents,
    perItemCapCents: Math.round(Math.max(1500, budgetCents * 0.4)),
    maxQuantity: 3,
    allowedCategories: cats,
    notes,
  });
}

const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: '2-5 word title' },
    budget_usd: { type: 'number' },
    per_item_cap_usd: { type: 'number' },
    max_quantity: { type: 'integer' },
    categories: { type: 'array', items: { type: 'string', enum: SELECTABLE_CATEGORIES } },
    shopping_list: { type: 'array', items: { type: 'string' } },
    notes: { type: 'array', items: { type: 'string' } },
    expires_in_days: { type: 'integer' },
  },
  required: ['title', 'budget_usd', 'per_item_cap_usd', 'max_quantity', 'categories', 'shopping_list', 'notes', 'expires_in_days'],
};

export async function draftWithAi(env: Env, errand: string): Promise<{ terms: MandateTerms; by: string }> {
  const catList = SELECTABLE_CATEGORIES.map((c) => `- ${c}: ${CATEGORIES[c].description}`).join('\n');
  const res = await chat(env, {
    messages: [
      {
        role: 'system',
        content:
          'You convert a person\'s shopping errand into a spending mandate for an AI purchasing agent. Be conservative: the mandate is a hard limit on what the agent may spend.\n' +
          'Rules:\n- budget_usd: the explicit budget if one is given, otherwise a sensible estimate (max 150).\n' +
          '- per_item_cap_usd: the most the agent may spend on a single purchase line; usually 35-50% of the budget and never below 15.\n' +
          '- max_quantity: units per line, 1-6.\n' +
          `- categories: ONLY the categories the errand actually needs, chosen from:\n${catList}\n` +
          '- shopping_list: the distinct things the errand asks to buy, 1-3 words each, in the errand\'s words (e.g. "coffee", "oat milk", "vegan snacks").\n' +
          '- notes: 1-4 short constraints or preferences taken from the errand (dietary needs, headcount, exclusions).\n' +
          '- expires_in_days: 1-14, default 7. title: 2-5 words.',
      },
      { role: 'user', content: errand },
    ],
    jsonSchema: DRAFT_SCHEMA,
    maxTokens: 350,
    temperature: 0.1,
  });
  const j = extractJson(res.content);
  if (!j) throw new Error('AI returned no mandate');
  const days = Math.min(LIMITS.maxExpiryDays, Math.max(1, Number(j.expires_in_days) || 7));
  const terms = clampTerms({
    errand,
    title: j.title,
    budgetCents: Math.round(Number(j.budget_usd) * 100),
    perItemCapCents: Math.round(Math.max(15, Number(j.per_item_cap_usd) || 0) * 100),
    maxQuantity: j.max_quantity,
    allowedCategories: j.categories,
    shoppingList: j.shopping_list,
    notes: j.notes,
    expiresAt: new Date(Date.now() + days * 86400_000).toISOString(),
  });
  return { terms, by: res.model };
}

export async function draftMandate(env: Env, errand: string): Promise<{ terms: MandateTerms; by: string; aiError?: string }> {
  try {
    return await draftWithAi(env, errand);
  } catch (e) {
    const quota = e instanceof AiQuotaError;
    return {
      terms: draftWithRules(errand),
      by: 'rules',
      aiError: quota ? 'quota' : String((e as Error)?.message || e).slice(0, 200),
    };
  }
}

// ---- Signing --------------------------------------------------------------------------

function canonical(terms: MandateTerms, paypal: { orderId?: string; authorizationId?: string }): string {
  return JSON.stringify({
    title: terms.title,
    budgetCents: terms.budgetCents,
    perItemCapCents: terms.perItemCapCents,
    maxQuantity: terms.maxQuantity,
    allowedCategories: [...terms.allowedCategories].sort(),
    shoppingList: terms.shoppingList,
    expiresAt: terms.expiresAt,
    currency: terms.currency,
    orderId: paypal.orderId || null,
    authorizationId: paypal.authorizationId || null,
  });
}

async function hmac(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function signMandate(env: Env, terms: MandateTerms, paypal: { orderId?: string; authorizationId?: string }) {
  return hmac(env.MANDATE_SIGNING_KEY || 'dev-only-key', canonical(terms, paypal));
}

export async function verifyMandate(env: Env, terms: MandateTerms, paypal: { orderId?: string; authorizationId?: string }, signature?: string) {
  if (!signature) return false;
  const expected = await signMandate(env, terms, paypal);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}
