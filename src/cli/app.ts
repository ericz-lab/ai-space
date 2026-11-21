import { openStorage } from "../space/config.ts";
import { parseArgs, need, noMore } from "./args.ts";
import { type TaskView, confirm, listTasks, scheduleText, taskRef } from "./common.ts";
import { deployVerb } from "./deploy.ts";
import { newApp } from "./newapp.ts";
import { buildVerb, createVerb } from "./studio.ts";
import { catalogVerb, installOrCatalog } from "./catalog.ts";
import { inspectPackageVerb, packVerb, packagesVerb, openPackageVerb, packageChangeVerb, releaseVerb, keygenVerb } from "./package.ts";
import { ago, bytes, until } from "./output.ts";
import { ApiError, type Ctx, type Noun, UsageError } from "./types.ts";

/** `space app`: the apps of the workspace, as the panel sees them, plus the disk-bound `env`, `new` and `deploy`. */

export type AppView = {
  id: string;
  name: string;
  peer?: string;
  title: string;
  description?: string;
  url?: string;
  repo?: string;
  status: string;
  manifestOnly: boolean;
  hidden: boolean;
  service?: { port: number; health: string };
  agents: { name: string; title: string }[];
  widgets: { name: string; title: string; kind: string }[];
};

const ls = async (ctx: Ctx, argv: string[]) => {
  const { flags, positional } = parseArgs(argv, { panel: { kind: "bool" } });
  noMore(positional, 0);
  const c = await ctx.client();
  const res = await c.get<{ apps: AppView[] }>(`/api/apps${flags.panel ? "" : "?all=1"}`);
  if (ctx.flags.json) return ctx.print.data(res), 0;
  ctx.print.table(res.apps, [
    { title: "name", get: (a) => a.id },
    { title: "title", get: (a) => a.title },
    { title: "status", get: (a) => a.status },
    { title: "service", get: (a) => (a.service ? `:${a.service.port} ${a.service.health}` : "") },
    { title: "url", get: (a) => a.url ?? "" },
    { title: "hidden", get: (a) => (a.hidden ? "hidden" : "") },
  ]);
  return 0;
};

const show = async (ctx: Ctx, argv: string[]) => {
  const { positional } = parseArgs(argv, {});
  const name = need(positional, 0, "APP");
  noMore(positional, 1);
  const c = await ctx.client();
  const { app } = await c.get<{ app: AppView }>(`/api/apps/${name}`);
  const [storage, backups, tasks] = await Promise.all([
    c.get<{ databases: { name: string; backend: string; env: string; orphaned: boolean }[]; blobs?: { backend: string; env?: string } }>(`/api/apps/${name}/storage`).catch(() => undefined),
    c.get<{ snapshots: { at: number; status: string; bytes: number; verifyOk?: boolean }[]; nextRunAt?: number; enabled?: boolean }>(`/api/apps/${name}/backups`).catch(() => undefined),
    listTasks(c).then((all) => all.filter((t) => t.app === name)).catch(() => [] as TaskView[]),
  ]);
  if (ctx.flags.json) return ctx.print.data({ app, storage, backups, tasks }), 0;
  const now = Date.now();
  const last = backups?.snapshots[0];
  ctx.print.kv([
    ["name", app.id],
    ["title", app.title],
    ["description", app.description],
    ["status", app.status],
    ["url", app.url],
    ["repo", app.repo],
    ["service", app.service ? `:${app.service.port} ${app.service.health}` : ""],
    ["hidden", app.hidden ? "yes" : ""],
    ["manifest only", app.manifestOnly ? "yes" : ""],
    ["agents", app.agents.map((a) => a.name).join(", ")],
    ["widgets", app.widgets.map((w) => `${w.name} (${w.kind})`).join(", ")],
    ["databases", storage?.databases.map((d) => `${d.name} ${d.backend}${d.orphaned ? " (orphaned)" : ""} → ${d.env}`).join("; ")],
    ["blobs", storage?.blobs ? `${storage.blobs.backend}${storage.blobs.env ? ` → ${storage.blobs.env}` : ""}` : ""],
    ["last backup", last ? `${ago(new Date(last.at).toISOString(), now)} ${last.status} ${bytes(last.bytes)}${last.verifyOk ? " verified" : ""}` : ""],
    ["next backup", backups?.nextRunAt ? until(new Date(backups.nextRunAt).toISOString(), now) : ""],
  ]);
  if (tasks.length) {
    ctx.print.line("");
    ctx.print.table(tasks, [
      { title: "task", get: taskRef },
      { title: "schedule", get: (t) => scheduleText(t.schedule) },
      { title: "enabled", get: (t) => t.enabled },
      { title: "last run", get: (t) => (t.state.lastRunAt ? `${ago(t.state.lastRunAt, now)} ${t.state.lastStatus ?? ""}` : "") },
      { title: "next", get: (t) => until(t.state.nextRunAt, now) },
    ]);
  }
  return 0;
};

const sync = async (ctx: Ctx, argv: string[]) => {
  const { positional } = parseArgs(argv, {});
  noMore(positional, 1);
  const c = await ctx.client();
  const name = positional[0];
  if (name) {
    const res = await c.post<{ sync: { app: string; created: string[]; updated: string[]; orphaned: string[] } }>(`/api/apps/${name}/sync`);
    if (ctx.flags.json) return ctx.print.data(res), 0;
    // The sync also reconciled the app's unit; say what it did when the space supervises it.
    const svc = await c.get<{ service: ServiceStatus }>(`/api/apps/${name}/service`).catch(() => undefined);
    const last = svc?.service.supervisor === "space" ? svc.service.last : undefined;
    ctx.print.line(summary(res.sync) + (last && last.action !== "absent" ? ` · service ${last.action}${last.error ? `: ${last.error}` : ""}` : ""));
    return last?.action === "conflict" || last?.action === "failed" ? 1 : 0;
  }
  const res = await c.post<{ synced: { app: string; created: string[]; updated: string[]; orphaned: string[] }[]; skipped: { dir: string; error: string }[]; gone: { app: string }[] }>("/api/apps/sync");
  if (ctx.flags.json) return ctx.print.data(res), 0;
  for (const s of res.synced) ctx.print.line(summary(s));
  for (const g of res.gone) ctx.print.line(`${g.app}: gone, deregistered`);
  for (const s of res.skipped) ctx.io.err(`skipped ${s.dir}: ${s.error}`);
  return res.skipped.length ? 1 : 0;
};

function summary(s: { app: string; created: string[]; updated: string[]; orphaned: string[] }): string {
  const parts = [s.created.length ? `${s.created.length} created` : "", s.updated.length ? `${s.updated.length} updated` : "", s.orphaned.length ? `${s.orphaned.length} orphaned` : ""].filter(Boolean);
  return `${s.app}: ${parts.length ? parts.join(", ") : "unchanged"}`;
}

const hidden = (value: boolean) => async (ctx: Ctx, argv: string[]) => {
  const { positional } = parseArgs(argv, {});
  const name = need(positional, 0, "APP");
  noMore(positional, 1);
  const c = await ctx.client();
  const res = await c.patch<{ app: AppView }>(`/api/apps/${name}`, { hidden: value });
  if (ctx.flags.json) return ctx.print.data(res), 0;
  ctx.print.line(`${res.app.id}: ${res.app.hidden ? "hidden" : "shown"}`);
  return 0;
};

const uninstall = async (ctx: Ctx, argv: string[]) => {
  const { flags, positional } = parseArgs(argv, { yes: { kind: "bool", alias: "y" }, force: { kind: "bool" } });
  const name = need(positional, 0, "APP");
  noMore(positional, 1);
  if (!(await confirm(ctx, flags.yes, `Uninstall ${name}: stop its service, take its directory out of the workspace and forget it (data is kept)?`))) return 1;
  const c = await ctx.client();
  // Without --force the space refuses while a task of the app is running (409 with their names).
  const res = await c.delete<{ app: string; stopped: string; dir: unknown; data: string }>(`/api/apps/${name}${flags.force ? "?force=1" : ""}`, { timeoutMs: 120_000 });
  if (ctx.flags.json) return ctx.print.data(res), 0;
  const dir = res.dir as { kind: string; to?: string; reason?: string };
  ctx.print.line(`${res.app}: service ${res.stopped}; directory ${dir.kind}${dir.to ? ` to ${dir.to}` : dir.reason ? ` (${dir.reason})` : ""}; data kept at ${res.data}`);
  return 0;
};

type ServiceStatus = {
  app: string;
  supervisor: "space" | "operator";
  unit: string;
  scope: "user" | "system";
  managed: boolean;
  state?: { loadState: string; activeState: string; subState: string; unitFileState: string; restarts: number; since?: string; mainPid: number };
  last?: { action: string; at: number; error?: string; health?: string; skippedEnv?: string[] };
};

function printService(ctx: Ctx, s: ServiceStatus) {
  const now = Date.now();
  const st = s.state;
  ctx.print.kv([
    ["app", s.app],
    ["supervisor", s.supervisor],
    ["unit", `${s.unit}${s.scope === "system" ? " (system)" : ""}${s.supervisor === "space" && !s.managed ? " (not written)" : ""}`],
    ["state", st && st.loadState !== "not-found" ? `${st.activeState} (${st.subState})${st.mainPid ? ` pid ${st.mainPid}` : ""}` : "no such unit"],
    ["since", st?.since ? ago(st.since, now) : ""],
    ["restarts", st && st.loadState !== "not-found" ? st.restarts : ""],
    ["enabled", st?.unitFileState ?? ""],
    ["last sync", s.last ? `${s.last.action} ${ago(new Date(s.last.at).toISOString(), now)}${s.last.health ? ` · health ${s.last.health}` : ""}` : ""],
    ["error", s.last?.error ?? ""],
    ["env left out", s.last?.skippedEnv?.join(", ") ?? ""],
  ]);
}

/** A package app's process, as `/api/packages/apps/:app/runtime` answers (src/space/packages/runtime.ts). */
type PackageRuntimeStatus = { app: string; state: string; leases: number; port?: number; error?: string; kind: string; mode?: string; declaredMode?: string; unit?: string; pid?: number; startedAt?: string };
type Client = Awaited<ReturnType<Ctx["client"]>>;

/** The runtime of a package app, or undefined when the name is not one (a spec-1 app, or unknown). */
async function packageRuntime(c: Client, name: string): Promise<PackageRuntimeStatus | undefined> {
  try { return (await c.get<{ runtime: PackageRuntimeStatus }>(`/api/packages/apps/${encodeURIComponent(name)}/runtime`)).runtime; }
  catch (e) { if (e instanceof ApiError && e.status === 404) return undefined; throw e; }
}

function printRuntime(ctx: Ctx, r: PackageRuntimeStatus) {
  ctx.print.kv([
    ["app", r.app],
    ["run by", r.unit ? `the system, on its own: ${r.unit}` : "the space (package)"],
    ["state", `${r.state}${r.pid ? ` pid ${r.pid}` : ""}${r.port ? ` port ${r.port}` : ""}`],
    ["since", r.startedAt ? ago(r.startedAt, Date.now()) : ""],
    ["mode", r.mode ? `${r.mode}${r.mode !== r.declaredMode ? ` (chosen here; the app declares ${r.declaredMode})` : ""}` : r.kind === "static" ? "static files, no process" : ""],
    ["in use", r.leases || ""],
    ["error", r.error ?? ""],
  ]);
}

async function packageControl(ctx: Ctx, c: Client, name: string, body: { action?: string; mode?: string }): Promise<number> {
  type Answer = { ok: boolean; error?: string; runtime?: PackageRuntimeStatus };
  let res: Answer;
  try { res = await c.post<Answer>(`/api/packages/apps/${encodeURIComponent(name)}/runtime`, body, { timeoutMs: 120_000 }); }
  catch (e) {
    const answer = (e as ApiError).body as Answer | undefined;
    if (!(e instanceof ApiError) || !answer?.runtime) throw e;
    res = answer;
  }
  if (ctx.flags.json) return ctx.print.data(res), res.ok ? 0 : 1;
  if (res.runtime) printRuntime(ctx, res.runtime);
  if (!res.ok) ctx.io.err(`${name}: ${res.error}`);
  return res.ok ? 0 : 1;
}

const mode = async (ctx: Ctx, argv: string[]) => {
  const { positional } = parseArgs(argv, {});
  const name = need(positional, 0, "APP");
  const to = need(positional, 1, "on-demand|background|standalone|default");
  noMore(positional, 2);
  if (!["on-demand", "background", "standalone", "default"].includes(to)) throw new UsageError("the mode is on-demand, background, standalone or default (what the app declares)");
  return packageControl(ctx, await ctx.client(), name, { mode: to });
};

const service = async (ctx: Ctx, argv: string[]) => {
  const { positional } = parseArgs(argv, {});
  const name = need(positional, 0, "APP");
  noMore(positional, 1);
  const c = await ctx.client();
  const runtime = await packageRuntime(c, name);
  if (runtime) return ctx.flags.json ? (ctx.print.data({ ok: true, runtime }), 0) : (printRuntime(ctx, runtime), 0);
  const res = await c.get<{ service: ServiceStatus }>(`/api/apps/${name}/service`);
  if (ctx.flags.json) return ctx.print.data(res), 0;
  printService(ctx, res.service);
  return 0;
};

// Under SPACE_SUPERVISOR=operator the space answers 409 with the command to run instead.
const control = (action: "start" | "stop" | "restart") => async (ctx: Ctx, argv: string[]) => {
  const { positional } = parseArgs(argv, {});
  const name = need(positional, 0, "APP");
  noMore(positional, 1);
  const c = await ctx.client();
  if (await packageRuntime(c, name)) return packageControl(ctx, c, name, { action });
  const res = await c.post<{ service: ServiceStatus }>(`/api/apps/${name}/service`, { action }, { timeoutMs: 120_000 });
  if (ctx.flags.json) return ctx.print.data(res), 0;
  printService(ctx, res.service);
  return 0;
};

// The hand-over waits for health (30 s) and may roll back; the answer lists what was done either way.
const supervise = async (ctx: Ctx, argv: string[]) => {
  const { positional } = parseArgs(argv, {});
  const name = need(positional, 0, "APP");
  const to = positional[1] ?? "space";
  noMore(positional, 2);
  if (to !== "space" && to !== "operator") throw new UsageError("the second argument is space or operator");
  const c = await ctx.client();
  type Answer = { ok: boolean; error?: string; handover?: { ok: boolean; steps: string[]; error?: string; rolledBack?: boolean }; service?: ServiceStatus };
  let res: Answer;
  try {
    res = await c.post<Answer>(`/api/apps/${name}/service`, { action: "supervise", to }, { timeoutMs: 180_000 });
  } catch (e) {
    const body = (e as ApiError).body as Answer | undefined;
    if (!(e instanceof ApiError) || !body?.handover) throw e;
    res = body;
  }
  if (ctx.flags.json) return ctx.print.data(res), res.ok ? 0 : 1;
  const h = res.handover!;
  for (const step of h.steps) ctx.print.line(`  ${step}`);
  if (h.ok) {
    ctx.print.line(`${name}: now run by ${to === "space" ? "the space" : "the operator's unit"}`);
    return 0;
  }
  ctx.io.err(`${name}: hand-over failed: ${h.error}${h.rolledBack ? " (rolled back)" : h.rolledBack === false ? " (NOT rolled back: check the units by hand)" : ""}`);
  return 1;
};

const env = async (ctx: Ctx, argv: string[]) => {
  const { positional } = parseArgs(argv, {});
  const name = need(positional, 0, "APP");
  noMore(positional, 1);
  const { ws, config } = await ctx.workspace();
  const storage = await openStorage(ws, config, () => {});
  const vars = await storage.envFor(name);
  if (ctx.flags.json) return ctx.print.data(vars), 0;
  for (const [k, v] of Object.entries(vars)) ctx.print.line(`export ${k}=${shellQuote(v)}`);
  return 0;
};

export function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

export const appNoun: Noun = {
  name: "app",
  summary: "the apps of the workspace: list, show, sync, deploy, service, start/stop/restart, mode, supervise, hide, uninstall, env, new; the app catalog: catalog, install, upgrade",
  verbs: {
    create: { usage: "NAME [--title T] [--description D]", summary: "make a new app inside the Space: source in app-src/NAME from the template, packed and installed (no GitHub)", run: createVerb },
    build: { usage: "NAME", summary: "pack app-src/NAME and install it, or upgrade the installed app (patch version +1)", run: buildVerb },
    catalog: { usage: "[--refresh]", summary: "apps of the app catalog: release, what is installed, whether an update waits, what each needs", run: catalogVerb },
    install: { usage: "NAME [--source [--ref REF]] [--with-source] [--trust] | FILE [--allow-unsigned] [--operation-id UUID]", summary: "install an app of the catalog (signed package, or --source: cloned to app-src and built here), or a package file", run: installOrCatalog() },
    upgrade: { usage: "NAME [--source|--package] [--trust] | FILE [--allow-unsigned] [--operation-id UUID]", summary: "bring a catalog app to its new release (or its checkout forward), or replace a package from a file; code and data are retained", run: installOrCatalog(true) },
    packages: { usage: "", summary: "Space identity and package installation history", run: packagesVerb },
    open: { usage: "APP [--space-id UUID --connection UUID]", summary: "print a one-use URL for a local or authorized remote package app", run: openPackageVerb },
    rollback: { usage: "APP RETAINED_OPERATION_ID [--yes] [--operation-id UUID]", summary: "restore retained package code without restoring data", run: packageChangeVerb("rollback") },
    "remove-package": { usage: "APP [--yes] [--operation-id UUID]", summary: "unregister a package and retain code and data", run: packageChangeVerb("remove") },
    pack: { usage: "DIR --output FILE [--include PATH,...] [--manifest FILE] [--target OS/ARCH] [--source-included] [--sign-key FILE]", summary: "create an offline application package from explicitly selected prepared files", run: packVerb },
    "inspect-package": { usage: "FILE [--trusted-key FILE] [--check-host]", summary: "verify package contents and inspect its signature without executing code", run: inspectPackageVerb },
    release: { usage: "[DIR] [--output-dir D] [--variant bundle|source|both] [--sign-key FILE]", summary: "build a checkout (space.release.yaml or space.yaml, its build: section) into packages to publish", run: releaseVerb },
    keygen: { usage: "--out FILE", summary: "a publisher's Ed25519 signing key: FILE (private, mode 600) and FILE.pub, with its key ID", run: keygenVerb },
    ls: { usage: "[--panel]", summary: "every app (--panel: only what the panel shows)", run: ls },
    show: { usage: "APP", summary: "manifest, storage, backups and tasks of one app", run: show },
    sync: { usage: "[APP]", summary: "re-read one space.yaml, or every app directory", run: sync },
    deploy: { usage: "APP [--rev REV] [--git-dir DIR] [--no-restart]", summary: "on the host: check out, install, check and build, then sync and restart; a failure restores the previous tree", run: deployVerb() },
    service: { usage: "APP", summary: "who runs the app's process, its state, pid, mode, since when; for a spec-1 app its unit and the last sync's outcome", run: service },
    start: { usage: "APP", summary: "start the app's process (a package app, or the space's unit under SPACE_SUPERVISOR=space)", run: control("start") },
    stop: { usage: "APP", summary: "stop the app's process: a package app stays off until start; a unit until its next sync", run: control("stop") },
    restart: { usage: "APP", summary: "restart the app's process", run: control("restart") },
    mode: { usage: "APP on-demand|background|standalone|default", summary: "how this Space runs a package app: started when used and stopped when idle, kept running, as a system service of its own that outlives a restart of the Space, or as the app declares", run: mode },
    supervise: { usage: "APP [space|operator]", summary: "hand the app from the operator's unit to the space's (or back), rolled back unless healthy", run: supervise },
    hide: { usage: "APP", summary: "hide the app on the panel", run: hidden(true) },
    unhide: { usage: "APP", summary: "show the app on the panel again", run: hidden(false) },
    uninstall: { usage: "APP [--yes] [--force]", summary: "stop, take out of the workspace, forget (data kept; --force: even with a task running)", run: uninstall },
    env: { usage: "APP", summary: "the variables storage provisioned, as export lines (eval \"$(space app env APP)\")", run: env },
    new: { usage: "NAME [--dir DIR] [--title T] [--port N] [--no-github]", summary: "a new app from the template: git init, first commit, private GitHub repository when GitHub is set up", run: (ctx, argv) => newApp(ctx, argv) },
  },
};
