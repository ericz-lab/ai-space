import { type Runner, createRunner } from "./runner.ts";
import type { ModelStore } from "./store.ts";
import { type ModelCall, type RunInput, type RunOutcome, type Usage } from "./types.ts";

/**
 * The service: runs calls on the workspace's backend under a concurrency cap
 * and writes every one of them, success or failure, to the ledger. The cap
 * exists because every call is a `claude` process (or an API request) and an
 * app in a loop must not start fifty of them; excess calls wait in order.
 */

export type ModelServiceOptions = {
  store: ModelStore;
  runner?: Runner;
  /** How many calls may run at the same time (SPACE_MODEL_MAX_CONCURRENCY). */
  maxConcurrency?: number;
  log?: (message: string) => void;
  now?: () => number;
};

export type RunResult = { outcome: RunOutcome; call: ModelCall };

export class ModelService {
  readonly store: ModelStore;
  readonly runner: Runner;
  readonly maxConcurrency: number;
  private readonly log: (m: string) => void;
  private readonly now: () => number;
  private running = 0;
  private readonly queue: (() => void)[] = [];

  constructor(opts: ModelServiceOptions) {
    this.store = opts.store;
    this.runner = opts.runner ?? createRunner();
    this.maxConcurrency = Math.max(1, opts.maxConcurrency ?? 4);
    this.log = opts.log ?? ((m) => console.log(`[model] ${m}`));
    this.now = opts.now ?? Date.now;
  }

  get backend(): string {
    return this.runner.backend;
  }

  /** In flight and waiting, for the status view. */
  get load(): { running: number; waiting: number } {
    return { running: this.running, waiting: this.queue.length };
  }

  /** Run one call for an app and record it. Never throws for a failed call: the outcome says so. */
  async run(app: string, input: RunInput, signal?: AbortSignal): Promise<RunResult> {
    await this.acquire();
    const startedAt = this.now();
    let outcome: RunOutcome;
    try {
      outcome = await this.runner.run(input, signal);
    } catch (e) {
      outcome = { ok: false, error: (e as Error).message ?? String(e), backend: this.runner.backend };
    } finally {
      this.release();
    }
    const call = this.store.add({
      app,
      tag: input.tag,
      model: input.model,
      backend: outcome.backend,
      origin: "run",
      status: outcome.ok ? "ok" : "error",
      error: outcome.ok ? undefined : outcome.error,
      startedAt,
      durationMs: Math.max(0, this.now() - startedAt),
      promptChars: input.prompt.length,
      outputChars: outcome.ok ? outcome.text.length : undefined,
      usage: outcome.usage,
      costUsd: outcome.costUsd,
    });
    if (!outcome.ok) this.log(`${app}/${input.tag} (${input.model}, ${outcome.backend}): ${outcome.error}`);
    return { outcome, call };
  }

  /** Record a call that ran elsewhere: the scheduler's agent tasks, which spawn `claude` themselves. */
  record(entry: {
    app: string;
    tag: string;
    model: string;
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
