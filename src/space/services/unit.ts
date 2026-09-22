import type { Manifest } from "../scheduler/manifest.ts";

/**
 * What a supervised app looks like to systemd: one user unit and one
 * environment file, both rendered here from the manifest and the variables
 * the space hands over. Pure functions, so a golden test pins the text, and
 * the supervisor can tell "unchanged" from "changed" by comparing what it
 * would write with what is on disk (docs/supervision.md).
 */

/** First line of every unit ai-space writes; a unit without it is never touched. */
export const UNIT_MARKER = "# Written by ai-space. Do not edit: it is regenerated on every app sync.";

/** The unit of an app the space supervises. The operator's own units are named after the app. */
export function unitName(app: string): string {
  return `space-${app}.service`;
}

export type UnitInput = {
  app: string;
  title?: string;
  dir: string;
  command: string;
  envFile: string;
};

/**
 * The unit text. `KillMode=mixed` and `TimeoutStopSec=30` give the app's
 * main process the SIGTERM the contract promises (app-spec.md: exit within
 * 10 seconds) with room to spare before systemd kills what is left.
 */
export function renderUnit(u: UnitInput): string {
  return [
    UNIT_MARKER,
    "[Unit]",
    `Description=${specifiers(oneLine(u.title ?? u.app))} (ai-space app)`,
    `X-Space-App=${u.app}`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    `WorkingDirectory=${specifiers(u.dir)}`,
    `EnvironmentFile=${specifiers(u.envFile)}`,
    `ExecStart=/bin/sh -c ${execArg(u.command)}`,
    "Restart=on-failure",
    "RestartSec=5",
    "KillMode=mixed",
    "TimeoutStopSec=30",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function renderUnitFor(manifest: Manifest, command: string, envFile: string): string {
  return renderUnit({ app: manifest.app, ...(manifest.title ? { title: manifest.title } : {}), dir: manifest.dir, command, envFile });
}

export type EnvInput = {
  app: string;
  dir: string;
  port: number;
  /** The `PATH` of the space's own process: a user unit does not get the login shell's. */
  path?: string;
  /** The app's `.env`. */
  appEnv: Record<string, string>;
  /** What storage hands over (`space.env`): identity, token, databases, blob store. */
  spaceEnv: Record<string, string>;
  /** `service.env`, placeholders already resolved. */
  serviceEnv: Record<string, string>;
};

/**
 * The environment of the process, in app-spec.md's increasing precedence:
 * the app's `.env`, `space.env`, `service.env`, then what the space sets.
 * `PATH` comes first of all, so an app's `.env` may still extend it.
 */
export function serviceEnv(e: EnvInput): Record<string, string> {
  return {
    ...(e.path ? { PATH: e.path } : {}),
    ...e.appEnv,
    ...e.spaceEnv,
    ...e.serviceEnv,
    PORT: String(e.port),
    SPACE_APP: e.app,
    SPACE_APP_DIR: e.dir,
    ...pick(e.spaceEnv, ["SPACE_APP_DATA_DIR", "SPACE_API_URL", "SPACE_NAME"]),
  };
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * An `EnvironmentFile=` for the variables: one `KEY="value"` line each, with
 * `\` and `"` escaped. A name systemd would not accept, or a value with a
 * line break (which the format cannot hold), is left out and reported in
 * `skipped` rather than written half-way.
 */
export function renderEnvFile(vars: Record<string, string>): { text: string; skipped: string[] } {
  const lines = ["# Written by ai-space for the unit of this app; regenerated on every app sync."];
  const skipped: string[] = [];
  for (const [k, v] of Object.entries(vars)) {
    if (!ENV_KEY_RE.test(k) || /[\r\n]/.test(v)) {
      skipped.push(k);
      continue;
    }
    lines.push(`${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  }
  return { text: lines.join("\n") + "\n", skipped };
}

/**
 * The command as one double-quoted `ExecStart=` word: systemd unquotes it,
 * so `\` and `"` are escaped for that, and `%` and `$` are doubled so
 * systemd neither expands specifiers nor environment variables in it;
 * the shell sees exactly the manifest's command. A command over several
 * lines has no faithful one-line form, so it is refused.
 */
export function execArg(command: string): string {
  if (/[\r\n]/.test(command.trim())) throw new Error("service.command must be a single line for the space to supervise it; move the lines into a script");
  return `"${specifiers(command.trim()).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "$$$$")}"`;
}

function specifiers(s: string): string {
  return s.replace(/%/g, "%%");
}

function oneLine(s: string): string {
  return s.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

function pick(vars: Record<string, string>, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) if (vars[k] !== undefined) out[k] = vars[k];
  return out;
}
