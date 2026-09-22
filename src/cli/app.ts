import { openStorage } from "../space/config.ts";
import { parseArgs, need, noMore } from "./args.ts";
import { type TaskView, confirm, listTasks, scheduleText, taskRef } from "./common.ts";
import { newApp } from "./newapp.ts";
import { ago, bytes, until } from "./output.ts";
import { type Ctx, type Noun } from "./types.ts";

/** `space app`: the apps of the workspace, as the panel sees them, plus the disk-bound `env` and `new`. */

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
    ctx.print.line(summary(res.sync));
    return 0;
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
  summary: "the apps of the workspace: list, show, sync, hide, uninstall, env, new",
  verbs: {
    ls: { usage: "[--panel]", summary: "every app (--panel: only what the panel shows)", run: ls },
    show: { usage: "APP", summary: "manifest, storage, backups and tasks of one app", run: show },
    sync: { usage: "[APP]", summary: "re-read one space.yaml, or every app directory", run: sync },
    hide: { usage: "APP", summary: "hide the app on the panel", run: hidden(true) },
    unhide: { usage: "APP", summary: "show the app on the panel again", run: hidden(false) },
    uninstall: { usage: "APP [--yes] [--force]", summary: "stop, take out of the workspace, forget (data kept; --force: even with a task running)", run: uninstall },
    env: { usage: "APP", summary: "the variables storage provisioned, as export lines (eval \"$(space app env APP)\")", run: env },
    new: { usage: "NAME [--dir DIR] [--title T] [--port N] [--no-github]", summary: "a new app from the template: git init, first commit, private GitHub repository when configured", run: newApp },
  },
};
