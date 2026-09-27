import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { type S3Config, StorageService, openDatabase, sqliteUrl } from "./storage/index.ts";
import { BackupStore, type BackupTarget, type TaskDefaults, missingArchiveTools, openBackupTarget } from "./storage/backup/index.ts";
import type { Workspace } from "./workspace.ts";
import { type TerminalConfig, loadTerminalConfig } from "./terminal/index.ts";
import { type RouterConfig, loadRouterConfig } from "./router/index.ts";

/**
 * ai-space configuration: the workspace `.env` (and the process environment)
 * read into one `Config`, plus the openers the entry point and the CLI share.
 * `src/index.ts` boots the services from it; `src/cli/` reads it for the
 * commands that work on the workspace without a running ai-space.
 */

/** The shared skills apps reference as `space:<name>`: the checkout's `skills/` directory. */
export const SHARED_SKILLS = resolve(import.meta.dir, "..", "..", "skills");

/** The checkout root (where `bin/`, `skills/` and `src/` are). */
export const SPACE_ROOT = resolve(import.meta.dir, "..", "..");

/** The entry point the scheduler's tasks spawn (`bun src/index.ts backup <app>`). */
export const ENTRY = resolve(import.meta.dir, "..", "index.ts");

/** journalctl, the way apps run today (user units named after the app). */
export const DEFAULT_SERVICE_LOGS = "journalctl --user -u {app} -n {lines} --no-pager {follow}";

export type Config = {
  host: string;
  port: number;
  dbPath: string;
  /** Extra app directories (comma-separated SPACE_APPS) synced in addition to <workspace>/apps/*. */
  extraAppDirs: string[];
  apiToken: string;
  maxConcurrency: number;
  /**
   * How long a shutdown waits for the task runs and model calls in flight before it
   * aborts them (SPACE_DRAIN_SECONDS, 300). The default covers the observed p99 of both:
   * a scraper or a model call of a few minutes survives a deploy, and a restart that
   * catches nothing in flight still returns at once. Keep the service unit's
   * TimeoutStopSec above it, or systemd kills the process mid-drain.
   */
  drainMs: number;
  /** Superuser URL used only to create per-app postgres databases; empty disables postgres provisioning. */
  pgAdminUrl: string;
  /** Credentials for per-app s3 blob stores (SPACE_S3_*); undefined disables the s3 backend. */
  s3?: S3Config;
  /** Channel the scheduler reports failing tasks to (SPACE_NOTIFY_TASKS); empty disables it. */
  notifyTasks: string;
  /** How long published events are kept (SPACE_EVENTS_RETENTION_DAYS); deliveries and run history reference them. */
  eventRetentionMs: number;
  /** Chat model when neither the request nor the manifest names one (SPACE_CHAT_MODEL). */
  chatModel: string;
  /**
   * Who runs the apps' services (SPACE_SUPERVISOR, docs/supervision.md): `space` writes and keeps a user
   * unit per app (`space-<app>.service`); `operator` (the default) leaves them to units the operator
   * installed, which the space only probes, stops through SPACE_SERVICE_STOP and reads through SPACE_SERVICE_LOGS.
   */
  supervisor: "space" | "operator";
  /** Command that stops an app's service when the panel uninstalls it (SPACE_SERVICE_STOP), `{app}` = name; empty = services are not stopped. */
  serviceStop: string;
  /**
   * Command that prints an app's log (SPACE_SERVICE_LOGS): `{app}` = the unit name (`ai-space` for the space itself),
   * `{lines}` = how many lines, `{follow}` = `-f` when the caller wants to keep reading, empty otherwise.
   * Behind `GET /api/apps/:app/logs` and `space logs` until ai-space collects the logs itself.
   */
  serviceLogs: string;
  /** What this space calls itself towards a hub (SPACE_NAME); default: the hostname. */
  name: string;
  /** Token a hub must present on `/api/peer/*` (SPACE_HUB_TOKEN); empty = those routes are absent. */
  hubToken: string;
  /** The web terminal (docs/terminal.md): off unless SPACE_TERMINAL_ENABLED is set. */
  terminal: TerminalConfig;
  /** The router (docs/router.md): off unless SPACE_ROUTER=caddy, with SPACE_DOMAIN as the wildcard's domain. */
  router: RouterConfig;
  /** Where snapshots go (SPACE_BACKUP_URL); default s3://<SPACE_S3_BUCKET>/backups/<SPACE_NAME>/ when S3 is configured; empty = backup tasks fail until set. */
  backupUrl: string;
  /** Cron for the per-app backup tasks (SPACE_BACKUP_SCHEDULE); each app gets its own minute. */
  backupSchedule: string;
  /** Cron for the weekly verification (SPACE_BACKUP_VERIFY_SCHEDULE). */
  backupVerifySchedule: string;
  /** A newest successful snapshot older than this fails verification and shows stale (SPACE_BACKUP_MAX_AGE_HOURS). */
  backupMaxAgeMs: number;
  /** Timeout of one backup run (SPACE_BACKUP_TIMEOUT_MIN). */
  backupTimeoutMs: number;
  /**
   * The model service (docs/model.md): how many calls at once and the default model. Which
   * runtimes exist is `<workspace>/runtimes.yaml`, or the SPACE_MODEL_* / SPACE_CHAT_* variables
   * when the file is absent (see `src/space/runtimes/config.ts`).
   */
  model: {
    /** Calls running at the same time (SPACE_MODEL_MAX_CONCURRENCY). */
    maxConcurrency: number;
    /** Days of ledger kept (SPACE_MODEL_RETENTION_DAYS); 0 = everything. */
    retentionDays: number;
    /** Model when a request names none (SPACE_MODEL_DEFAULT). */
    defaultModel: string;
  };
};

export function loadConfig(ws: Workspace, env: Record<string, string | undefined> = process.env): Config {
  const s3Bucket = env.SPACE_S3_BUCKET?.trim() ?? "";
  const s3Configured = Boolean(env.SPACE_S3_ACCESS_KEY_ID?.trim() && env.SPACE_S3_SECRET_ACCESS_KEY?.trim());
  const name = env.SPACE_NAME?.trim() || hostname();
  const terminal = loadTerminalConfig(env);
  for (const w of terminal.warnings) console.warn(`[terminal] ${w}`);
  const router = loadRouterConfig(env);
  for (const w of router.warnings) console.warn(`[router] ${w}`);
  const supervisor = loadSupervisor(env);
  return {
    // One prefix per machine: several spaces sharing a bucket must not mix their `space/` (and same-named apps') snapshots.
    backupUrl: env.SPACE_BACKUP_URL?.trim() || (s3Configured && s3Bucket ? `s3://${s3Bucket}/backups/${name}/` : ""),
    backupSchedule: env.SPACE_BACKUP_SCHEDULE?.trim() || "0 3 * * *",
    backupVerifySchedule: env.SPACE_BACKUP_VERIFY_SCHEDULE?.trim() || "0 5 * * 1",
    backupMaxAgeMs: Math.max(1, Number(env.SPACE_BACKUP_MAX_AGE_HOURS ?? 48) || 48) * 3600_000,
    backupTimeoutMs: Math.max(1, Number(env.SPACE_BACKUP_TIMEOUT_MIN ?? 30) || 30) * 60_000,
    host: env.SPACE_HOST?.trim() || "127.0.0.1",
    port: Number(env.SPACE_PORT ?? 8700),
    dbPath: resolve(env.SPACE_DB?.trim() || join(ws.data, "space.db")),
    extraAppDirs: (env.SPACE_APPS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((p) => resolve(p.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"))),
    apiToken: env.SPACE_API_TOKEN?.trim() ?? "",
    maxConcurrency: Math.max(1, Number(env.SPACE_MAX_CONCURRENCY ?? 2) || 2),
    drainMs: Math.max(0, Number(env.SPACE_DRAIN_SECONDS ?? 300) || 300) * 1000,
    pgAdminUrl: env.SPACE_PG_ADMIN_URL?.trim() ?? "",
    notifyTasks: env.SPACE_NOTIFY_TASKS?.trim() ?? "",
    eventRetentionMs: Math.max(1, Number(env.SPACE_EVENTS_RETENTION_DAYS ?? 30) || 30) * 24 * 3600_000,
    chatModel: env.SPACE_CHAT_MODEL?.trim() ?? "sonnet",
    supervisor,
    serviceStop: env.SPACE_SERVICE_STOP?.trim() ?? "",
    serviceLogs: env.SPACE_SERVICE_LOGS?.trim() || DEFAULT_SERVICE_LOGS,
    name,
    hubToken: env.SPACE_HUB_TOKEN?.trim() ?? "",
    terminal: terminal.config,
    router: router.config,
    model: {
      maxConcurrency: Math.max(1, Number(env.SPACE_MODEL_MAX_CONCURRENCY ?? 4) || 4),
      retentionDays: Math.max(0, Number(env.SPACE_MODEL_RETENTION_DAYS ?? 0) || 0),
      defaultModel: env.SPACE_MODEL_DEFAULT?.trim() || "sonnet",
    },
    ...(env.SPACE_S3_ACCESS_KEY_ID?.trim() && env.SPACE_S3_SECRET_ACCESS_KEY?.trim()
      ? {
          s3: {
            accessKeyId: env.SPACE_S3_ACCESS_KEY_ID.trim(),
            secretAccessKey: env.SPACE_S3_SECRET_ACCESS_KEY.trim(),
            ...(env.SPACE_S3_ENDPOINT?.trim() ? { endpoint: env.SPACE_S3_ENDPOINT.trim() } : {}),
            ...(env.SPACE_S3_REGION?.trim() ? { region: env.SPACE_S3_REGION.trim() } : {}),
            ...(env.SPACE_S3_BUCKET?.trim() ? { bucket: env.SPACE_S3_BUCKET.trim() } : {}),
          },
        }
      : {}),
  };
}

/**
 * SPACE_SUPERVISOR: `operator` when unset, so a machine whose services are the operator's units keeps
 * them until it is switched on purpose. The two operator templates belong to the operator's units: set
 * together with `space` they would describe units that no longer run the apps, so that is refused.
 */
export function loadSupervisor(env: Record<string, string | undefined>): "space" | "operator" {
  const raw = env.SPACE_SUPERVISOR?.trim() || "operator";
  if (raw !== "space" && raw !== "operator") throw new Error(`SPACE_SUPERVISOR must be space or operator, not "${raw}"`);
  if (raw === "space") {
    const set = ["SPACE_SERVICE_STOP", "SPACE_SERVICE_LOGS"].filter((k) => env[k]?.trim());
    if (set.length) throw new Error(`SPACE_SUPERVISOR=space runs the services itself; remove ${set.join(" and ")} from the workspace .env (they describe the operator's units)`);
  }
  return raw;
}

/** Open the storage service on ai-space's own database. */
export async function openStorage(ws: Workspace, config: Config, log?: (m: string) => void): Promise<StorageService> {
  const db = await openDatabase(sqliteUrl(config.dbPath));
  return StorageService.open({ ws, db, pgAdminUrl: config.pgAdminUrl, s3: config.s3, apiUrl: `http://${config.host}:${config.port}`, spaceName: config.name, log });
}

/** What the backup tasks need to spawn `bun src/index.ts backup <app>` from the scheduler. */
export function backupTaskDefaults(ws: Workspace, config: Config): TaskDefaults {
  return {
    schedule: config.backupSchedule,
    verifySchedule: config.backupVerifySchedule,
    timeoutMs: config.backupTimeoutMs,
    bun: process.execPath,
    entry: ENTRY,
    spaceRoot: SPACE_ROOT,
    home: ws.home,
  };
}

/** Open the backup index and target. A target that cannot be opened is reported, not fatal: the tasks fail visibly instead. */
export async function openBackups(config: Config, log: (m: string) => void = (m) => console.error(m)) {
  const db = await openDatabase(sqliteUrl(config.dbPath));
  const store = await BackupStore.open(db);
  let target: BackupTarget | undefined;
  if (!config.backupUrl) log("[backup] SPACE_BACKUP_URL is not set; backup tasks will fail until it is (docs/backup.md)");
  else {
    try {
      target = openBackupTarget(config.backupUrl, config.s3);
      if (target.kind === "file") log(`[backup] target ${target.url} is on this machine; a copy on the same disk is not a backup`);
    } catch (e) {
      log(`[backup] ${(e as Error).message}`);
    }
  }
  const tools = missingArchiveTools();
  if (tools.length) log(`[backup] ${tools.join(" and ")} not on PATH; backup tasks will fail until installed`);
  return { db, store, target };
}
