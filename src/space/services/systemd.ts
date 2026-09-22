/**
 * `systemctl` for the supervisor: user units by default, the system manager
 * only to look (an operator's unit installed with sudo). The runner is
 * injected, so tests assert the exact command sequence with a fake.
 */

export type RunResult = { code: number; stdout: string; stderr: string };
export type Runner = (cmd: string[]) => Promise<RunResult>;

/** What `systemctl show` says about one unit; empty strings when systemd does not know it. */
export type UnitState = {
  loadState: string;
  activeState: string;
  subState: string;
  unitFileState: string;
  fragmentPath: string;
  /** Restarts systemd made after a crash since the unit was last started by hand. */
  restarts: number;
  /** When the unit last became active, ISO 8601; absent while it is not. */
  since?: string;
  mainPid: number;
};

const PROPS = ["LoadState", "ActiveState", "SubState", "UnitFileState", "FragmentPath", "NRestarts", "ActiveEnterTimestamp", "MainPID"];

export class Systemctl {
  private readonly run: Runner;

  constructor(opts: { run?: Runner } = {}) {
    this.run = opts.run ?? spawnCollect;
  }

  /** True when a user manager answers: the precondition of `SPACE_SUPERVISOR=space`. */
  async available(): Promise<boolean> {
    const r = await this.run(["systemctl", "--user", "is-system-running"]);
    // Exit 1 with "degraded" still means a manager that answers; only a missing one prints nothing useful.
    return /^(running|degraded|starting|initializing|maintenance)/.test(r.stdout.trim());
  }

  async show(unit: string, scope: "user" | "system" = "user"): Promise<UnitState> {
    const r = await this.run(["systemctl", ...(scope === "user" ? ["--user"] : []), "show", "-p", PROPS.join(","), "--", unit]);
    if (r.code !== 0 && !r.stdout.trim()) throw new Error(`systemctl show ${unit}: ${lastLine(r.stderr) || `exit ${r.code}`}`);
    const kv: Record<string, string> = {};
    for (const line of r.stdout.split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim();
    }
    const since = kv.ActiveEnterTimestamp ? new Date(kv.ActiveEnterTimestamp.replace(/^\w{3} /, "")) : undefined;
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
  enableNow(unit: string): Promise<void> {
    return this.user(["enable", "--now", "--", unit]);
  }
  disableNow(unit: string): Promise<void> {
    return this.user(["disable", "--now", "--", unit]);
  }
  start(unit: string): Promise<void> {
    return this.user(["start", "--", unit]);
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

  private async user(args: string[]): Promise<void> {
    const r = await this.run(["systemctl", "--user", ...args]);
    if (r.code !== 0) throw new Error(`systemctl --user ${args.filter((a) => a !== "--").join(" ")}: ${lastLine(r.stderr || r.stdout) || `exit ${r.code}`}`);
  }
}

function lastLine(text: string): string {
  return text.trim().split("\n").at(-1)?.trim() ?? "";
}

async function spawnCollect(cmd: string[]): Promise<RunResult> {
  try {
    const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: process.env });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr };
  } catch (e) {
    return { code: 127, stdout: "", stderr: (e as Error).message };
  }
}
