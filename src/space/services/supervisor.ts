import { chmod, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Manifest } from "../scheduler/manifest.ts";
import { interpolate as interpolateEnv, loadAppEnv } from "../scheduler/targets.ts";
import type { Scope, ServiceManager, UnitState } from "./manager.ts";
import { serviceEnv } from "./unit.ts";

/**
 * Service supervision (docs/supervision.md). Under `SPACE_SUPERVISOR=space`
 * the space owns one user unit per app, `space-<app>.service` under systemd
 * or the LaunchAgent `space.<app>` under launchd (the `ServiceManager`), and
 * keeps it in step with the manifest on every sync:
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

/** What `handover` did, step by step; `ok: false` after a rollback, with the reason. */
export type HandoverResult = {
  app: string;
  to: SupervisorMode;
  ok: boolean;
  steps: string[];
  error?: string;
  rolledBack?: boolean;
};

export type ServiceStatus = {
  app: string;
  supervisor: SupervisorMode;
  /** The unit that runs the app: the space's (`space-<app>.service`, `space.<app>`), the operator's (`<app>.service`, `<app>`) otherwise. */
  unit: string;
  scope: Scope;
  /** A unit written by the space exists for the app. */
  managed: boolean;
  state?: UnitState;
  last?: ApplyResult;
};

export type SupervisorOptions = {
  mode: SupervisorMode;
  /** `<workspace>/run/env`: one environment file per supervised app. */
  envDir: string;
  /** systemd on Linux, launchd on macOS; it knows where the units live. */
  manager: ServiceManager;
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
  private managerUp?: Promise<boolean>;

  constructor(private readonly opts: SupervisorOptions) {
    this.log = opts.log ?? (() => {});
  }

  get mode(): SupervisorMode {
    return this.opts.mode;
  }

  unitOf(app: string): string {
    return this.opts.mode === "space" ? this.opts.manager.unitName(app) : this.opts.manager.operatorUnit(app);
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
      if (!this.owned(text)) return { removed: false };
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
      files = await readdir(this.opts.manager.unitDir);
    } catch {
      return [];
    }
    const removed: string[] = [];
    for (const f of files) {
      const app = this.opts.manager.appOfFile(f);
      if (!app || keep.has(app)) continue;
      if (!this.owned(await this.readUnit(app))) continue;
      try {
        await this.remove(app);
        removed.push(app);
      } catch (e) {
        this.log(`${app}: could not remove the unit of a gone app: ${(e as Error).message}`);
      }
    }
    return removed;
  }

  async status(app: string): Promise<ServiceStatus> {
    const managed = this.opts.mode === "space" && this.owned(await this.readUnit(app));
    const unit = this.unitOf(app);
    let scope: Scope = "user";
    let state: UnitState | undefined;
    try {
      state = await this.opts.manager.show(unit);
      // An operator's unit may be a system one (installed with sudo).
      if (this.opts.mode === "operator" && state.loadState === "not-found") {
        const sys = await this.opts.manager.show(unit, "system");
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
      if (this.opts.mode !== "space") throw new SupervisorError(409, `services on this machine are the operator's (SPACE_SUPERVISOR=operator): ${this.opts.manager.command(action, this.opts.manager.operatorUnit(app))}`);
      if (!this.owned(await this.readUnit(app))) throw new SupervisorError(409, `"${app}" has no unit of the space; sync it with status: active and a service`);
      await this.requireManager();
      await this.opts.manager[action](this.opts.manager.unitName(app));
    });
  }

  /**
   * Move an app between the operator's unit and the space's, under
   * `SPACE_SUPERVISOR=space`, and wait for its health path to answer.
   *
   *   to space     disable --now the operator's unit (user, or system with sudo -n),
   *                reconcile (write, enable --now the space's), wait for health;
   *                on failure remove the space's unit and bring the operator's back as it was
   *   to operator  remove the space's unit, enable --now the operator's, wait for health;
   *                on failure disable it again and give the app back to the space
   *
   * The app stays down between the stop and the first healthy answer: a few seconds.
   */
  handover(m: Manifest, to: SupervisorMode): Promise<HandoverResult> {
    return this.serial(m.app, async () => {
      if (this.opts.mode !== "space") throw new SupervisorError(409, "hand-over needs SPACE_SUPERVISOR=space: under operator the operator's units run every app");
      if (!m.service) throw new SupervisorError(409, `"${m.app}" declares no service`);
      if (to === "space" && m.status !== "active") throw new SupervisorError(409, `"${m.app}" is ${m.status}; only an active app runs under the space`);
      await this.requireManager();
      return to === "space" ? this.toSpace(m) : this.toOperator(m);
    });
  }

  private async toSpace(m: Manifest): Promise<HandoverResult> {
    const app = m.app;
    const mgr = this.opts.manager;
    const own = mgr.unitName(app);
    const opUnit = mgr.operatorUnit(app);
    const steps: string[] = [];
    const op = await this.operatorUnit(app);
    const wasEnabled = op?.state.unitFileState === "enabled";
    const wasActive = op ? isRunning(op.state.activeState) : false;
    const hadUnit = this.owned(await this.readUnit(app));
    const fail = async (error: string): Promise<HandoverResult> => {
      try {
        if (!hadUnit && this.owned(await this.readUnit(app))) {
          await this.teardown(app);
          steps.push(`removed ${own}`);
        }
        if (op && wasEnabled) await mgr.enableNow(opUnit, op.scope);
        else if (op && wasActive) await mgr.start(opUnit, op.scope);
        if (op && (wasEnabled || wasActive)) steps.push(`restored the ${op.scope} unit ${opUnit}`);
        this.record({ app, action: "conflict", at: Date.now(), error: `hand-over failed: ${error}` });
      } catch (e) {
        return { app, to: "space", ok: false, steps, error: `${error}; rollback failed too: ${(e as Error).message}`, rolledBack: false };
      }
      return { app, to: "space", ok: false, steps, error, rolledBack: true };
    };
    if (op && (wasEnabled || wasActive)) {
      try {
        await mgr.disableNow(opUnit, op.scope);
      } catch (e) {
        return { app, to: "space", ok: false, steps, error: `could not stop the operator's unit: ${(e as Error).message}` };
      }
      steps.push(`disabled the ${op.scope} unit ${opUnit}`);
    }
    let r: ApplyResult;
    try {
      r = await this.reconcile(m);
    } catch (e) {
      return fail((e as Error).message);
    }
    this.record(r);
    if (r.action === "conflict" || r.action === "failed") return fail(r.error ?? r.action);
    steps.push(`${r.action} ${own}`);
    const health = await this.waitHealthy(m, own, "user");
    if (health !== "ok") return fail(health);
    steps.push("healthy");
    this.log(`${app}: handed over to the space`);
    return { app, to: "space", ok: true, steps };
  }

  private async toOperator(m: Manifest): Promise<HandoverResult> {
    const app = m.app;
    const mgr = this.opts.manager;
    const own = mgr.unitName(app);
    const opUnit = mgr.operatorUnit(app);
    const steps: string[] = [];
    const op = await this.operatorUnit(app);
    if (!op) throw new SupervisorError(409, `there is no operator unit ${opUnit} (user or system) to hand "${app}" back to; install one first`);
    if (this.owned(await this.readUnit(app))) {
      await this.teardown(app);
      steps.push(`removed ${own}`);
    }
    const giveBack = async (error: string): Promise<HandoverResult> => {
      try {
        await mgr.disableNow(opUnit, op.scope);
        const r = this.record(await this.reconcile(m));
        steps.push(`gave the app back to the space (${r.action})`);
      } catch (e) {
        return { app, to: "operator", ok: false, steps, error: `${error}; rollback failed too: ${(e as Error).message}`, rolledBack: false };
      }
      return { app, to: "operator", ok: false, steps, error, rolledBack: true };
    };
    try {
      await mgr.enableNow(opUnit, op.scope);
    } catch (e) {
      return giveBack((e as Error).message);
    }
    steps.push(`enabled the ${op.scope} unit ${opUnit}`);
    const health = await this.waitHealthy(m, opUnit, op.scope);
    if (health !== "ok") return giveBack(health);
    steps.push("healthy");
    // Syncs from now on record the operator's unit as a conflict, and leave it running.
    this.record({ app, action: "conflict", at: Date.now(), error: `handed back to the operator's ${op.scope} unit ${opUnit}` });
    this.log(`${app}: handed back to the operator`);
    return { app, to: "operator", ok: true, steps };
  }

  /** The operator's unit named after the app, user first; absent when neither manager knows one. */
  private async operatorUnit(app: string): Promise<{ scope: Scope; state: UnitState } | undefined> {
    for (const scope of ["user", "system"] as const) {
      const state = await this.opts.manager.show(this.opts.manager.operatorUnit(app), scope);
      if (state.loadState && state.loadState !== "not-found") return { scope, state };
    }
    return undefined;
  }

  /** "ok", or why not: the health path never answered, or the unit is not running (no health path). */
  private async waitHealthy(m: Manifest, unit: string, scope: Scope): Promise<string> {
    const wait = this.opts.healthWaitMs ?? 30_000;
    const deadline = Date.now() + wait;
    const health = m.service?.health;
    const probe = this.opts.probe;
    for (;;) {
      const state = await this.opts.manager.show(unit, scope).catch(() => undefined);
      // A crashing command never reaches "failed" under Restart=on-failure: it loops through auto-restart.
      if (state && (state.activeState === "failed" || state.subState === "auto-restart" || state.restarts > 0)) return `${unit} ${state.activeState === "failed" ? "failed to start" : "keeps exiting"}; see ${this.opts.manager.logHint(unit, scope)}`;
      if (probe && health && m.service) {
        if ((await probe(m.service.port, health).catch(() => "down")) === "ok") return "ok";
      } else if (state && state.activeState === "active") return "ok";
      if (Date.now() >= deadline) return probe && health && m.service ? `not healthy ${Math.round(wait / 1000)} s after start (GET 127.0.0.1:${m.service.port}${health})` : `${unit} is ${state?.activeState ?? "unknown"}`;
      await Bun.sleep(Math.min(1_000, wait));
    }
  }

  // ------------------------------------------------------------ reconcile

  /** Asked once: without a user manager nothing is written, so a machine without one keeps no stray unit files. */
  private async requireManager(): Promise<void> {
    this.managerUp ??= this.opts.manager.available().catch(() => false);
    if (!(await this.managerUp)) {
      this.managerUp = undefined; // asked again next time: lingering may be enabled meanwhile
      throw new SupervisorError(503, this.opts.manager.unavailable);
    }
  }

  private async reconcile(m: Manifest): Promise<ApplyResult> {
    const app = m.app;
    const mgr = this.opts.manager;
    const unit = mgr.unitName(app);
    const unitPath = join(mgr.unitDir, mgr.unitFile(app));
    const at = Date.now();
    const onDisk = await this.readUnit(app);
    if (onDisk === undefined && (!m.service || m.status !== "active")) return { app, action: "absent", at };
    await this.requireManager();
    if (onDisk !== undefined && !this.owned(onDisk)) {
      return { app, action: "conflict", at, error: `${unitPath} exists and was not written by ai-space; move it away` };
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
    const env = mgr.renderEnv(vars);
    const envPath = this.envPath(app);
    const unitText = mgr.renderUnit(m, interpolate(service.command), envPath);
    const skipped = env.skipped.length ? { skippedEnv: env.skipped } : {};
    if (env.skipped.length) this.log(`${app}: left out of the environment: ${env.skipped.join(", ")}`);

    const envOnDisk = await readText(envPath);
    if (onDisk === unitText && envOnDisk === env.text) {
      const state = await mgr.show(unit);
      if (["active", "activating", "reloading"].includes(state.activeState)) return { app, action: "unchanged", at, ...skipped };
      const conflict = await this.operatorConflict(app);
      if (conflict) return { app, action: "conflict", at, error: conflict };
      await mgr.prepare?.(app);
      await mgr.start(unit);
      this.log(`${app}: started ${unit}`);
      return this.afterStart(m, { app, action: "started", at, ...skipped });
    }

    const conflict = await this.operatorConflict(app);
    if (conflict) return { app, action: "conflict", at, error: conflict };
    await mkdir(this.opts.envDir, { recursive: true, mode: 0o700 });
    await Bun.write(envPath, env.text);
    await chmod(envPath, 0o600); // it holds the app's credentials; Bun.write follows the umask
    await mkdir(mgr.unitDir, { recursive: true });
    await Bun.write(unitPath, unitText);
    await mgr.prepare?.(app);
    await mgr.daemonReload();
    if (onDisk === undefined) {
      await mgr.enableNow(unit);
      this.log(`${app}: installed and started ${unit}`);
      return this.afterStart(m, { app, action: "installed", at, ...skipped });
    }
    await mgr.restart(unit);
    this.log(`${app}: ${unit} changed, restarted`);
    return this.afterStart(m, { app, action: "restarted", at, ...skipped });
  }

  /** An enabled or running unit named after the app: the operator still runs it. */
  private async operatorConflict(app: string): Promise<string | undefined> {
    const mgr = this.opts.manager;
    const unit = mgr.operatorUnit(app);
    for (const scope of ["user", "system"] as const) {
      const s = await mgr.show(unit, scope);
      const on = s.unitFileState === "enabled" || ["active", "activating", "reloading"].includes(s.activeState);
      if (on) return `the operator's ${scope} unit ${unit} is ${s.activeState === "active" ? "running" : s.unitFileState}; disable it (${mgr.command("disable", unit, scope)}) or hand it over (space app supervise ${app}) before the space takes the app over`;
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
    const mgr = this.opts.manager;
    const unit = mgr.unitName(app);
    await mgr.disableNow(unit);
    await rm(join(mgr.unitDir, mgr.unitFile(app)), { force: true });
    await rm(this.envPath(app), { force: true });
    await mgr.daemonReload();
    await mgr.resetFailed(unit);
  }

  // ------------------------------------------------------------ helpers

  private envPath(app: string): string {
    return join(this.opts.envDir, `${app}.env`);
  }

  private readUnit(app: string): Promise<string | undefined> {
    return readText(join(this.opts.manager.unitDir, this.opts.manager.unitFile(app)));
  }

  /** A unit file the space wrote; anything else of that name is the operator's and never touched. */
  private owned(text: string | undefined): boolean {
    return text !== undefined && this.opts.manager.owns(text);
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

function isRunning(activeState: string): boolean {
  return ["active", "activating", "reloading"].includes(activeState);
}

async function readText(path: string): Promise<string | undefined> {
  const f = Bun.file(path);
  return (await f.exists()) ? await f.text() : undefined;
}
