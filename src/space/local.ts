import { cp, mkdir, readdir, readlink, rename, rm, stat, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { Database } from "bun:sqlite";
import { AuthService } from "./auth/service.ts";
import { AuthStore } from "./auth/store.ts";
import { readOperatorToken } from "./auth/operator-token.ts";
import { inspectPackage, readPackageFile } from "./packages/pack.ts";
import { SPACE_ROOT } from "./config.ts";
import { whichUsable, withUserToolDirs } from "./host-tools.ts";
import { workspaceLocked } from "./instance.ts";
import { Launchctl } from "./services/launchd.ts";
import type { Runner, UnitState } from "./services/manager.ts";
import { spawnCollect } from "./services/manager.ts";
import { updateEnvText } from "./setup.ts";

/**
 * The Local edition's managed installation on this Mac (docs/editions.md#ai-space-local,
 * docs/local.md). The Mac app runs these through `space local <verb> --json` with the Bun inside
 * its bundle; the app itself never starts or stops the service process.
 *
 *   ~/Library/Application Support/ai-space/local/      the program, never the data
 *     releases/<version>-<commit>/                     a copy of the app's Resources/space
 *     current -> releases/<version>-<commit>           what the background service runs
 *   ~/Library/LaunchAgents/ai.space.local.plist        the background service (launchd)
 *   ~/.ai-space/                                       the workspace, as every edition uses it
 *     installation.json                                this installation is the Local app's
 *
 * The program is copied out of the app so moving, replacing or deleting the app never pulls files
 * from under a running service. Ownership is the file in the workspace, never a PID or a busy port:
 * a workspace without it, or a Space answering on the port that is not managed, belongs to someone
 * else, and is only connected to or migrated on the user's explicit choice.
 */

export const LOCAL_LABEL = "ai.space.local";
export const OWNERSHIP_FILE = "installation.json";
export const MANAGED_BY = "ai-space-local";
/** Releases kept besides the current one, for a rollback. */
const KEEP_RELEASES = 3;

export type Ownership = { managedBy: typeof MANAGED_BY; installedAt: string; version: string; release: string };

export type LocalPaths = {
  prefix: string;
  releases: string;
  current: string;
  agentsDir: string;
  plist: string;
  workspace: string;
  logs: string;
};

export function localPaths(env: Record<string, string | undefined> = process.env, home = homedir()): LocalPaths {
  const prefix = env.SPACE_LOCAL_PREFIX?.trim() || join(home, "Library", "Application Support", "ai-space", "local");
  const agentsDir = env.SPACE_LOCAL_AGENTS?.trim() || join(home, "Library", "LaunchAgents");
  const workspace = env.SPACE_HOME?.trim() || join(home, ".ai-space");
  return { prefix, releases: join(prefix, "releases"), current: join(prefix, "current"), agentsDir, plist: join(agentsDir, `${LOCAL_LABEL}.plist`), workspace, logs: join(workspace, "logs") };
}

export async function readOwnership(workspace: string): Promise<Ownership | undefined> {
  try {
    const o = (await Bun.file(join(workspace, OWNERSHIP_FILE)).json()) as Ownership;
    return o.managedBy === MANAGED_BY ? o : undefined;
  } catch {
    return undefined;
  }
}

async function writeOwnership(workspace: string, o: Ownership): Promise<void> {
  await Bun.write(join(workspace, OWNERSHIP_FILE), `${JSON.stringify(o, null, 2)}\n`);
}

export type ReleaseInfo = { product: string; edition: string; version: string; commit: string; os?: string; arch?: string; bun?: string };

export async function readRelease(dir: string): Promise<ReleaseInfo | undefined> {
  try {
    return (await Bun.file(join(dir, "RELEASE.json")).json()) as ReleaseInfo;
  } catch {
    return undefined;
  }
}

export const releaseDirName = (r: ReleaseInfo) => `${r.version}-${r.commit.slice(0, 12)}`;

/** The port the workspace's service listens on: SPACE_PORT in its .env, else the default. */
export async function workspacePort(workspace: string): Promise<number> {
  try {
    const m = /^\s*SPACE_PORT\s*=\s*["']?(\d+)/m.exec(await Bun.file(join(workspace, ".env")).text());
    if (m) return Number(m[1]);
  } catch {}
  return 8700;
}

export type Identity = { product: string; version: string; edition: string; api: number; installation?: string; id?: string };

/** Whether nothing listens on the loopback port. */
export function portFree(port: number): boolean {
  try {
    Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response() }).stop(true);
    return true;
  } catch {
    return false;
  }
}

function freePort(): number {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = s.port!;
  s.stop(true);
  return port;
}

/** What answers on the port, if it is an ai-space at all. */
export async function probe(port: number, fetcher: typeof fetch = fetch): Promise<Identity | undefined> {
  try {
    const r = await fetcher(`http://127.0.0.1:${port}/api/space`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return undefined;
    const id = (await r.json()) as Identity;
    return id.product === "ai-space" ? id : undefined;
  } catch {
    return undefined;
  }
}

export type Runtimes = Record<"claude" | "codex", string | null>;

export function findRuntimes(env: Record<string, string | undefined> = process.env, home = homedir()): Runtimes {
  const PATH = withUserToolDirs(env.PATH ?? "/usr/bin:/bin", home);
  return { claude: whichUsable("claude", { PATH }) ?? null, codex: whichUsable("codex", { PATH }) ?? null };
}

/**
 * Where this Mac stands:
 *
 *   absent       no workspace, nothing on the port: install freely
 *   managed      the workspace is this app's (installation.json)
 *   foreign      a workspace or a running Space that someone else installed: connect or migrate
 */
export type LocalState = "absent" | "managed" | "foreign";

export type LocalStatus = {
  state: LocalState;
  /** Why it is foreign, in words. */
  reason?: string;
  bundle?: ReleaseInfo;
  installed?: ReleaseInfo & { path: string };
  ownership?: Ownership;
  workspace: { path: string; exists: boolean; locked: boolean };
  port: number;
  url: string;
  running?: Identity;
  service: { label: string; plist: boolean; loaded: boolean; running: boolean; disabled: boolean; pid: number; detail: string };
  runtimes: Runtimes;
};

export type LocalDeps = {
  env: Record<string, string | undefined>;
  home: string;
  /** The tree this command runs from: the app's Resources/space, or an installed release. */
  root: string;
  run: Runner;
  fetch: typeof fetch;
  uid: number;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  /** How long an install waits for the new release to answer; default a minute. */
  healthTimeoutMs?: number;
};

export function realLocalDeps(log: (line: string) => void = () => {}): LocalDeps {
  return { env: process.env, home: homedir(), root: SPACE_ROOT, run: spawnCollect, fetch, uid: process.getuid?.() ?? 0, log, sleep: Bun.sleep };
}

function launchctl(d: LocalDeps, p: LocalPaths): Launchctl {
  return new Launchctl({ run: d.run, unitDir: p.agentsDir, logDir: p.logs, uid: d.uid, stopWaitMs: 15_000 });
}

function serviceView(s: UnitState, plist: boolean) {
  return {
    label: LOCAL_LABEL,
    plist,
    loaded: s.loadState === "loaded",
    running: s.activeState === "active",
    disabled: s.unitFileState === "disabled",
    pid: s.mainPid,
    detail: `${s.loadState}/${s.activeState}/${s.subState}`,
  };
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

export async function localStatus(d: LocalDeps): Promise<LocalStatus> {
  const p = localPaths(d.env, d.home);
  const bundle = await readRelease(d.root);
  let installed: LocalStatus["installed"];
  try {
    const target = await readlink(p.current);
    const path = target.startsWith("/") ? target : join(p.prefix, target);
    const info = await readRelease(path);
    if (info) installed = { ...info, path };
  } catch {}
  const wsExists = await exists(p.workspace);
  const ownership = wsExists ? await readOwnership(p.workspace) : undefined;
  const port = await workspacePort(p.workspace);
  const running = await probe(port, d.fetch);
  const plist = await exists(p.plist);
  const unit = await launchctl(d, p)
    .show(LOCAL_LABEL)
    .catch((e: Error) => ({ loadState: "unknown", activeState: "unknown", subState: e.message, unitFileState: "", fragmentPath: "", restarts: 0, mainPid: 0 }) as UnitState);
  const locked = wsExists && workspaceLocked(join(p.workspace, "run"));

  let state: LocalState = "absent";
  let reason: string | undefined;
  if (ownership) state = "managed";
  else if (running) [state, reason] = ["foreign", `an ai-space ${running.version} (${running.edition}) that this app did not install answers on port ${port}`];
  else if (locked) [state, reason] = ["foreign", `an ai-space service that this app did not install is running on ${p.workspace}`];
  else if (wsExists && (await readdir(p.workspace)).length > 0) [state, reason] = ["foreign", `${p.workspace} exists and was not made by this app`];
  // A managed workspace whose port is held by something else is reported, not taken.
  if (state === "managed" && running && running.installation !== "managed") reason = `port ${port} is answered by an ai-space this app did not start`;

  return {
    state,
    ...(reason ? { reason } : {}),
    ...(bundle ? { bundle } : {}),
    ...(installed ? { installed } : {}),
    ...(ownership ? { ownership } : {}),
    workspace: { path: p.workspace, exists: wsExists, locked },
    port,
    url: `http://127.0.0.1:${port}/`,
    ...(running ? { running } : {}),
    service: serviceView(unit, plist),
    runtimes: findRuntimes(d.env, d.home),
  };
}

/** The LaunchAgent: the current release's Bun runs `start` on the workspace, at login and after a crash. */
export function renderLocalPlist(p: LocalPaths): string {
  const str = (s: string) => `<string>${s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</string>`;
  const env: Record<string, string> = { SPACE_HOME: p.workspace, SPACE_EDITION: "local", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<!-- Written by the AI Space app (Local edition). Removed from its Settings: Remove background service. -->",
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key>${str(LOCAL_LABEL)}`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...[join(p.current, "runtime", "bun"), join(p.current, "src", "index.ts"), "start"].map((a) => `    ${str(a)}`),
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    ...Object.entries(env).map(([k, v]) => `    <key>${k}</key>${str(v)}`),
    "  </dict>",
    `  <key>WorkingDirectory</key>${str(p.workspace)}`,
    "  <key>RunAtLoad</key><true/>",
    "  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
    "  <key>ThrottleInterval</key><integer>10</integer>",
    "  <key>ExitTimeOut</key><integer>40</integer>",
    "  <key>ProcessType</key><string>Interactive</string>",
    `  <key>StandardOutPath</key>${str(join(p.logs, "space.log"))}`,
    `  <key>StandardErrorPath</key>${str(join(p.logs, "space.log"))}`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export class LocalError extends Error {
  constructor(
    readonly code: "foreign" | "foreign-running" | "no-bundle" | "unhealthy" | "not-installed" | "busy",
    message: string,
    readonly status?: LocalStatus,
    /** For `busy`: what the running Space is doing (GET /api/space/activity). */
    readonly activity?: Activity,
  ) {
    super(message);
  }
}

export type Activity = { busy: boolean; items: { kind: string; label: string; since?: number }[] };

/** What the running Space is doing; undefined when it does not say (not running, or a release before /api/space/activity). */
export async function readActivity(d: LocalDeps, workspace: string, port: number): Promise<Activity | undefined> {
  try {
    const r = await d.fetch(`http://127.0.0.1:${port}/api/space/activity`, { headers: { authorization: `Bearer ${await operatorToken(workspace)}` }, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return undefined;
    const body = (await r.json()) as Activity & { ok?: boolean };
    return { busy: Boolean(body.busy), items: body.items ?? [] };
  } catch {
    return undefined;
  }
}

/**
 * Before the release changes, a copy of space.db, the one database the release itself migrates,
 * taken with the service stopped. Restored when the new release does not start and the previous
 * one is put back, so it finds the schema it knows. The last KEEP_RELEASES are kept.
 */
async function snapshotDb(p: LocalPaths, label: string): Promise<string | undefined> {
  const db = join(p.workspace, "data", "space.db");
  if (!(await exists(db))) return undefined;
  const root = join(p.prefix, "db-snapshots");
  const dir = join(root, `${new Date().toISOString().replace(/[:.]/g, "-")}-before-${label}`);
  await mkdir(dir, { recursive: true });
  const target = join(dir, "space.db");
  const src = new Database(db);
  try {
    src.query("VACUUM INTO ?").run(target);
  } finally {
    src.close();
  }
  const names = (await readdir(root)).sort().reverse();
  for (const n of names.slice(KEEP_RELEASES)) await rm(join(root, n), { recursive: true, force: true });
  return target;
}

async function restoreDb(p: LocalPaths, snapshot: string): Promise<void> {
  const db = join(p.workspace, "data", "space.db");
  for (const f of [`${db}-wal`, `${db}-shm`]) await rm(f, { force: true });
  await cp(snapshot, `${db}.restoring`);
  await rename(`${db}.restoring`, db);
}

export type BundledApp = { file: string; app?: string; version?: string; status: "installed" | "upgraded" | "present" | "failed"; detail?: string };

export type InstallResult = {
  apps: BundledApp[];
  version: string;
  release: string;
  workspace: string;
  url: string;
  migrated: boolean;
  upgraded: boolean;
  device?: { id: number; name: string; token: string };
};

async function switchCurrent(p: LocalPaths, release: string): Promise<void> {
  const tmp = `${p.current}.new`;
  await rm(tmp, { force: true });
  await symlink(join("releases", basename(release)), tmp);
  await rename(tmp, p.current);
}

/** Waits until the port answers as this release: its version, edition local, managed. */
async function waitHealthy(d: LocalDeps, port: number, version: string, ms = 60_000): Promise<Identity | undefined> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const id = await probe(port, d.fetch);
    if (id && id.version === version && id.edition === "local" && id.installation === "managed") return id;
    await d.sleep(500);
  }
  return undefined;
}

/** The operator token of the workspace: SPACE_API_TOKEN in its .env, else run/operator-token (builtin). */
async function operatorToken(workspace: string): Promise<string> {
  const env = await Bun.file(join(workspace, ".env")).text().catch(() => "");
  const m = /^\s*SPACE_API_TOKEN\s*=\s*["']?([^"'\s]+)/m.exec(env);
  return m?.[1] ?? (await readOperatorToken(workspace));
}

/**
 * The apps the app bundles, `bundled-apps/*.spaceapp` in the release: installed through the
 * running service's package routes, no Git and no network (docs/app-packages.md). One already
 * installed at the same version is left alone, another version is upgraded. The app's own code
 * signature covers these files, so they go in without a package signature. A failure is reported,
 * never thrown: the Space works without its bundled apps.
 */
export async function installBundledApps(d: LocalDeps, p: LocalPaths, port: number): Promise<BundledApp[]> {
  const dir = join(p.current, "bundled-apps");
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".spaceapp")).sort();
  if (!files.length) return [];
  const base = `http://127.0.0.1:${port}`;
  const auth = { authorization: `Bearer ${await operatorToken(p.workspace)}` };
  const listed = (await (await d.fetch(`${base}/api/packages`, { headers: auth })).json().catch(() => ({}))) as { operations?: { app: string; version: string; state: string }[] };
  const installed = new Map((listed.operations ?? []).filter((o) => o.state === "installed").map((o) => [o.app, o.version]));
  const out: BundledApp[] = [];
  for (const file of files) {
    try {
      const bytes = await readPackageFile(join(dir, file));
      const { manifest } = await inspectPackage(bytes);
      const have = installed.get(manifest.app);
      if (have === manifest.version) {
        out.push({ file, app: manifest.app, version: manifest.version, status: "present" });
        continue;
      }
      d.log(`${have ? "upgrading" : "installing"} ${manifest.app} ${manifest.version}`);
      const r = await d.fetch(`${base}/api/packages`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/octet-stream", "x-space-allow-unsigned": "true", ...(have ? { "x-space-upgrade": "true" } : {}) },
        body: new Blob([bytes as Uint8Array<ArrayBuffer>]),
      });
      const body = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      out.push(body.ok ? { file, app: manifest.app, version: manifest.version, status: have ? "upgraded" : "installed" } : { file, app: manifest.app, version: manifest.version, status: "failed", detail: body.error ?? `HTTP ${r.status}` });
    } catch (e) {
      out.push({ file, status: "failed", detail: (e as Error).message });
    }
  }
  return out;
}

async function prune(p: LocalPaths, keep: string[]): Promise<void> {
  const names = await readdir(p.releases).catch(() => [] as string[]);
  const dated = await Promise.all(names.map(async (n) => ({ n, t: (await stat(join(p.releases, n))).mtimeMs })));
  dated.sort((a, b) => b.t - a.t);
  const kept = new Set([...dated.slice(0, KEEP_RELEASES).map((x) => x.n), ...keep]);
  for (const { n } of dated) if (!kept.has(n)) await rm(join(p.releases, n), { recursive: true, force: true });
}

async function runInit(d: LocalDeps, p: LocalPaths): Promise<void> {
  const bun = join(p.current, "runtime", "bun");
  const env = { PATH: withUserToolDirs("/usr/bin:/bin:/usr/sbin:/sbin", d.home), HOME: d.home, SPACE_HOME: p.workspace, SPACE_EDITION: "local", SPACE_DEFAULT_APPS: "none" };
  const r = await new Promise<{ code: number; out: string }>((resolve) => {
    const proc = Bun.spawn([bun, join(p.current, "src", "index.ts"), "init"], { cwd: d.home, env, stdout: "pipe", stderr: "pipe" });
    void Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]).then(([o, e, code]) => resolve({ code, out: o + e }));
  });
  if (r.code !== 0) throw new Error(`init failed: ${r.out.trim().split("\n").at(-1)}`);
}

/** The workspace values the Local edition runs with, set on every install; the user's other values stay as they are. */
export const LOCAL_ENV = { SPACE_EDITION: "local", SPACE_AUTH: "builtin", SPACE_SUPERVISOR: "space", SPACE_DEFAULT_APPS: "none" };

/**
 * Values set only when the workspace has none: the user may change them. The terminal is on: the
 * service listens on loopback only and every session needs the owner (the app's device credential).
 */
// The drain on stop stays inside the LaunchAgent's ExitTimeOut (40 s), after which launchd kills.
export const LOCAL_DEFAULTS = { SPACE_TERMINAL_ENABLED: "1", SPACE_DRAIN_SECONDS: "30" };

/** What an upgrade does while the Space is busy: refuse and say with what, wait for it, or drain it now. */
export type WhenBusy = "refuse" | "wait" | "now";

/**
 * Install or upgrade: copy the bundle's release out, point `current` at it, make the workspace
 * (or take over a foreign one with `migrate`), write the LaunchAgent, start it, and wait for the
 * service to answer as this version. A start that fails puts the previous release back.
 *
 * An upgrade is coordinated with the work in progress (docs/local.md#updates): while the running
 * Space reports work, it is refused (`busy`, with the work), waited for, or drained now, per
 * `whenBusy`. The old service then stops (draining what is left), space.db is copied, and only then
 * does the new release touch the workspace. If it does not answer, the copy is restored and the
 * previous release starts again.
 */
export async function localInstall(d: LocalDeps, opts: { migrate?: boolean; device?: string; whenBusy?: WhenBusy; waitMs?: number } = {}): Promise<InstallResult> {
  const p = localPaths(d.env, d.home);
  const status = await localStatus(d);
  const bundle = status.bundle;
  if (!bundle || bundle.edition !== "local") throw new LocalError("no-bundle", `no Local release at ${d.root} (RELEASE.json with edition "local")`, status);
  if (status.state === "foreign") {
    if (!opts.migrate) throw new LocalError("foreign", status.reason ?? "this Mac already has an ai-space this app did not install", status);
    if (status.running || status.workspace.locked) throw new LocalError("foreign-running", `stop the ai-space that runs now before migrating it: ${status.reason}`, status);
  }
  const migrated = status.state === "foreign";
  const changing = migrated || Boolean(status.installed && status.installed.commit !== bundle.commit);

  if (changing && status.state === "managed" && status.running) {
    const whenBusy = opts.whenBusy ?? "refuse";
    const until = Date.now() + (opts.waitMs ?? 30 * 60_000);
    for (;;) {
      const work = whenBusy === "now" ? undefined : await readActivity(d, p.workspace, status.port);
      if (!work?.busy) break;
      const what = work.items.map((i) => i.label).join(", ");
      if (whenBusy === "refuse" || Date.now() >= until) throw new LocalError("busy", `the Space is busy: ${what}. Update when it is done, or now (the work gets ${LOCAL_DEFAULTS.SPACE_DRAIN_SECONDS} s to finish)`, status, work);
      d.log(`waiting for: ${what}`);
      await d.sleep(5000);
    }
  }

  const name = releaseDirName(bundle);
  const release = join(p.releases, name);
  await mkdir(p.releases, { recursive: true });
  const same = (await readRelease(release))?.commit === bundle.commit;
  if (!same && d.root !== release) {
    d.log(`copying ${bundle.version} into ${release}`);
    const tmp = `${release}.partial`;
    await rm(tmp, { recursive: true, force: true });
    await cp(d.root, tmp, { recursive: true, verbatimSymlinks: true });
    await rm(release, { recursive: true, force: true });
    await rename(tmp, release);
  }
  const previous = status.installed?.path;
  const upgraded = Boolean(previous && basename(previous) !== name);
  const lc = launchctl(d, p);
  let snapshot: string | undefined;
  if (changing) {
    if (status.service.loaded) {
      d.log("stopping the running service (its work drains)");
      await lc.disableNow(LOCAL_LABEL).catch(() => {});
    }
    try {
      snapshot = await snapshotDb(p, name);
    } catch (e) {
      // Nothing changed yet: the old release goes back to work.
      if (status.service.loaded) await lc.enableNow(LOCAL_LABEL).catch(() => {});
      throw e;
    }
    if (snapshot) d.log(`space.db copied to ${snapshot}`);
  }
  await switchCurrent(p, release);

  await mkdir(p.workspace, { recursive: true });
  await runInit(d, p);
  const envPath = join(p.workspace, ".env");
  const envText = await Bun.file(envPath).text().catch(() => "");
  // The default port taken by another program (not an ai-space: that was refused above): use a free one.
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(LOCAL_DEFAULTS)) if (!new RegExp(`^\\s*${k}\\s*=`, "m").test(envText)) extra[k] = v;
  // Package apps open through their own loopback gateway (docs/app-packages.md#application-entry-gateway): a stable port.
  if (!/^\s*SPACE_PACKAGE_PORT\s*=/m.test(envText)) extra.SPACE_PACKAGE_PORT = String(portFree(8702) ? 8702 : freePort());
  if (!/^\s*SPACE_PORT\s*=/m.test(envText) && !status.running && !portFree(status.port)) extra.SPACE_PORT = String(freePort());
  await Bun.write(envPath, updateEnvText(envText, { ...LOCAL_ENV, ...extra }));
  await writeOwnership(p.workspace, { managedBy: MANAGED_BY, installedAt: status.ownership?.installedAt ?? new Date().toISOString(), version: bundle.version, release: name });

  let device: InstallResult["device"];
  if (opts.device) {
    const db = new Database(join(p.workspace, "data", "space.db"), { create: true });
    try {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA busy_timeout = 5000");
      const made = new AuthService(new AuthStore(db)).addDevice(opts.device);
      device = { id: made.device.id, name: made.device.name, token: made.token };
    } finally {
      db.close();
    }
  }

  await mkdir(p.agentsDir, { recursive: true });
  await mkdir(p.logs, { recursive: true });
  await Bun.write(p.plist, renderLocalPlist(p));
  d.log("starting the background service");
  await lc.disableNow(LOCAL_LABEL).catch(() => {});
  await lc.enableNow(LOCAL_LABEL);
  const port = await workspacePort(p.workspace);
  if (!(await waitHealthy(d, port, bundle.version, d.healthTimeoutMs))) {
    let back = "";
    if (previous && previous !== release) {
      d.log(`the new release did not answer; going back to ${basename(previous)}`);
      await lc.disableNow(LOCAL_LABEL).catch(() => {});
      // The new release may have migrated space.db into a shape the previous one does not read.
      if (snapshot) await restoreDb(p, snapshot);
      await switchCurrent(p, previous);
      await lc.enableNow(LOCAL_LABEL).catch(() => {});
      back = `; ${basename(previous)} runs again${snapshot ? " with space.db as it was before" : ""}`;
    }
    throw new LocalError("unhealthy", `the service did not answer as ${bundle.version} on port ${port} in time${back}; see ${join(p.logs, "space.log")}`, await localStatus(d));
  }
  await prune(p, [name, ...(previous ? [basename(previous)] : [])]);
  const apps = await installBundledApps(d, p, port);
  return { apps, version: bundle.version, release, workspace: p.workspace, url: `http://127.0.0.1:${port}/`, migrated, upgraded, ...(device ? { device } : {}) };
}

async function requireManaged(d: LocalDeps): Promise<LocalPaths> {
  const p = localPaths(d.env, d.home);
  if (!(await readOwnership(p.workspace))) throw new LocalError("not-installed", "this Mac has no ai-space installed by this app", await localStatus(d));
  return p;
}

/** Start the background service and keep it on at login. */
export async function localStart(d: LocalDeps): Promise<LocalStatus> {
  const p = await requireManaged(d);
  if (!(await exists(p.plist))) await Bun.write(p.plist, renderLocalPlist(p));
  await launchctl(d, p).enableNow(LOCAL_LABEL);
  return localStatus(d);
}

/** Stop it, and keep it off at login until it is started again. Work in progress drains first (SIGTERM). */
export async function localStop(d: LocalDeps): Promise<LocalStatus> {
  const p = await requireManaged(d);
  await launchctl(d, p).disableNow(LOCAL_LABEL);
  return localStatus(d);
}

export async function localRestart(d: LocalDeps): Promise<LocalStatus> {
  const p = await requireManaged(d);
  const lc = launchctl(d, p);
  await lc.disableNow(LOCAL_LABEL).catch(() => {});
  await lc.enableNow(LOCAL_LABEL);
  return localStatus(d);
}

/**
 * Remove the background service before the app is deleted: stop it, unregister the LaunchAgent,
 * delete the program under Application Support. The workspace (apps, databases, settings) stays,
 * still marked as this app's, so installing again picks it up.
 */
export async function localRemoveService(d: LocalDeps): Promise<LocalStatus> {
  const p = await requireManaged(d);
  const lc = launchctl(d, p);
  await lc.disableNow(LOCAL_LABEL).catch(() => {});
  await rm(p.plist, { force: true });
  await rm(p.prefix, { recursive: true, force: true });
  return localStatus(d);
}
