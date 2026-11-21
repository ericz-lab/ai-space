import { readFileSync } from "node:fs";
import { lstat, mkdir, readdir, readlink, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SPACE_ROOT } from "./config.ts";
import { LOCAL_LABEL, LOCAL_UNIT, localPaths, readOwnership, readRelease } from "./local.ts";
import { Launchctl } from "./services/launchd.ts";
import { type Runner, type ServiceManager, type UnitState, spawnCollect } from "./services/manager.ts";
import { plistString } from "./services/plist.ts";
import { LAUNCHER_HEAD, TASK_NAME, TaskScheduler, renderLauncher, renderTask, taskFileBytes, workspaceOfLauncher } from "./services/schtasks.ts";
import { Systemctl } from "./services/systemd.ts";
import { readHolder, workspaceLocked } from "./instance.ts";

/**
 * ai-space's own background service on this machine (docs/release.md#the-background-service): the
 * one place that knows which service manager keeps it running. `deploy/install.sh` calls
 * `space service install` on either system instead of writing a unit itself.
 *
 *   On Linux                                           On a Mac
 *   ~/.config/systemd/user/ai-space.service            ~/Library/LaunchAgents/ai.space.server.plist
 *   systemd user manager, lingering on                 launchd, the user's GUI domain (logged in)
 *   the journal (journalctl --user -u ai-space)        <workspace>/logs/space.log
 *
 *   On Windows
 *   %LOCALAPPDATA%\ai-space\service\ai-space.xml and ai-space.cmd
 *   the Task Scheduler, a task started at the user's logon (services/schtasks.ts)
 *   <workspace>\logs\space.log
 *
 * Both run `<bun> src/index.ts` from the code's directory (a checkout, or a release's `current`)
 * with `SPACE_HOME` set to the workspace. A workspace the AI Space app installed (the Local
 * edition, `installation.json`) keeps the app's service: `restart` drives that one, and `install`
 * and `remove` refuse it.
 */

export const SERVER_LABEL = "ai.space.server";
export const SERVER_UNIT = "ai-space.service";

export type ServicePlatform = "darwin" | "linux" | "win32";

export const servicePlatform = (): ServicePlatform => (process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux");

/** Whether the service's output is a file in the workspace (launchd, the Task Scheduler) and not the journal. */
export const logsToFile = (platform: ServicePlatform = servicePlatform()): boolean => platform !== "linux";

export type ServiceDeps = {
  env: Record<string, string | undefined>;
  home: string;
  /** The code the service runs: a checkout, or a release's `current`. */
  root: string;
  /** The Bun that runs it. */
  bun: string;
  run: Runner;
  uid: number;
  platform: ServicePlatform;
  log: (line: string) => void;
  /** Windows: how long a start or a stop is waited for, read from the workspace's lock. Tests pass 0. */
  settleMs?: number;
};

/**
 * `BUN` names the Bun when the installer passes it: `process.execPath` is the resolved file, and
 * a release's unit must keep running through `current`, not the release it pointed at that day.
 */
export function realServiceDeps(log: (line: string) => void = () => {}, over: { root?: string; bun?: string } = {}): ServiceDeps {
  return {
    env: process.env,
    home: homedir(),
    root: resolve(over.root ?? SPACE_ROOT),
    bun: resolve(over.bun ?? (process.env.BUN?.trim() || process.execPath)),
    run: spawnCollect,
    uid: process.getuid?.() ?? 0,
    platform: servicePlatform(),
    log,
  };
}

export type ServicePaths = {
  platform: ServicePlatform;
  /** `~/.config/systemd/user` or `~/Library/LaunchAgents`; `SPACE_SERVICE_UNITS` moves it (tests). */
  unitDir: string;
  unitFile: string;
  workspace: string;
  logs: string;
};

function unitDirOf(d: Pick<ServiceDeps, "env" | "home" | "platform">): string {
  const config = d.env.XDG_CONFIG_HOME?.trim() || join(d.home, ".config");
  if (d.env.SPACE_SERVICE_UNITS?.trim()) return d.env.SPACE_SERVICE_UNITS.trim();
  if (d.platform === "win32") return join(d.env.LOCALAPPDATA?.trim() || join(d.home, "AppData", "Local"), "ai-space", "service");
  return d.platform === "darwin" ? join(d.home, "Library", "LaunchAgents") : join(config, "systemd", "user");
}

const unitFileName = (platform: ServicePlatform): string => (platform === "darwin" ? `${SERVER_LABEL}.plist` : platform === "win32" ? `${TASK_NAME}.xml` : SERVER_UNIT);

/** Windows: the launcher beside the task's file; it is what names the workspace. */
const launcherOf = (unitFile: string): string => unitFile.replace(/\.xml$/, ".cmd");

const system32Of = (d: Pick<ServiceDeps, "env">): string => join(d.env.SystemRoot?.trim() || d.env.windir?.trim() || "C:\\Windows", "System32");

/** The workspace an installed unit runs on, read back from its text. */
export function workspaceOfUnit(text: string, platform: ServicePlatform, home: string): string | undefined {
  if (platform === "win32") return workspaceOfLauncher(text);
  if (platform === "darwin") {
    const m = /<key>SPACE_HOME<\/key>\s*<string>([^<]*)<\/string>/.exec(text);
    return m ? m[1]!.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") : undefined;
  }
  const m = /^Environment=SPACE_HOME=(.+)$/m.exec(text);
  return m ? m[1]!.trim().replace(/^%h(?=$|\/)/, home) : undefined;
}

/**
 * The workspace of this machine's service: `SPACE_HOME` when set, else the one the installed
 * unit already runs on (a git-push deploy runs without the operator's environment), else
 * `~/.ai-space`.
 */
export async function serviceWorkspace(d: Pick<ServiceDeps, "env" | "home" | "platform">): Promise<string> {
  const raw = d.env.SPACE_HOME?.trim();
  if (raw) return resolve(raw.replace(/^~(?=$|\/)/, d.home));
  const file = join(unitDirOf(d), unitFileName(d.platform));
  const text = await Bun.file(d.platform === "win32" ? launcherOf(file) : file).text().catch(() => "");
  return workspaceOfUnit(text, d.platform, d.home) ?? join(d.home, ".ai-space");
}

export async function servicePaths(d: Pick<ServiceDeps, "env" | "home" | "platform">): Promise<ServicePaths> {
  const unitDir = unitDirOf(d);
  const workspace = await serviceWorkspace(d);
  return { platform: d.platform, unitDir, unitFile: join(unitDir, unitFileName(d.platform)), workspace, logs: join(workspace, "logs") };
}

export type UnitInput = { root: string; bun: string; workspace: string; home: string };

/**
 * The systemd user unit: `deploy/ai-space.service` with this machine's checkout, workspace and
 * Bun written over its defaults. When the Bun is not `~/.bun/bin/bun` (a release's own), its
 * directory goes first on the unit's PATH, so the apps' services find the same one.
 */
export function renderServerUnit(template: string, u: UnitInput): string {
  const binDir = dirname(u.bun);
  const pathFix = binDir !== join(u.home, ".bun", "bin");
  return template
    .split("\n")
    .map((line) => {
      let l = line.replace("%h/.ai-space/core", () => u.root);
      if (l.startsWith("Environment=SPACE_HOME=")) l = `Environment=SPACE_HOME=${u.workspace}`;
      l = l.replace("%h/.bun/bin/bun", () => u.bun);
      if (pathFix && l.startsWith("Environment=PATH=")) l = `Environment=PATH=${binDir}:${l.slice("Environment=PATH=".length)}`;
      return l;
    })
    .join("\n");
}

/** The first two lines of the LaunchAgent; `remove` deletes no plist without them. */
export const SERVER_PLIST_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n<!-- Written by ai-space (space service install). Removed by: space service remove. -->';

/** launchd gives a job `/usr/bin:/bin:/usr/sbin:/sbin` only: the Bun's directory and where agent CLIs usually are go first. */
export function launchPath(u: Pick<UnitInput, "bun" | "home">): string {
  const dirs = [dirname(u.bun), join(u.home, ".bun", "bin"), join(u.home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  return [...new Set(dirs)].join(":");
}

/**
 * The LaunchAgent, the systemd unit's counterpart: started at login and when loaded, restarted
 * after a crash only, and given the drain (SPACE_DRAIN_SECONDS, 300 by default) plus a margin
 * before launchd kills it. launchd keeps no journal, so the output goes to a file in the workspace.
 */
export function renderServerPlist(u: UnitInput): string {
  const str = plistString;
  const env: Record<string, string> = { SPACE_HOME: u.workspace, PATH: launchPath(u) };
  const log = join(u.workspace, "logs", "space.log");
  return [
    SERVER_PLIST_HEAD,
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key>${str(SERVER_LABEL)}`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...[u.bun, join(u.root, "src", "index.ts")].map((a) => `    ${str(a)}`),
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    ...Object.entries(env).map(([k, v]) => `    <key>${k}</key>${str(v)}`),
    "  </dict>",
    `  <key>WorkingDirectory</key>${str(u.root)}`,
    "  <key>RunAtLoad</key><true/>",
    "  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
    "  <key>ThrottleInterval</key><integer>5</integer>",
    "  <key>ExitTimeOut</key><integer>360</integer>",
    "  <key>ProcessType</key><string>Interactive</string>",
    `  <key>StandardOutPath</key>${str(log)}`,
    `  <key>StandardErrorPath</key>${str(log)}`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export class ServiceError extends Error {
  constructor(
    readonly code: "local-edition" | "no-manager" | "not-installed" | "not-a-release",
    message: string,
  ) {
    super(message);
  }
}

/** One background service under its manager: the Server's, or the Local edition's when the workspace is the app's. */
type Handle = {
  kind: "server" | "local";
  name: string;
  file: string;
  /** What this module asks of a manager; the Task Scheduler supervises no app, so it answers the app questions with nothing. */
  manager: Pick<ServiceManager, "available" | "unavailable" | "stop" | "daemonReload" | "appOfFile" | "owns" | "unitName" | "disableNow" | "resetFailed"> & { kind: ServiceStatus["manager"] };
  restart(): Promise<void>;
  enableNow(): Promise<void>;
  disableNow(): Promise<void>;
  show(): Promise<UnitState>;
  /** Whatever registered the service besides its file, taken back when the file is removed. */
  unregister?(): Promise<void>;
};

/**
 * The Task Scheduler's handle. Running is read from the workspace's lock, which the service holds
 * for its life and which names its pid: the scheduler's own state is in the system's language and
 * does not cover what the launcher started. A stop ends that process and what it started; Windows
 * has no signal to drain on, so work in flight ends with it.
 */
function taskHandle(d: ServiceDeps, file: string, workspace: string): Handle {
  const ts = new TaskScheduler({ run: d.run, system32: system32Of(d) });
  const runDir = join(workspace, "run");
  const settle = async (want: boolean) => {
    const until = Date.now() + (d.settleMs ?? 20_000);
    while (workspaceLocked(runDir) !== want && Date.now() < until) await Bun.sleep(250);
  };
  const stopProcess = async () => {
    const pid = workspaceLocked(runDir) ? (await readHolder(runDir))?.pid : undefined;
    await ts.end(TASK_NAME);
    if (pid) await ts.kill(pid);
    await settle(false);
  };
  const startTask = async () => {
    await ts.start(TASK_NAME);
    await settle(true);
  };
  return {
    kind: "server",
    name: TASK_NAME,
    file,
    manager: { kind: ts.kind, available: () => ts.available(), unavailable: ts.unavailable, stop: stopProcess, daemonReload: async () => {}, appOfFile: () => undefined, owns: () => false, unitName: (app) => app, disableNow: async () => {}, resetFailed: async () => {} },
    restart: async () => {
      await stopProcess();
      await startTask();
    },
    enableNow: async () => {
      await ts.enable(TASK_NAME);
      if (!workspaceLocked(runDir)) await startTask();
    },
    disableNow: async () => {
      if ((await ts.query(TASK_NAME)).registered) await ts.disable(TASK_NAME);
      await stopProcess();
    },
    show: async () => {
      const t = await ts.query(TASK_NAME);
      const running = workspaceLocked(runDir);
      const holder = running ? await readHolder(runDir) : undefined;
      return { loadState: t.registered ? "loaded" : "not-found", activeState: running ? "active" : "inactive", subState: running ? "running" : "dead", unitFileState: !t.registered ? "" : t.enabled ? "enabled" : "disabled", fragmentPath: file, restarts: 0, mainPid: holder?.pid ?? 0, ...(holder ? { since: holder.startedAt } : {}) };
    },
    unregister: async () => {
      await ts.delete(TASK_NAME);
      const launcher = launcherOf(file);
      if ((await Bun.file(launcher).text().catch(() => "")).startsWith(LAUNCHER_HEAD)) await rm(launcher, { force: true });
    },
  };
}

function handle(d: ServiceDeps, kind: "server" | "local", unitDir: string, file: string, logs: string): Handle {
  if (d.platform === "win32") return taskHandle(d, file, dirname(logs));
  if (d.platform === "darwin") {
    const label = kind === "server" ? SERVER_LABEL : LOCAL_LABEL;
    // A stop waits for the drain: longer than the plist's ExitTimeOut, after which launchd kills.
    const lc = new Launchctl({ run: d.run, unitDir, logDir: logs, uid: d.uid, stopWaitMs: kind === "server" ? 370_000 : 35_000 });
    return { kind, name: label, file, manager: lc, restart: () => lc.restart(label), enableNow: () => lc.enableNow(label), disableNow: () => lc.disableNow(label), show: () => lc.show(label) };
  }
  const unit = kind === "server" ? SERVER_UNIT : LOCAL_UNIT;
  const sd = new Systemctl({ run: d.run, unitDir });
  return {
    kind,
    name: unit,
    file,
    manager: sd,
    restart: () => sd.restart(unit),
    // systemd reads a unit file on a reload only.
    enableNow: async () => {
      await sd.daemonReload();
      await sd.enableNow(unit);
    },
    disableNow: async () => {
      const s = await sd.show(unit).catch(() => undefined);
      if (!s || s.loadState === "not-found") return;
      await sd.disableNow(unit);
    },
    show: () => sd.show(unit),
  };
}

/** The service that runs this machine's workspace: the app's when `installation.json` says the workspace is its, the Server's otherwise. */
async function current(d: ServiceDeps): Promise<{ h: Handle; p: ServicePaths }> {
  const p = await servicePaths(d);
  // The AI Space app on Windows runs its service inside WSL: no workspace here is its.
  if (d.platform !== "win32" && (await readOwnership(p.workspace))) {
    const lp = localPaths({ ...d.env, SPACE_HOME: p.workspace }, d.home, d.platform);
    return { h: handle(d, "local", lp.unitDir, lp.unitFile, lp.logs), p };
  }
  return { h: handle(d, "server", p.unitDir, p.unitFile, p.logs), p };
}

export type ServiceStatus = {
  /** `server`: this module's unit. `local`: the AI Space app's (the Local edition). */
  kind: "server" | "local";
  manager: "systemd" | "launchd" | "task-scheduler";
  name: string;
  file: string;
  installed: boolean;
  running: boolean;
  enabled: boolean;
  pid: number;
  detail: string;
  workspace: string;
  /** Where its output goes: a file under launchd, the journal's command under systemd. */
  logs: string;
};

export async function serviceStatus(d: ServiceDeps): Promise<ServiceStatus> {
  const { h, p } = await current(d);
  const installed = await exists(h.file);
  const s = await h.show().catch((e: Error) => ({ loadState: "unknown", activeState: "unknown", subState: e.message, unitFileState: "", fragmentPath: "", restarts: 0, mainPid: 0 }) as UnitState);
  return {
    kind: h.kind,
    manager: h.manager.kind,
    name: h.name,
    file: h.file,
    installed,
    running: s.activeState === "active",
    enabled: s.unitFileState === "enabled",
    pid: s.mainPid,
    detail: `${s.loadState}/${s.activeState}/${s.subState}`,
    workspace: p.workspace,
    logs: logsToFile(d.platform) ? join(p.logs, "space.log") : `journalctl --user -u ${h.name.replace(/\.service$/, "")}`,
  };
}

async function server(d: ServiceDeps, verb: string): Promise<{ h: Handle; p: ServicePaths }> {
  const c = await current(d);
  if (c.h.kind === "local") throw new ServiceError("local-edition", `${c.p.workspace} belongs to the AI Space app (the Local edition), which runs its own background service: ${verb} it from the app, or with \`space local\``);
  return c;
}

/**
 * Write the unit for this code, workspace and Bun, and (re)start it. On Linux lingering is asked
 * for, so the service outlives the login session; without the right to it the unit still runs
 * while the user is logged in. Idempotent: an upgrade runs it again and gets a restart.
 */
export async function serviceInstall(d: ServiceDeps): Promise<ServiceStatus> {
  const { h, p } = await server(d, "install");
  if (!(await h.manager.available())) throw new ServiceError("no-manager", h.manager.unavailable.replace(/ or set SPACE_SUPERVISOR=operator$/, ""));
  const u: UnitInput = { root: d.root, bun: d.bun, workspace: p.workspace, home: d.home };
  if (d.platform === "win32") {
    const user = [d.env.USERDOMAIN?.trim(), d.env.USERNAME?.trim()].filter(Boolean).join("\\");
    if (!d.env.USERNAME?.trim()) throw new ServiceError("no-manager", "USERNAME is not set: the task needs the account whose logon starts it");
    const launcher = launcherOf(h.file);
    await mkdir(p.unitDir, { recursive: true });
    await mkdir(p.logs, { recursive: true }); // the launcher appends to the log; cmd makes the file, not its directory
    await Bun.write(launcher, renderLauncher(u));
    await Bun.write(h.file, taskFileBytes(renderTask({ ...u, user, launcher, system32: system32Of(d) })));
    d.log(`wrote ${h.file}`);
    await h.manager.stop(h.name); // what runs keeps the code it started with
    await new TaskScheduler({ run: d.run, system32: system32Of(d) }).create(TASK_NAME, h.file);
    await h.enableNow();
    return serviceStatus(d);
  }
  const text = d.platform === "darwin" ? renderServerPlist(u) : renderServerUnit(readFileSync(join(d.root, "deploy", "ai-space.service"), "utf8"), u);
  await mkdir(p.unitDir, { recursive: true });
  // launchd creates the log file but not its directory: without it the job never starts.
  if (d.platform === "darwin") await mkdir(p.logs, { recursive: true });
  await Bun.write(h.file, text);
  d.log(`wrote ${h.file}`);
  if (d.platform === "linux") {
    const user = d.env.USER?.trim() || String(d.uid);
    const linger = await d.run(["loginctl", "enable-linger", user]);
    if (linger.code !== 0) d.log(`lingering is off (loginctl enable-linger ${user} was refused): ai-space stops when you log out; turn it on with sudo`);
    await h.enableNow();
    await h.restart();
  } else {
    // launchd reads a plist when it loads it: unload what runs (its work drains), then load.
    await h.manager.stop(h.name);
    await h.enableNow();
  }
  return serviceStatus(d);
}

const installHint = (d: Pick<ServiceDeps, "platform">): string => (d.platform === "win32" ? "space service install" : "bash deploy/install.sh");

/** Restart whichever service runs this workspace; what `.env` edits and a Codex upgrade need. */
export async function serviceRestart(d: ServiceDeps): Promise<ServiceStatus> {
  const { h } = await current(d);
  if (!(await exists(h.file))) throw new ServiceError("not-installed", `no ${h.name} on this machine (${h.file}); install it with: ${installHint(d)}`);
  await h.restart();
  return serviceStatus(d);
}

/** Start it and keep it on at login. */
export async function serviceStart(d: ServiceDeps): Promise<ServiceStatus> {
  const { h } = await current(d);
  if (!(await exists(h.file))) throw new ServiceError("not-installed", `no ${h.name} on this machine (${h.file}); install it with: ${installHint(d)}`);
  await h.enableNow();
  return serviceStatus(d);
}

/** Stop it (its work drains first) and keep it off until it is started again. */
export async function serviceStop(d: ServiceDeps): Promise<ServiceStatus> {
  const { h } = await current(d);
  await h.disableNow();
  return serviceStatus(d);
}

/** Stop and unregister the Server's unit; the program and the workspace stay. */
export async function serviceRemove(d: ServiceDeps): Promise<ServiceStatus> {
  const { h } = await server(d, "remove");
  await h.disableNow().catch((e: Error) => d.log(`stopping ${h.name}: ${e.message}`));
  await rm(h.file, { force: true });
  await h.unregister?.();
  await h.manager.daemonReload().catch(() => {});
  return serviceStatus(d);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

// ---------------------------------------------------------------- uninstall

export type UninstallStep = { what: "app-service" | "service" | "link" | "program" | "workspace"; target: string; detail: string };

export type UninstallPlan = { workspace: string; steps: UninstallStep[]; kept: string[] };

/** The release installation a tree belongs to: `<prefix>/releases/<version>` with `<prefix>/current`. */
export async function releasePrefix(root: string): Promise<string | undefined> {
  const real = await realpath(root).catch(() => root);
  if (!(await readRelease(real))) return undefined;
  const releases = dirname(real);
  const prefix = dirname(releases);
  if (releases !== join(prefix, "releases") || !(await lstat(join(prefix, "current")).catch(() => undefined))) return undefined;
  return prefix;
}

/**
 * What `space uninstall` would do, in order: the apps' units this workspace's supervisor wrote
 * (under SPACE_SUPERVISOR=space they would keep running without it), ai-space's own unit, the
 * `space` and `bun` links that point into the program, the program when it is a release (a
 * checkout is the operator's and stays), and the workspace only when asked.
 */
export async function planUninstall(d: ServiceDeps, opts: { workspace?: boolean } = {}): Promise<UninstallPlan> {
  const { h, p } = await server(d, "uninstall");
  const steps: UninstallStep[] = [];
  const kept: string[] = [];
  const envDir = join(p.workspace, "run", "env");
  for (const file of (await readdir(p.unitDir).catch(() => [] as string[])).sort()) {
    const app = h.manager.appOfFile(file);
    if (!app) continue;
    const text = await Bun.file(join(p.unitDir, file)).text().catch(() => "");
    if (h.manager.owns(text, join(envDir, `${app}.env`))) steps.push({ what: "app-service", target: join(p.unitDir, file), detail: `stop ${app} and remove its ${d.platform === "darwin" ? "LaunchAgent" : "unit"}` });
  }
  if (await exists(h.file)) steps.push({ what: "service", target: h.file, detail: `stop ai-space and remove ${h.name}` });
  const prefix = await releasePrefix(d.root);
  const program = prefix ?? (await realpath(d.root).catch(() => d.root));
  for (const name of ["space", "bun"]) {
    const link = join(d.home, ".local", "bin", name);
    const to = await readlink(link).catch(() => undefined);
    if (to === undefined) continue;
    const real = await realpath(link).catch(() => resolve(dirname(link), to));
    if (real === program || real.startsWith(`${program}/`)) steps.push({ what: "link", target: link, detail: `remove the ${name} command (${link})` });
  }
  if (prefix) steps.push({ what: "program", target: prefix, detail: `delete the program (${prefix})` });
  else kept.push(`${d.root}: a checkout, not a release; delete it yourself`);
  if (opts.workspace) steps.push({ what: "workspace", target: p.workspace, detail: `delete the workspace with every app, database and setting (${p.workspace})` });
  else if (await exists(p.workspace)) kept.push(`${p.workspace}: the workspace (apps, databases, .env); --workspace deletes it too`);
  return { workspace: p.workspace, steps, kept };
}

export async function runUninstall(d: ServiceDeps, plan: UninstallPlan): Promise<void> {
  const { h } = await server(d, "uninstall");
  for (const s of plan.steps) {
    d.log(s.detail);
    if (s.what === "app-service") {
      const unit = h.manager.unitName(h.manager.appOfFile(s.target.split("/").at(-1)!)!);
      await h.manager.disableNow(unit).catch((e: Error) => d.log(`  ${e.message}`));
      await rm(s.target, { force: true });
      await h.manager.resetFailed(unit).catch(() => {});
    } else if (s.what === "service") {
      await h.disableNow().catch((e: Error) => d.log(`  ${e.message}`));
      await rm(s.target, { force: true });
      await h.unregister?.();
      await h.manager.daemonReload().catch(() => {});
    } else if (s.what === "link") {
      await rm(s.target, { force: true });
    } else {
      await rm(s.target, { recursive: true, force: true });
    }
  }
  // systemd forgets a removed unit on the next reload; launchd forgot it at bootout.
  if (plan.steps.some((s) => s.what === "app-service")) await h.manager.daemonReload().catch(() => {});
}
