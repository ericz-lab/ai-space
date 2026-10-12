import { lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import type { PackageManifest } from "./manifest.ts";
import type { PackageIndex } from "./contract.ts";

export type RuntimeApp = { manifest: PackageManifest; dir: string; index: PackageIndex };
type Child = { exited: Promise<number>; exitCode: number | null; stop: () => Promise<void> };
type State = {
  app: RuntimeApp; leases: number; lastUsed: number; child?: Child; starting?: Promise<void>;
  port?: number; error?: string; retryAt: number; failures: number; stopping?: Promise<void>;
};
export type RuntimeOptions = {
  envFor: (app: string) => Promise<Record<string, string>>;
  logDir: string;
  now?: () => number;
  startTimeoutMs?: number;
  spawn?: (app: RuntimeApp, port: number, env: Record<string, string>) => Promise<Child>;
  probe?: (port: number, path: string) => Promise<boolean>;
  port?: () => number;
};

/** One owner per app process. Requests/tasks hold explicit leases until their work is finished. */
export class PackageRuntime {
  private readonly apps = new Map<string, State>();
  private readonly now: () => number;
  private readonly probe: NonNullable<RuntimeOptions["probe"]>;
  private closing = false;
  private readonly suspended = new Set<string>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly opts: RuntimeOptions) {
    this.now = opts.now ?? (() => performance.now());
    this.probe = opts.probe ?? (async (port, path) => {
      try { return (await fetch(`http://127.0.0.1:${port}${path}`, { redirect: "manual", signal: AbortSignal.timeout(1000) })).status === 200; }
      catch { return false; }
    });
    this.timer = setInterval(() => void this.sweep().catch(() => {}), 1000);
    this.timer.unref();
  }

  async register(app: RuntimeApp): Promise<void> {
    if (this.closing) throw new Error("application runtime is shutting down");
    const name = app.manifest.app;
    const old = this.apps.get(name);
    if (old && JSON.stringify(old.app) === JSON.stringify(app)) return;
    if (old?.leases) throw new Error(`${name} is still in use`);
    if (old) await this.stop(old);
    const state: State = { app, leases: 0, lastUsed: this.now(), failures: 0, retryAt: 0 };
    this.apps.set(name, state);
    if (app.manifest.status === "active" && app.manifest.launch?.kind === "process" && app.manifest.launch.mode === "background") await this.ensure(state);
  }

  get(app: string): RuntimeApp | undefined { return this.apps.get(app)?.app; }

  status(app: string) {
    const s = this.apps.get(app);
    if (!s) return undefined;
    return { app, state: s.app.manifest.status !== "active" ? s.app.manifest.status : s.starting ? "starting" : s.child ? "running" : s.app.manifest.launch?.kind === "static" ? "static" : s.error ? "failed" : "idle", leases: s.leases, port: s.port, error: s.error };
  }

  async acquire(app: string, startProcess = true): Promise<{ port?: number; release: () => void }> {
    if (this.closing) throw new Error("application runtime is shutting down");
    if (this.suspended.has(app)) throw new Error(`${app} is changing version`);
    const s = this.apps.get(app);
    if (!s) throw new Error(`unknown package application: ${app}`);
    if (s.app.manifest.status !== "active") throw new Error(`${app} is ${s.app.manifest.status}`);
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
      if (launch.mode === "on-demand" && s.child && !s.leases && this.now() - s.lastUsed >= launch.idleTimeoutMs) await this.stop(s);
      if (launch.mode === "background" && !s.child && this.now() >= s.retryAt) await this.ensure(s).catch(() => {});
    }
  }

  async remove(app: string): Promise<void> {
    const s = this.apps.get(app);
    if (!s) return;
    if (s.leases) throw new Error(`${app} is still in use`);
    await this.stop(s); this.apps.delete(app);
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
    this.closing = true; clearInterval(this.timer);
    const deadline = performance.now() + graceMs;
    while ([...this.apps.values()].some((s) => s.leases) && performance.now() < deadline) await Bun.sleep(20);
    await Promise.all([...this.apps.values()].map((s) => this.stop(s)));
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
      const port = this.opts.port?.() ?? freePort();
      const env = await this.opts.envFor(s.app.manifest.app);
      if (this.closing) throw new Error("application runtime is shutting down");
      child = await (this.opts.spawn ?? ((a, p, e) => spawnApp(a, p, e, this.opts.logDir)))(s.app, port, env);
      const deadline = performance.now() + (this.opts.startTimeoutMs ?? 30_000);
      while (performance.now() < deadline) {
        if (this.closing) throw new Error("application runtime is shutting down");
        if (child.exitCode !== null) throw new Error(`application exited during startup (${child.exitCode})`);
        if (await this.probe(port, launch.health)) {
          if (child.exitCode !== null) throw new Error("application exited during health check");
          s.child = child; s.port = port; s.error = undefined;
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

async function spawnApp(app: RuntimeApp, port: number, env: Record<string, string>, logDir: string): Promise<Child> {
  const launch = app.manifest.launch;
  if (launch?.kind !== "process") throw new Error("not a process application");
  const entry = join(app.dir, launch.entry);
  const args = launch.runtime === "bun" ? [process.execPath, entry, ...launch.args] : [entry, ...launch.args];
  const setsid = process.platform === "linux" ? Bun.which("setsid") : null;
  await mkdir(join(logDir, app.manifest.app), { recursive: true });
  const log = await open(join(logDir, app.manifest.app, "package.log"), "a", 0o600);
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
