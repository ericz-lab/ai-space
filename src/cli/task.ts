import { need, noMore, parseArgs, parseCount, parseDuration } from "./args.ts";
import { type RunView, type TaskView, confirm, iso, listTasks, readBody, resolveTask, scheduleText, targetText, taskRef } from "./common.ts";
import { ago, duration, until, when } from "./output.ts";
import { type Ctx, type Noun, UsageError } from "./types.ts";

/** `space task`: the scheduler's tasks. A task is `<app>/<name>`, a unique bare name, or its id. */

const ls = async (ctx: Ctx, argv: string[]) => {
  const { flags, positional } = parseArgs(argv, { app: { kind: "value" }, failing: { kind: "bool" }, all: { kind: "bool" } });
  noMore(positional, 0);
  const c = await ctx.client();
  let tasks = await listTasks(c);
  if (flags.app) tasks = tasks.filter((t) => t.app === flags.app);
  if (flags.failing) tasks = tasks.filter((t) => t.state.lastStatus === "error");
  if (!flags.all) tasks = tasks.filter((t) => !t.orphaned);
  if (ctx.flags.json) return ctx.print.data({ ok: true, tasks }), 0;
  const now = Date.now();
  ctx.print.table(tasks, [
    { title: "task", get: taskRef },
    { title: "schedule", get: (t) => scheduleText(t.schedule) + (t.triggers.length ? ` +${t.triggers.length} trigger${t.triggers.length > 1 ? "s" : ""}` : "") },
    { title: "on", get: (t) => (t.orphaned ? "orphaned" : t.enabled ? "yes" : "no") },
    { title: "last run", get: (t) => (t.state.runningAt ? "running" : t.state.lastRunAt ? ago(t.state.lastRunAt, now) : "") },
    { title: "status", get: (t) => (t.state.runningAt ? "" : (t.state.lastStatus ?? "")) + (t.state.consecutiveErrors > 1 ? ` ×${t.state.consecutiveErrors}` : "") },
    { title: "next", get: (t) => until(t.state.nextRunAt, now) },
  ]);
  return 0;
};

const show = async (ctx: Ctx, argv: string[]) => {
  const { positional } = parseArgs(argv, {});
  const ref = need(positional, 0, "TASK");
  noMore(positional, 1);
  const c = await ctx.client();
  const task = await resolveTask(c, ref);
  const runs = (await c.get<{ runs: RunView[] }>(`/api/tasks/${task.id}/runs?limit=5`)).runs;
  if (ctx.flags.json) return ctx.print.data({ ok: true, task, runs }), 0;
  const now = Date.now();
  ctx.print.kv([
    ["task", taskRef(task)],
    ["id", task.id],
    ["description", task.description],
    ["source", task.source + (task.orphaned ? " (orphaned: no longer in the manifest)" : "")],
    ["enabled", task.enabled],
    ["schedule", scheduleText(task.schedule)],
    ["triggers", task.triggers.map((t) => t.event).join(", ")],
    ["target", targetText(task.target)],
    ["timeout", task.timeoutMs ? duration(task.timeoutMs) : ""],
    ["next run", task.state.nextRunAt ? `${when(task.state.nextRunAt)} (${until(task.state.nextRunAt, now)})` : ""],
    ["running since", task.state.runningAt ? ago(task.state.runningAt, now) : ""],
    ["last run", task.state.lastRunAt ? `${when(task.state.lastRunAt)} (${ago(task.state.lastRunAt, now)}) ${task.state.lastStatus ?? ""} ${duration(task.state.lastDurationMs)}`.trim() : ""],
    ["last error", task.state.lastError],
    ["failures", task.state.consecutiveErrors > 0 ? `${task.state.consecutiveErrors} in a row` : ""],
  ]);
  if (runs.length) {
    ctx.print.line("");
    ctx.print.table(runs, runColumns(now));
  }
  return 0;
};

function runColumns(now: number) {
  return [
    { title: "started", get: (r: RunView) => `${when(iso(r.startedAt))} (${ago(iso(r.startedAt), now)})` },
    { title: "took", get: (r: RunView) => duration(Number(new Date(r.endedAt)) - Number(new Date(r.startedAt))) },
    { title: "status", get: (r: RunView) => r.status },
    { title: "trigger", get: (r: RunView) => r.trigger },
    { title: "error", get: (r: RunView) => (r.error ?? "").slice(0, 100) },
  ];
}

const runs = async (ctx: Ctx, argv: string[]) => {
  const { flags, positional } = parseArgs(argv, { limit: { kind: "value", alias: "n" }, output: { kind: "bool", alias: "o" } });
  const ref = need(positional, 0, "TASK");
  noMore(positional, 1);
  const c = await ctx.client();
  const task = await resolveTask(c, ref);
  const list = (await c.get<{ runs: RunView[] }>(`/api/tasks/${task.id}/runs?limit=${parseCount(flags.limit, 20, "--limit")}`)).runs;
  if (ctx.flags.json) return ctx.print.data({ ok: true, runs: list }), 0;
  const now = Date.now();
  if (flags.output) {
    for (const r of list) {
      ctx.print.line(`── ${when(iso(r.startedAt))} ${r.status} ${r.trigger}${r.error ? ` · ${r.error}` : ""}`);
      if (r.output) ctx.print.line(r.output.replace(/\s+$/, ""));
    }
    return 0;
  }
  ctx.print.table(list, runColumns(now), `no runs of ${taskRef(task)} yet`);
  return 0;
};

const runNow = async (ctx: Ctx, argv: string[]) => {
  const { flags, positional } = parseArgs(argv, { wait: { kind: "bool", alias: "w" }, timeout: { kind: "value" } });
  const ref = need(positional, 0, "TASK");
  noMore(positional, 1);
  const c = await ctx.client();
  const task = await resolveTask(c, ref);
  const before = Date.now();
  const res = await c.post<{ started: boolean; task: TaskView }>(`/api/tasks/${task.id}/run`, undefined, { accept: [409] });
  if (!res.started) {
    if (ctx.flags.json) ctx.print.data(res);
    else ctx.io.err(`${taskRef(task)}: not started (already running, or disabled)`);
    return 1;
  }
  if (!flags.wait) {
    if (ctx.flags.json) return ctx.print.data(res), 0;
    ctx.print.line(`${taskRef(task)}: started`);
    return 0;
  }
  const limit = flags.timeout ? parseDuration(flags.timeout, "--timeout") : (task.timeoutMs ?? 10 * 60_000) + 30_000;
  const run = await waitForRun(c, task.id, before, limit);
  if (!run) {
    ctx.io.err(`${taskRef(task)}: still running after ${duration(limit)}`);
    return 1;
  }
  if (ctx.flags.json) return ctx.print.data({ ok: run.status === "ok", run }), run.status === "ok" ? 0 : 1;
  ctx.print.line(`${taskRef(task)}: ${run.status} in ${duration(Number(new Date(run.endedAt)) - Number(new Date(run.startedAt)))}${run.error ? ` · ${run.error}` : ""}`);
  if (run.output) ctx.print.line(run.output.replace(/\s+$/, ""));
  return run.status === "ok" ? 0 : 1;
};

/** Poll the run history until a run that started after `since` has ended. */
export async function waitForRun(c: { get: <T>(p: string) => Promise<T> }, taskId: string, since: number, limitMs: number, sleep = (ms: number) => Bun.sleep(ms)): Promise<RunView | undefined> {
  const deadline = Date.now() + limitMs;
  let delay = 500;
  while (Date.now() < deadline) {
    const { runs } = await c.get<{ runs: RunView[] }>(`/api/tasks/${taskId}/runs?limit=3`);
    const hit = runs.find((r) => Number(new Date(r.startedAt)) >= since - 1000);
    if (hit) return hit;
    await sleep(delay);
    delay = Math.min(5000, delay * 1.5);
  }
  return undefined;
}

const enabled = (value: boolean) => async (ctx: Ctx, argv: string[]) => {
  const { flags, positional } = parseArgs(argv, { reset: { kind: "bool" } });
  const ref = need(positional, 0, "TASK");
  noMore(positional, 1);
  const c = await ctx.client();
  const task = await resolveTask(c, ref);
  const res = await c.patch<{ task: TaskView }>(`/api/tasks/${task.id}`, { enabled: flags.reset ? null : value });
  if (ctx.flags.json) return ctx.print.data(res), 0;
  ctx.print.line(`${taskRef(res.task)}: ${flags.reset ? "override cleared, " : ""}${res.task.enabled ? "enabled" : "disabled"}`);
  return 0;
};

const create = async (ctx: Ctx, argv: string[]) => {
  const { flags, positional } = parseArgs(argv, {
    app: { kind: "value" },
    name: { kind: "value" },
    cron: { kind: "value" },
    every: { kind: "value" },
    at: { kind: "value" },
    tz: { kind: "value" },
    http: { kind: "value" },
    method: { kind: "value" },
    command: { kind: "value" },
    cwd: { kind: "value" },
    timeout: { kind: "value" },
    description: { kind: "value" },
    "json-file": { kind: "value" },
  });
  noMore(positional, 1);
  let body = (await readBody(ctx, positional[0], flags["json-file"])) as Record<string, unknown> | undefined;
  if (!body) {
    if (!flags.app || !flags.name) throw new UsageError("--app and --name are required (or a JSON body)");
    const schedule = flags.cron ? { kind: "cron", expr: flags.cron, ...(flags.tz ? { tz: flags.tz } : {}) } : flags.every ? { kind: "every", everyMs: parseDuration(flags.every, "--every") } : flags.at ? { kind: "at", at: flags.at } : { kind: "manual" };
    const target = flags.http ? { kind: "http", method: flags.method ?? "POST", url: flags.http } : flags.command ? { kind: "command", command: flags.command, ...(flags.cwd ? { cwd: flags.cwd } : {}) } : undefined;
    if (!target) throw new UsageError("--http URL or --command CMD is required");
    body = { app: flags.app, name: flags.name, schedule, target, ...(flags.timeout ? { timeoutMs: parseDuration(flags.timeout, "--timeout") } : {}), ...(flags.description ? { description: flags.description } : {}) };
  }
  const c = await ctx.client();
  const res = await c.post<{ task: TaskView }>("/api/tasks", body);
  if (ctx.flags.json) return ctx.print.data(res), 0;
  ctx.print.line(`${taskRef(res.task)}: created (${res.task.id}), ${scheduleText(res.task.schedule)}, next ${until(res.task.state.nextRunAt) || "never"}`);
  return 0;
};

const rm = async (ctx: Ctx, argv: string[]) => {
  const { flags, positional } = parseArgs(argv, { yes: { kind: "bool", alias: "y" } });
  const ref = need(positional, 0, "TASK");
  noMore(positional, 1);
  const c = await ctx.client();
  const task = await resolveTask(c, ref);
  // What the API deletes: API tasks, and manifest tasks that are orphaned (gone from their manifest or their app).
  if (task.source === "manifest" && !task.orphaned) throw new UsageError(`${taskRef(task)} is in space.yaml: remove it there and sync`);
  if (!(await confirm(ctx, flags.yes, `Delete task ${taskRef(task)}${task.orphaned ? " (orphaned)" : ""} and its run history?`))) return 1;
  await c.delete(`/api/tasks/${task.id}`);
  if (ctx.flags.json) return ctx.print.data({ ok: true, id: task.id }), 0;
  ctx.print.line(`${taskRef(task)}: deleted`);
  return 0;
};

export const taskNoun: Noun = {
  name: "task",
  summary: "scheduled and event-driven tasks: list, show, run, history, enable, create",
  verbs: {
    ls: { usage: "[--app APP] [--failing] [--all]", summary: "every task with its schedule, last run and next run (--all: orphaned too)", run: ls },
    show: { usage: "TASK", summary: "one task and its last five runs", run: show },
    run: { usage: "TASK [--wait] [--timeout DUR]", summary: "force a run now; --wait follows it to the end and exits with its status", run: runNow },
    runs: { usage: "TASK [-n 20] [--output]", summary: "run history, newest first (--output: with each run's output)", run: runs },
    enable: { usage: "TASK [--reset]", summary: "enable (--reset clears the override, back to the manifest)", run: enabled(true) },
    disable: { usage: "TASK [--reset]", summary: "disable until enabled again", run: enabled(false) },
    create: { usage: "--app A --name N [--cron E|--every D|--at T] --http URL|--command C", summary: "an API task (or a JSON body: argument, - for stdin, --json-file F)", run: create },
    rm: { usage: "TASK [--yes]", summary: "delete an API task, or an orphaned manifest task, with its history", run: rm },
  },
};
