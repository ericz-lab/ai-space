import { chmod, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Manifest } from "../scheduler/manifest.ts";
import { interpolate as interpolateEnv, loadAppEnv } from "../scheduler/targets.ts";
import { type Systemctl, type UnitState } from "./systemd.ts";
import { UNIT_MARKER, renderEnvFile, renderUnitFor, serviceEnv, unitName } from "./unit.ts";

/**
 * Service supervision (docs/supervision.md). Under `SPACE_SUPERVISOR=space`
 * the space owns one user unit per app, `space-<app>.service`, and keeps it
 * in step with the manifest on every sync:
 *
 *   should run, no unit                   write, enable --now
 *   should run, unit or env changed       rewrite, daemon-reload, restart
 *   should run, unchanged, not running    start
 *   should run, unchanged, running        nothing
 *   should not run, a unit of ours        disable --now, delete unit and env file
 *   a unit of that name not written here  refuse: conflict
 *
 * "Should run" is `service` declared and `status: active`, the same line the
 * scheduler draws for tasks. "Changed" is the rendered text against the file
 * on disk, so a sync that changes nothing never restarts an app. Before a
 * start, an operator unit named after the app that is enabled or running
 * is a conflict too: two processes would fight for the port.
 *
 * Under `SPACE_SUPERVISOR=operator` nothing here acts: the operator's units
 * run the apps, and the space only probes and stops them as before.
 */

export type SupervisorMode = "space" | "operator";

export type ApplyAction = "operator" | "unchanged" | "installed" | "restarted" | "started" | "removed" | "absent" | "conflict" | "failed";

export type ApplyResult = {
  app: string;
  action: ApplyAction;
  at: number;
  error?: string;
  /** Variables left out of the environment file (a name or value the format cannot hold). */
  skippedEnv?: string[];
  /** After a start: whether the health path answered within the wait; absent without a health path. */
  health?: "pending" | "ok" | "down";
};

export type ServiceStatus = {
  app: string;
  supervisor: SupervisorMode;
  /** The unit that runs the app: `space-<app>.service` under the space, the operator's `<app>.service` otherwise. */
  unit: string;
  scope: "user" | "system";
  /** A unit written by the space exists for the app. */
  managed: boolean;
  state?: UnitState;
  last?: ApplyResult;
};

export type SupervisorOptions = {
  mode: SupervisorMode;
  /** `~/.config/systemd/user`. */
  unitDir: string;
  /** `<workspace>/run/env`: one environment file per supervised app. */
  envDir: string;
  systemctl: Systemctl;
  /** The variables storage hands the app (`space.env`). */
  envFor: (app: string) => Promise<Record<string, string>>;
  /** The app's own `.env`; default reads `<dir>/.env`. */
  appEnv?: (dir: string) => Promise<Record<string, string>>;
  /** `${VAR}` resolution for the command and `service.env`; default: the space's environment. */
  interpolate?: (text: string) => string;
  /** `PATH` for the unit; default: the space's own. */
  path?: string;
  /** One probe of the app's health path; with it, a start is followed by a wait for the first `ok`. */
  probe?: (port: number, path: string) => Promise<"ok" | "down">;
  /** How long a start waits for health before recording `down`; default 30 s. */
  healthWaitMs?: number;
  log?: (line: string) => void;
};

export class Supervisor {
  private readonly last = new Map<string, ApplyResult>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly log: (line: string) => void;
  private manager?: Promise<boolean>;

  constructor(private readonly opts: SupervisorOptions) {
    this.log = opts.log ?? (() => {});
  }

  get mode(): SupervisorMode {
    return this.opts.mode;
  }

  unitOf(app: string): string {
    return this.opts.mode === "space" ? unitName(app) : `${app}.service`;
  }

  /** Bring the app's unit in line with its manifest. Never throws: the outcome is recorded and returned. */
  apply(manifest: Manifest): Promise<ApplyResult> {
    return this.serial(manifest.app, async () => {
      if (this.opts.mode === "operator") return this.record({ app: manifest.app, action: "operator", at: Date.now() });
      try {
        return this.record(await this.reconcile(manifest));
      } catch (e) {
        this.log(`${manifest.app}: ${(e as Error).message}`);
        return this.record({ app: manifest.app, action: "failed", at: Date.now(), error: (e as Error).message });
      }
    });
  }

  /** Stop and delete the space's unit of an app (uninstall). `removed: false` when there was none. */
  remove(app: string): Promise<{ removed: boolean }> {
    return this.serial(app, async () => {
      this.last.delete(app);
      if (this.opts.mode !== "space") return { removed: false };
      const text = await this.readUnit(app);
      if (text === undefined || !text.startsWith(UNIT_MARKER)) return { removed: false };
      await this.teardown(app);
      return { removed: true };
    });
  }

  /**
   * Remove the space's units of apps that are no longer registered (their
   * directory left while the space was down). `keep` holds every app name the
   * workspace still has, including the ones whose manifest failed to load.
   */
  async sweep(keep: Set<string>): Promise<string[]> {
    if (this.opts.mode !== "space") return [];
    let files: string[];
    try {
      files = await readdir(this.opts.unitDir);
    } catch {
      return [];
    }
    const removed: string[] = [];
    for (const f of files) {
      const m = /^space-(.+)\.service$/.exec(f);
      if (!m || keep.has(m[1]!)) continue;
      const text = await this.readUnit(m[1]!);
      if (!text?.startsWith(UNIT_MARKER)) continue;
      try {
        await this.remove(m[1]!);
        removed.push(m[1]!);
      } catch (e) {
        this.log(`${m[1]}: could not remove the unit of a gone app: ${(e as Error).message}`);
      }
    }
    return removed;
  }

  async status(app: string): Promise<ServiceStatus> {
    const managed = this.opts.mode === "space" && Boolean((await this.readUnit(app))?.startsWith(UNIT_MARKER));
    const unit = this.unitOf(app);
    let scope: "user" | "system" = "user";
    let state: UnitState | undefined;
    try {
      state = await this.opts.systemctl.show(unit);
      // An operator's unit may be a system one (installed with sudo).
      if (this.opts.mode === "operator" && state.loadState === "not-found") {
        const sys = await this.opts.systemctl.show(unit, "system");
        if (sys.loadState && sys.loadState !== "not-found") [state, scope] = [sys, "system"];
      }
    } catch {
      state = undefined;
    }
    const last = this.last.get(app);
    return { app, supervisor: this.opts.mode, unit, scope, managed, ...(state ? { state } : {}), ...(last ? { last } : {}) };
  }

  /** The last apply of every app. */
  results(): ApplyResult[] {
    return [...this.last.values()];
  }

  lastOf(app: string): ApplyResult | undefined {
    return this.last.get(app);
  }

  /** Start, stop or restart the space's unit of an app by hand. A stop holds until the next sync of the app. */
  control(app: string, action: "start" | "stop" | "restart"): Promise<void> {
    return this.serial(app, async () => {
      if (this.opts.mode !== "space") throw new SupervisorError(409, `services on this machine are the operator's (SPACE_SUPERVISOR=operator): systemctl ${action} ${app}.service`);
      if (!(await this.readUnit(app))?.startsWith(UNIT_MARKER)) throw new SupervisorError(409, `"${app}" has no unit of the space; sync it with status: active and a service`);
      await this.requireManager();
      await this.opts.systemctl[action](unitName(app));
    });
  }

  // ------------------------------------------------------------ reconcile

  /** Asked once: without a user manager nothing is written, so a machine without systemd keeps no stray unit files. */
  private async requireManager(): Promise<void> {
    this.manager ??= this.opts.systemctl.available().catch(() => false);
    if (!(await this.manager)) {
      this.manager = undefined; // asked again next time: lingering may be enabled meanwhile
      throw new SupervisorError(503, "no systemd user manager answers (systemctl --user); enable lingering (loginctl enable-linger) or set SPACE_SUPERVISOR=operator");
    }
  }

  private async reconcile(m: Manifest): Promise<ApplyResult> {
    const app = m.app;
    const unit = unitName(app);
    const at = Date.now();
    const onDisk = await this.readUnit(app);
    if (onDisk === undefined && (!m.service || m.status !== "active")) return { app, action: "absent", at };
    await this.requireManager();
    if (onDisk !== undefined && !onDisk.startsWith(UNIT_MARKER)) {
      return { app, action: "conflict", at, error: `${join(this.opts.unitDir, unit)} exists and was not written by ai-space; move it away` };
    }
    if (!m.service || m.status !== "active") {
      if (onDisk === undefined) return { app, action: "absent", at };
      await this.teardown(app);
      this.log(`${app}: ${m.service ? `status ${m.status}` : "no service"}, unit removed`);
      return { app, action: "removed", at };
    }

    const interpolate = this.opts.interpolate ?? ((t: string) => interpolateEnv(t));
    const service = m.service;
    const serviceVars: Record<string, string> = {};
    for (const [k, v] of Object.entries(service.env ?? {})) serviceVars[k] = interpolate(v);
    const vars = serviceEnv({
      app,
      dir: m.dir,
      port: service.port,
      path: this.opts.path ?? process.env.PATH,
      appEnv: await (this.opts.appEnv ?? loadAppEnv)(m.dir),
      spaceEnv: await this.opts.envFor(app),
      serviceEnv: serviceVars,
    });
    const env = renderEnvFile(vars);
    const envPath = this.envPath(app);
    const unitText = renderUnitFor(m, interpolate(service.command), envPath);
    const skipped = env.skipped.length ? { skippedEnv: env.skipped } : {};
    if (env.skipped.length) this.log(`${app}: left out of the environment: ${env.skipped.join(", ")}`);

    const envOnDisk = await readText(envPath);
    const sysctl = this.opts.systemctl;
    if (onDisk === unitText && envOnDisk === env.text) {
      const state = await sysctl.show(unit);
      if (["active", "activating", "reloading"].includes(state.activeState)) return { app, action: "unchanged", at, ...skipped };
      const conflict = await this.operatorConflict(app);
      if (conflict) return { app, action: "conflict", at, error: conflict };
      await sysctl.start(unit);
      this.log(`${app}: started ${unit}`);
      return this.afterStart(m, { app, action: "started", at, ...skipped });
    }

    const conflict = await this.operatorConflict(app);
    if (conflict) return { app, action: "conflict", at, error: conflict };
    await mkdir(this.opts.envDir, { recursive: true, mode: 0o700 });
    await Bun.write(envPath, env.text);
    await chmod(envPath, 0o600); // it holds the app's credentials; Bun.write follows the umask
    await mkdir(this.opts.unitDir, { recursive: true });
    await Bun.write(join(this.opts.unitDir, unit), unitText);
    await sysctl.daemonReload();
    if (onDisk === undefined) {
      await sysctl.enableNow(unit);
      this.log(`${app}: installed and started ${unit}`);
      return this.afterStart(m, { app, action: "installed", at, ...skipped });
    }
    await sysctl.restart(unit);
    this.log(`${app}: ${unit} changed, restarted`);
    return this.afterStart(m, { app, action: "restarted", at, ...skipped });
  }

  /** An enabled or running unit named after the app: the operator still runs it. */
  private async operatorConflict(app: string): Promise<string | undefined> {
    for (const scope of ["user", "system"] as const) {
      const s = await this.opts.systemctl.show(`${app}.service`, scope);
      const on = s.unitFileState === "enabled" || ["active", "activating", "reloading"].includes(s.activeState);
      if (on) return `the operator's ${scope} unit ${app}.service is ${s.activeState === "active" ? "running" : s.unitFileState}; disable it (${scope === "system" ? "sudo systemctl" : "systemctl --user"} disable --now ${app}.service) before the space takes the app over`;
    }
    return undefined;
  }

  /** Record `pending`, then wait for the first healthy answer in the background. */
  private afterStart(m: Manifest, r: ApplyResult): ApplyResult {
    const probe = this.opts.probe;
    const health = m.service?.health;
    if (!probe || !health || !m.service) return r;
    const port = m.service.port;
    const result: ApplyResult = { ...r, health: "pending" };
    void (async () => {
      const deadline = Date.now() + (this.opts.healthWaitMs ?? 30_000);
      let h: "ok" | "down" = "down";
      while (Date.now() < deadline) {
        h = await probe(port, health).catch(() => "down" as const);
        if (h === "ok") break;
        await Bun.sleep(1_000);
      }
      if (this.last.get(m.app) === result) result.health = h;
      if (h !== "ok") this.log(`${m.app}: not healthy ${Math.round((this.opts.healthWaitMs ?? 30_000) / 1000)} s after start (GET 127.0.0.1:${port}${health})`);
    })();
    return result;
  }

  private async teardown(app: string): Promise<void> {
    const unit = unitName(app);
    const sysctl = this.opts.systemctl;
    await sysctl.disableNow(unit);
    await rm(join(this.opts.unitDir, unit), { force: true });
    await rm(this.envPath(app), { force: true });
    await sysctl.daemonReload();
    await sysctl.resetFailed(unit);
  }

  // ------------------------------------------------------------ helpers

  private envPath(app: string): string {
    return join(this.opts.envDir, `${app}.env`);
  }

  private readUnit(app: string): Promise<string | undefined> {
    return readText(join(this.opts.unitDir, unitName(app)));
  }

  private record(r: ApplyResult): ApplyResult {
    this.last.set(r.app, r);
    return r;
  }

  /** One operation per app at a time: a sync and a restart from the panel must not interleave. */
  private serial<T>(app: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(app) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    this.chains.set(app, tail);
    void tail.then(() => {
      if (this.chains.get(app) === tail) this.chains.delete(app);
    });
    return next;
  }
}

export class SupervisorError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readText(path: string): Promise<string | undefined> {
  const f = Bun.file(path);
  return (await f.exists()) ? await f.text() : undefined;
}
