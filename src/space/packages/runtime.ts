import { copyFile, lstat, mkdir, open, stat, truncate } from "node:fs/promises";
import { join } from "node:path";
import type { PackageManifest } from "./manifest.ts";
import type { PackageIndex } from "./contract.ts";

export type RuntimeApp = { manifest: PackageManifest; dir: string; index: PackageIndex };
type Child = { exited: Promise<number>; exitCode: number | null; stop: () => Promise<void>; pid?: number };
/**
 * `on-demand` and `background` are what a manifest may declare: a child process of the Space.
 * `standalone` is the owner's choice only: the operating system runs the app as a service of its
 * own, so a restart or stop of the Space leaves it running (see `StandaloneHost`).
 */
export type RuntimeMode = "on-demand" | "background" | "standalone";
/**
 * What the owner of this Space chose for one app, over what its manifest declares: `mode` replaces
 * `launch.mode`; `stopped` keeps the process off (no visitor, task or restart starts it) until a start;
 * `port` is the fixed port of a standalone app, chosen once so its service file stays the same.
 */
export type RuntimeSetting = { mode?: RuntimeMode; stopped?: boolean; port?: number };
/** The operating system's service of one standalone app (src/space/packages/standalone.ts). */
export type StandaloneHost = {
  /** Undefined when the system can run services for this user, else why not. */
  unavailable(): Promise<string | undefined>;
  /** Write the service for this version, port and environment and make sure it runs; an unchanged, running one is left alone. */
  start(app: RuntimeApp, port: number, env: Record<string, string>): Promise<void>;
  /** Stop it and keep it from starting at the next login. */
  stop(app: string): Promise<void>;
  /** Stop it and delete its files. */
  remove(app: string): Promise<void>;
  state(app: string): Promise<{ active: boolean; pid?: number; since?: string }>;
  /** The service's name, for messages. */
  unit(app: string): string;
};
export type RuntimeAction = "start" | "stop" | "restart";
export const RUNTIME_ACTIONS: readonly RuntimeAction[] = ["start", "stop", "restart"];
export const RUNTIME_MODES: readonly RuntimeMode[] = ["on-demand", "background", "standalone"];
export type RuntimeStatus = {
  app: string; state: string; leases: number; port?: number; error?: string;
  kind: "process" | "static" | "none";
  /** The mode in force and the manifest's; they differ when the owner chose another. Process apps only. */
  mode?: RuntimeMode; declaredMode?: RuntimeMode;
  /** The operating system's service that runs a standalone app. */
  unit?: string;
  pid?: number;
  /** When the running process passed its health check, ISO 8601. */
  startedAt?: string;
};
type State = {
  app: RuntimeApp; leases: number; lastUsed: number; child?: Child; starting?: Promise<void>;
  port?: number; error?: string; retryAt: number; failures: number; stopping?: Promise<void>;
  setting: RuntimeSetting; startedAt?: number; checkedAt?: number;
};
export type RuntimeOptions = {
  envFor: (app: string) => Promise<Record<string, string>>;
  logDir: string;
  now?: () => number;
  startTimeoutMs?: number;
  spawn?: (app: RuntimeApp, port: number, env: Record<string, string>) => Promise<Child>;
  probe?: (port: number, path: string) => Promise<boolean>;
  port?: () => number;
  /** Where the owner's choices are kept; without it they live as long as this object. An empty setting forgets the app. */
  settings?: { get: (app: string) => RuntimeSetting; set: (app: string, setting: RuntimeSetting) => void };
  /** Runs standalone apps; without it that mode is refused. */
  standalone?: StandaloneHost;
  /** Size at which an app's `package.log` is kept as `package.log.1` and started over; default 10 MiB. */
  maxLogBytes?: number;
};

const MAX_LOG_BYTES = 10 * 1024 ** 2;

/**
 * Keeps one previous generation of a log its writer holds open in append mode: the content is
 * copied to `<file>.1` and the file truncated in place, so the writer's next line starts it over.
 * True when it rotated.
 */
export async function rotateLog(file: string, maxBytes: number): Promise<boolean> {
  const size = await stat(file).then((s) => s.size, () => 0);
  if (size <= maxBytes) return false;
  await copyFile(file, `${file}.1`);
  await truncate(file, 0);
  return true;
}

/** One owner per app process. Requests/tasks hold explicit leases until their work is finished. */
export class PackageRuntime {
  private readonly apps = new Map<string, State>();
  private readonly now: () => number;
  private readonly probe: NonNullable<RuntimeOptions["probe"]>;
  private closing = false;
  private readonly suspended = new Set<string>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly logTimer: ReturnType<typeof setInterval>;

  constructor(private readonly opts: RuntimeOptions) {
    this.now = opts.now ?? (() => performance.now());
    this.probe = opts.probe ?? (async (port, path) => {
      try { return (await fetch(`http://127.0.0.1:${port}${path}`, { redirect: "manual", signal: AbortSignal.timeout(1000) })).status === 200; }
      catch { return false; }
    });
    this.timer = setInterval(() => void this.sweep().catch(() => {}), 1000);
    this.timer.unref();
    // A running process appends to its log for as long as it lives: keep each under its cap, hourly.
    this.logTimer = setInterval(() => void this.rotateLogs().catch(() => {}), 3_600_000);
    this.logTimer.unref();
  }

  /** Rotates the `package.log` of each registered app that is over its cap; returns those apps. */
  async rotateLogs(): Promise<string[]> {
    const rotated: string[] = [];
    for (const app of this.apps.keys()) {
      if (await rotateLog(join(this.opts.logDir, app, "package.log"), this.opts.maxLogBytes ?? MAX_LOG_BYTES)) rotated.push(app);
    }
    return rotated;
  }

  async register(app: RuntimeApp): Promise<void> {
    if (this.closing) throw new Error("application runtime is shutting down");
    const name = app.manifest.app;
    const old = this.apps.get(name);
    if (old && JSON.stringify(old.app) === JSON.stringify(app)) return;
    if (old?.leases) throw new Error(`${name} is still in use`);
    if (old) await this.stop(old);
    const state: State = { app, leases: 0, lastUsed: this.now(), failures: 0, retryAt: 0, setting: this.opts.settings?.get(name) ?? old?.setting ?? {} };
    this.apps.set(name, state);
    if (app.manifest.status === "active" && this.keptRunning(state) && !state.setting.stopped) await this.ensure(state);
  }

  /** Background and standalone apps run without a visitor and come back after a crash. */
  private keptRunning(s: State): boolean {
    const mode = this.mode(s);
    return mode === "background" || mode === "standalone";
  }

  /** The launch mode in force for a process app: the owner's choice, else the manifest's. */
  private mode(s: State): RuntimeMode | undefined {
    const launch = s.app.manifest.launch;
    return launch?.kind === "process" ? s.setting.mode ?? launch.mode : undefined;
  }

  private save(s: State, patch: RuntimeSetting): void {
    const next = { ...s.setting, ...patch };
    s.setting = { ...(next.mode ? { mode: next.mode } : {}), ...(next.stopped ? { stopped: true } : {}), ...(next.port ? { port: next.port } : {}) };
    this.opts.settings?.set(s.app.manifest.app, s.setting);
  }

  private processApp(app: string, doing: string): State {
    const s = this.apps.get(app);
    if (!s) throw new Error(`unknown package application: ${app}`);
    if (s.app.manifest.launch?.kind !== "process") throw new Error(`${app} has no process to ${doing}`);
    return s;
  }

  /**
   * Start, stop or restart an app's process by hand. A stop cuts requests in flight and holds: the
   * app stays off, across restarts of the Space, until a start or restart.
   */
  async control(app: string, action: RuntimeAction): Promise<void> {
    if (this.closing) throw new Error("application runtime is shutting down");
    const s = this.processApp(app, action);
    if (this.suspended.has(app)) throw new Error(`${app} is changing version`);
    if (action === "stop") { this.save(s, { stopped: true }); await this.stop(s); return; }
    if (s.app.manifest.status !== "active") throw new Error(`${app} is ${s.app.manifest.status}`);
    if (action === "restart") await this.stop(s);
    this.save(s, { stopped: false });
    s.retryAt = 0;
    await this.ensure(s);
    s.lastUsed = this.now();
  }

  /** Choose the launch mode for this Space, or go back to the manifest's with `undefined`. */
  async configure(app: string, mode: RuntimeMode | undefined): Promise<void> {
    const s = this.processApp(app, "configure");
    const before = this.mode(s);
    const after = mode ?? (s.app.manifest.launch as { mode: RuntimeMode }).mode;
    if (before !== after && (before === "standalone" || after === "standalone")) {
      // The process changes hands between the Space and the operating system: the old one ends first.
      if (this.suspended.has(app)) throw new Error(`${app} is changing version`);
      if (after === "standalone") {
        if (!this.opts.standalone) throw new Error("this Space cannot run an app on its own");
        const why = await this.opts.standalone.unavailable();
        if (why) throw new Error(`${app} cannot run on its own here: ${why}`);
      }
      await this.stop(s);
      if (before === "standalone") await this.opts.standalone?.remove(app);
      this.save(s, { mode, port: after === "standalone" ? s.setting.port ?? (this.opts.port?.() ?? freePort()) : undefined });
    } else this.save(s, { mode });
    s.lastUsed = this.now();
    // A kept-running app that cannot start is retried by the sweep; the choice itself has been kept.
    if (this.keptRunning(s) && s.app.manifest.status === "active" && !s.setting.stopped && !this.suspended.has(app) && !this.closing) await this.ensure(s).catch(() => {});
  }

  get(app: string): RuntimeApp | undefined { return this.apps.get(app)?.app; }

  status(app: string): RuntimeStatus | undefined {
    const s = this.apps.get(app);
    if (!s) return undefined;
    const launch = s.app.manifest.launch;
    const state = s.app.manifest.status !== "active" ? s.app.manifest.status : s.starting ? "starting" : s.child ? "running" : launch?.kind === "static" ? "static" : s.setting.stopped ? "stopped" : s.error ? "failed" : "idle";
    return {
      app, state, leases: s.leases, port: s.port, error: s.error, kind: launch?.kind ?? "none",
      ...(launch?.kind === "process" ? { mode: this.mode(s), declaredMode: launch.mode } : {}),
      ...(this.mode(s) === "standalone" && this.opts.standalone ? { unit: this.opts.standalone.unit(app) } : {}),
      ...(s.child?.pid ? { pid: s.child.pid } : {}),
      ...(s.child && s.startedAt ? { startedAt: new Date(s.startedAt).toISOString() } : {}),
    };
  }

  async acquire(app: string, startProcess = true): Promise<{ port?: number; release: () => void }> {
    if (this.closing) throw new Error("application runtime is shutting down");
    if (this.suspended.has(app)) throw new Error(`${app} is changing version`);
    const s = this.apps.get(app);
    if (!s) throw new Error(`unknown package application: ${app}`);
    if (s.app.manifest.status !== "active") throw new Error(`${app} is ${s.app.manifest.status}`);
    if (startProcess && s.setting.stopped && s.app.manifest.launch?.kind === "process") throw new Error(`${app} is stopped; start it in Settings or with: space app start ${app}`);
    s.leases++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      s.leases--; s.lastUsed = this.now();
    };
    try { if (startProcess) await this.ensure(s); return { port: s.port, release }; }
    catch (e) { release(); throw e; }
  }

  /**
   * Start a process app once and wait for its health, also while a version change holds the app
   * suspended. An on-demand process is otherwise first started by a visitor, after the change committed.
   */
  async verify(app: string): Promise<void> {
    const s = this.apps.get(app);
    if (!s || s.app.manifest.status !== "active" || s.app.manifest.launch?.kind !== "process") return;
    await this.ensure(s);
    s.lastUsed = this.now();
    // The new version was checked; an app the owner stopped goes back to stopped.
    if (s.setting.stopped) await this.stop(s);
  }

  async staticResponse(app: string, pathname: string): Promise<Response> {
    const lease = await this.acquire(app);
    try {
      const s = this.apps.get(app)!;
      const launch = s.app.manifest.launch;
      if (launch?.kind !== "static") throw new Error("application has no static entry");
      const decoded = decodeURIComponent(pathname);
      if (!decoded.startsWith("/") || decoded.includes("\\") || /[\x00-\x1f]/.test(decoded) || decoded.split("/").some((p) => p === "." || p === "..")) return new Response("Not found", { status: 404 });
      const relative = `${launch.root}/${decoded === "/" ? launch.index : decoded.slice(1)}`;
      if (!s.app.index.files.some((f) => f.path === relative)) return new Response("Not found", { status: 404 });
      const pieces = relative.split("/");
      for (let i = 1; i <= pieces.length; i++) {
        const stat = await lstat(join(s.app.dir, ...pieces.slice(0, i)));
        if (i < pieces.length ? !stat.isDirectory() : !stat.isFile()) return new Response("Not found", { status: 404 });
      }
      const file = Bun.file(join(s.app.dir, relative));
      // Read while leased: a concurrent version switch must not change a lazy file body's pathname.
      return new Response(await file.arrayBuffer(), { headers: { "content-type": file.type, "x-content-type-options": "nosniff", "cache-control": "no-cache" } });
    } finally { lease.release(); }
  }

  async sweep(): Promise<void> {
    if (this.closing) return;
    for (const s of this.apps.values()) {
      const launch = s.app.manifest.launch;
      if (this.suspended.has(s.app.manifest.app) || s.app.manifest.status !== "active" || launch?.kind !== "process" || s.starting || s.stopping) continue;
      if (s.setting.stopped) continue;
      const mode = this.mode(s);
      if (mode === "on-demand" && s.child && !s.leases && this.now() - s.lastUsed >= launch.idleTimeoutMs) await this.stop(s);
      if (mode === "standalone" && s.child && this.now() - (s.checkedAt ?? 0) >= 5000) await this.check(s);
      if (mode !== "on-demand" && !s.child && this.now() >= s.retryAt) await this.ensure(s).catch(() => {});
    }
  }

  /** A standalone app's process is the operating system's: ask it whether the app still runs, and under which process. */
  private async check(s: State): Promise<void> {
    s.checkedAt = this.now();
    const running = s.child;
    const state = await this.opts.standalone?.state(s.app.manifest.app).catch(() => undefined);
    if (!state || s.child !== running || !running) return;
    if (state.active) { running.pid = state.pid; if (state.since) s.startedAt = Date.parse(state.since); return; }
    s.child = undefined; s.port = undefined;
    this.failed(s, "the application's service is not running");
  }

  async remove(app: string): Promise<void> {
    const s = this.apps.get(app);
    if (!s) return;
    if (s.leases) throw new Error(`${app} is still in use`);
    // A standalone app's service is switched off here and kept: a version switch starts it again.
    await this.stop(s); this.apps.delete(app);
  }

  /** An uninstalled app leaves no choice behind, nor a service: installed again, it starts as its manifest says. */
  async forget(app: string): Promise<void> {
    await this.opts.standalone?.remove(app);
    this.opts.settings?.set(app, {});
  }

  async suspend(app: string): Promise<() => void> {
    if (this.suspended.has(app)) throw new Error(`${app} is already changing version`);
    const state = this.apps.get(app);
    if (state?.leases) throw new Error(`${app} is still in use`);
    this.suspended.add(app);
    try { if (state) await this.stop(state); }
    catch (e) { this.suspended.delete(app); throw e; }
    return () => { this.suspended.delete(app); };
  }

  async close(graceMs = 10_000): Promise<void> {
    this.closing = true; clearInterval(this.timer); clearInterval(this.logTimer);
    const deadline = performance.now() + graceMs;
    while ([...this.apps.values()].some((s) => s.leases) && performance.now() < deadline) await Bun.sleep(20);
    // A standalone app is left running: that is what the mode is for. The next Space finds it again.
    await Promise.all([...this.apps.values()].filter((s) => this.mode(s) !== "standalone").map((s) => this.stop(s)));
    this.apps.clear();
  }

  private async ensure(s: State): Promise<void> {
    if (s.stopping) await s.stopping;
    if (s.child || s.app.manifest.launch?.kind !== "process") return;
    if (s.starting) return s.starting;
    if (this.now() < s.retryAt) throw new Error(s.error ?? "application restart is backing off");
    const start = this.start(s);
    s.starting = start;
    try { await start; } finally { s.starting = undefined; }
  }

  private async start(s: State): Promise<void> {
    const launch = s.app.manifest.launch;
    if (launch?.kind !== "process") return;
    let child: Child | undefined;
    try {
      const standalone = this.mode(s) === "standalone" ? this.opts.standalone : undefined;
      if (this.mode(s) === "standalone" && !standalone) throw new Error("this Space cannot run an app on its own");
      const port = standalone ? s.setting.port ?? (this.opts.port?.() ?? freePort()) : this.opts.port?.() ?? freePort();
      if (standalone && s.setting.port !== port) this.save(s, { port });
      const env = await this.opts.envFor(s.app.manifest.app);
      if (this.closing) throw new Error("application runtime is shutting down");
      if (standalone) {
        const name = s.app.manifest.app;
        await standalone.start(s.app, port, env);
        // The operating system owns the process: it never "exits" for the Space, and a stop goes through the system.
        child = { exited: new Promise<number>(() => {}), exitCode: null, stop: () => standalone.stop(name) };
      } else child = await (this.opts.spawn ?? ((a, p, e) => spawnApp(a, p, e, this.opts.logDir, this.opts.maxLogBytes ?? MAX_LOG_BYTES)))(s.app, port, env);
      const deadline = performance.now() + (this.opts.startTimeoutMs ?? 30_000);
      while (performance.now() < deadline) {
        if (this.closing) throw new Error("application runtime is shutting down");
        if (child.exitCode !== null) throw new Error(`application exited during startup (${child.exitCode})`);
        if (await this.probe(port, launch.health)) {
          if (child.exitCode !== null) throw new Error("application exited during health check");
          s.child = child; s.port = port; s.error = undefined; s.startedAt = Date.now();
          if (standalone) await this.check(s);
          const startedAt = this.now();
          const running = child;
          void child.exited.then((code) => {
            if (s.child === running) {
              s.child = undefined; s.port = undefined;
              if (this.now() - startedAt >= 30_000) s.failures = 0;
              this.failed(s, `application exited (${code})`);
            }
          });
          return;
        }
        await Bun.sleep(25);
      }
      throw new Error("application startup health check timed out");
    } catch (e) {
      await child?.stop();
      this.failed(s, (e as Error).message);
      throw e;
    }
  }

  private failed(s: State, error: string): void {
    s.error = error; s.failures++; s.retryAt = this.now() + Math.min(30_000, 1000 * 2 ** Math.min(s.failures - 1, 5));
  }

  private async stop(s: State): Promise<void> {
    if (s.stopping) return s.stopping;
    const stop = async () => {
      await s.starting?.catch(() => {});
      const child = s.child; s.child = undefined; s.port = undefined;
      await child?.stop();
      // A standalone service the Space lost track of (it kept crashing) is still switched off.
      if (!child && this.mode(s) === "standalone") await this.opts.standalone?.stop(s.app.manifest.app).catch(() => {});
      s.failures = 0; s.retryAt = 0;
    };
    s.stopping = stop();
    try { await s.stopping; } finally { s.stopping = undefined; }
  }
}

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open(socket) { socket.end(); } } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

async function spawnApp(app: RuntimeApp, port: number, env: Record<string, string>, logDir: string, maxLogBytes: number): Promise<Child> {
  const launch = app.manifest.launch;
  if (launch?.kind !== "process") throw new Error("not a process application");
  const entry = join(app.dir, launch.entry);
  const args = launch.runtime === "bun" ? [process.execPath, entry, ...launch.args] : [entry, ...launch.args];
  const setsid = process.platform === "linux" ? Bun.which("setsid") : null;
  await mkdir(join(logDir, app.manifest.app), { recursive: true });
  const logFile = join(logDir, app.manifest.app, "package.log");
  // A process that keeps failing to start is restarted many times; each start checks the cap too.
  await rotateLog(logFile, maxLogBytes);
  const log = await open(logFile, "a", 0o600);
  let proc: Bun.Subprocess;
  try {
    proc = Bun.spawn(setsid ? [setsid, ...args] : args, {
      cwd: app.dir, stdin: "ignore", stdout: log.fd, stderr: log.fd,
      env: { PATH: process.env.PATH ?? "", ...env, PORT: String(port), SPACE_APP: app.manifest.app, SPACE_APP_DIR: app.dir },
    });
  } catch (e) { await log.close(); throw e; }
  void proc.exited.then(() => log.close());
  let stopping: Promise<void> | undefined;
  const signal = (sig: NodeJS.Signals) => { try { if (setsid) process.kill(-proc.pid, sig); else proc.kill(sig); } catch { /* already exited */ } };
  return {
    pid: proc.pid,
    exited: proc.exited,
    get exitCode() { return proc.exitCode; },
    stop: () => stopping ??= (async () => {
      signal("SIGTERM");
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([proc.exited, new Promise<void>((resolve) => { timer = setTimeout(resolve, 10_000); })]);
      clearTimeout(timer);
      if (proc.exitCode === null) signal("SIGKILL");
      await proc.exited;
    })(),
  };
}
