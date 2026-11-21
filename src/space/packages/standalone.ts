import { chmod, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ServiceManager } from "../services/manager.ts";
import { renderPlist } from "../services/plist.ts";
import { renderUnit } from "../services/unit.ts";
import type { RuntimeApp, StandaloneHost } from "./runtime.ts";

/**
 * A package app the owner switched to run on its own (docs/app-packages.md#running-on-its-own):
 * one service of the operating system per app, a systemd user unit or a LaunchAgent, written and
 * driven by the Space but not a child of it, so the app keeps running while the Space is
 * restarted, upgraded or stopped, comes back after a crash and starts at login.
 *
 * The service is named after the app and this Space's identity (`space-<app>-<id>.service`,
 * `space.<app>-<id>`): two workspaces of one user never meet on a name. Its environment file is
 * `<workspace>/run/env/<app>-<id>.env`, which is how `space uninstall` and the supervisor's sweep
 * tell this workspace's units from anyone else's. Output goes to the app's `package.log`, where
 * the Space's own child processes write it.
 */
export type StandaloneOptions = {
  manager: ServiceManager;
  /** The Space's identity; its first 8 characters go into the service names. */
  spaceId: string;
  /** `<workspace>/run/env`. */
  envDir: string;
  /** `<workspace>/logs`. */
  logDir: string;
  /** The Bun that runs `runtime: bun` apps; default this process's. */
  bun?: string;
  /** `PATH` of the app's process; default this process's. */
  path?: string;
};

export class StandaloneServices implements StandaloneHost {
  private readonly suffix: string;
  constructor(private readonly opts: StandaloneOptions) {
    this.suffix = opts.spaceId.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase();
    if (this.suffix.length < 8) throw new Error("a Space identity of at least 8 characters is required");
  }

  /** The app's name in service and file names. */
  key(app: string): string { return `${app}-${this.suffix}`; }
  unit(app: string): string { return this.opts.manager.unitName(this.key(app)); }
  /** Every key of this Space's the sweep of `SPACE_SUPERVISOR=space` must leave alone. */
  isKey(name: string): boolean { return name.endsWith(`-${this.suffix}`); }
  envFile(app: string): string { return join(this.opts.envDir, `${this.key(app)}.env`); }
  private unitPath(app: string): string { return join(this.opts.manager.unitDir, this.opts.manager.unitFile(this.key(app))); }

  async unavailable(): Promise<string | undefined> {
    return (await this.opts.manager.available()) ? undefined : this.opts.manager.unavailable.replace(/ or set SPACE_SUPERVISOR=operator$/, "");
  }

  /** The service file and the environment file of this version of the app, as text. */
  render(app: RuntimeApp, port: number, env: Record<string, string>): { unit: string; env: string; skipped: string[] } {
    const launch = app.manifest.launch;
    if (launch?.kind !== "process") throw new Error("not a process application");
    const name = app.manifest.app;
    const entry = join(app.dir, launch.entry);
    const command = (launch.runtime === "bun" ? [this.opts.bun ?? process.execPath, entry, ...launch.args] : [entry, ...launch.args]).map(shellWord).join(" ");
    const envFile = this.envFile(name);
    const logFile = join(this.opts.logDir, name, "package.log");
    const vars = { PATH: this.opts.path ?? process.env.PATH ?? "", ...env, PORT: String(port), SPACE_APP: name, SPACE_APP_DIR: app.dir };
    const rendered = this.opts.manager.renderEnv(vars);
    const unit = this.opts.manager.kind === "launchd"
      ? renderPlist({ app: this.key(name), dir: app.dir, command, envFile, logFile })
      // systemd would send the output to the journal; the Space reads the app's log file.
      : renderUnit({ app: name, title: app.manifest.title ?? name, dir: app.dir, command, envFile })
        .replace("\nRestart=always\n", `\nStandardOutput=append:${logFile.replace(/%/g, "%%")}\nStandardError=append:${logFile.replace(/%/g, "%%")}\nRestart=always\n`);
    return { unit, env: rendered.text, skipped: rendered.skipped };
  }

  async start(app: RuntimeApp, port: number, env: Record<string, string>): Promise<void> {
    const name = app.manifest.app;
    const mgr = this.opts.manager;
    const unit = this.unit(name);
    const text = this.render(app, port, env);
    if (text.skipped.length) throw new Error(`variables the service's environment file cannot hold: ${text.skipped.join(", ")}`);
    const [unitOnDisk, envOnDisk] = await Promise.all([readText(this.unitPath(name)), readText(this.envFile(name))]);
    const changed = unitOnDisk !== text.unit || envOnDisk !== text.env;
    if (changed) {
      await mkdir(this.opts.envDir, { recursive: true, mode: 0o700 });
      await mkdir(mgr.unitDir, { recursive: true });
      await mkdir(join(this.opts.logDir, name), { recursive: true });
      await Bun.write(this.envFile(name), text.env);
      await chmod(this.envFile(name), 0o600); // it holds the app's credentials; Bun.write follows the umask
      await Bun.write(this.unitPath(name), text.unit);
      await mgr.daemonReload();
      // A running process still has the old version, port or environment.
      if ((await mgr.show(unit)).activeState === "active") await mgr.stop(unit);
    }
    await mgr.enableNow(unit);
  }

  async stop(app: string): Promise<void> {
    if ((await readText(this.unitPath(app))) === undefined) return;
    await this.opts.manager.disableNow(this.unit(app));
  }

  async remove(app: string): Promise<void> {
    const mgr = this.opts.manager;
    if ((await readText(this.unitPath(app))) !== undefined) {
      // launchd keeps a "disabled" entry per label for ever; a label that is going away is only unloaded.
      await (mgr.kind === "launchd" ? mgr.stop(this.unit(app)) : mgr.disableNow(this.unit(app))).catch(() => {});
      await rm(this.unitPath(app), { force: true });
      await mgr.daemonReload().catch(() => {});
      await mgr.resetFailed(this.unit(app)).catch(() => {});
    }
    await rm(this.envFile(app), { force: true });
  }

  async state(app: string): Promise<{ active: boolean; pid?: number; since?: string }> {
    const s = await this.opts.manager.show(this.unit(app));
    return { active: s.activeState === "active", ...(s.mainPid ? { pid: s.mainPid } : {}), ...(s.since ? { since: s.since } : {}) };
  }
}

/** One argument of a `/bin/sh -c` command line. */
function shellWord(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

async function readText(path: string): Promise<string | undefined> {
  try { return await Bun.file(path).text(); } catch { return undefined; }
}
