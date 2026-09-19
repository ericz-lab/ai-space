import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Manifest } from "./scheduler/manifest.ts";
import type { Workspace } from "./workspace.ts";

/**
 * Apps a space comes with, and the per-machine overrides that let a public
 * app's manifest stay generic.
 *
 * Default apps are cloned into `apps/` by `init` when their directory is
 * absent, and their own `deploy/install.sh` is run by `install-defaults`
 * once ai-space is up (`deploy/install.sh` does both, in that order, so the
 * app's `space.env` exists before its service starts), so a fresh space has
 * something on its panel before the operator writes a line.
 * `SPACE_DEFAULT_APPS` in the workspace `.env` (or the environment) replaces
 * the list: `none` installs nothing, otherwise a comma-separated list of
 * clone URLs, each optionally `name=url`. An app that was uninstalled is not
 * brought back: cloning happens only when the directory is absent.
 *
 * `SPACE_APP_URL_<NAME>` (the app name uppercased, `-` and `.` as `_`)
 * replaces the `url` of that app's manifest, so an app checked out from a
 * public repository can point its tile at this machine's hostname.
 */

export type DefaultApp = { name: string; repo: string };

export const DEFAULT_APPS: DefaultApp[] = [{ name: "ai-usage", repo: "https://github.com/ericz-lab/ai-usage.git" }];

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function parseDefaultApps(env: Record<string, string | undefined>): DefaultApp[] {
  const raw = env.SPACE_DEFAULT_APPS;
  if (raw === undefined) return DEFAULT_APPS;
  const text = raw.trim();
  if (!text || ["none", "off", "0", "false"].includes(text.toLowerCase())) return [];
  const out: DefaultApp[] = [];
  for (const part of text.split(",")) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf("=");
    const repo = (eq > 0 ? p.slice(eq + 1) : p).trim();
    const name = (eq > 0 ? p.slice(0, eq) : basename(repo).replace(/\.git$/, "")).trim().toLowerCase();
    if (!NAME_RE.test(name)) throw new Error(`SPACE_DEFAULT_APPS: "${name}" is not an app name (lowercase letters, digits, . _ -)`);
    if (!/^(https?:\/\/|git@|ssh:\/\/|\/)/.test(repo)) throw new Error(`SPACE_DEFAULT_APPS: "${repo}" is not a clone URL`);
    out.push({ name, repo });
  }
  return out;
}

export type InstallReport = { name: string; status: "present" | "cloned" | "installed" | "absent" | "no-installer" | "failed"; detail?: string };

export type InstallOptions = {
  /** Run a command in a directory; resolves to the exit code and the last lines of output. */
  run?: (cmd: string[], cwd: string) => Promise<{ code: number; output: string }>;
  log?: (line: string) => void;
};

const lastLine = (output: string, fallback: string) => output.trim().split("\n").at(-1) || fallback;

/** Clone every missing default app; failures are reported, never thrown. */
export async function cloneDefaultApps(ws: Workspace, apps: DefaultApp[], opts: InstallOptions = {}): Promise<InstallReport[]> {
  const run = opts.run ?? runCommand;
  const log = opts.log ?? (() => {});
  const reports: InstallReport[] = [];
  for (const app of apps) {
    const dir = join(ws.apps, app.name);
    if (await exists(dir)) {
      reports.push({ name: app.name, status: "present" });
      continue;
    }
    log(`cloning ${app.repo} into ${dir}`);
    const clone = await run(["git", "clone", "--quiet", app.repo, dir], ws.apps);
    if (clone.code !== 0) reports.push({ name: app.name, status: "failed", detail: `git clone: ${lastLine(clone.output, `exit ${clone.code}`)}` });
    else reports.push({ name: app.name, status: "cloned" });
  }
  return reports;
}

/** Run `deploy/install.sh` of every default app that is present and ships one; idempotent by the apps' contract. */
export async function installDefaultApps(ws: Workspace, apps: DefaultApp[], opts: InstallOptions = {}): Promise<InstallReport[]> {
  const run = opts.run ?? runCommand;
  const log = opts.log ?? (() => {});
  const reports: InstallReport[] = [];
  for (const app of apps) {
    const dir = join(ws.apps, app.name);
    if (!(await exists(dir))) {
      reports.push({ name: app.name, status: "absent" });
      continue;
    }
    const installer = join(dir, "deploy", "install.sh");
    if (!(await exists(installer))) {
      reports.push({ name: app.name, status: "no-installer" });
      continue;
    }
    log(`running ${installer}`);
    const inst = await run(["bash", installer], dir);
    if (inst.code !== 0) reports.push({ name: app.name, status: "failed", detail: `deploy/install.sh: ${lastLine(inst.output, `exit ${inst.code}`)}` });
    else reports.push({ name: app.name, status: "installed", detail: lastLine(inst.output, "") || undefined });
  }
  return reports;
}

export function describeInstalls(reports: InstallReport[]): string {
  if (!reports.length) return "none";
  return reports.map((r) => `${r.name} ${r.status}${r.detail ? ` (${r.detail})` : ""}`).join(", ");
}

/** The environment variable that overrides an app's `url`: `ai-usage` -> `SPACE_APP_URL_AI_USAGE`. */
export function urlOverrideKey(app: string): string {
  return `SPACE_APP_URL_${app.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/** The manifest with this machine's overrides applied; unchanged when none is set. */
export function applyEnvOverrides(manifest: Manifest, env: Record<string, string | undefined>): Manifest {
  const url = env[urlOverrideKey(manifest.app)]?.trim();
  if (!url) return manifest;
  if (!/^https?:\/\//.test(url)) throw new Error(`${urlOverrideKey(manifest.app)} must start with http:// or https://`);
  return { ...manifest, url };
}

async function runCommand(cmd: string[], cwd: string): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn(cmd, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: process.env });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, output: (out + err).slice(-2000) };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
