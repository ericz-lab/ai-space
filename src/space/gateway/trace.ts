import type { Usage } from "../runtimes/types.ts";
import type { GatewayTrace } from "./types.ts";

/**
 * What the built-in model gateway keeps per run token: which provider and model answered, which
 * were tried, the tokens the answers reported, and, per requested model, the member of a group
 * that first answered (so a conversation stays with one vendor). No prompt or reply content, and
 * not a ledger: the model and speech services write the rows, reading this after the run.
 *
 * In memory, bounded: at most `max` runs, the oldest dropped first, and none older than `ttlMs`.
 */

export type TraceStoreOptions = { max?: number; ttlMs?: number; now?: () => number };

type Entry = GatewayTrace & { pinned: Map<string, string> };

export class TraceStore {
  private readonly runs = new Map<string, Entry>();
  private readonly max: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: TraceStoreOptions = {}) {
    this.max = opts.max ?? 2000;
    this.ttlMs = opts.ttlMs ?? 24 * 3600_000;
    this.now = opts.now ?? Date.now;
  }

  get(run: string): GatewayTrace | undefined {
    const e = this.live(run);
    if (!e) return undefined;
    const { pinned: _, ...trace } = e;
    return { ...trace, tried: [...trace.tried], ...(trace.usage ? { usage: { ...trace.usage } } : {}) };
  }

  /** The member that first answered `requested` (a group's name, or a `provider/model`) for this run. */
  pinned(run: string, requested: string): string | undefined {
    return this.live(run)?.pinned.get(requested);
  }

  /** A request forwarded under the run: what was tried, what answered. */
  note(run: string, r: { tried: string[]; served?: string; requested?: string; error?: string; pin?: boolean }): void {
    const e = this.entry(run);
    e.requests++;
    for (const t of r.tried) if (!e.tried.includes(t)) e.tried.push(t);
    if (r.served) {
      e.served = r.served;
      delete e.error;
      if (r.pin && r.requested && !e.pinned.has(r.requested)) e.pinned.set(r.requested, r.served);
    } else if (r.error) e.error = r.error.slice(0, 300);
    e.updatedAt = this.now();
  }

  /** Tokens an answer reported, added to the run's sum. */
  addUsage(run: string, u: Usage): void {
    const e = this.entry(run);
    const s = e.usage ?? { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
    e.usage = { inputTokens: s.inputTokens + u.inputTokens, cacheWriteTokens: s.cacheWriteTokens + u.cacheWriteTokens, cacheReadTokens: s.cacheReadTokens + u.cacheReadTokens, outputTokens: s.outputTokens + u.outputTokens };
    e.updatedAt = this.now();
  }

  get size(): number {
    return this.runs.size;
  }

  private live(run: string): Entry | undefined {
    const e = this.runs.get(run);
    if (e && this.now() - e.updatedAt > this.ttlMs) {
      this.runs.delete(run);
      return undefined;
    }
    return e;
  }

  private entry(run: string): Entry {
    let e = this.live(run);
    if (e) {
      // Most recently used last, so the oldest is the first one dropped.
      this.runs.delete(run);
      this.runs.set(run, e);
      return e;
    }
    e = { run, requests: 0, tried: [], updatedAt: this.now(), pinned: new Map() };
    this.runs.set(run, e);
    while (this.runs.size > this.max) this.runs.delete(this.runs.keys().next().value!);
    return e;
  }
}
