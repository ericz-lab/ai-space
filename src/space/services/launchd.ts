import { copyFile, mkdir, readdir, stat, truncate } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Manifest } from "../scheduler/manifest.ts";
import { type RunResult, type Runner, type Scope, type ServiceManager, type UnitState, type Verb, lastLine, spawnCollect } from "./manager.ts";
import { PLIST_HEAD, launchLabel, renderPlist, renderShellEnv } from "./plist.ts";

/**
 * `launchctl` for the supervisor on macOS (docs/supervision.md#macos): the
 * space's LaunchAgents in the user's GUI domain (`gui/<uid>`), loaded at
 * login; an operator's LaunchDaemon in the `system` domain only to look and,
 * in a hand-over, through `sudo -n`. launchd's states are mapped onto
 * systemd's words, so the supervisor reads both alike:
 *
 *   not loaded, no plist          not-found / inactive
 *   running                       loaded / active (running)
 *   spawn scheduled after a crash loaded / activating (auto-restart)
 *   not running, last exit 0      loaded / inactive (dead)
 *   not running, last exit not 0  loaded / failed
 *
 * launchd reads a plist when it is loaded, so a restart is `bootout` and
 * `bootstrap`; `bootout` returns before the job is gone, so every stop then
 * waits for the job's process group to empty (SIGKILL after `stopWaitMs`)
 * and for the label to leave the domain: a new process must never meet the
 * old one on the port.
 */

export type LaunchctlOptions = {
  run?: Runner;
  /** The space's LaunchAgents and the operator's: `~/Library/LaunchAgents`. */
  unitDir?: string;
  /** The operator's LaunchDaemons: `/Library/LaunchDaemons`. */
  systemDir?: string;
  /** `<workspace>/logs`: each app writes to `<app>/service.log` under it. */
  logDir: string;
  uid?: number;
  /** Whether a process of the group is still alive; default `kill(-pgid, 0)`. */
  groupAlive?: (pgid: number) => boolean;
  killGroup?: (pgid: number) => void;
  /** How long a stop waits for the processes before SIGKILL; default 35 s (the plist's ExitTimeOut is 30). */
  stopWaitMs?: number;
  /** Size at which `rotateLogs` keeps the log as `service.log.1` and starts it over; default 10 MiB. */
  maxLogBytes?: number;
};

/** What `launchctl print` exits with for a label the domain does not have. */
const NOT_FOUND = 113;

export class Launchctl implements ServiceManager {
  readonly kind = "launchd";
  readonly unitDir: string;
  readonly unavailable: string;
  private readonly run: Runner;
  private readonly systemDir: string;
  private readonly logDir: string;
  private readonly uid: number;
  private readonly groupAlive: (pgid: number) => boolean;
  private readonly killGroup: (pgid: number) => void;
  private readonly stopWaitMs: number;
  private readonly maxLogBytes: number;

  constructor(opts: LaunchctlOptions) {
    this.run = opts.run ?? spawnCollect;
    this.unitDir = opts.unitDir ?? join(homedir(), "Library", "LaunchAgents");
    this.systemDir = opts.systemDir ?? "/Library/LaunchDaemons";
    this.logDir = opts.logDir;
    this.uid = opts.uid ?? process.getuid?.() ?? 0;
    this.groupAlive = opts.groupAlive ?? groupAlive;
    this.killGroup = opts.killGroup ?? ((pgid) => void signalGroup(pgid, "SIGKILL"));
    this.stopWaitMs = opts.stopWaitMs ?? 35_000;
    this.maxLogBytes = opts.maxLogBytes ?? 10 * 1024 * 1024;
    this.unavailable = `no launchd GUI session for this user (launchctl print gui/${this.uid}); LaunchAgents run while the user is logged in: log in on the Mac (automatic login keeps it so after a reboot) or set SPACE_SUPERVISOR=operator`;
  }

  unitName(app: string): string {
    return launchLabel(app);
  }
  unitFile(app: string): string {
    return `${launchLabel(app)}.plist`;
  }
  appOfFile(file: string): string | undefined {
    return /^space\.(.+)\.plist$/.exec(file)?.[1];
  }
  operatorUnit(app: string): string {
    return app;
  }
  owns(text: string): boolean {
    return text.startsWith(PLIST_HEAD);
  }
  renderUnit(manifest: Manifest, command: string, envFile: string): string {
    return renderPlist({ app: manifest.app, dir: manifest.dir, command, envFile, logFile: this.logFile(manifest.app) });
  }
  renderEnv(vars: Record<string, string>): { text: string; skipped: string[] } {
    return renderShellEnv(vars);
  }
  /** launchd creates the log file but not its directory: without it the job never starts. */
  async prepare(app: string): Promise<void> {
    await mkdir(join(this.logDir, app), { recursive: true });
  }

  /** The `SPACE_SERVICE_LOGS`-style template that reads an app's log (`{app}` is the app's name). */
  logsTemplate(): string {
    return `tail -n {lines} {follow} '${this.logDir.replace(/'/g, `'\\''`)}'/{app}/service.log`;
  }

  /** Where an app's stdout and stderr go. */
  logFile(app: string): string {
    return join(this.logDir, app, "service.log");
  }

  /**
   * Keep each app's log under `maxLogBytes`: copy it to `service.log.1` and
   * truncate it in place. launchd holds the file open for appending, so the
   * app goes on writing at the new end; a rename would leave it writing to
   * the old file.
   */
  async rotateLogs(): Promise<string[]> {
    let apps: string[];
    try {
      apps = await readdir(this.logDir);
    } catch {
      return [];
    }
    const rotated: string[] = [];
    for (const app of apps) {
      const file = join(this.logDir, app, "service.log");
      const size = await stat(file).then((s) => s.size, () => 0);
      if (size <= this.maxLogBytes) continue;
      await copyFile(file, `${file}.1`);
      await truncate(file, 0);
      rotated.push(app);
    }
    return rotated;
  }

  async available(): Promise<boolean> {
    return (await this.run(["launchctl", "print", `gui/${this.uid}`])).code === 0;
  }

  async show(unit: string, scope: Scope = "user"): Promise<UnitState> {
    const r = await this.run(["launchctl", "print", this.target(unit, scope)]);
    const file = this.plistPath(unit, scope);
    const hasFile = await Bun.file(file).exists();
    const disabled = await this.disabled(unit, scope);
    const unitFileState = disabled ? "disabled" : hasFile ? "enabled" : "";
    if (r.code !== 0) {
      if (r.code !== NOT_FOUND && !/could not find service/i.test(r.stderr + r.stdout)) throw new Error(`launchctl print ${this.target(unit, scope)}: ${lastLine(r.stderr || r.stdout) || `exit ${r.code}`}`);
      return { loadState: hasFile ? "not-loaded" : "not-found", activeState: "inactive", subState: "dead", unitFileState, fragmentPath: hasFile ? file : "", restarts: 0, mainPid: 0 };
    }
    const kv = parsePrint(r.stdout);
    const pid = Number(kv.pid ?? 0) || 0;
    const runs = Number(kv.runs ?? 0) || 0;
    const exit = kv["last exit code"] ?? "";
    const state = kv.state ?? "";
    let activeState = "inactive";
    let subState = "dead";
    if (state === "running" || pid > 0) [activeState, subState] = ["active", "running"];
    else if (state === "spawn scheduled") [activeState, subState] = ["activating", "auto-restart"];
    else if (/^-?\d+$/.test(exit) && exit !== "0") [activeState, subState] = ["failed", "failed"];
    const since = pid > 0 ? await this.startedAt(pid) : undefined;
    return {
      loadState: "loaded",
      activeState,
      subState,
      unitFileState,
      fragmentPath: kv.path ?? (hasFile ? file : ""),
      restarts: Math.max(0, runs - 1),
      ...(since && activeState === "active" ? { since: since.toISOString() } : {}),
      mainPid: pid,
    };
  }

  /** launchd reads the plist when it loads it: there is no separate reload. */
  async daemonReload(): Promise<void> {}

  /** Switch the label on (it loads at login again) and load it now. */
  async enableNow(unit: string, scope: Scope = "user"): Promise<void> {
    await this.exec(["enable", this.target(unit, scope)], scope);
    await this.start(unit, scope);
  }

  /** Unload it and switch the label off, so it does not come back at the next login. */
  async disableNow(unit: string, scope: Scope = "user"): Promise<void> {
    await this.unload(unit, scope);
    await this.exec(["disable", this.target(unit, scope)], scope);
  }

  /**
   * Load it unless it is running. A label that is loaded but not running
   * (it exited, or crashes in a loop) is unloaded first, so launchd reads
   * the plist again and counts restarts from zero.
   */
  async start(unit: string, scope: Scope = "user"): Promise<void> {
    const s = await this.show(unit, scope);
    if (s.activeState === "active") return;
    if (s.loadState === "loaded") await this.unload(unit, scope, s.mainPid);
    await this.load(unit, scope);
  }

  /** Unloaded until the next sync or login, whichever comes first. */
  async stop(unit: string): Promise<void> {
    await this.unload(unit, "user");
  }

  async restart(unit: string): Promise<void> {
    await this.unload(unit, "user");
    await this.load(unit, "user");
  }

  /** launchd keeps no failed state once a label is unloaded. */
  async resetFailed(_unit: string): Promise<void> {}

  command(verb: Verb, unit: string, scope?: Scope): string {
    const sudo = scope === "system" ? "sudo " : "";
    const target = this.target(unit, scope ?? "user");
    switch (verb) {
      case "disable":
        return `${sudo}launchctl bootout ${target} && ${sudo}launchctl disable ${target}`;
      case "start":
        return `${sudo}launchctl bootstrap ${this.domain(scope ?? "user")} ${this.plistPath(unit, scope ?? "user")}`;
      case "stop":
        return `${sudo}launchctl bootout ${target}`;
      case "restart":
        return `${sudo}launchctl kickstart -k ${target}`;
    }
  }

  logHint(unit: string, scope: Scope): string {
    const app = scope === "user" ? this.appOfFile(`${unit}.plist`) : undefined;
    return app ? this.logFile(app) : `the StandardErrorPath of ${this.plistPath(unit, scope)} (launchctl print ${this.target(unit, scope)})`;
  }

  // ------------------------------------------------------------ helpers

  private domain(scope: Scope): string {
    return scope === "user" ? `gui/${this.uid}` : "system";
  }

  private target(unit: string, scope: Scope): string {
    return `${this.domain(scope)}/${unit}`;
  }

  private plistPath(unit: string, scope: Scope): string {
    return join(scope === "user" ? this.unitDir : this.systemDir, `${unit}.plist`);
  }

  private async load(unit: string, scope: Scope): Promise<void> {
    await this.exec(["bootstrap", this.domain(scope), this.plistPath(unit, scope)], scope);
  }

  /** `bootout`, then wait until the job's processes and its label are gone. */
  private async unload(unit: string, scope: Scope, pid?: number): Promise<void> {
    const target = this.target(unit, scope);
    const before = await this.run(["launchctl", "print", target]);
    if (before.code !== 0) return;
    // A system job's processes are root's: the space cannot signal them, and waits only for the label below.
    const pgid = scope === "system" ? 0 : (pid ?? (Number(parsePrint(before.stdout).pid ?? 0) || 0));
    await this.exec(["bootout", target], scope, (r) => r.code === 3 || r.code === NOT_FOUND || /no such process|could not find/i.test(r.stderr));
    const deadline = Date.now() + this.stopWaitMs;
    if (pgid > 0) {
      while (this.groupAlive(pgid) && Date.now() < deadline) await Bun.sleep(200);
      if (this.groupAlive(pgid)) {
        this.killGroup(pgid);
        for (let i = 0; i < 25 && this.groupAlive(pgid); i++) await Bun.sleep(200);
      }
    }
    // The label lingers for a moment after its processes; a bootstrap before then fails with EIO.
    for (let i = 0; i < 50; i++) {
      if ((await this.run(["launchctl", "print", target])).code !== 0) return;
      await Bun.sleep(100);
    }
  }

  private async disabled(unit: string, scope: Scope): Promise<boolean> {
    const r = await this.run(["launchctl", "print-disabled", this.domain(scope)]);
    const label = unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`"${label}"\\s*=>\\s*(disabled|true)\\b`).test(r.stdout);
  }

  private async startedAt(pid: number): Promise<Date | undefined> {
    const r = await this.run(["ps", "-o", "lstart=", "-p", String(pid)]);
    return r.code === 0 ? parseLstart(r.stdout) : undefined;
  }

  private async exec(args: string[], scope: Scope, ok?: (r: RunResult) => boolean): Promise<void> {
    const cmd = scope === "user" ? ["launchctl", ...args] : ["sudo", "-n", "launchctl", ...args];
    const r = await this.run(cmd);
    if (r.code !== 0 && !ok?.(r)) throw new Error(`${cmd.filter((a) => a !== "-n").join(" ")}: ${lastLine(r.stderr || r.stdout).replace(/^Try re-running.*$/, "") || `exit ${r.code}`}`);
  }
}

/** The top level of `launchctl print`: one tab of indent, `key = value`; nested blocks are skipped. */
export function parsePrint(text: string): Record<string, string> {
  const kv: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\t([a-z][a-z ]*?) = (.*)$/.exec(line);
    if (m && !m[2]!.endsWith("{") && kv[m[1]!] === undefined) kv[m[1]!] = m[2]!.trim();
  }
  return kv;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `ps -o lstart=`, `Wed Oct  7 00:53:12 2026`, as local time. */
export function parseLstart(text: string): Date | undefined {
  const m = /([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})/.exec(text);
  const month = m ? MONTHS.indexOf(m[1]!) : -1;
  if (!m || month < 0) return undefined;
  return new Date(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
}

function groupAlive(pgid: number): boolean {
  return signalGroup(pgid, 0);
}

function signalGroup(pgid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (e) {
    // EPERM: the group exists but is someone else's; for the space's own jobs that does not happen.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
