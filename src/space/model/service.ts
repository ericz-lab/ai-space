import type { OnDelta, RuntimeAdapter } from "../runtimes/types.ts";
import { RuntimeRegistry, claudeOnly } from "../runtimes/registry.ts";
import type { ModelStore } from "./store.ts";
import { type ModelCall, type RunInput, type RunOutcome, type Usage } from "./types.ts";

/**
 * The service: resolves a request's model to one of the configured runtimes
 * (`runtime/model`, or the default runtime for a bare model), runs the call
 * under a concurrency cap and writes every one of them, success or failure,
 * to the ledger. The cap exists because every call is a process (or an API
 * request) and an app in a loop must not start fifty of them; excess calls
 * wait in order.
 *
 * Shutdown: `drain` waits for the calls in flight, because an app is blocked on
 * each of them; the ones still running when the grace is over are written to the
 * ledger as interrupted, so a restart that cuts a call is visible there.
 */

export type ModelServiceOptions = {
  store: ModelStore;
  runtimes?: RuntimeRegistry;
  /** How many calls may run at the same time (SPACE_MODEL_MAX_CONCURRENCY). */
  maxConcurrency?: number;
  log?: (message: string) => void;
  now?: () => number;
};

export type RunResult = { outcome: RunOutcome; call: ModelCall };

/** Recorded for a call the process could not finish: a restart, or a drain that ran out of grace. */
export const INTERRUPTED = "interrupted: ai-space stopped while the call was running";

type Inflight = { app: string; tag: string; model: string; promptChars: number; startedAt: number };

export class ModelService {
  readonly store: ModelStore;
  readonly runtimes: RuntimeRegistry;
  readonly maxConcurrency: number;
  private readonly log: (m: string) => void;
  private readonly now: () => number;
  private running = 0;
  private readonly queue: (() => void)[] = [];
  private readonly inflight = new Map<Promise<RunResult>, Inflight>();

  constructor(opts: ModelServiceOptions) {
    this.store = opts.store;
    this.runtimes = opts.runtimes ?? claudeOnly();
    this.maxConcurrency = Math.max(1, opts.maxConcurrency ?? 4);
    this.log = opts.log ?? ((m) => console.log(`[model] ${m}`));
    this.now = opts.now ?? Date.now;
  }

  /** Where a bare model name runs; the status view shows it. */
  get backend(): string {
    return this.runtimes.default.backend;
  }

  /** In flight and waiting, for the status view. */
  get load(): { running: number; waiting: number } {
    return { running: this.running, waiting: this.queue.length };
  }

  /** The runtime a request's model names, and the model as that runtime knows it. Throws on an unknown runtime or one without answers. */
  resolve(model: string): { runtime: RuntimeAdapter; model: string } {
    const r = this.runtimes.resolve(model);
    if (!r.runtime.capabilities.complete) throw new Error(`runtime ${r.runtime.name} does not answer requests`);
    return r;
  }

  /**
   * Run one call for an app and record it. Never throws for a failed call: the outcome says so.
   * With `onDelta`, the runtime hands the text over as it is produced when it can; the outcome
   * still carries the whole answer.
   */
  async run(app: string, input: RunInput, signal?: AbortSignal, onDelta?: OnDelta): Promise<RunResult> {
    const p = this.execute(app, input, signal, onDelta);
    this.inflight.set(p, { app, tag: input.tag, model: input.model, promptChars: input.prompt.length, startedAt: this.now() });
    try {
      return await p;
    } finally {
      this.inflight.delete(p);
    }
  }

  /** Resolves once no call is in flight. */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight.keys()]);
  }

  /**
   * Let the calls in flight finish, up to `graceMs`; whatever is still running then
   * is recorded as interrupted, since the process is about to go away and the call
   * would otherwise leave nothing in the ledger.
   */
  async drain(graceMs: number): Promise<{ finished: number; interrupted: number }> {
    const started = this.inflight.size;
    if (started && graceMs > 0) await Promise.race([this.idle(), sleep(graceMs)]);
    const left = [...this.inflight.values()];
    const at = this.now();
    for (const e of left) {
      this.store.add({ app: e.app, tag: e.tag, model: e.model, backend: this.backend as ModelCall["backend"], origin: "run", status: "error", error: INTERRUPTED, startedAt: e.startedAt, durationMs: Math.max(0, at - e.startedAt), promptChars: e.promptChars });
      this.log(`${e.app}/${e.tag} (${e.model}): ${INTERRUPTED}`);
    }
    return { finished: started - left.length, interrupted: left.length };
  }

  private async execute(app: string, input: RunInput, signal?: AbortSignal, onDelta?: OnDelta): Promise<RunResult> {
    let target: { runtime: RuntimeAdapter; model: string };
    try {
      target = this.resolve(input.model);
    } catch (e) {
      // Recorded too: an app asking for a runtime this space lacks shows up in the ledger as its own error.
      const outcome: RunOutcome = { ok: false, error: (e as Error).message, backend: this.backend as RunOutcome["backend"] };
      return { outcome, call: this.record(app, input, undefined, outcome, this.now(), 0) };
    }
    await this.acquire();
    const startedAt = this.now();
    let outcome: RunOutcome;
    try {
      outcome = await target.runtime.complete({ ...input, model: target.model }, signal, onDelta);
    } catch (e) {
      outcome = { ok: false, error: (e as Error).message ?? String(e), backend: target.runtime.backend };
    } finally {
      this.release();
    }
    const call = this.record(app, { ...input, model: target.model }, target.runtime.name, outcome, startedAt, Math.max(0, this.now() - startedAt));
    if (!outcome.ok) this.log(`${app}/${input.tag} (${target.runtime.name}/${target.model}, ${outcome.backend}): ${outcome.error}`);
    return { outcome, call };
  }

  private record(app: string, input: RunInput, runtime: string | undefined, outcome: RunOutcome, startedAt: number, durationMs: number): ModelCall {
    return this.store.add({
      app,
      tag: input.tag,
      model: input.model,
      runtime,
      backend: outcome.backend,
      origin: "run",
      status: outcome.ok ? "ok" : "error",
      error: outcome.ok ? undefined : outcome.error,
      startedAt,
      durationMs,
      promptChars: input.prompt.length,
      outputChars: outcome.ok ? outcome.text.length : undefined,
      usage: outcome.usage,
      costUsd: outcome.costUsd,
    });
  }

  /** Record a call that ran elsewhere: the scheduler's agent tasks, which run on their runtime from the scheduler. */
  recordExternal(entry: {
    app: string;
    tag: string;
    model: string;
    runtime?: string;
    backend: string;
    ok: boolean;
    error?: string;
    startedAt: number;
    durationMs: number;
    promptChars: number;
    outputChars?: number;
    usage?: Usage;
    costUsd?: number;
  }): ModelCall {
    return this.store.add({
      app: entry.app,
      tag: entry.tag,
      model: entry.model,
      runtime: entry.runtime,
      backend: entry.backend,
      origin: "task",
      status: entry.ok ? "ok" : "error",
      error: entry.ok ? undefined : entry.error,
      startedAt: entry.startedAt,
      durationMs: entry.durationMs,
      promptChars: entry.promptChars,
      outputChars: entry.outputChars,
      usage: entry.usage,
      costUsd: entry.costUsd,
    });
  }

  private acquire(): Promise<void> {
    if (this.running < this.maxConcurrency) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.running++;
        resolve();
      });
    });
  }

  private release(): void {
    this.running--;
    this.queue.shift()?.();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t === "object" && "unref" in t) t.unref();
  });
}
