import type { Manifest } from "../scheduler/manifest.ts";

/**
 * The service manager behind the supervisor: systemd user units on Linux
 * (`systemd.ts`), launchd LaunchAgents on macOS (`launchd.ts`). The
 * supervisor decides what should happen (docs/supervision.md); a manager
 * knows where the space's unit of an app lives, how it is written, and the
 * commands that load, start, stop and remove it. Both take an injected
 * runner, so tests assert the exact command sequence with a fake.
 */

export type RunResult = { code: number; stdout: string; stderr: string };
export type Runner = (cmd: string[]) => Promise<RunResult>;

/** `user`: the logged-in user's manager. `system`: the machine's, where an operator may have installed a unit with sudo. */
export type Scope = "user" | "system";

/** What the manager says about one unit, in systemd's words; launchd's states are mapped onto them. */
export type UnitState = {
  /** `not-found` when the manager knows no unit of that name and no file declares one. */
  loadState: string;
  activeState: string;
  subState: string;
  /** `enabled` when it starts by itself (at boot or login), `disabled` when switched off, empty without a file. */
  unitFileState: string;
  fragmentPath: string;
  /** Restarts the manager made after a crash since the unit was last started by hand. */
  restarts: number;
  /** When the unit last became active, ISO 8601; absent while it is not. */
  since?: string;
  mainPid: number;
};

export type ManagerKind = "systemd" | "launchd";

/** What the operator would type, for messages: `disable` also stops. */
export type Verb = "disable" | "start" | "stop" | "restart";

export interface ServiceManager {
  readonly kind: ManagerKind;
  /** Where the space's units live: `~/.config/systemd/user` or `~/Library/LaunchAgents`. */
  readonly unitDir: string;
  /** The space's unit of an app, as the manager names it. */
  unitName(app: string): string;
  /** Its file name in `unitDir`. */
  unitFile(app: string): string;
  /** The app behind a file in `unitDir` that looks like one of the space's, for the sweep. */
  appOfFile(file: string): string | undefined;
  /** The operator's unit, named after the app. */
  operatorUnit(app: string): string;
  /** Whether a unit file was written by the space: anything else of that name is never touched. */
  owns(text: string): boolean;
  renderUnit(manifest: Manifest, command: string, envFile: string): string;
  /** The environment file the unit reads; names or values the format cannot hold are left out and listed. */
  renderEnv(vars: Record<string, string>): { text: string; skipped: string[] };
  /** Whatever must exist before the unit starts (launchd: the log directory). */
  prepare?(app: string): Promise<void>;

  /** True when a manager answers that can run the space's units. */
  available(): Promise<boolean>;
  /** Why `available` said no, and what to do about it. */
  readonly unavailable: string;
  show(unit: string, scope?: Scope): Promise<UnitState>;
  daemonReload(): Promise<void>;
  enableNow(unit: string, scope?: Scope): Promise<void>;
  disableNow(unit: string, scope?: Scope): Promise<void>;
  start(unit: string, scope?: Scope): Promise<void>;
  stop(unit: string): Promise<void>;
  restart(unit: string): Promise<void>;
  /** Forget a failed state after a unit is removed. */
  resetFailed(unit: string): Promise<void>;

  /** The command line an operator runs for `verb` on a unit; without a scope, the plain form. */
  command(verb: Verb, unit: string, scope?: Scope): string;
  /** Where to read why a unit failed. */
  logHint(unit: string, scope: Scope): string;
}

export function lastLine(text: string): string {
  return text.trim().split("\n").at(-1)?.trim() ?? "";
}

export async function spawnCollect(cmd: string[]): Promise<RunResult> {
  try {
    const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: process.env });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr };
  } catch (e) {
    return { code: 127, stdout: "", stderr: (e as Error).message };
  }
}
