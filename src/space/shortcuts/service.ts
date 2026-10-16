import { randomUUID } from "node:crypto";
import type { AppCapabilities, CallRequest, CallResult } from "../bus/bus.ts";
import type { Capability } from "../bus/types.ts";
import type { Run as TaskRun, Task } from "../scheduler/types.ts";
import { CalcError, evaluate, format } from "./calc.ts";
import type { ShortcutStore } from "./store.ts";
import { isDate, isTime, isTimezone, localInstant, resolveDate, resolvePeriod } from "./time.ts";
import { type Action, type ActionInput, type ActionSpec, MAX_ITEMS, type ListItem, type ReceiptItem, type Run, type RunResult, TEMPLATES, TEMPLATE_RESULTS, type Template } from "./types.ts";

/**
 * Shortcuts (docs/shortcuts.md): the action catalogue and the executor every entry point shares.
 *
 * The catalogue is the built-ins (calculator, currency conversion, running a scheduler task) plus
 * every capability on this space or a peer that carries an `action:` block. A phase-1 template slot
 * no provider fills still shows, unavailable, with the dependency it misses.
 *
 * A run validates its arguments against the action's inputs, resolves relative dates in the run's
 * timezone, records itself, and executes in the background: the request that started it waits a
 * few seconds and then answers the run as it stands, and the page follows it by id. Writes carry
 * an idempotency key; a write whose answer was lost is `unknown`, not failed, and is retried only
 * when the provider declares it idempotent (the same key answers the first result).
 */

/** The caller name the bus records for the operator's own calls. */
export const OPERATOR = "space";
/** How long the starting request waits for a run before answering it as still running. */
export const WAIT_MS = 8_000;
/** How long a rates answer is reused for conversions; the answer's own `asOf` is shown either way. */
export const RATES_TTL_MS = 10 * 60_000;
export const RATES = { app: "fx-desk", capability: "rates" };

export class ShortcutError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type ShortcutBus = {
  capabilities(): AppCapabilities[];
  capability(app: string, name: string): Capability | undefined;
  call(caller: string, app: string, name: string, req?: CallRequest): Promise<CallResult>;
};

/** A peer as the executor needs it: its catalogue and a way to call one of its capabilities. */
export type ShortcutPeers = {
  capabilities(): (AppCapabilities & { peer: string })[];
  call(peer: string, app: string, capability: string, body: string): Promise<{ status: number; body: string; callId?: number }>;
};

export type ShortcutScheduler = {
  runNow(id: string): boolean;
  getTask(id: string): Task | undefined;
  listTasks(): Task[];
  listRuns(taskId: string, limit?: number): TaskRun[];
};

export type ShortcutOptions = {
  store: ShortcutStore;
  bus: ShortcutBus;
  peers?: ShortcutPeers;
  scheduler?: ShortcutScheduler;
  /** True when the app's service can take a call now; an app action is unavailable otherwise. */
  running?: (app: string) => boolean;
  /** The capability conversions take their rates from. */
  rates?: { app: string; capability: string };
  now?: () => number;
  waitMs?: number;
  log?: (msg: string) => void;
};

export type RunInput = { action: string; peer?: string; args?: Record<string, unknown>; timezone?: string; requestId?: string };

type Rates = { base: string; rates: Record<string, number>; asOf?: string; source?: string; stale?: boolean };

export class Shortcuts {
  private readonly store: ShortcutStore;
  private readonly now: () => number;
  private readonly waitMs: number;
  private readonly rates: { app: string; capability: string };
  private readonly inflight = new Map<number, Promise<void>>();
  private ratesCache?: { at: number; rates: Rates };

  constructor(private readonly opts: ShortcutOptions) {
    this.store = opts.store;
    this.now = opts.now ?? Date.now;
    this.waitMs = opts.waitMs ?? WAIT_MS;
    this.rates = opts.rates ?? RATES;
  }

  // ---------------------------------------------------------------- catalogue

  catalogue(): Action[] {
    const out: Action[] = [...this.builtins()];
    const filled = new Set<Template>(["calc", "convert", "run-task"]);
    const add = (a: AppCapabilities, peer?: string) => {
      for (const cap of a.provides) {
        if (!cap.action) continue;
        if (cap.action.template) filled.add(cap.action.template);
        const running = peer ? true : (this.opts.running?.(a.app) ?? true);
        out.push({ ...cap.action, id: `${a.app}/${cap.name}`, app: a.app, builtin: false, ...(peer ? { peer } : {}), available: running, ...(running ? {} : { reason: `${a.app} has no running service` }) });
      }
    };
    for (const a of this.opts.bus.capabilities()) add(a);
    for (const a of this.opts.peers?.capabilities() ?? []) add(a, a.peer);
    // The slots nobody fills yet: shown so the operator sees what is missing.
    for (const t of TEMPLATES) if (!filled.has(t)) out.push(missingTemplate(t));
    return out;
  }

  private builtins(): Action[] {
    const tasks = this.opts.scheduler?.listTasks() ?? [];
    const ratesHere = !!this.opts.bus.capability(this.rates.app, this.rates.capability);
    const ratesPeer = (this.opts.peers?.capabilities() ?? []).some((a) => a.app === this.rates.app && a.provides.some((c) => c.name === this.rates.capability));
    return [
      {
        ...CALC,
        id: "space/calc",
        app: OPERATOR,
        builtin: true,
        available: true,
      },
      {
        ...CONVERT,
        id: "space/convert",
        app: OPERATOR,
        builtin: true,
        available: ratesHere || ratesPeer,
        ...(ratesHere || ratesPeer ? {} : { reason: `no ${this.rates.app}/${this.rates.capability} capability on this space or its peers` }),
      },
      {
        ...RUN_TASK,
        inputs: [{ ...RUN_TASK.inputs[0]!, options: tasks.map((t) => ({ value: t.id, label: `${t.app} · ${t.name}` })) }],
        id: "space/run-task",
        app: OPERATOR,
        builtin: true,
        available: !!this.opts.scheduler && tasks.length > 0,
        ...(this.opts.scheduler && tasks.length ? {} : { reason: "no scheduler tasks on this space" }),
      },
    ];
  }

  find(id: string, peer?: string): Action | undefined {
    return this.catalogue().find((a) => a.id === id && (a.peer ?? "") === (peer ?? ""));
  }

  // ---------------------------------------------------------------- runs

  listRuns(limit?: number): Run[] {
    return this.store.listRuns({ limit }).map((r) => this.refresh(r));
  }

  getRun(id: number): Run | undefined {
    const r = this.store.getRun(id);
    return r ? this.refresh(r) : undefined;
  }

  /**
   * Validate, record and start a run; answers when it ends or after `waitMs`, whichever is first.
   * A request id seen before answers that run (`duplicate`), so a double submit never runs twice.
   */
  async start(input: RunInput): Promise<{ run: Run; duplicate: boolean }> {
    if (input.requestId !== undefined && (typeof input.requestId !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(input.requestId))) throw new ShortcutError(400, "requestId must be 8-80 letters, digits, - or _");
    if (input.requestId) {
      const seen = this.store.byRequest(input.requestId);
      if (seen) return { run: await this.settle(seen), duplicate: true };
    }
    const action = this.find(input.action, input.peer);
    if (!action) throw new ShortcutError(404, `unknown action: ${input.peer ? `${input.peer}:` : ""}${input.action}`);
    if (!action.available) throw new ShortcutError(503, action.reason ?? `${action.id} is not available`);
    const { args, resolved, timezone } = this.prepare(action, input.args ?? {}, input.timezone);
    const run = this.store.addRun({
      requestId: input.requestId ?? randomUUID(),
      action: action.id,
      ...(action.peer ? { peer: action.peer } : {}),
      title: action.title,
      effect: action.effect,
      args,
      resolved,
      ...(timezone ? { timezone } : {}),
      ...(action.effect === "write" ? { idempotencyKey: randomUUID() } : {}),
      createdAt: this.now(),
    });
    // Lost a race with the same request id: answer the run that won.
    if (!run) return { run: await this.settle(this.store.byRequest(input.requestId!)!), duplicate: true };
    this.launch(run, action);
    return { run: await this.settle(run), duplicate: false };
  }

  /**
   * Run a failed or unknown run again. An `unknown` write goes again only to an idempotent provider,
   * with the same key, so the provider answers the first write if it happened.
   */
  async retry(id: number): Promise<Run> {
    const run = this.getRun(id);
    if (!run) throw new ShortcutError(404, `unknown run: ${id}`);
    if (run.status === "running") throw new ShortcutError(409, "the run is still running");
    if (run.status === "ok") throw new ShortcutError(409, "the run succeeded; start a new one");
    const action = this.find(run.action, run.peer);
    if (!action) throw new ShortcutError(404, `the action ${run.action} is gone`);
    if (run.status === "unknown" && !action.idempotent) throw new ShortcutError(409, `${action.app} cannot tell whether the first attempt was written; check it there before submitting again`);
    if (action.effect === "run") throw new ShortcutError(409, "start the task again from a new run");
    const fresh = this.store.patchRun(run.id, { status: "running", error: undefined, result: undefined, endedAt: undefined })!;
    this.launch(fresh, action);
    return this.settle(fresh);
  }

  /** A read action's result without recording a run: the command box's live preview (conversions). */
  async preview(input: RunInput): Promise<RunResult> {
    const action = this.find(input.action, input.peer);
    if (!action) throw new ShortcutError(404, `unknown action: ${input.action}`);
    if (action.effect !== "read") throw new ShortcutError(400, `${action.id} is not read-only; submit it as a run`);
    if (!action.available) throw new ShortcutError(503, action.reason ?? `${action.id} is not available`);
    const { resolved, timezone } = this.prepare(action, input.args ?? {}, input.timezone);
    return (await this.execute(action, resolved, timezone)).result;
  }

  /** Wait for in-flight runs (shutdown, tests). */
  async idle(): Promise<void> {
    await Promise.all(this.inflight.values());
  }

  private launch(run: Run, action: Action): void {
    const attempts = run.attempts + 1;
    this.store.patchRun(run.id, { attempts });
    const p = this.execute(action, run.resolved ?? {}, run.timezone, run.idempotencyKey)
      .then((out) => {
        this.store.patchRun(run.id, { status: out.status ?? "ok", result: out.result, ...(out.callId !== undefined ? { callId: out.callId } : {}), ...(out.taskId ? { taskId: out.taskId, taskStartedAt: out.taskStartedAt } : {}), ...(out.status === "running" ? {} : { endedAt: this.now() }) });
      })
      .catch((e) => {
        const status = e instanceof Uncertain ? "unknown" : "error";
        this.store.patchRun(run.id, { status, error: (e as Error).message ?? String(e), ...(e instanceof Uncertain && e.callId !== undefined ? { callId: e.callId } : {}), endedAt: this.now() });
        this.opts.log?.(`shortcut ${action.id} #${run.id}: ${status}: ${(e as Error).message}`);
      })
      .finally(() => this.inflight.delete(run.id));
    this.inflight.set(run.id, p);
  }

  private async settle(run: Run): Promise<Run> {
    const p = this.inflight.get(run.id);
    if (p) await Promise.race([p, new Promise((r) => setTimeout(r, this.waitMs))]);
    return this.getRun(run.id)!;
  }

  /** A task run's status comes from the scheduler: running until its run record appears. */
  private refresh(run: Run): Run {
    if (run.status !== "running" || !run.taskId || run.taskStartedAt === undefined || !this.opts.scheduler) return run;
    const task = this.opts.scheduler.getTask(run.taskId);
    if (!task) return this.store.patchRun(run.id, { status: "error", error: "the task was removed", endedAt: this.now() })!;
    if (task.state.runningAt === run.taskStartedAt) return run;
    const done = this.opts.scheduler.listRuns(run.taskId, 50).find((r) => r.startedAt === run.taskStartedAt);
    if (!done) return run;
    const prev = run.result?.kind === "task" ? run.result : undefined;
    const result: RunResult = { kind: "task", taskId: task.id, task: prev?.task ?? `${task.app} · ${task.name}`, startedAt: new Date(done.startedAt).toISOString(), runId: done.id, status: done.status === "error" ? "error" : "ok", ...(done.error ? { error: done.error } : {}), ...(done.output ? { output: done.output.slice(-2000) } : {}) };
    return this.store.patchRun(run.id, { status: done.status === "error" ? "error" : "ok", result, ...(done.error ? { error: done.error } : {}), endedAt: done.endedAt })!;
  }

  // ---------------------------------------------------------------- arguments

  /** Validate every argument against its input; resolve relative dates and periods in `timezone`. */
  prepare(action: Action, raw: Record<string, unknown>, tz: string | undefined): { args: Record<string, unknown>; resolved: Record<string, unknown>; timezone?: string } {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ShortcutError(400, "args must be an object");
    for (const k of Object.keys(raw)) if (!action.inputs.some((i) => i.name === k)) throw new ShortcutError(400, `${action.id} has no input "${k}"`);
    const zoned = action.inputs.some((i) => i.type === "date" || i.type === "period" || i.type === "time") || !action.builtin;
    if (tz !== undefined && !isTimezone(tz)) throw new ShortcutError(400, `timezone "${String(tz)}" is not an IANA zone`);
    if (zoned && !tz) throw new ShortcutError(400, "timezone is required (the operator's IANA zone, e.g. Asia/Seoul)");
    const now = this.now();
    const args: Record<string, unknown> = {};
    const resolved: Record<string, unknown> = {};
    for (const input of action.inputs) {
      let v = raw[input.name];
      if (v === "" || v === null) v = undefined;
      if (v === undefined) {
        if (input.required) throw new ShortcutError(400, `${input.label} is required`);
        continue;
      }
      args[input.name] = v;
      try {
        resolved[input.name] = resolveInput(input, v, tz ?? "UTC", now);
      } catch (e) {
        throw new ShortcutError(400, `${input.label}: ${(e as Error).message}`);
      }
    }
    // A time without its date has nothing to attach to.
    for (const input of action.inputs) {
      if (input.type !== "time" || resolved[input.name] === undefined) continue;
      const date = action.inputs.find((i) => i.type === "date" && resolved[i.name] !== undefined);
      if (!date) throw new ShortcutError(400, `${input.label} needs a date`);
      try {
        localInstant(resolved[date.name] as string, resolved[input.name] as string, tz!);
      } catch (e) {
        throw new ShortcutError(400, (e as Error).message);
      }
    }
    return { args, resolved, ...(zoned && tz ? { timezone: tz } : {}) };
  }

  // ---------------------------------------------------------------- execution

  private async execute(action: Action, args: Record<string, unknown>, tz: string | undefined, idempotencyKey?: string): Promise<{ result: RunResult; status?: "running"; callId?: number; taskId?: string; taskStartedAt?: number }> {
    if (action.id === "space/calc" && action.builtin) {
      try {
        const v = evaluate(String(args.expression));
        return { result: { kind: "value", value: v, text: format(v) } };
      } catch (e) {
        throw new Error(e instanceof CalcError ? e.message : String(e));
      }
    }
    if (action.id === "space/convert" && action.builtin) return { result: await this.convert(args) };
    if (action.id === "space/run-task" && action.builtin) return this.runTask(String(args.task));
    return this.callAction(action, args, tz, idempotencyKey);
  }

  private runTask(id: string): { result: RunResult; status: "running"; taskId: string; taskStartedAt: number } {
    const scheduler = this.opts.scheduler;
    const task = scheduler?.getTask(id);
    if (!scheduler || !task) throw new Error(`unknown task: ${id}`);
    // The scheduler's overlap rule: a task already running is not started twice.
    if (!scheduler.runNow(id)) throw new Error(`${task.app} · ${task.name} is already running`);
    const startedAt = scheduler.getTask(id)?.state.runningAt ?? this.now();
    return { status: "running", taskId: id, taskStartedAt: startedAt, result: { kind: "task", taskId: id, task: `${task.app} · ${task.name}`, startedAt: new Date(startedAt).toISOString(), status: "running" } };
  }

  private async callAction(action: Action, args: Record<string, unknown>, tz: string | undefined, idempotencyKey?: string): Promise<{ result: RunResult; callId?: number }> {
    const [app, capability] = action.id.split("/") as [string, string];
    const body = JSON.stringify({ ...args, ...(tz ? { timezone: tz } : {}), now: new Date(this.now()).toISOString(), ...(idempotencyKey ? { idempotencyKey } : {}) });
    const write = action.effect === "write";
    let status: number;
    let text: string;
    let callId: number | undefined;
    if (action.peer) {
      if (!this.opts.peers) throw new Error(`peer ${action.peer} is not connected`);
      let r: Awaited<ReturnType<ShortcutPeers["call"]>>;
      try {
        r = await this.opts.peers.call(action.peer, app, capability, body);
      } catch (e) {
        // The request may have reached the peer: for a write that is not a failure we can claim.
        if (write) throw new Uncertain(`no answer from ${action.peer}: ${(e as Error).message}; the write may have happened`);
        throw new Error(`${action.peer} unreachable: ${(e as Error).message}`);
      }
      ({ status, body: text, callId } = r);
      if (write && status >= 500 && status !== 503) throw new Uncertain(`${action.peer}/${app} answered ${status}; the write may have happened`, callId);
    } else {
      let r: CallResult;
      try {
        r = await this.opts.bus.call(OPERATOR, app, capability, { body, contentType: "application/json", accept: "application/json" });
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        const rec = (e as { record?: { id: number } }).record;
        // A timeout or a cut-off answer after the request went out leaves a write undecided; a refused connection does not.
        if (write && rec && !msg.startsWith("unreachable")) throw new Uncertain(`${msg}; the write may have happened`, rec.id);
        throw new Error(msg);
      }
      status = r.status;
      text = new TextDecoder().decode(r.body);
      callId = r.record.id;
    }
    let json: Record<string, unknown> | undefined;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = undefined;
    }
    if (status < 200 || status >= 300 || !json || json.ok === false) {
      const why = typeof json?.error === "string" ? json.error : text.slice(0, 300) || `HTTP ${status}`;
      throw new Error(`${app} answered ${status}: ${why}`);
    }
    return { result: normalize(action.result, json, app), ...(callId !== undefined ? { callId } : {}) };
  }

  private async convert(args: Record<string, unknown>): Promise<RunResult> {
    const amount = Number(args.amount);
    const from = String(args.from).toUpperCase();
    const to = String(args.to).toUpperCase();
    const r = await this.loadRates();
    const rate = (code: string) => (code === r.base ? 1 : r.rates[code]);
    const a = rate(from);
    const b = rate(to);
    if (!a) throw new Error(`no rate for ${from} from ${this.rates.app}`);
    if (!b) throw new Error(`no rate for ${to} from ${this.rates.app}`);
    const cross = b / a;
    const digits = currencyDigits(to);
    const value = Number((amount * cross).toFixed(digits));
    const text = value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
    return {
      kind: "value",
      value,
      text: `${text} ${to}`,
      unit: to,
      detail: `${amount.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${from} · 1 ${from} = ${Number(cross.toPrecision(6))} ${to}`,
      source: r.source ?? `${this.rates.app}/${this.rates.capability}`,
      ...(r.asOf ? { asOf: r.asOf } : {}),
      ...(r.stale ? { stale: true } : {}),
    };
  }

  private async loadRates(): Promise<Rates> {
    if (this.ratesCache && this.now() - this.ratesCache.at < RATES_TTL_MS) return this.ratesCache.rates;
    const { app, capability } = this.rates;
    let text: string;
    let status: number;
    if (this.opts.bus.capability(app, capability)) {
      const r = await this.opts.bus.call(OPERATOR, app, capability, { body: "{}", contentType: "application/json" });
      status = r.status;
      text = new TextDecoder().decode(r.body);
    } else {
      const peer = (this.opts.peers?.capabilities() ?? []).find((a) => a.app === app && a.provides.some((c) => c.name === capability));
      if (!peer || !this.opts.peers) throw new Error(`no ${app}/${capability} capability on this space or its peers`);
      ({ status, body: text } = await this.opts.peers.call(peer.peer, app, capability, "{}"));
    }
    const j = JSON.parse(text) as { ok?: boolean; base?: unknown; rates?: unknown; asOf?: unknown; source?: unknown; stale?: unknown; error?: unknown };
    if (status >= 300 || j.ok === false || typeof j.base !== "string" || !j.rates || typeof j.rates !== "object") throw new Error(`${app}/${capability} answered ${status}: ${typeof j.error === "string" ? j.error : "no rates"}`);
    const rates: Rates = {
      base: j.base.toUpperCase(),
      rates: Object.fromEntries(Object.entries(j.rates as Record<string, unknown>).filter(([, v]) => typeof v === "number" && v > 0 && Number.isFinite(v)) as [string, number][]),
      ...(typeof j.asOf === "string" ? { asOf: j.asOf } : {}),
      ...(typeof j.source === "string" ? { source: j.source } : {}),
      ...(j.stale === true ? { stale: true } : {}),
    };
    this.ratesCache = { at: this.now(), rates };
    return rates;
  }
}

/** A write whose outcome is not known: the request may have reached the provider. */
class Uncertain extends Error {
  constructor(
    message: string,
    readonly callId?: number,
  ) {
    super(message);
  }
}

function resolveInput(input: ActionInput, v: unknown, tz: string, now: number): unknown {
  switch (input.type) {
    case "number": {
      const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v.replace(/,/g, "")) : Number.NaN;
      if (!Number.isFinite(n)) throw new Error("must be a number");
      if (input.min !== undefined && n < input.min) throw new Error(`must be at least ${input.min}`);
      if (input.max !== undefined && n > input.max) throw new Error(`must be at most ${input.max}`);
      return n;
    }
    case "date":
      if (typeof v !== "string") throw new Error("must be a date");
      return resolveDate(v, tz, now);
    case "period":
      if (typeof v !== "string") throw new Error("must be a period");
      return resolvePeriod(v, tz, now);
    case "time":
      if (!isTime(v)) throw new Error("must be HH:MM");
      return v;
    case "choice":
    case "task":
      if (typeof v !== "string" || !input.options?.some((o) => o.value === v)) throw new Error("is not one of the choices");
      return v;
    default: {
      if (typeof v !== "string") throw new Error("must be text");
      const s = v.trim();
      if (s.length > 2000) throw new Error("is longer than 2000 characters");
      if (input.required && !s) throw new Error("is required");
      return s;
    }
  }
}

/** The provider's answer, held to the result kind the action declared; anything else is dropped. */
export function normalize(kind: ActionSpec["result"], j: Record<string, unknown>, app: string): RunResult {
  const str = (v: unknown, max = 500) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
  const url = (v: unknown) => {
    const s = str(v, 2000);
    return s && /^https?:\/\//i.test(s) ? s : undefined;
  };
  const instant = (v: unknown) => {
    const s = str(v, 40);
    return s && /(Z|[+-]\d{2}:?\d{2})$/.test(s) && Number.isFinite(Date.parse(s)) ? new Date(s).toISOString() : undefined;
  };
  const items = Array.isArray(j.items) ? (j.items as unknown[]).filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null) : undefined;
  if (kind === "value") {
    const v = j.value;
    if (typeof v !== "number" && typeof v !== "string") throw new Error(`${app} answered no value`);
    return { kind: "value", value: v, text: str(j.text) ?? String(v), ...opt("unit", str(j.unit, 20)), ...opt("detail", str(j.detail)), ...opt("source", str(j.source, 200)), ...opt("asOf", instant(j.asOf)), ...(j.stale === true ? { stale: true } : {}) };
  }
  if (!items) throw new Error(`${app} answered no items`);
  if (kind === "receipt") {
    const out: ReceiptItem[] = items.slice(0, MAX_ITEMS).map((i) => {
      const id = typeof i.id === "number" || typeof i.id === "string" ? String(i.id) : undefined;
      const title = str(i.title);
      if (!id || !title) throw new Error(`${app} answered an item without id or title`);
      return { id, title, ...opt("url", url(i.url)), ...opt("detail", str(i.detail)) };
    });
    if (!out.length) throw new Error(`${app} created nothing`);
    return { kind: "receipt", items: out };
  }
  const list: ListItem[] = items.slice(0, MAX_ITEMS).flatMap((i) => {
    const title = str(i.title);
    if (!title) return [];
    return [{ title, ...opt("url", url(i.url)), ...opt("source", str(i.source, 200)), ...opt("at", instant(i.at)), ...opt("date", isDate(i.date) ? (i.date as string) : undefined), ...opt("time", isTime(i.time) ? (i.time as string) : undefined), ...opt("timezone", isTimezone(i.timezone) ? (i.timezone as string) : undefined), ...opt("detail", str(i.detail, 1000)), ...opt("tag", str(i.tag, 60)) }];
  });
  return { kind: "list", items: list, ...opt("asOf", instant(j.asOf)), ...(typeof j.total === "number" ? { total: j.total } : {}) };
}

function opt<K extends string, V>(k: K, v: V | undefined): { [P in K]?: V } {
  return (v === undefined ? {} : { [k]: v }) as { [P in K]?: V };
}

function currencyDigits(code: string): number {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

// ---------------------------------------------------------------- built-ins and slots

const CALC: ActionSpec = {
  title: "Calculator",
  description: "Arithmetic: + - × ÷ ^ %, parentheses. Shown as you type.",
  keywords: ["calc", "calculate", "math"],
  effect: "read",
  result: "value",
  template: "calc",
  inputs: [{ name: "expression", type: "text", label: "Expression", required: true, query: true }],
  i18n: { zh: { title: "计算器", description: "四则运算、乘方、百分号和括号，边输入边出结果。", keywords: ["计算", "算"], inputs: { expression: "算式" } } },
};

const CONVERT: ActionSpec = {
  title: "Convert currency",
  description: "Convert an amount with the rates provider's latest quote. Type “100 USD to CNY”.",
  keywords: ["convert", "currency", "fx", "exchange", "rate"],
  effect: "read",
  result: "value",
  template: "convert",
  inputs: [
    { name: "amount", type: "number", label: "Amount", required: true, default: 100 },
    { name: "from", type: "text", label: "From", required: true, default: "USD" },
    { name: "to", type: "text", label: "To", required: true, default: "CNY" },
  ],
  i18n: { zh: { title: "汇率换算", description: "按汇率服务的最新报价换算金额，可直接输入「100 美元 换 人民币」。", keywords: ["汇率", "换算", "兑换"], inputs: { amount: "金额", from: "从", to: "到" } } },
};

const RUN_TASK: ActionSpec = {
  title: "Run task",
  description: "Start a scheduler task now and follow its run.",
  keywords: ["run", "task", "job"],
  effect: "run",
  result: "task",
  template: "run-task",
  inputs: [{ name: "task", type: "task", label: "Task", required: true }],
  i18n: { zh: { title: "运行任务", description: "立刻运行一个定时任务并查看这次运行。", keywords: ["运行", "任务", "执行"], inputs: { task: "任务" } } },
};

const SLOTS: Record<"news" | "calendar" | "todo", { title: string; zh: string; needs: string }> = {
  news: { title: "Financial news", zh: "财经新闻", needs: "an app action with template: news (finance-news-feed)" },
  calendar: { title: "Calendar", zh: "日历", needs: "an app action with template: calendar (ai-calendar)" },
  todo: { title: "Create todo", zh: "新建待办", needs: "an app action with template: todo (ai-todo)" },
};

function missingTemplate(t: Template): Action {
  const slot = SLOTS[t as keyof typeof SLOTS];
  return {
    id: `space/${t}`,
    app: OPERATOR,
    builtin: true,
    title: slot.title,
    keywords: [],
    effect: t === "todo" ? "write" : "read",
    result: TEMPLATE_RESULTS[t]!,
    template: t,
    inputs: [],
    i18n: { zh: { title: slot.zh } },
    available: false,
    reason: `not configured: needs ${slot.needs}`,
  };
}
