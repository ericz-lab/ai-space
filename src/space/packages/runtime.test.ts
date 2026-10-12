import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePackageManifest } from "./manifest.ts";
import { PackageRuntime, type RuntimeApp } from "./runtime.ts";

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
