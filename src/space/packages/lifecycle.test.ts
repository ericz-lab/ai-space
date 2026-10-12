import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspacePaths } from "../workspace.ts";
import { PackageInstaller } from "./install.ts";
import { PackageLifecycle } from "./lifecycle.ts";
import { packApplication, readPackageFile } from "./pack.ts";
import { PackageRuntime } from "./runtime.ts";
import { PackageStore } from "./store.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "space-lifecycle-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const ws = workspacePaths(join(root, "workspace")); await mkdir(ws.home); await mkdir(ws.data);
  const db = new Database(":memory:"); cleanup.push(() => db.close());
  const store = new PackageStore(db), installer = new PackageInstaller(ws, store);
  const runtime = new PackageRuntime({ logDir: ws.logs, envFor: async () => ({}) }); cleanup.push(() => runtime.close(0));
  let failVersion = "";
  const activate = async (app: string) => { const loaded = await installer.load(app); if (loaded.manifest.version === failVersion) throw new Error("activation rejected"); await runtime.register(loaded); };
  const lifecycle = new PackageLifecycle(installer, { suspend: (app) => runtime.suspend(app), activate, remove: (app) => runtime.remove(app), verify: (app) => runtime.verify(app) });
  const pack = async (version: string) => {
    const dir = join(root, "source");
    await Bun.write(join(dir, "space.yaml"), `spec: 2\nname: demo\nversion: ${version}\nrequires: {spaceApi: 1}\noffline: {features: [Read], online: []}\nlaunch: {kind: static, root: web}\n`);
    await Bun.write(join(dir, "web/index.html"), version);
    const output = join(root, `${version}.spaceapp`);
    await packApplication({ dir, output, include: ["web"], sourceIncluded: false, target: { os: "any", arch: "any" } });
    return readPackageFile(output);
  };
  const first = await installer.install(await pack("1.0.0"), { allowUnsigned: true }); await activate("demo");
  await Bun.write(join(ws.data, "demo/notes.txt"), "user data");
  return { root, ws, db, store, installer, runtime, lifecycle, first, pack, fail: (v: string) => { failVersion = v; } };
}

test("upgrade, rollback and uninstall retain data and code; operation retries are idempotent", async () => {
  const f = await fixture();
  const bytes = await f.pack("2.0.0"), id = crypto.randomUUID();
  const changed = await f.lifecycle.upgrade(bytes, { id, allowUnsigned: true });
  expect(changed.state).toBe("done");
  expect((await f.installer.load("demo")).manifest.version).toBe("2.0.0");
  expect((await f.lifecycle.upgrade(bytes, { id, allowUnsigned: true })).id).toBe(id);
  expect((await f.lifecycle.rollback("demo", f.first.id)).state).toBe("done");
  expect((await f.installer.load("demo")).manifest.version).toBe("1.0.0");
  const removed = await f.lifecycle.uninstall("demo");
  expect(removed.state).toBe("done"); expect(f.runtime.get("demo")).toBeUndefined();
  await expect(f.installer.load("demo")).rejects.toThrow(/no installed/);
  expect(await Bun.file(join(f.ws.data, "demo/notes.txt")).text()).toBe("user data");
  expect(await Bun.file(join(f.ws.run, "package-changes", removed.id, "previous/web/index.html")).text()).toBe("1.0.0");
});

test("busy apps refuse changes and failed activation restores the last working code", async () => {
  const f = await fixture(); const bytes = await f.pack("2.0.0");
  const lease = await f.runtime.acquire("demo", false);
  const busy = await f.lifecycle.upgrade(bytes, { allowUnsigned: true });
  expect(busy).toMatchObject({ state: "failed", error: expect.stringContaining("still in use") });
  expect((await f.installer.load("demo")).manifest.version).toBe("1.0.0");
  lease.release(); f.fail("2.0.0");
  const failed = await f.lifecycle.upgrade(bytes, { allowUnsigned: true });
  expect(failed).toMatchObject({ state: "failed", error: "activation rejected" });
  expect((await f.installer.load("demo")).manifest.version).toBe("1.0.0");
  expect(f.runtime.get("demo")?.manifest.version).toBe("1.0.0");
  expect(await Bun.file(join(f.ws.data, "demo/notes.txt")).text()).toBe("user data");
});

test("restart recovers an interruption after the previous tree was moved", async () => {
  const f = await fixture(); const id = crypto.randomUUID();
  const root = join(f.ws.run, "package-changes", id); await mkdir(root, { recursive: true });
  f.db.query("INSERT INTO package_changes(id,app,kind,old_id,state,created_at,updated_at) VALUES(?,?,'uninstall',?,'pending',?,?)").run(id, "demo", f.first.id, Date.now(), Date.now());
  await rename(join(f.ws.apps, "demo"), join(root, "previous"));
  await f.lifecycle.recover();
  expect(f.lifecycle.get(id)?.state).toBe("failed");
  expect((await f.installer.load("demo")).manifest.version).toBe("1.0.0");
  expect(await Bun.file(join(f.ws.data, "demo/notes.txt")).text()).toBe("user data");
});

test("restart restores old code if publication committed but activation completion was not journaled", async () => {
  const f = await fixture();
  const changed = await f.lifecycle.upgrade(await f.pack("2.0.0"), { allowUnsigned: true });
  f.db.query("UPDATE package_changes SET state='pending' WHERE id=?").run(changed.id);
  await f.runtime.remove("demo");
  await f.lifecycle.recover();
  expect(f.lifecycle.get(changed.id)?.state).toBe("failed");
  expect((await f.installer.load("demo")).manifest.version).toBe("1.0.0");
  expect(f.store.get(changed.newId!)?.state).toBe("retired");
  expect(await Bun.file(join(f.ws.run, "package-changes", changed.id, "rejected/web/index.html")).text()).toBe("2.0.0");
});

test("an on-demand version that never becomes healthy is not committed", async () => {
  const f = await fixture();
  const pack = async (version: string, code: string) => {
    const dir = join(f.root, `process-${version}`);
    await Bun.write(join(dir, "space.yaml"), `spec: 2\nname: demo\nversion: ${version}\nrequires: {spaceApi: 1, bun: 1.3.0}\noffline: {features: [Read], online: []}\nlaunch: {kind: process, runtime: bun, entry: server.js, health: /healthz}\n`);
    await Bun.write(join(dir, "server.js"), code);
    const output = join(f.root, `process-${version}.spaceapp`);
    await packApplication({ dir, output, include: ["server.js"], sourceIncluded: true, target: { os: "any", arch: "any" } });
    return readPackageFile(output);
  };
  const healthy = 'Bun.serve({hostname:"127.0.0.1",port:Number(process.env.PORT),fetch:()=>new Response("ok")});';
  expect((await f.lifecycle.upgrade(await pack("2.0.0", healthy), { allowUnsigned: true })).state).toBe("done");
  expect(f.runtime.status("demo")).toMatchObject({ state: "running", leases: 0 });
  const broken = await f.lifecycle.upgrade(await pack("3.0.0", "process.exit(3)"), { allowUnsigned: true });
  expect(broken).toMatchObject({ state: "failed", error: expect.stringContaining("exited during startup") });
  expect((await f.installer.load("demo")).manifest.version).toBe("2.0.0");
  const lease = await f.runtime.acquire("demo");
  expect((await fetch(`http://127.0.0.1:${lease.port}/healthz`)).status).toBe(200);
  lease.release();
});

test("a change that cannot be recovered blocks its app only and is reported instead of thrown", async () => {
  const f = await fixture(); const id = crypto.randomUUID();
  const root = join(f.ws.run, "package-changes", id); await mkdir(root, { recursive: true });
  f.db.query("INSERT INTO package_changes(id,app,kind,old_id,state,created_at,updated_at) VALUES(?,?,'uninstall',?,'pending',?,?)").run(id, "demo", f.first.id, Date.now(), Date.now());
  await rename(join(f.ws.apps, "demo"), join(root, "previous"));
  await Bun.write(join(root, "previous/web/index.html"), "altered");
  const blocked = await f.lifecycle.recover();
  expect(blocked).toHaveLength(1);
  expect(blocked[0]).toMatchObject({ change: { id, app: "demo" }, error: expect.stringContaining("failed recovery validation") });
  expect(f.lifecycle.get(id)?.state).toBe("pending");
  expect(await Bun.file(join(root, "previous/web/index.html")).text()).toBe("altered");
  expect((await f.lifecycle.uninstall("demo").catch((e: Error) => e)) as Error).toMatchObject({ message: expect.stringContaining("UNIQUE") });
});
