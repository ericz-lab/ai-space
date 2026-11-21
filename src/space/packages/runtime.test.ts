import { afterEach, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePackageManifest } from "./manifest.ts";
import { PackageRuntime, rotateLog, type RuntimeApp, type RuntimeSetting, type StandaloneHost } from "./runtime.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of cleanups.splice(0).reverse()) await f(); });
const app = (mode = "on-demand"): RuntimeApp => ({
  dir: "/unused", index: { format: 1, target: { os: "any", arch: "any" }, sourceIncluded: true, files: [] },
  manifest: parsePackageManifest(`spec: 2\nname: demo\nversion: 1.0.0\nrequires: { spaceApi: 1, bun: 1.3.0 }\noffline: { features: [Read], online: [] }\nlaunch: { kind: process, runtime: bun, entry: app.ts, health: /healthz, mode: ${mode}${mode === "on-demand" ? ", idleTimeoutMs: 1000" : ""} }`),
});
function fake() {
  let now = 0, starts = 0, stops = 0;
  let exit: (code: number) => void = () => {};
  const runtime = new PackageRuntime({
    logDir: "/unused", now: () => now, port: () => 1234, envFor: async () => ({}), probe: async () => true,
    spawn: async () => {
      starts++;
      let code: number | null = null;
      const exited = new Promise<number>((resolve) => { exit = (value) => { code = value; resolve(value); }; });
      return { exited, get exitCode() { return code; }, stop: async () => { stops++; exit(0); } };
    },
  });
  cleanups.push(() => runtime.close(0));
  return { runtime, advance: (n: number) => { now += n; }, exit: (code: number) => exit(code), counts: () => ({ starts, stops }) };
}

test("on-demand startup is shared; idle exit waits for every lease", async () => {
  const f = fake(); await f.runtime.register(app());
  expect(f.counts().starts).toBe(0);
  const [a, b] = await Promise.all([f.runtime.acquire("demo"), f.runtime.acquire("demo")]);
  expect(f.counts().starts).toBe(1);
  expect(a.port).toBe(1234);
  a.release(); a.release(); f.advance(2000); await f.runtime.sweep();
  expect(f.counts().stops).toBe(0);
  await expect(f.runtime.remove("demo")).rejects.toThrow(/in use/);
  b.release(); f.advance(999); await f.runtime.sweep(); expect(f.counts().stops).toBe(0);
  f.advance(1); await f.runtime.sweep(); expect(f.counts().stops).toBe(1);
  expect(f.runtime.status("demo")?.state).toBe("idle");
  const c = await f.runtime.acquire("demo"); expect(f.counts().starts).toBe(2); c.release();
});

test("background app survives idle and restarts after a crash with backoff", async () => {
  const f = fake(); await f.runtime.register(app("background"));
  expect(f.counts().starts).toBe(1);
  f.advance(10_000); await f.runtime.sweep(); expect(f.counts().stops).toBe(0);
  f.exit(1); await Bun.sleep(0);
  expect(f.runtime.status("demo")?.state).toBe("failed");
  await f.runtime.sweep(); expect(f.counts().starts).toBe(1);
  f.advance(1000); await f.runtime.sweep(); expect(f.counts().starts).toBe(2);
  await f.runtime.register({ ...app("background"), manifest: { ...app("background").manifest, status: "paused" } });
  expect(f.counts().stops).toBe(1);
  await expect(f.runtime.acquire("demo")).rejects.toThrow(/paused/);
});

test("failed health checks stop children, release leases and permit a later retry", async () => {
  let stopped = 0;
  const runtime = new PackageRuntime({ logDir: "/unused", envFor: async () => ({}), port: () => 1234, startTimeoutMs: 1, probe: async () => false,
    spawn: async () => ({ exited: new Promise<number>(() => {}), exitCode: null, stop: async () => { stopped++; } }) });
  cleanups.push(() => runtime.close(0));
  await runtime.register(app());
  await expect(runtime.acquire("demo")).rejects.toThrow(/timed out/);
  expect(stopped).toBe(1);
  expect(runtime.status("demo")?.leases).toBe(0);
});

test("static resources have no process, refuse unindexed files and links", async () => {
  const dir = await mkdtemp(join(tmpdir(), "space-static-")); cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await Bun.write(join(dir, "web/index.html"), "hello"); await Bun.write(join(dir, "web/private"), "not indexed");
  await symlink("private", join(dir, "web/link"));
  const f = fake(); const a = app();
  a.dir = dir;
  a.manifest.launch = { kind: "static", root: "web", index: "index.html" };
  a.index.files = ["web/index.html", "web/link"].map((path) => ({ path, size: 0, sha256: "a".repeat(64), executable: false }));
  await f.runtime.register(a);
  expect(await (await f.runtime.staticResponse("demo", "/")).text()).toBe("hello");
  expect((await f.runtime.staticResponse("demo", "/private")).status).toBe(404);
  expect((await f.runtime.staticResponse("demo", "/link")).status).toBe(404);
  expect((await f.runtime.staticResponse("demo", "/%2e%2e/space.yaml")).status).toBe(404);
  expect(f.counts().starts).toBe(0);
});

test("real Bun process starts without inherited operator secrets and shuts down", async () => {
  const dir = await mkdtemp(join(tmpdir(), "space-process-")); cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await Bun.write(join(dir, "app.ts"), 'Bun.serve({hostname:"127.0.0.1",port:Number(process.env.PORT),fetch:r=>new Response(new URL(r.url).pathname==="/healthz"?"ok":JSON.stringify({app:process.env.SPACE_APP,token:process.env.SPACE_API_TOKEN??null}))});');
  const runtime = new PackageRuntime({ logDir: join(dir, "logs"), envFor: async () => ({}), startTimeoutMs: 5000 });
  cleanups.push(() => runtime.close(0));
  await runtime.register({ ...app(), dir });
  const lease = await runtime.acquire("demo");
  expect(await (await fetch(`http://127.0.0.1:${lease.port}/`)).json()).toEqual({ app: "demo", token: null });
  lease.release();
  await runtime.close(0);
  await expect(runtime.acquire("demo")).rejects.toThrow(/shutting down/);
});

test("an app's package.log over its cap keeps one previous generation and starts over in place", async () => {
  const dir = await mkdtemp(join(tmpdir(), "space-log-")); cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "package.log");
  expect(await rotateLog(file, 10)).toBe(false); // No log yet.
  await Bun.write(file, "0123456789");
  expect(await rotateLog(file, 10)).toBe(false); // At the cap, not over it.
  await appendFile(file, "abc");
  expect(await rotateLog(file, 10)).toBe(true);
  expect(await Bun.file(`${file}.1`).text()).toBe("0123456789abc");
  expect(await Bun.file(file).text()).toBe("");

  // The runtime checks each registered app's log.
  const logs = join(dir, "logs");
  const runtime = new PackageRuntime({ logDir: logs, maxLogBytes: 4, envFor: async () => ({}), spawn: async () => { throw new Error("unused"); } });
  cleanups.push(() => runtime.close(0));
  await runtime.register(app());
  await mkdir(join(logs, "demo"), { recursive: true });
  await Bun.write(join(logs, "demo", "package.log"), "too long");
  expect(await runtime.rotateLogs()).toEqual(["demo"]);
  expect(await runtime.rotateLogs()).toEqual([]);
  expect(await Bun.file(join(logs, "demo", "package.log.1")).text()).toBe("too long");
});

test("stop holds the app off until start; restart replaces the process", async () => {
  const f = fake(); await f.runtime.register(app("background"));
  expect(f.runtime.status("demo")).toMatchObject({ state: "running", kind: "process", mode: "background", declaredMode: "background" });
  await f.runtime.control("demo", "stop");
  expect(f.counts()).toEqual({ starts: 1, stops: 1 });
  expect(f.runtime.status("demo")?.state).toBe("stopped");
  f.advance(60_000); await f.runtime.sweep(); expect(f.counts().starts).toBe(1);
  await expect(f.runtime.acquire("demo")).rejects.toThrow(/is stopped; start it/);
  // Held without starting the process (an agent holding the app's files) is still allowed.
  (await f.runtime.acquire("demo", false)).release();
  // A version check starts it once and puts it back.
  await f.runtime.verify("demo");
  expect(f.counts()).toEqual({ starts: 2, stops: 2 });
  expect(f.runtime.status("demo")?.state).toBe("stopped");
  await f.runtime.control("demo", "start");
  expect(f.runtime.status("demo")?.state).toBe("running");
  await f.runtime.control("demo", "restart");
  expect(f.counts()).toEqual({ starts: 4, stops: 3 });
  await expect(f.runtime.control("nope", "start")).rejects.toThrow(/unknown package application/);
});

test("the owner's mode replaces the manifest's, is kept in the settings store and forgotten on removal", async () => {
  const saved = new Map<string, RuntimeSetting>();
  let now = 0, starts = 0, stops = 0;
  const make = () => new PackageRuntime({
    logDir: "/unused", now: () => now, port: () => 1234, envFor: async () => ({}), probe: async () => true,
    settings: { get: (a) => saved.get(a) ?? {}, set: (a, s) => { if (s.mode || s.stopped) saved.set(a, s); else saved.delete(a); } },
    spawn: async () => {
      starts++;
      let code: number | null = null; let done: (n: number) => void = () => {};
      const exited = new Promise<number>((resolve) => { done = resolve; });
      return { pid: 4242, exited, get exitCode() { return code; }, stop: async () => { stops++; code = 0; done(0); } };
    },
  });
  const first = make(); cleanups.push(() => first.close(0));
  await first.register(app());
  expect(starts).toBe(0);
  await first.configure("demo", "background");
  expect(starts).toBe(1);
  expect(first.status("demo")).toMatchObject({ state: "running", mode: "background", declaredMode: "on-demand", pid: 4242 });
  expect(first.status("demo")?.startedAt).toMatch(/^\d{4}-/);
  now += 60_000; await first.sweep(); expect(stops).toBe(0);
  expect(saved.get("demo")).toEqual({ mode: "background" });
  await first.control("demo", "stop");
  expect(saved.get("demo")).toEqual({ mode: "background", stopped: true });
  await first.close(0);

  // The next start of the Space reads the choice back: background, but stopped by the owner.
  const second = make(); cleanups.push(() => second.close(0));
  await second.register(app());
  expect(starts).toBe(1);
  expect(second.status("demo")).toMatchObject({ state: "stopped", mode: "background" });
  await second.control("demo", "start");
  expect(starts).toBe(2);
  // Back to the manifest's on-demand: the idle process is stopped by the sweep.
  await second.configure("demo", undefined);
  expect(saved.has("demo")).toBe(false);
  now += 1000; await second.sweep(); expect(stops).toBe(2);
  expect(second.status("demo")).toMatchObject({ state: "idle", mode: "on-demand" });
  // A version switch takes the app out and puts it back: the choice stays. An uninstall forgets it.
  await second.configure("demo", "background");
  await second.remove("demo");
  expect(saved.get("demo")).toEqual({ mode: "background" });
  await second.register(app());
  expect(second.status("demo")).toMatchObject({ state: "running", mode: "background" });
  await second.remove("demo");
  await second.forget("demo");
  expect(saved.has("demo")).toBe(false);
});

test("a static app has no process to control", async () => {
  const f = fake();
  await f.runtime.register({ ...app(), manifest: parsePackageManifest("spec: 2\nname: demo\nversion: 1.0.0\nrequires: { spaceApi: 1 }\noffline: { features: [Read], online: [] }\nlaunch: { kind: static, root: site }") });
  expect(f.runtime.status("demo")).toMatchObject({ state: "static", kind: "static" });
  await expect(f.runtime.control("demo", "restart")).rejects.toThrow(/no process to restart/);
  await expect(f.runtime.configure("demo", "background")).rejects.toThrow(/no process/);
});

test("a standalone app is the system's: it survives the Space closing, is found again, and is watched", async () => {
  const saved = new Map<string, RuntimeSetting>();
  const log: string[] = [];
  let now = 0, spawns = 0, active = false, available: string | undefined;
  const host: StandaloneHost = {
    unavailable: async () => available,
    start: async (a, port) => { log.push(`start ${a.manifest.app}@${a.manifest.version} :${port}`); active = true; },
    stop: async (a) => { log.push(`stop ${a}`); active = false; },
    remove: async (a) => { log.push(`remove ${a}`); active = false; },
    state: async () => ({ active, ...(active ? { pid: 9001, since: "2026-11-20T10:00:00.000Z" } : {}) }),
    unit: (a) => `space-${a}-abcd1234.service`,
  };
  let nextPort = 5000;
  const make = () => new PackageRuntime({
    logDir: "/unused", now: () => now, port: () => nextPort++, envFor: async () => ({}), probe: async () => true, standalone: host,
    settings: { get: (a) => saved.get(a) ?? {}, set: (a, s) => { if (Object.keys(s).length) saved.set(a, s); else saved.delete(a); } },
    spawn: async () => {
      spawns++;
      let code: number | null = null; let done: (n: number) => void = () => {};
      return { exited: new Promise<number>((resolve) => { done = resolve; }), get exitCode() { return code; }, stop: async () => { code = 0; done(0); } };
    },
  });
  const first = make();
  await first.register(app("background"));
  expect(spawns).toBe(1);
  available = "no systemd user manager answers";
  await expect(first.configure("demo", "standalone")).rejects.toThrow(/cannot run on its own here: no systemd/);
  expect(first.status("demo")).toMatchObject({ state: "running", mode: "background" });
  available = undefined;
  await first.configure("demo", "standalone");
  expect(log).toEqual(["start demo@1.0.0 :5001"]);
  expect(saved.get("demo")).toEqual({ mode: "standalone", port: 5001 });
  expect(first.status("demo")).toMatchObject({ state: "running", mode: "standalone", declaredMode: "background", unit: "space-demo-abcd1234.service", pid: 9001, port: 5001, startedAt: "2026-11-20T10:00:00.000Z" });
  // The Space stops: the app is not.
  await first.close(0);
  expect(log).toEqual(["start demo@1.0.0 :5001"]);
  expect(active).toBe(true);

  // The next Space registers it on the same port; the host leaves an unchanged service alone.
  const second = make(); cleanups.push(() => second.close(0));
  await second.register(app("background"));
  expect(log.at(-1)).toBe("start demo@1.0.0 :5001");
  expect(spawns).toBe(1);
  // It died outside the Space's sight: seen within 5 seconds, then started again after the backoff.
  active = false;
  now += 5000; await second.sweep();
  expect(log.filter((l) => l.startsWith("start"))).toHaveLength(2);
  expect(second.status("demo")).toMatchObject({ state: "failed", error: "the application's service is not running" });
  now += 1000; await second.sweep();
  expect(log.filter((l) => l.startsWith("start"))).toHaveLength(3);
  expect(second.status("demo")?.state).toBe("running");
  // Stop holds, through the system; start brings it back.
  await second.control("demo", "stop");
  expect(log.at(-1)).toBe("stop demo");
  now += 60_000; await second.sweep();
  expect(log.at(-1)).toBe("stop demo");
  await second.control("demo", "start");
  expect(log.at(-1)).toBe("start demo@1.0.0 :5001");
  // Back to a child of the Space: the service is removed and its port forgotten.
  await second.configure("demo", undefined);
  expect(log.slice(-2)).toEqual(["stop demo", "remove demo"]);
  expect(saved.has("demo")).toBe(false);
  expect(spawns).toBe(2);
  expect(second.status("demo")).toMatchObject({ state: "running", mode: "background" });
  expect(second.status("demo")?.unit).toBeUndefined();
  // A version switch while standalone: the service is switched off, kept, and started on the same port.
  await second.configure("demo", "standalone");
  const port = saved.get("demo")!.port;
  await second.remove("demo");
  expect(log.at(-1)).toBe("stop demo");
  expect(saved.get("demo")).toEqual({ mode: "standalone", port });
  await second.register({ ...app("background"), manifest: { ...app("background").manifest, version: "2.0.0" } });
  expect(log.at(-1)).toBe(`start demo@2.0.0 :${port}`);
  // Uninstalled: the service goes with the app.
  await second.remove("demo");
  await second.forget("demo");
  expect(log.slice(-2)).toEqual(["stop demo", "remove demo"]);
  expect(saved.has("demo")).toBe(false);
});
