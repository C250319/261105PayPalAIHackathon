// Workers AI wrapper: model fallback, output normalisation, tool-call parsing and the
// daily free-tier (10,000 neurons) budget. When the budget is gone we throw AiQuotaError and
// the callers switch to rules-only mode instead of failing.
import type { ChatMessage, Env } from './types.ts';

export class AiQuotaError extends Error {}
export class AiUnavailableError extends Error {}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  model: string;
  neurons: number;
}

export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, any> };
}

// USD per million tokens (from the Workers AI model catalog); 1 neuron = $0.000011.
const PRICES: Record<string, [number, number]> = {
  '@cf/mistralai/mistral-small-3.1-24b-instruct': [0.351, 0.555],
  '@cf/meta/llama-4-scout-17b-16e-instruct': [0.27, 0.85],
};

function estimateNeurons(model: string, usage: any): number {
  if (usage && typeof usage.neurons === 'number') return usage.neurons;
  const [pin, pout] = PRICES[model] || [0.4, 0.8];
  const tin = Number(usage?.prompt_tokens || 0);
  const tout = Number(usage?.completion_tokens || 0);
  return ((tin * pin + tout * pout) / 1e6) / 0.000011;
}

const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
/** Mistral on Workers AI requires tool-call ids of exactly 9 alphanumeric characters. */
export function toolCallId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return Array.from(bytes, (b) => ALNUM[b % ALNUM.length]).join('');
}

/** Parse possibly-malformed tool arguments ("{..}{..}" concatenations, code fences, etc.). */
export function parseArgs(raw: unknown): Record<string, any>[] {
  if (raw && typeof raw === 'object') return [raw as Record<string, any>];
  const s = String(raw ?? '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  if (!s) return [{}];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [v];
  } catch {
    const parts = s.split(/}\s*{/).map((x, i, arr) => (i === 0 ? x : '{' + x) + (i < arr.length - 1 ? '}' : ''));
    const out: Record<string, any>[] = [];
    for (const part of parts) {
      try {
        out.push(JSON.parse(part));
      } catch {
        /* ignore */
      }
    }
    return out.length ? out : [{}];
  }
}

/** Some models print tool calls as JSON text instead of using the tool-call channel. */
function toolCallsFromText(content: string, toolNames: string[]): ToolCall[] {
  const calls: ToolCall[] = [];
  const re = /\{[^{}]*"name"\s*:\s*"([a-z_]+)"[^{}]*"(?:parameters|arguments)"\s*:\s*(\{[^{}]*\})[^{}]*\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    if (!toolNames.includes(m[1])) continue;
    for (const args of parseArgs(m[2])) calls.push({ id: toolCallId(), name: m[1], args });
  }
  return calls;
}

function normalise(model: string, raw: any, toolNames: string[]): ChatResult {
  let content = '';
  let calls: ToolCall[] = [];
  const usage = raw?.usage;
  if (raw?.choices?.[0]?.message) {
    const msg = raw.choices[0].message;
    content = typeof msg.content === 'string' ? msg.content : '';
    for (const tc of msg.tool_calls || []) {
      const name = tc.function?.name || tc.name;
      for (const args of parseArgs(tc.function?.arguments ?? tc.arguments)) calls.push({ id: toolCallId(), name, args });
    }
  } else {
    content = typeof raw?.response === 'string' ? raw.response : raw?.response ? JSON.stringify(raw.response) : '';
    for (const tc of raw?.tool_calls || []) {
      for (const args of parseArgs(tc.arguments)) calls.push({ id: toolCallId(), name: tc.name, args });
    }
  }
  if (!calls.length && content && toolNames.length) {
    calls = toolCallsFromText(content, toolNames);
    if (calls.length) content = '';
  }
  return { content: content.trim(), toolCalls: calls, model, neurons: estimateNeurons(model, usage) };
}

function isQuotaError(e: unknown): boolean {
  const s = String((e as any)?.message || e);
  return /4006|daily free allocation|used up your daily|free allocation of/i.test(s);
}

function isModelUnavailable(e: unknown): boolean {
  const s = String((e as any)?.message || e);
  return /5035|5007|not available|no such model|deprecated|unknown model/i.test(s);
}

export interface ChatOptions {
  messages: ChatMessage[];
  tools?: ToolDef[];
  maxTokens?: number;
  temperature?: number;
  jsonSchema?: Record<string, any>;
}

export async function chat(env: Env, opts: ChatOptions): Promise<ChatResult> {
  const quota = env.QUOTA.get(env.QUOTA.idFromName('global'));
  const status = await quota.status();
  if (status.exhausted) throw new AiQuotaError('Daily free Workers AI budget used up');

  const models = [env.AI_MODEL, env.AI_FALLBACK_MODEL].filter(Boolean);
  let lastErr: unknown = null;
  for (const model of models) {
    try {
      const input: Record<string, any> = {
        messages: opts.messages.map((m) => {
          const o: Record<string, any> = { role: m.role, content: m.content ?? '' };
          if (m.tool_calls) o.tool_calls = m.tool_calls;
          if (m.tool_call_id) o.tool_call_id = m.tool_call_id;
          return o;
        }),
        max_tokens: opts.maxTokens ?? 600,
        temperature: opts.temperature ?? 0.2,
      };
      if (opts.tools?.length) input.tools = opts.tools;
      if (opts.jsonSchema) input.response_format = { type: 'json_schema', json_schema: opts.jsonSchema };
      const raw = await env.AI.run(model as any, input as any);
      const result = normalise(model, raw, (opts.tools || []).map((t) => t.function.name));
      await quota.record(result.neurons);
      return result;
    } catch (e) {
      lastErr = e;
      if (isQuotaError(e)) {
        await quota.markExhausted();
        throw new AiQuotaError('Daily free Workers AI budget used up');
      }
      if (!isModelUnavailable(e)) break;
    }
  }
  throw new AiUnavailableError(String((lastErr as any)?.message || lastErr || 'AI unavailable').slice(0, 300));
}

/** Pull the first JSON object out of a model reply. */
export function extractJson(text: string): any | null {
  const s = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '');
  try {
    return JSON.parse(s);
  } catch {
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(s.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}
