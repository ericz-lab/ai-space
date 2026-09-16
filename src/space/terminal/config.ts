/**
 * Terminal configuration: `SPACE_TERMINAL_*` in the workspace .env.
 *
 *   SPACE_TERMINAL_ENABLED=1            off by default: a shell over HTTP is opt-in
 *   SPACE_TERMINAL_SHELL=/bin/zsh -l    the command a session runs; default: $SHELL -l, else bash, else sh
 *   SPACE_TERMINAL_PASSPHRASE=…         optional second check typed in the browser before a session opens
 *   SPACE_TERMINAL_IDLE=30m             a session with no keystroke for this long is closed; 0 = never
 *   SPACE_TERMINAL_MAX_SESSIONS=4       open sessions (and unredeemed tickets) at the same time
 *
 * The client never chooses the command, the directory or the environment:
 * everything about what runs comes from here.
 */

export type TerminalConfig = {
  enabled: boolean;
  /** Command and arguments of the shell a session runs. */
  shell: string[];
  /** Empty = no passphrase. */
  passphrase: string;
  /** Idle limit in milliseconds; 0 = none. */
  idleMs: number;
  maxSessions: number;
};

export const DEFAULT_IDLE_MS = 30 * 60_000;
export const DEFAULT_MAX_SESSIONS = 4;

export type TerminalLoad = { config: TerminalConfig; warnings: string[] };

export function loadTerminalConfig(env: Record<string, string | undefined> = process.env): TerminalLoad {
  const warnings: string[] = [];
  const enabled = isOn(env.SPACE_TERMINAL_ENABLED);
  const shell = parseShell(env.SPACE_TERMINAL_SHELL, env);
  let idleMs = DEFAULT_IDLE_MS;
  try {
    idleMs = parseIdle(env.SPACE_TERMINAL_IDLE);
  } catch (e) {
    warnings.push(`${(e as Error).message}; using 30m`);
  }
  const rawMax = env.SPACE_TERMINAL_MAX_SESSIONS?.trim();
  let maxSessions = DEFAULT_MAX_SESSIONS;
  if (rawMax) {
    const n = Number(rawMax);
    if (Number.isInteger(n) && n >= 1 && n <= 64) maxSessions = n;
    else warnings.push(`SPACE_TERMINAL_MAX_SESSIONS must be an integer from 1 to 64; using ${DEFAULT_MAX_SESSIONS}`);
  }
  const passphrase = env.SPACE_TERMINAL_PASSPHRASE ?? "";
  if (passphrase && passphrase.length < 8) warnings.push("SPACE_TERMINAL_PASSPHRASE is shorter than 8 characters");
  return { config: { enabled, shell, passphrase, idleMs, maxSessions }, warnings };
}

export function isOn(raw: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((raw ?? "").trim());
}

/** `SPACE_TERMINAL_SHELL` split on whitespace (no quoting: a path with spaces goes through $SHELL), else `$SHELL -l`, else bash or sh. */
export function parseShell(raw: string | undefined, env: Record<string, string | undefined>): string[] {
  const parts = (raw ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length) return parts;
  const sh = env.SHELL?.trim();
  if (sh) return [sh, "-l"];
  const found = Bun.which("bash") ?? Bun.which("sh") ?? "/bin/sh";
  return [found, "-l"];
}

/** `30m`, `2h`, `90s`, plain seconds, or `0` for never. */
export function parseIdle(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_IDLE_MS;
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h)?$/);
  if (!m) throw new Error(`SPACE_TERMINAL_IDLE "${raw}" is not a duration (30m, 2h, 90s, 0)`);
  const n = Number(m[1]);
  const ms = m[2] === "m" ? n * 60_000 : m[2] === "h" ? n * 3_600_000 : n * 1000;
  return ms === 0 ? 0 : Math.max(10_000, Math.round(ms));
}

/**
 * Variables kept out of a session's environment. The shell runs as the
 * operator's user, who can read the workspace .env anyway; this only keeps
 * credentials off the screen (`env`, a shared recording, a screenshot) and
 * out of anything the shell spawns by accident.
 */
const SECRET_RE = /(TOKEN|SECRET|PASSWORD|PASSPHRASE|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?)$/i;

export function sessionEnv(base: Record<string, string | undefined>, extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || SECRET_RE.test(k)) continue;
    out[k] = v;
  }
  out.TERM = "xterm-256color";
  out.COLORTERM = "truecolor";
  if (!out.LANG && !out.LC_ALL) out.LANG = "C.UTF-8";
  return { ...out, ...extra };
}
