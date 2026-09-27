import { assertTriggerEvent, matchingTriggers } from "./events.ts";
import type { Manifest, ManifestTask } from "./manifest.ts";
import { assertSchedule, nextRunAt } from "./schedule.ts";
import type { Store } from "./store.ts";
import { type RunContext, type RunResult, runTarget } from "./targets.ts";
import {
  DEFAULT_TIMEOUT_MS,
  type EventInput,
  type EventTrigger,
  type Run,
  type RunTrigger,
  type Schedule,
  type SpaceEvent,
  type Task,
  type TaskCreate,
  type TaskPatch,
  type TaskState,
  effectiveEnabled,
  effectiveSchedule,
  effectiveTarget,
  assertTaskModel,
  taskSupportsModel,
} from "./types.ts";

/**
 * Scheduler engine.
 *
 * One timer, aimed at the earliest due task and clamped to MAX_TIMER_DELAY_MS so
 * the loop recovers quickly after a suspend or clock jump. A tick launches due
 * tasks up to the concurrency limit without awaiting them; each finished run
 * applies its result and re-ticks so waiting tasks get the freed slot.
 *
 * Rules:
 * - a task never overlaps itself (runningAt marker);
 * - every run has a hard timeout (AbortSignal);
 * - errors back off 30s → 1m → 5m → 15m → 60m, reset on success;
 * - a tick with nothing due only fills in missing nextRunAt values, it never
 *   advances a past-due one (that would silently skip a run);
 * - stale running markers are cleared on start and after STUCK_RUN_MS, and the
 *   run they belonged to is recorded as interrupted, so a process that went away
 *   mid-run leaves a trace instead of nothing.
 *
 * Shutdown: `drain` stops the clock, gives the runs in flight a grace period to
 * finish, and aborts whatever is still going, so those runs reach the history as
 * failures rather than disappearing with the process.
 *
 * Events: `publish` stores the event and queues it on every enabled task whose
 * triggers match (`state.pending`, due after the trigger's debounce). A task is
 * due when its clock or its pending events say so; whichever launch comes first
 * takes the pending events along, so a burst of events, or events arriving
 * while the task runs, produce one more run, never one per event. A run that
 * fails with events aboard puts them back in front of the queue (redelivery),
 * due after the error backoff, up to MAX_EVENT_REDELIVERIES times; then they
 * are dropped and the drop is logged. `onPublish` lets another service (the bus)
 * see every stored event.
 */

const MAX_TIMER_DELAY_MS = 60_000;
const STUCK_RUN_MS = 2 * 3_600_000;
const ERROR_BACKOFF_MS = [30_000, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
/** How long an aborted run may take to unwind before the drain gives up on it. */
const ABORT_GRACE_MS = 5_000;
/** Recorded for a run the process could not finish: a restart, or a drain that ran out of grace. */
export const INTERRUPTED = "interrupted: ai-space stopped while the task was running";
/** Failed runs an event rides through before it is dropped from the task's queue. */
export const MAX_EVENT_REDELIVERIES = 5;

export type Runner = (task: Task, ctx: RunContext) => Promise<RunResult>;

export type SchedulerOptions = {
  store: Store;
  now?: () => number;
  runner?: Runner;
  maxConcurrency?: number;
  log?: (message: string) => void;
  /** Extra environment for an app's command/agent runs, e.g. the variables storage provisioned. */
  envFor?: (app: string) => Promise<Record<string, string>>;
  /** Called after every run is recorded, with the task's updated state and the state before the run. */
  onFinish?: (event: { task: Task; run: Run; before: TaskState }) => void;
  /** Called with every stored event, after the tasks it matched were queued (the bus delivers it to subscriptions). */
  onPublish?: (event: SpaceEvent) => void;
};

export type SyncSummary = { app: string; created: string[]; updated: string[]; orphaned: string[] };

export class Scheduler {
  private readonly store: Store;
  private readonly now: () => number;
  private readonly runner: Runner;
  private readonly maxConcurrency: number;
  private readonly log: (message: string) => void;
  private readonly envFor?: (app: string) => Promise<Record<string, string>>;
  private readonly onFinish?: SchedulerOptions["onFinish"];
  private readonly onPublish?: SchedulerOptions["onPublish"];
  private readonly appDirs = new Map<string, string>();
  /** Apps whose tasks ai-space itself contributes (`space`): a workspace sync must not forget them. */
  private readonly builtin = new Set<string>();
  private readonly inflight = new Map<string, { promise: Promise<void>; controller: AbortController }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private ticking = false;

  constructor(opts: SchedulerOptions) {
    this.store = opts.store;
    this.now = opts.now ?? Date.now;
    this.runner = opts.runner ?? ((task, ctx) => runTarget(task.target, ctx));
    this.maxConcurrency = Math.max(1, opts.maxConcurrency ?? 2);
    this.log = opts.log ?? ((m) => console.log(`[scheduler] ${m}`));
    this.envFor = opts.envFor;
    this.onFinish = opts.onFinish;
    this.onPublish = opts.onPublish;
  }

  // ---------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const now = this.now();
    let stale = 0;
    for (const task of this.store.listTasks()) {
      let changed = false;
      if (task.state.runningAt !== undefined) {
        this.recordInterrupted(task, now);
        stale++;
        changed = true;
      }
      if (this.fillNextRun(task, now)) changed = true;
      if (changed) this.store.saveState(task.id, task.state, now);
    }
    if (stale) this.log(`${stale} run(s) were interrupted by a previous process and are recorded as such`);
    const tasks = this.store.listTasks();
    this.log(`started with ${tasks.length} task(s), ${tasks.filter(effectiveEnabled).length} enabled`);
    await this.tick();
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Resolves once no run is in flight. Mostly for tests and graceful shutdown. */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight.values()].map((r) => r.promise));
  }

  /**
   * Shut the scheduler down without losing what is running: the clock stops, the
   * runs in flight get `graceMs` to finish on their own, and the ones still going
   * then are aborted so their failure is recorded. Returns what happened, for the log.
   */
  async drain(graceMs: number): Promise<{ finished: number; aborted: number }> {
    this.stop();
    const started = this.inflight.size;
    if (started && graceMs > 0) await Promise.race([this.idle(), sleep(graceMs)]);
    const left = [...this.inflight.values()];
    if (left.length) {
      this.log(`aborting ${left.length} run(s) still going after ${Math.round(graceMs / 1000)}s`);
      for (const r of left) r.controller.abort(new Error("ai-space is shutting down"));
      await Promise.race([this.idle(), sleep(ABORT_GRACE_MS)]);
    }
    return { finished: started - left.length, aborted: left.length };
  }

  /**
   * A run whose process went away: `finish` never ran, so without this the run leaves
   * no record at all and the task simply runs again. Recorded as a failure, but without
   * the error backoff - the run did not fail, it was cut off.
   */
  private recordInterrupted(task: Task, now: number): void {
    const startedAt = task.state.runningAt ?? now;
    const state = task.state;
    const before = { ...state };
    state.runningAt = undefined;
    state.lastRunAt = startedAt;
    state.lastStatus = "error";
    state.lastError = INTERRUPTED;
    state.lastDurationMs = Math.max(0, now - startedAt);
    const run = this.store.addRun({ taskId: task.id, startedAt, endedAt: now, status: "error", error: INTERRUPTED, trigger: state.runningTrigger ?? "schedule" });
    state.runningTrigger = undefined;
    this.log(`task ${task.app}/${task.name}: interrupted after ${state.lastDurationMs}ms`);
    if (this.onFinish) {
      try {
        this.onFinish({ task, run, before });
      } catch (e) {
        this.log(`onFinish hook failed: ${(e as Error).message ?? String(e)}`);
      }
    }
  }

  /** Tasks of an app with a run in flight right now; an uninstall refuses to pull the ground from under them. */
  runningTasks(app: string): string[] {
    const names: string[] = [];
    for (const id of this.inflight.keys()) {
      const task = this.store.getTask(id);
      if (task?.app === app) names.push(task.name);
    }
    return names.sort();
  }

  appDir(app: string): string | undefined {
    return this.appDirs.get(app);
  }

  /** Every app a manifest sync has registered, sorted. */
  apps(): string[] {
    return [...this.appDirs.keys()].sort();
  }

  /**
   * Apps the store still runs manifest tasks for although no sync in this
   * process has seen them: their directory disappeared while ai-space was
   * down, so boot never registered them and their tasks kept firing. Boot
   * and the workspace sync forget them.
   */
  leftovers(): string[] {
    const out = new Set<string>();
    for (const t of this.store.listTasks()) if (t.source === "manifest" && !t.orphaned && !this.appDirs.has(t.app) && !this.builtin.has(t.app)) out.add(t.app);
    return [...out].sort();
  }

  /** Sync a manifest ai-space itself owns; `forget` ignores the app from then on. */
  syncBuiltin(manifest: Manifest, extra: ManifestTask[] = []): SyncSummary {
    this.builtin.add(manifest.app);
    return this.syncManifest(manifest, extra);
  }

  isBuiltin(app: string): boolean {
    return this.builtin.has(app);
  }

  /**
   * Drop an app whose directory is gone: its manifest tasks become orphaned (kept in
   * the store with their run history) and the per-app sync route stops knowing it.
   */
  forget(app: string): SyncSummary | undefined {
    if (this.builtin.has(app)) return undefined;
    // A leftover (see `leftovers`) has no directory on record; an empty one is fine, it is deleted right after.
    const dir = this.appDirs.get(app);
    if (dir === undefined && !this.leftovers().includes(app)) return undefined;
    const summary = this.syncManifest({ app, dir: dir ?? "", spec: 1, status: "archived", agents: [], widgets: [], tasks: [] });
    this.appDirs.delete(app);
    return summary;
  }

  // ---------------------------------------------------------------- tick

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      const tasks = this.store.listTasks();
      let changed = false;
      for (const task of tasks) {
        if (task.state.runningAt !== undefined && !this.inflight.has(task.id) && now - task.state.runningAt > STUCK_RUN_MS) {
          this.log(`task ${task.app}/${task.name}: clearing stuck running marker`);
          task.state.runningAt = undefined;
          changed = true;
        }
        if (this.fillNextRun(task, now)) changed = true;
        if (changed) this.store.saveState(task.id, task.state, now);
        changed = false;
      }

      const due = tasks
        .filter((t) => effectiveEnabled(t) && t.state.runningAt === undefined && dueAt(t) <= now)
        .sort((a, b) => dueAt(a) - dueAt(b));
      const slots = this.maxConcurrency - this.inflight.size;
      for (const task of due.slice(0, Math.max(0, slots))) {
        const byClock = task.state.nextRunAt !== undefined && task.state.nextRunAt <= now;
        this.launch(task, byClock ? "schedule" : "event");
      }
    } finally {
      this.ticking = false;
      this.armTimer();
    }
  }

  private armTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.started) return;
    const now = this.now();
    let nextAt: number | undefined;
    for (const t of this.store.listTasks()) {
      if (!effectiveEnabled(t) || t.state.runningAt !== undefined) continue;
      const at = dueAt(t);
      if (at === Number.POSITIVE_INFINITY) continue;
      if (nextAt === undefined || at < nextAt) nextAt = at;
    }
    if (nextAt === undefined) return;
    const delay = Math.min(Math.max(nextAt - now, 0), MAX_TIMER_DELAY_MS);
    this.timer = setTimeout(() => void this.tick().catch((e) => this.log(`tick failed: ${String(e)}`)), delay);
    if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref();
  }

  /** Give an enabled task a nextRunAt if it has none. Never moves an existing one. */
  private fillNextRun(task: Task, now: number): boolean {
    if (!effectiveEnabled(task)) {
      if (task.state.nextRunAt !== undefined || task.state.pending) {
        task.state.nextRunAt = undefined;
        task.state.pending = undefined;
        return true;
      }
      return false;
    }
    if (task.state.nextRunAt !== undefined) return false;
    // A task that has never run (or was just re-enabled) is due right away for
    // interval schedules; cron and one-shot wait for their natural moment.
    const schedule = effectiveSchedule(task);
    const next = schedule.kind === "every" && task.state.lastRunAt === undefined ? now : nextRunAt(schedule, now);
    if (next === undefined) return false;
    task.state.nextRunAt = next;
    return true;
  }

  // ---------------------------------------------------------------- execution

  /** Start one run. Pending events, if any, go along whatever the trigger, and are cleared. */
  private launch(task: Task, trigger: RunTrigger): void {
    const startedAt = this.now();
    const events = this.store.getEvents(task.state.pending?.eventIds ?? []);
    const attempt = task.state.pending?.attempt ?? 0;
    task.state.pending = undefined;
    task.state.runningAt = startedAt;
    task.state.runningTrigger = trigger;
    task.state.lastError = undefined;
    this.store.saveState(task.id, task.state, startedAt);
    this.log(`task ${task.app}/${task.name}: started (${trigger}${events.length ? `, ${events.length} event(s)` : ""})`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), task.timeoutMs);
    const env = this.envFor ? this.envFor(task.app) : Promise.resolve(undefined);
    const p = env
      .then((extra) => this.runner({ ...task, target: effectiveTarget(task) }, { appDir: this.appDirs.get(task.app), env: extra, signal: controller.signal, trigger, events }))
      .catch((e): RunResult => ({ status: "error", error: (e as Error).message ?? String(e) }))
      .then((result) => {
        clearTimeout(timeout);
        this.finish(task.id, startedAt, result, trigger, events, attempt);
      })
      .finally(() => {
        this.inflight.delete(task.id);
        void this.tick().catch((e) => this.log(`tick failed: ${String(e)}`));
      });
    this.inflight.set(task.id, { promise: p, controller });
  }

  private finish(taskId: string, startedAt: number, result: RunResult, trigger: RunTrigger, events: SpaceEvent[], attempt = 0): void {
    const endedAt = this.now();
    const task = this.store.getTask(taskId);
    if (!task) return; // deleted while running
    const before = { ...task.state };
    const s = task.state;
    s.runningAt = undefined;
    s.runningTrigger = undefined;
    s.lastRunAt = startedAt;
    s.lastStatus = result.status;
    s.lastError = result.error;
    s.lastDurationMs = Math.max(0, endedAt - startedAt);
    s.consecutiveErrors = result.status === "error" ? s.consecutiveErrors + 1 : 0;

    const schedule = effectiveSchedule(task);
    const natural = effectiveEnabled(task) ? nextRunAt(schedule, endedAt) : undefined;
    const backoff = ERROR_BACKOFF_MS[Math.min(s.consecutiveErrors - 1, ERROR_BACKOFF_MS.length - 1)] ?? 0;
    if (result.status === "error" && natural !== undefined) {
      s.nextRunAt = Math.max(natural, endedAt + backoff);
    } else {
      s.nextRunAt = natural;
    }
    // Redelivery: a failed run's events go back in front of whatever queued meanwhile, due after
    // the backoff, until they have failed too often; a disabled task drops them like any pending.
    if (result.status === "error" && events.length && effectiveEnabled(task)) {
      const ids = events.map((e) => e.id);
      if (attempt + 1 < MAX_EVENT_REDELIVERIES) {
        const later = s.pending?.eventIds.filter((id) => !ids.includes(id)) ?? [];
        s.pending = { eventIds: [...ids, ...later], dueAt: Math.max(s.pending?.dueAt ?? 0, endedAt + backoff), attempt: attempt + 1 };
      } else {
        this.log(`task ${task.app}/${task.name}: dropping ${ids.length} event(s) after ${attempt + 1} failed deliveries`);
      }
    }

    this.store.saveState(task.id, s, endedAt);
    const run = this.store.addRun({
      taskId: task.id,
      startedAt,
      endedAt,
      status: result.status,
      error: result.error,
      output: result.output,
      trigger,
      ...(events.length ? { eventIds: events.map((e) => e.id) } : {}),
    });
    const summary = result.status === "ok" ? "ok" : `${result.status}: ${result.error ?? ""}`;
    this.log(`task ${task.app}/${task.name}: ${summary} in ${s.lastDurationMs}ms`);
    if (this.onFinish) {
      try {
        this.onFinish({ task, run, before });
      } catch (e) {
        this.log(`onFinish hook failed: ${(e as Error).message ?? String(e)}`);
      }
    }
  }

  /** Force a run now. Returns false when the task is already running. */
  runNow(id: string): boolean {
    const task = this.store.getTask(id);
    if (!task) throw new Error(`unknown task: ${id}`);
    if (task.state.runningAt !== undefined || this.inflight.has(id)) return false;
    this.launch(task, "manual");
    return true;
  }

  // ---------------------------------------------------------------- events

  /**
   * Publish an event: store it, queue it on every enabled task with a matching
   * trigger, and tick. Returns the stored event and the tasks it reached. A
   * disabled or orphaned task is not queued; the event stays in the history.
   */
  publish(input: EventInput): { event: SpaceEvent; matched: Task[] } {
    const now = this.now();
    const event = this.store.addEvent(input, input.at ?? now);
    const matched: Task[] = [];
    for (const task of this.store.listTasks()) {
      if (!effectiveEnabled(task)) continue;
      const hits = matchingTriggers(task.triggers, event);
      if (!hits.length) continue;
      const debounce = Math.max(...hits.map((t) => t.debounceMs ?? 0));
      const pending = task.state.pending ?? { eventIds: [], dueAt: now };
      pending.eventIds.push(event.id);
      // The quiet period restarts with every event; an earlier, shorter due time never moves later than that.
      pending.dueAt = Math.max(pending.dueAt, now + debounce);
      task.state.pending = pending;
      this.store.saveState(task.id, task.state, now);
      matched.push(task);
    }
    this.log(`event ${event.name} #${event.id}: ${matched.length ? matched.map((t) => `${t.app}/${t.name}`).join(", ") : "no task"}`);
    if (matched.length) void this.tick().catch((e) => this.log(`tick failed: ${String(e)}`));
    if (this.onPublish) {
      try {
        this.onPublish(event);
      } catch (e) {
        this.log(`onPublish hook failed: ${(e as Error).message ?? String(e)}`);
      }
    }
    return { event, matched };
  }

  // ---------------------------------------------------------------- CRUD

  addTask(input: TaskCreate): Task {
    if (input.target.kind !== "agent" && input.target.model !== undefined) assertTaskModel(input.target.model);
    assertSchedule(input.schedule);
    assertTriggers(input.triggers);
    if (input.schedule.kind === "manual" && !input.triggers?.length) throw new Error(`task ${input.app}/${input.name} has neither a schedule nor triggers`);
    if (this.store.findTask(input.app, input.name)) throw new Error(`task ${input.app}/${input.name} already exists`);
    const now = this.now();
    const task: Task = {
      id: crypto.randomUUID(),
      app: input.app,
      name: input.name,
      description: input.description,
      schedule: withAnchor(input.schedule, now),
      target: input.target,
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      enabled: input.enabled ?? true,
      overrides: {},
      source: input.source ?? "api",
      orphaned: false,
      ...(input.notify ? { notify: input.notify } : {}),
      ...(input.triggers?.length ? { triggers: input.triggers } : {}),
      state: { consecutiveErrors: 0 },
      createdAt: now,
      updatedAt: now,
    };
    this.fillNextRun(task, now);
    this.store.saveTask(task);
    this.armTimer();
    return task;
  }

  /**
   * Operator patch. Manifest tasks keep the manifest as their base and record
   * the patch as an override (null clears it); API tasks are edited in place.
   */
  patchTask(id: string, patch: TaskPatch): Task {
    const task = this.store.getTask(id);
    if (!task) throw new Error(`unknown task: ${id}`);
    const now = this.now();
    const before = JSON.stringify(effectiveSchedule(task));
    if (patch.schedule) assertSchedule(patch.schedule);
    if (patch.model !== undefined && patch.model !== null) {
      assertTaskModel(patch.model);
      if (!taskSupportsModel(task)) throw new Error("this task has not opted in to model selection");
    }
    if (patch.model === null) delete task.overrides.model;
    else if (patch.model !== undefined) task.overrides.model = patch.model;

    if (task.source === "manifest") {
      if (patch.enabled === null) delete task.overrides.enabled;
      else if (patch.enabled !== undefined) task.overrides.enabled = patch.enabled;
      if (patch.schedule === null) delete task.overrides.schedule;
      else if (patch.schedule) task.overrides.schedule = withAnchor(patch.schedule, now);
    } else {
      if (typeof patch.enabled === "boolean") task.enabled = patch.enabled;
      if (patch.schedule) task.schedule = withAnchor(patch.schedule, now);
    }

    if (JSON.stringify(effectiveSchedule(task)) !== before) task.state.nextRunAt = undefined;
    this.fillNextRun(task, now);
    task.updatedAt = now;
    this.store.saveTask(task);
    this.armTimer();
    return task;
  }

  removeTask(id: string): boolean {
    const task = this.store.getTask(id);
    if (!task) return false;
    if (task.source === "manifest" && !task.orphaned) {
      throw new Error("manifest tasks are removed by deleting them from space.yaml and re-syncing");
    }
    const removed = this.store.deleteTask(id);
    this.armTimer();
    return removed;
  }

  // ---------------------------------------------------------------- manifest sync

  /**
   * What the scheduler should see of a manifest: a paused or archived app keeps its
   * storage and stays registered, but its tasks stop (they become orphaned on sync).
   */
  static schedulable(manifest: Manifest): Manifest {
    return manifest.status === "active" ? manifest : { ...manifest, tasks: [] };
  }

  /**
   * Idempotent upsert of an app's manifest tasks; unlisted manifest tasks become orphaned.
   * `extra` are tasks other services contribute for the app (the backup task); they are
   * treated exactly like manifest tasks.
   */
  syncManifest(manifest: Manifest, extra: ManifestTask[] = []): SyncSummary {
    const now = this.now();
    this.appDirs.set(manifest.app, manifest.dir);
    const summary: SyncSummary = { app: manifest.app, created: [], updated: [], orphaned: [] };
    const seen = new Set<string>();

    for (const mt of [...manifest.tasks, ...extra]) {
      if (seen.has(mt.name)) throw new Error(`${manifest.app}: task "${mt.name}" is declared twice`);
      seen.add(mt.name);
      const existing = this.store.findTask(manifest.app, mt.name);
      if (!existing) {
        this.addTask({ app: manifest.app, name: mt.name, description: mt.description, schedule: mt.schedule, target: mt.target, timeoutMs: mt.timeoutMs, enabled: mt.enabled, source: "manifest", notify: mt.notify, triggers: mt.triggers });
        summary.created.push(mt.name);
        continue;
      }
      const scheduleChanged = JSON.stringify(stripAnchor(existing.schedule)) !== JSON.stringify(stripAnchor(mt.schedule));
      const changed =
        scheduleChanged ||
        existing.orphaned ||
        existing.source !== "manifest" ||
        existing.description !== mt.description ||
        existing.enabled !== mt.enabled ||
        existing.timeoutMs !== mt.timeoutMs ||
        JSON.stringify(existing.target) !== JSON.stringify(mt.target) ||
        JSON.stringify(existing.notify ?? null) !== JSON.stringify(mt.notify ?? null) ||
        JSON.stringify(existing.triggers ?? null) !== JSON.stringify(mt.triggers?.length ? mt.triggers : null);
      if (!changed) continue;
      existing.description = mt.description;
      existing.target = mt.target;
      existing.timeoutMs = mt.timeoutMs;
      existing.notify = mt.notify;
      existing.triggers = mt.triggers?.length ? mt.triggers : undefined;
      existing.enabled = mt.enabled;
      existing.source = "manifest";
      existing.orphaned = false;
      if (scheduleChanged) {
        existing.schedule = withAnchor(mt.schedule, now);
        if (!existing.overrides.schedule) existing.state.nextRunAt = undefined;
      }
      this.fillNextRun(existing, now);
      existing.updatedAt = now;
      this.store.saveTask(existing);
      summary.updated.push(mt.name);
    }

    for (const t of this.store.listTasks()) {
      if (t.app !== manifest.app || t.source !== "manifest" || seen.has(t.name) || t.orphaned) continue;
      t.orphaned = true;
      t.state.nextRunAt = undefined;
      t.state.pending = undefined;
      t.updatedAt = now;
      this.store.saveTask(t);
      summary.orphaned.push(t.name);
    }

    this.log(`synced ${manifest.app}: +${summary.created.length} ~${summary.updated.length} -${summary.orphaned.length}`);
    this.armTimer();
    return summary;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t === "object" && "unref" in t) t.unref();
  });
}

/** When the task next wants to run: its clock or its pending events, whichever is earlier. */
function dueAt(task: Task): number {
  return Math.min(task.state.nextRunAt ?? Number.POSITIVE_INFINITY, task.state.pending?.dueAt ?? Number.POSITIVE_INFINITY);
}

function assertTriggers(triggers: EventTrigger[] | undefined): void {
  for (const t of triggers ?? []) {
    assertTriggerEvent(t.event);
    if (t.debounceMs !== undefined && (!Number.isFinite(t.debounceMs) || t.debounceMs < 0)) throw new Error(`invalid debounce: ${t.debounceMs}`);
  }
}

function withAnchor(schedule: Schedule, now: number): Schedule {
  return schedule.kind === "every" ? { ...schedule, anchorMs: schedule.anchorMs ?? now } : schedule;
}

function stripAnchor(schedule: Schedule): Schedule {
  if (schedule.kind !== "every") return schedule;
  const { anchorMs: _, ...rest } = schedule;
  return rest;
}
