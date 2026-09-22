import { openStorage } from "../space/config.ts";
import { backupCli } from "../space/storage/backup/index.ts";
import { discoverApps } from "../space/workspace.ts";
import { noMore, parseArgs } from "./args.ts";
import { ago, bytes, until } from "./output.ts";
import { type Ctx, type Noun } from "./types.ts";

/**
 * `space backup`: `ls` reads the running ai-space; `run`, `verify` and
 * `restore` work on the target directly, in their own process, which is
 * what the scheduler's backup task spawns (`bun src/index.ts backup <app>`).
 */

type Overview = { target: string | null; maxAgeHours: number; backups: { app: string; count: number; lastAt?: number; lastStatus?: string; lastError?: string; lastOkAt?: number; lastOkBytes?: number; lastVerifiedAt?: number; lastVerifyOk?: boolean; stale: boolean; retired: boolean; nextRunAt?: number; enabled?: boolean }[] };
type Snapshots = { snapshots: { key: string; at: number; bytes: number; status: string; error?: string; entries: number; verifiedAt?: number; verifyOk?: boolean; verifyError?: string }[] };

const ls = async (ctx: Ctx, argv: string[]) => {
  const { flags, positional } = parseArgs(argv, { target: { kind: "bool" } });
  noMore(positional, 1);
  const app = positional[0];
  const disk = async () => {
    const { ws, config } = await ctx.workspace();
    return backupCli("backups", app ? [app] : [], await cliContext(ctx, ws, config));
  };
  if (flags.target) return disk();
  const c = await ctx.client();
  const now = Date.now();
  if (app) {
    const res = await c.get<Snapshots>(`/api/apps/${app}/backups`);
    if (ctx.flags.json) return ctx.print.data(res), 0;
    ctx.print.table(res.snapshots, [
      { title: "when", get: (s) => ago(new Date(s.at).toISOString(), now) },
      { title: "status", get: (s) => s.status },
      { title: "size", get: (s) => bytes(s.bytes), align: "right" },
      { title: "entries", get: (s) => s.entries, align: "right" },
      { title: "verified", get: (s) => (s.verifiedAt ? (s.verifyOk ? "ok" : `FAILED ${s.verifyError ?? ""}`) : "") },
      { title: "key", get: (s) => s.key },
      { title: "error", get: (s) => s.error ?? "" },
    ], `no snapshots of ${app}`);
    return 0;
  }
  const res = await c.get<Overview>("/api/backups");
  if (ctx.flags.json) return ctx.print.data(res), 0;
  ctx.print.line(`target ${res.target ?? "none (SPACE_BACKUP_URL)"} · stale after ${res.maxAgeHours}h`);
  ctx.print.line("");
  ctx.print.table(res.backups, [
    { title: "app", get: (b) => b.app },
    { title: "snapshots", get: (b) => b.count, align: "right" },
    { title: "last ok", get: (b) => (b.lastOkAt ? `${ago(new Date(b.lastOkAt).toISOString(), now)} ${bytes(b.lastOkBytes)}` : "never") },
    { title: "state", get: (b) => (b.retired ? "retired" : b.stale ? "STALE" : b.lastStatus === "error" ? "last run failed" : "fresh") },
    { title: "verified", get: (b) => (b.lastVerifiedAt ? `${b.lastVerifyOk ? "ok" : "FAILED"} ${ago(new Date(b.lastVerifiedAt).toISOString(), now)}` : "") },
    { title: "next", get: (b) => (b.retired ? "" : b.enabled === false ? "disabled" : b.nextRunAt ? until(new Date(b.nextRunAt).toISOString(), now) : "") },
    { title: "error", get: (b) => (b.lastError ?? "").slice(0, 60) },
  ]);
  return 0;
};

const viaCli = (command: "backup" | "backup-verify" | "restore") => async (ctx: Ctx, argv: string[]) => {
  const { ws, config } = await ctx.workspace();
  return backupCli(command, argv, await cliContext(ctx, ws, config));
};

async function cliContext(ctx: Ctx, ws: Awaited<ReturnType<Ctx["workspace"]>>["ws"], config: Awaited<ReturnType<Ctx["workspace"]>>["config"]) {
  return {
    ws,
    dbPath: config.dbPath,
    s3: config.s3,
    backupUrl: config.backupUrl,
    backupMaxAgeMs: config.backupMaxAgeMs,
    serviceStop: config.serviceStop,
    appDirs: async () => [...(await discoverApps(ws)), ...config.extraAppDirs],
    storage: await openStorage(ws, config, () => {}),
    out: ctx.io.out,
    err: ctx.io.err,
  };
}

export const backupNoun: Noun = {
  name: "backup",
  summary: "snapshots of every app's data: run, list, verify, restore",
  verbs: {
    run: { usage: "APP", summary: "snapshot one app now (space for space.db); what the daily task runs", run: viaCli("backup") },
    ls: { usage: "[APP] [--target]", summary: "every app's last snapshot, or one app's list (--target: read the bucket itself)", run: ls },
    verify: { usage: "[APP…]", summary: "open the newest snapshot of every app, or of the named ones", run: viaCli("backup-verify") },
    restore: { usage: "APP [--at TIME] (--to DIR | --in-place [--stopped])", summary: "unpack a snapshot", run: viaCli("restore") },
  },
};
