/**
 * Calls another space forwarded here under a `ref` (docs/model-machines.md#resuming):
 * a call that outlives the connection that asked for it. The link between two
 * spaces may drop (a tunnel reconnecting, a proxy restarting) while the model
 * is still working; without this, the caller records a failure, its app tries
 * again, and the same work is paid for twice.
 *
 * - A call with a ref runs on its own signal, not the request's: the connection
 *   closing does not stop it. Only `cancel` does, which the caller sends when
 *   its own caller gave up.
 * - Asking again with the same ref (and caller) attaches to that call, running
 *   or finished, and never starts a second one. The caller does just that when
 *   its connection dropped.
 * - A finished call's last event is kept for `keepMs` (15 min), at most `maxKept`
 *   of them; a ref older than that, or from before a restart, starts afresh.
 */

/** The event that ends a call's stream: `done` {ok, text, call} or `error` {ok: false, error, call}. */
export type FinalEvent = { event: "done" | "error"; data: Record<string, unknown> };

export type PeerRun = {
  readonly settled: Promise<FinalEvent>;
  /** Called with each piece of text while the call runs; only the connection that started it listens. */
  readonly deltas: Set<(text: string) => void>;
};

type Entry = PeerRun & { controller: AbortController; doneAt?: number };

export const REF_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;
export const KEEP_MS = 15 * 60_000;
const MAX_KEPT = 200;

export class PeerRuns {
  private readonly runs = new Map<string, Entry>();

  constructor(private readonly opts: { keepMs?: number; maxKept?: number; now?: () => number } = {}) {}

  /** The call under this ref, or a new one run by `start`; `fresh` is true when this request started it. */
  open(caller: string, ref: string, start: (signal: AbortSignal, onDelta: (text: string) => void) => Promise<FinalEvent>): { run: PeerRun; fresh: boolean } {
    this.sweep();
    const key = `${caller}|${ref}`;
    const found = this.runs.get(key);
    if (found) return { run: found, fresh: false };
    const controller = new AbortController();
    const deltas = new Set<(text: string) => void>();
    const entry = { controller, deltas } as Entry;
    const settled = start(controller.signal, (text) => {
      for (const d of deltas) d(text);
    })
      .catch((e): FinalEvent => ({ event: "error", data: { ok: false, error: (e as Error).message ?? String(e) } }))
      .then((final) => {
        entry.doneAt = this.now();
        deltas.clear();
        return final;
      });
    Object.assign(entry, { settled });
    this.runs.set(key, entry);
    return { run: entry, fresh: true };
  }

  /** Stop a running call; false when there is none under the ref. */
  cancel(caller: string, ref: string): boolean {
    const entry = this.runs.get(`${caller}|${ref}`);
    if (!entry || entry.doneAt !== undefined) return false;
    entry.controller.abort();
    return true;
  }

  get size(): number {
    return this.runs.size;
  }

  private sweep(): void {
    const keep = this.opts.keepMs ?? KEEP_MS;
    const now = this.now();
    const done: [string, number][] = [];
    for (const [key, e] of this.runs) {
      if (e.doneAt === undefined) continue;
      if (now - e.doneAt > keep) this.runs.delete(key);
      else done.push([key, e.doneAt]);
    }
    const over = done.length - (this.opts.maxKept ?? MAX_KEPT);
    if (over > 0) for (const [key] of done.sort((a, b) => a[1] - b[1]).slice(0, over)) this.runs.delete(key);
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }
}
