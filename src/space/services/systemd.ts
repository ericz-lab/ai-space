import { homedir } from "node:os";
import { join } from "node:path";
import type { Manifest } from "../scheduler/manifest.ts";
import { type Runner, type Scope, type ServiceManager, type UnitState, type Verb, lastLine, spawnCollect } from "./manager.ts";
import { UNIT_MARKER, renderEnvFile, renderUnitFor, unitName } from "./unit.ts";

/**
 * `systemctl` for the supervisor on Linux: user units by default, the system
 * manager only to look (an operator's unit installed with sudo) and, in a
 * hand-over, through `sudo -n`. The runner is injected, so tests assert the
 * exact command sequence with a fake.
 */

export type { RunResult, Runner, UnitState } from "./manager.ts";

const PROPS = ["LoadState", "ActiveState", "SubState", "UnitFileState", "FragmentPath", "NRestarts", "ActiveEnterTimestamp", "MainPID"];

export class Systemctl implements ServiceManager {
  readonly kind = "systemd";
  readonly unitDir: string;
  readonly unavailable = "no systemd user manager answers (systemctl --user); enable lingering (loginctl enable-linger) or set SPACE_SUPERVISOR=operator";
  private readonly run: Runner;

  /** `unitDir` defaults to `$XDG_CONFIG_HOME/systemd/user`, `~/.config/systemd/user` without it. */
  constructor(opts: { run?: Runner; unitDir?: string } = {}) {
    this.run = opts.run ?? spawnCollect;
    this.unitDir = opts.unitDir ?? join(process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"), "systemd", "user");
  }

  unitName(app: string): string {
    return unitName(app);
  }
  unitFile(app: string): string {
    return unitName(app);
  }
  appOfFile(file: string): string | undefined {
    return /^space-(.+)\.service$/.exec(file)?.[1];
  }
  operatorUnit(app: string): string {
    return `${app}.service`;
  }
  owns(text: string): boolean {
    return text.startsWith(UNIT_MARKER);
  }
  renderUnit(manifest: Manifest, command: string, envFile: string): string {
    return renderUnitFor(manifest, command, envFile);
  }
  renderEnv(vars: Record<string, string>): { text: string; skipped: string[] } {
    return renderEnvFile(vars);
  }

  command(verb: Verb, unit: string, scope?: Scope): string {
    const ctl = scope === "system" ? "sudo systemctl" : scope === "user" ? "systemctl --user" : "systemctl";
    return `${ctl} ${verb === "disable" ? "disable --now" : verb} ${unit}`;
  }
  logHint(unit: string, scope: Scope): string {
    return `journalctl ${scope === "user" ? "--user " : ""}-u ${unit}`;
  }

  /** True when a user manager answers: the precondition of `SPACE_SUPERVISOR=space`. */
  async available(): Promise<boolean> {
    const r = await this.run(["systemctl", "--user", "is-system-running"]);
    // Exit 1 with "degraded" still means a manager that answers; only a missing one prints nothing useful.
    return /^(running|degraded|starting|initializing|maintenance)/.test(r.stdout.trim());
  }

  async show(unit: string, scope: Scope = "user"): Promise<UnitState> {
    const r = await this.run(["systemctl", ...(scope === "user" ? ["--user"] : []), "show", "-p", PROPS.join(","), "--", unit]);
    if (r.code !== 0 && !r.stdout.trim()) throw new Error(`systemctl show ${unit}: ${lastLine(r.stderr) || `exit ${r.code}`}`);
    const kv: Record<string, string> = {};
    for (const line of r.stdout.split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim();
    }
    const since = kv.ActiveEnterTimestamp ? parseTimestamp(kv.ActiveEnterTimestamp) : undefined;
    return {
      loadState: kv.LoadState ?? "",
      activeState: kv.ActiveState ?? "",
      subState: kv.SubState ?? "",
      unitFileState: kv.UnitFileState ?? "",
      fragmentPath: kv.FragmentPath ?? "",
      restarts: Number(kv.NRestarts ?? 0) || 0,
      ...(since && !Number.isNaN(since.getTime()) && kv.ActiveState === "active" ? { since: since.toISOString() } : {}),
      mainPid: Number(kv.MainPID ?? 0) || 0,
    };
  }

  daemonReload(): Promise<void> {
    return this.user(["daemon-reload"]);
  }
  /** `system` goes through `sudo -n`: only a hand-over touches an operator's system unit, and it must not prompt. */
  enableNow(unit: string, scope: Scope = "user"): Promise<void> {
    return this.exec(["enable", "--now", "--", unit], scope);
  }
  disableNow(unit: string, scope: Scope = "user"): Promise<void> {
    return this.exec(["disable", "--now", "--", unit], scope);
  }
  start(unit: string, scope: Scope = "user"): Promise<void> {
    return this.exec(["start", "--", unit], scope);
  }
  stop(unit: string): Promise<void> {
    return this.user(["stop", "--", unit]);
  }
  restart(unit: string): Promise<void> {
    return this.user(["restart", "--", unit]);
  }
  /** Forget a failed state, so a unit removed after crashing does not linger in `systemctl --user --failed`. */
  async resetFailed(unit: string): Promise<void> {
    await this.run(["systemctl", "--user", "reset-failed", "--", unit]);
  }

  private user(args: string[]): Promise<void> {
    return this.exec(args, "user");
  }

  private async exec(args: string[], scope: Scope): Promise<void> {
    const cmd = scope === "user" ? ["systemctl", "--user", ...args] : ["sudo", "-n", "systemctl", ...args];
    const r = await this.run(cmd);
    if (r.code !== 0) throw new Error(`${cmd.filter((a) => a !== "--").join(" ")}: ${lastLine(r.stderr || r.stdout) || `exit ${r.code}`}`);
  }
}

/**
 * A `systemctl show` timestamp, `Sun 2026-09-27 17:18:09 CST`, as local time.
 * The zone is an abbreviation JavaScript either misreads (`CST` is taken as
 * US Central, not China) or rejects (`KST`); systemd prints in the machine's
 * zone, which is this process's too, so the wall-clock part is enough.
 * `@<seconds>` (`--timestamp=unix`) is taken as is.
 */
export function parseTimestamp(text: string): Date | undefined {
  const unix = /^@(\d+)$/.exec(text);
  if (unix) return new Date(Number(unix[1]) * 1000);
  const m = /(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(text);
  if (!m) return undefined;
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  return new Date(y, mo - 1, d, h, mi, se);
}
