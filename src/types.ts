import type { CategoryId } from './catalog.ts';

export interface Env {
  AI: Ai;
  ASSETS: Fetcher;
  MANDATES: DurableObjectNamespace<import('./mandate-do.ts').MandateDO>;
  QUOTA: DurableObjectNamespace<import('./quota-do.ts').QuotaDO>;
  PAYPAL_CLIENT_ID: string;
  PAYPAL_CLIENT_SECRET: string;
  MANDATE_SIGNING_KEY: string;
  PAYPAL_WEBHOOK_ID?: string;
  REPO_URL?: string;
  PAYPAL_API_BASE: string;
  PAYPAL_SDK_URL: string;
  AI_MODEL: string;
  AI_FALLBACK_MODEL: string;
  AI_DAILY_NEURON_BUDGET: string;
}

/** The human's instructions to the agent, approved once through PayPal. */
export interface MandateTerms {
  title: string;
  errand: string;
  budgetCents: number;
  perItemCapCents: number;
  maxQuantity: number;
  allowedCategories: CategoryId[];
  /** What the human actually wants bought, in their words (the "intent" half of the mandate). */
  shoppingList: string[];
  notes: string[];
  expiresAt: string; // ISO time
  currency: 'USD';
}

export type MandateStatus = 'draft' | 'active' | 'closed';

export interface PolicyCheck {
  rule: string;
  ok: boolean;
  detail: string;
}

export type LineStatus =
  | 'approved' // passed policy + AI audit, PayPal capture about to run
  | 'captured' // money moved via PayPal partial capture
  | 'blocked' // stopped by the deterministic policy firewall
  | 'needs_approval' // flagged by the AI auditor; waiting for the human
  | 'declined' // human declined a flagged line
  | 'refunded' // captured, then refunded through PayPal
  | 'failed'; // PayPal returned an error

export interface LedgerRow {
  id: string; // L1, L2...
  n: number;
  ts: string;
  kind: 'purchase' | 'hold' | 'release';
  productId?: string;
  item: string;
  category?: string;
  quantity?: number;
  unitCents?: number;
  amountCents: number;
  status: LineStatus | 'authorized' | 'voided';
  agentReason?: string; // AI shopper's justification
  policy?: { ok: boolean; rule: string; detail: string; checks: PolicyCheck[] };
  audit?: { verdict: 'ok' | 'flag' | 'skipped'; note: string; by: string };
  paypal?: {
    id?: string; // capture / authorization id
    status?: string;
    refundId?: string;
    refundStatus?: string;
    debugId?: string;
    invoiceId?: string;
    webhook?: string; // last verified webhook event type
    error?: string;
  };
  decidedBy?: 'agent' | 'human';
  toolCallId?: string;
  turn?: number;
  /** Simulated compromised-agent attempt from the red-team drill (never captured). */
  redteam?: boolean;
}

export interface AgentEvent {
  ts: string;
  type: 'agent' | 'tool' | 'policy' | 'audit' | 'paypal' | 'system' | 'human' | 'error';
  text: string;
  rowId?: string;
}

export interface MandateState {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: MandateStatus;
  terms: MandateTerms;
  draftedBy: string; // model id or 'rules'
  paypal: {
    orderId?: string;
    orderStatus?: string;
    authorizationId?: string;
    authorizationStatus?: string;
    authorizedCents?: number;
    authorizationExpiresAt?: string;
    approvedAt?: string;
    voidedAt?: string;
    lastSyncAt?: string;
  };
  signature?: string;
  ledger: LedgerRow[];
  agent: {
    messages: ChatMessage[];
    turns: number;
    done: boolean;
    summary?: string;
    /** finish() proposed in the same turn as purchases; accepted later only if every one of them went through. */
    pendingFinish?: { summary: string; turn: number };
    mode?: 'ai' | 'rules';
    model?: string;
  };
  events: AgentEvent[];
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface PublicQuota {
  day: string;
  neuronsUsed: number;
  neuronBudget: number;
  exhausted: boolean;
  resetsAt: string;
}
