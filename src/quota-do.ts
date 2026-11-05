// Singleton Durable Object that keeps today's Workers AI neuron spend (free tier: 10,000/day)
// and simple per-visitor rate limits, so one visitor cannot burn the shared demo budget.
import { DurableObject } from 'cloudflare:workers';
import type { Env, PublicQuota } from './types.ts';

interface QuotaState {
  day: string;
  neurons: number;
  exhausted: boolean;
  hits: Record<string, number>; // `${ipHash}:${kind}` -> count today
}

const today = () => new Date().toISOString().slice(0, 10);
const nextUtcMidnight = () => {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.toISOString();
};

export class QuotaDO extends DurableObject<Env> {
  private state: QuotaState | null = null;

  private async load(): Promise<QuotaState> {
    if (!this.state) this.state = (await this.ctx.storage.get<QuotaState>('q')) || { day: today(), neurons: 0, exhausted: false, hits: {} };
    if (this.state.day !== today()) this.state = { day: today(), neurons: 0, exhausted: false, hits: {} };
    return this.state;
  }

  private async save() {
    if (this.state) await this.ctx.storage.put('q', this.state);
  }

  private budget(): number {
    return Number(this.env.AI_DAILY_NEURON_BUDGET || 9000);
  }

  async status(): Promise<PublicQuota> {
    const s = await this.load();
    return {
      day: s.day,
      neuronsUsed: Math.round(s.neurons),
      neuronBudget: this.budget(),
      exhausted: s.exhausted || s.neurons >= this.budget(),
      resetsAt: nextUtcMidnight(),
    };
  }

  async record(neurons: number): Promise<void> {
    const s = await this.load();
    s.neurons += Math.max(0, Number(neurons) || 0);
    await this.save();
  }

  async markExhausted(): Promise<void> {
    const s = await this.load();
    s.exhausted = true;
    await this.save();
  }

  /** Returns true if the visitor is still under today's limit for this action. */
  async hit(ipHash: string, kind: string, limit: number): Promise<boolean> {
    const s = await this.load();
    const key = `${ipHash}:${kind}`;
    const n = s.hits[key] || 0;
    if (n >= limit) return false;
    s.hits[key] = n + 1;
    // keep the map small
    const keys = Object.keys(s.hits);
    if (keys.length > 5000) for (const k of keys.slice(0, 1000)) delete s.hits[k];
    await this.save();
    return true;
  }
}
