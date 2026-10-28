import { assertCompletionMode, type OnDelta, type RuntimeAdapter } from "../runtimes/types.ts";
import { RuntimeRegistry, claudeOnly } from "../runtimes/registry.ts";
import type { ModelStore } from "./store.ts";
import type { ModelSource } from "./app-models.ts";
import { classifyFailure, REST_KINDS } from "./failure.ts";
import type { RuntimeHealth } from "./health.ts";
import { type CallTrace, type ImageRunInput, type ImageRunOutcome, type ModelCall, type Origin, type RunInput, type RunOutcome, type TraceCandidate, type TraceStop, type TraceTry, type Usage } from "./types.ts";

/**
 * The service: resolves a request's model to one of the configured runtimes
 * (`runtime/model`, or the default runtime for a bare model), runs the call
 * under a concurrency cap and writes every one of them, success or failure,
 * to the ledger. The cap exists because every call is a process (or an API
 * request) and an app in a loop must not start fifty of them; excess calls
 * wait in order.
 *
 * Fallback (docs/model-machines.md#fallback): when runtimes.yaml lists a fallback for the model a
 * call names, the call moves to the next entry only when the one it tried failed on credit, quota,
 * rate or transport, and only while nothing of the answer has reached the caller. Candidates that
 * rest, are signed out or cannot be reached go last, never dropped; one that cannot take this call
 * (full mode, tools, files, another machine) is skipped. The row names the first choice
 * (`fallbackFrom`), how many runtimes were tried, and the trace of the decision.
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
  /** Told about every call's outcome: the status table's limited and last-success columns. */
  health?: RuntimeHealth;
};

export type RunResult = { outcome: RunOutcome; call: ModelCall };

/** Which layer chose the model, and the layers above it that named a model this space cannot run (app-models.ts). */
export type CallChoice = ModelSource | { source: ModelSource; skipped?: { source: ModelSource; model: string }[] };

/** Less time than this left of the request's timeout: no further candidate is started. */
export const MIN_TRY_MS = 5_000;
export type ImageResult = { outcome: ImageRunOutcome; call: ModelCall };

/** Recorded for a call the process could not finish: a restart, or a drain that ran out of grace. */
export const INTERRUPTED = "interrupted: ai-space stopped while the call was running";

/** Tools that reach only the network: a call limited to them needs nothing of the machine it runs on. */
export const WEB_TOOLS: ReadonlySet<string> = new Set(["WebSearch", "WebFetch"]);

/**
 * Why a call needs the environment of the machine that runs it, or undefined when it is plain
 * reasoning (docs/model-machines.md#placement): full mode carries the CLI's own context and tools
 * there (its working directory, CLAUDE.md, MCP servers), and a tool other than the web ones reads
 * or changes that machine. Files are not a reason: they travel with the request.
 */
export function needsLocal(input: Pick<RunInput, "mode" | "tools">): string | undefined {
  if (input.mode === "full") return "full mode";
  const local = input.tools.filter((t) => !WEB_TOOLS.has(t.split("(")[0]!));
  return local.length ? `tools that act on the machine (${local.join(", ")})` : undefined;
}

function assertPlace(runtime: RuntimeAdapter, input: Pick<RunInput, "mode" | "tools">): void {
  const why = runtime.machine ? needsLocal(input) : undefined;
  if (why) throw new Error(`this call uses ${why} and needs this machine's environment, so it cannot run on ${runtime.machine}; send it without tools (or with WebSearch/WebFetch only), or hand the work to an agent on the machine that has the data`);
}

/** What every runtime that answers a call checks first; a failure here is the request's, never a reason to fall back. */
function assertTakes(runtime: RuntimeAdapter, input: RunInput): void {
  assertPlace(runtime, input);
  assertCompletionMode(input);
  if (input.serviceTier !== undefined && runtime.kind !== "codex-cli") throw new Error("serviceTier requires a local Codex streaming runtime");
  if (input.mode === "full" && runtime.kind !== "codex-cli" && runtime.kind !== "claude-code") throw new Error(`runtime ${runtime.name} does not support full completion mode`);
}

/**
 * Why a fallback entry cannot take this call, so it is skipped rather than tried: the checks every
 * runtime makes, then the tools and files its adapter would refuse (the first choice's adapter
 * reports those itself, as before).
 */
function whyNot(runtime: RuntimeAdapter, input: RunInput): string | undefined {
  if (!runtime.capabilities.complete) return `runtime ${runtime.name} does not answer requests`;
  try {
    assertTakes(runtime, input);
  } catch (e) {
    return (e as Error).message;
  }
  const local = input.tools.filter((t) => !WEB_TOOLS.has(t.split("(")[0]!));
  if (input.tools.length && runtime.kind === "anthropic-api") return "the API runtime takes no tools";
  if (local.length && (runtime.kind === "codex-cli" || runtime.kind === "deepseek-harness")) return `runtime ${runtime.name} answers with WebSearch/WebFetch only`;
  if (input.files?.length && (runtime.kind === "anthropic-api" || runtime.kind === "deepseek-harness")) return `runtime ${runtime.name} takes no files`;
  return undefined;
}

/** One candidate of a call: the first choice or a fallback entry, resolved here. */
type Candidate = { label: string; runtime?: RuntimeAdapter; model?: string; note: TraceCandidate; first?: true };

type Inflight = { mode?: RunInput["mode"]; app: string; tag: string; model: string; promptChars: number; startedAt: number };

export class ModelService {
  readonly store: ModelStore;
  readonly runtimes: RuntimeRegistry;
  readonly maxConcurrency: number;
  private readonly log: (m: string) => void;
  private readonly now: () => number;
  readonly health: RuntimeHealth | undefined;
  private running = 0;
  private readonly queue: (() => void)[] = [];
  private readonly inflight = new Map<Promise<RunResult | ImageResult>, Inflight>();

  constructor(opts: ModelServiceOptions) {
    this.store = opts.store;
    this.runtimes = opts.runtimes ?? claudeOnly();
    this.maxConcurrency = Math.max(1, opts.maxConcurrency ?? 4);
    this.log = opts.log ?? ((m) => console.log(`[model] ${m}`));
    this.now = opts.now ?? Date.now;
    this.health = opts.health;
  }

  /** Where a bare model name runs; the status view shows it. */
  get backend(): string {
    return this.runtimes.default?.backend ?? "none (every model names its runtime)";
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
   * The runtime for a call, refusing one that needs this machine's environment but resolves to
   * another machine (a peer, a `machines:` login or a runtime's own ssh host). Nothing moves it
   * back here silently: the app sends plain reasoning, or hands the work to an agent where the data is.
   */
  place(input: Pick<RunInput, "model" | "mode" | "tools">): { runtime: RuntimeAdapter; model: string } {
    const r = this.resolve(input.model);
    assertPlace(r.runtime, input);
    return r;
  }

  /**
   * Run one call for an app and record it. Never throws for a failed call: the outcome says so.
   * With `onDelta`, the runtime hands the text over as it is produced when it can; the outcome
   * still carries the whole answer. `source` is recorded with the call: which layer chose the model.
   */
  async run(app: string, input: RunInput, signal?: AbortSignal, onDelta?: OnDelta, source?: CallChoice, origin: Origin = "run"): Promise<RunResult> {
    const p = this.execute(app, input, signal, onDelta, source, origin);
    this.inflight.set(p, { mode: input.mode ?? (input.tools.length || input.files?.length ? undefined : "slim"), app, tag: input.tag, model: input.model, promptChars: input.prompt.length, startedAt: this.now() });
    try {
      return await p;
    } finally {
      this.inflight.delete(p);
    }
  }

  /** The runtime a request for pictures names; throws when it cannot make them. */
  resolveImage(model: string): { runtime: RuntimeAdapter; model: string } {
    const r = this.runtimes.resolve(model);
    if (!r.runtime.capabilities.image || !r.runtime.image) throw new Error(`runtime ${r.runtime.name} does not make images`);
    return r;
  }

  /**
   * Pictures for an app: the same cap, in-flight tracking and ledger as `run`. The row carries the
   * tokens the runtime reported for driving its image tool; what the tool itself cost is not reported.
   */
  async image(app: string, input: ImageRunInput, signal?: AbortSignal, source?: ModelSource, origin: Origin = "run"): Promise<ImageResult> {
    const p = this.executeImage(app, input, signal, source, origin);
    this.inflight.set(p, { app, tag: input.tag, model: input.model, promptChars: input.prompt.length, startedAt: this.now() });
    try {
      return await p;
    } finally {
      this.inflight.delete(p);
    }
  }

  private async executeImage(app: string, input: ImageRunInput, signal?: AbortSignal, source?: ModelSource, origin: Origin = "run"): Promise<ImageResult> {
    const row = (runtime: RuntimeAdapter | undefined, model: string, outcome: ImageRunOutcome, startedAt: number, durationMs: number) =>
      this.store.add({
        app, tag: input.tag, model: outcome.model ?? model, runtime: runtime?.name, ...(runtime?.machine ? { machine: runtime.machine } : {}), ...(source ? { modelSource: source } : {}),
        backend: outcome.backend, origin, status: outcome.ok ? "ok" : "error", error: outcome.ok ? undefined : outcome.error,
        startedAt, durationMs, promptChars: input.prompt.length, outputChars: outcome.ok ? outcome.text.length : undefined, usage: outcome.usage, costUsd: outcome.costUsd,
      });
    let target: { runtime: RuntimeAdapter; model: string };
    try {
      target = this.resolveImage(input.model);
    } catch (e) {
      const outcome: ImageRunOutcome = { ok: false, error: (e as Error).message, backend: this.backend as ImageRunOutcome["backend"] };
      return { outcome, call: row(undefined, input.model, outcome, this.now(), 0) };
    }
    if (!(await this.acquire(signal))) {
      const outcome: ImageRunOutcome = { ok: false, error: "aborted", backend: target.runtime.backend };
      return { outcome, call: row(target.runtime, target.model, outcome, this.now(), 0) };
    }
    const startedAt = this.now();
    let outcome: ImageRunOutcome;
    try {
      outcome = await target.runtime.image!({ ...input, model: target.model, caller: app }, signal);
    } catch (e) {
      outcome = { ok: false, error: (e as Error).message ?? String(e), backend: target.runtime.backend };
    } finally {
      this.release();
    }
    const call = row(target.runtime, target.model, outcome, startedAt, Math.max(0, this.now() - startedAt));
    this.health?.note(target.runtime.machine ?? "", target.runtime.name, outcome.ok ? undefined : outcome.error);
    if (!outcome.ok) this.log(`${app}/${input.tag} image (${target.runtime.name}/${target.model}, ${outcome.backend}): ${outcome.error}`);
    return { outcome, call };
  }

  /** The calls in flight (docs/local.md#updates). */
  inFlight(): { app: string; tag: string; model: string; startedAt: number }[] {
    return [...this.inflight.values()].map((e) => ({ app: e.app, tag: e.tag, model: e.model, startedAt: e.startedAt }));
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
      this.store.add({ mode: e.mode, app: e.app, tag: e.tag, model: e.model, backend: this.backend as ModelCall["backend"], origin: "run", status: "error", error: INTERRUPTED, startedAt: e.startedAt, durationMs: Math.max(0, at - e.startedAt), promptChars: e.promptChars });
      this.log(`${e.app}/${e.tag} (${e.model}): ${INTERRUPTED}`);
    }
    return { finished: started - left.length, interrupted: left.length };
  }

  private async execute(app: string, input: RunInput, signal?: AbortSignal, onDelta?: OnDelta, choice?: CallChoice, origin: Origin = "run"): Promise<RunResult> {
    const source = typeof choice === "object" ? choice.source : choice;
    const skippedLayers = typeof choice === "object" && choice.skipped?.length ? choice.skipped : undefined;
    let target: { runtime: RuntimeAdapter; model: string } | undefined;
    try {
      target = this.resolve(input.model);
      assertTakes(target.runtime, input);
    } catch (e) {
      // Recorded too: an app asking for a runtime this space lacks, or for this machine's environment
      // on another, shows up in the ledger as its own error (under that runtime and machine when known).
      const outcome: RunOutcome = { ok: false, error: (e as Error).message, backend: (target?.runtime.backend ?? this.backend) as RunOutcome["backend"] };
      return { outcome, call: this.record(app, target ? { ...input, model: target.model } : input, target?.runtime, outcome, this.now(), 0, source, origin, skippedLayers ? { trace: { skippedLayers, tries: [] } } : {}) };
    }
    const candidates = this.candidates(input, target, origin);
    if (!(await this.acquire(signal))) {
      // Cancelled while queued: it never ran, but the ledger still shows the request.
      const outcome: RunOutcome = { ok: false, error: "aborted", backend: target.runtime.backend };
      return { outcome, call: this.record(app, { ...input, model: target.model }, target.runtime, outcome, this.now(), 0, source, origin, skippedLayers ? { trace: { skippedLayers, tries: [] } } : {}) };
    }
    const startedAt = this.now();
    const deadline = startedAt + input.timeoutMs;
    const tries: TraceTry[] = [];
    let outcome: RunOutcome = { ok: false, error: "no candidate could take this call", backend: target.runtime.backend };
    let used: Candidate = candidates[0]!;
    let stop: TraceStop = "exhausted";
    try {
      for (const c of candidates) {
        if (!c.runtime || c.model === undefined || c.note.skipped) continue;
        if (tries.length) {
          if (signal?.aborted) {
            stop = "aborted";
            break;
          }
          if (deadline - this.now() < MIN_TRY_MS) {
            stop = "no-time";
            break;
          }
          this.log(`${app}/${input.tag}: ${used.label} failed (${tries.at(-1)!.kind}); trying ${c.label}`);
        }
        // Output that reached the caller pins the call to this runtime: the caller sees one answer, never two halves.
        let streamed = false;
        const relay: OnDelta | undefined = onDelta && ((text) => {
          streamed = true;
          onDelta(text);
        });
        const t0 = this.now();
        let o: RunOutcome;
        try {
          o = await c.runtime.complete({ ...input, model: c.model, caller: app, timeoutMs: tries.length ? deadline - t0 : input.timeoutMs }, signal, relay);
        } catch (e) {
          o = { ok: false, error: (e as Error).message ?? String(e), backend: c.runtime.backend };
        }
        const failure = o.ok ? undefined : classifyFailure(o.error, this.now());
        this.health?.note(c.runtime.machine ?? "", c.runtime.name, o.ok ? undefined : o.error, failure);
        tries.push({
          runtime: c.runtime.name, ...(c.runtime.machine ? { machine: c.runtime.machine } : {}), model: o.model ?? c.model, ok: o.ok,
          ...(o.ok ? {} : { error: o.error.slice(0, 200), kind: failure!.kind }), ms: Math.max(0, this.now() - t0),
          ...(streamed && !o.ok ? { streamed: true } : {}), ...(o.served ? { served: o.served } : {}),
        });
        outcome = o;
        used = c;
        if (o.ok) {
          stop = "answered";
          break;
        }
        this.log(`${app}/${input.tag} (${c.runtime.name}/${c.model}, ${o.backend}): ${o.error}`);
        if (streamed) {
          stop = "streamed";
          break;
        }
        if (!REST_KINDS.has(failure!.kind)) {
          stop = "not-switched";
          break;
        }
      }
    } finally {
      this.release();
    }
    const first = candidates.find((c) => c.first)!;
    const fellBack = used !== first;
    const informative = candidates.length > 1 || tries.length > 1 || Boolean(skippedLayers) || tries.some((t) => t.served);
    const trace: CallTrace | undefined = informative
      ? { ...(skippedLayers ? { skippedLayers } : {}), ...(candidates.length > 1 ? { candidates: candidates.map((c) => c.note) } : {}), tries, stop }
      : undefined;
    const call = this.record(app, { ...input, model: used.model ?? target.model }, used.runtime ?? target.runtime, outcome, startedAt, Math.max(0, this.now() - startedAt), source, origin, {
      ...(fellBack && tries.length ? { fallbackFrom: first.label } : {}),
      ...(tries.length ? { tries: tries.length } : {}),
      ...(trace ? { trace } : {}),
    });
    if (fellBack && outcome.ok) this.log(`${app}/${input.tag}: answered by ${used.label}, fallback from ${first.label}`);
    return { outcome, call };
  }

  /**
   * The first choice, then its fallback list (docs/model-machines.md#fallback), each resolved here.
   * One that cannot take this call is kept with the reason it is skipped; one that rests, is signed
   * out, unreachable or not installed goes after the others, in its own order, and is still tried.
   * A call another space forwarded here does not fall back here: the caller's own list decides, and
   * the peer offers only the runtimes it chose (SPACE_PEER_MODEL).
   */
  private candidates(input: RunInput, first: { runtime: RuntimeAdapter; model: string }, origin: Origin): Candidate[] {
    const list = origin === "peer" ? undefined : this.runtimes.fallbackFor(input.model);
    const head: Candidate = { label: list?.key ?? input.model, runtime: first.runtime, model: first.model, note: { model: list?.key ?? input.model }, first: true };
    if (!list) return [head];
    const all: Candidate[] = [head];
    for (const entry of list.entries) {
      let r: { runtime: RuntimeAdapter; model: string };
      try {
        r = this.runtimes.resolve(entry);
      } catch (e) {
        all.push({ label: entry, note: { model: entry, skipped: (e as Error).message } });
        continue;
      }
      const why = whyNot(r.runtime, input);
      all.push({ label: entry, runtime: r.runtime, model: r.model, note: { model: entry, ...(why ? { skipped: why } : {}) } });
    }
    for (const c of all) if (c.runtime && !c.note.skipped) Object.assign(c.note, this.stateOf(c.runtime));
    // The order they are tried in, each group in its configured order; the skipped ones close the trace.
    return [...all.filter((c) => !c.note.skipped && !c.note.later), ...all.filter((c) => !c.note.skipped && c.note.later), ...all.filter((c) => c.note.skipped)];
  }

  /** Why a candidate goes last, as this space knows its cell: its own probes and the calls it sent there. */
  private stateOf(runtime: RuntimeAdapter): Pick<TraceCandidate, "later" | "restKind" | "until"> {
    if (!this.health) return {};
    const machine = runtime.machine ?? "";
    const rest = this.health.resting(machine, runtime.name);
    if (rest) return { later: "resting", until: rest.until, ...(rest.kind ? { restKind: rest.kind } : {}) };
    const c = this.health.get(machine, runtime.name);
    if (c?.reachable === false) return { later: "unreachable" };
    if (c?.installed === false) return { later: "not-installed" };
    if (c?.signedIn === false) return { later: "signed-out" };
    return {};
  }

  private record(app: string, input: RunInput, runtime: RuntimeAdapter | undefined, outcome: RunOutcome, startedAt: number, durationMs: number, source?: ModelSource, origin: Origin = "run", extra: Pick<ModelCall, "fallbackFrom" | "tries" | "trace"> = {}): ModelCall {
    return this.store.add({
      app,
      tag: input.tag,
      // A peer resolved the tier: its concrete model is what ran.
      model: outcome.model ?? input.model,
      runtime: runtime?.name,
      ...(runtime?.machine ? { machine: runtime.machine } : {}),
      ...(source ? { modelSource: source } : {}),
      mode: input.mode ?? (input.tools.length || input.files?.length ? undefined : "slim"),
      backend: outcome.backend,
      origin,
      status: outcome.ok ? "ok" : "error",
      error: outcome.ok ? undefined : outcome.error,
      startedAt,
      durationMs,
      promptChars: input.prompt.length,
      outputChars: outcome.ok ? outcome.text.length : undefined,
      usage: outcome.usage,
      costUsd: outcome.costUsd,
      ...extra,
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
    if (entry.runtime) this.health?.note("", entry.runtime, entry.ok ? undefined : entry.error);
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

  /** A slot under the cap; false, holding none, when `signal` aborts first (the waiter leaves the queue at once). */
  private acquire(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    if (this.running < this.maxConcurrency) {
      this.running++;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const onAbort = () => {
        const i = this.queue.indexOf(grant);
        if (i >= 0) this.queue.splice(i, 1);
        resolve(false);
      };
      const grant = () => {
        signal?.removeEventListener("abort", onAbort);
        this.running++;
        resolve(true);
      };
      this.queue.push(grant);
      signal?.addEventListener("abort", onAbort, { once: true });
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
