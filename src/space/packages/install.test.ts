import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardBrowserWrites } from "../auth.ts";
import { workspacePaths } from "../workspace.ts";
import { createPackageRoutes } from "./api.ts";
import { PackageInstaller } from "./install.ts";
import { packApplication, readPackageFile } from "./pack.ts";
import { PackageStore } from "./store.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "space-install-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const ws = workspacePaths(join(root, "workspace"));
  await mkdir(ws.home); await mkdir(ws.data);
  const db = new Database(join(ws.data, "space.db"));
  cleanup.push(async () => db.close());
  const store = new PackageStore(db);
  const installer = new PackageInstaller(ws, store);
  const dir = join(root, "source");
  await Bun.write(join(dir, "space.yaml"), "spec: 2\nname: demo\nversion: 1.0.0\nrequires: { spaceApi: 1 }\noffline: { features: [Read], online: [] }\nlaunch: { kind: static, root: web }\n");
  await Bun.write(join(dir, "web/index.html"), "<p>Offline content</p>");
  const options = { dir, include: ["web"], output: join(root, "demo.spaceapp"), target: { os: "any", arch: "any" } as const, sourceIncluded: false };
  await packApplication(options);
  return { root, ws, db, store, installer, options, bytes: await readPackageFile(options.output) };
}

test("installation is explicit, idempotent, preserves data and persists Space identity", async () => {
  const s = await setup();
  await expect(s.installer.install(s.bytes)).rejects.toThrow(/signature/);
  expect(s.store.list()).toHaveLength(0);
  await Bun.write(join(s.ws.data, "demo/existing.txt"), "user data");
  const id = crypto.randomUUID();
  const [a, b] = await Promise.all([s.installer.install(s.bytes, { id, allowUnsigned: true }), s.installer.install(s.bytes, { id, allowUnsigned: true })]);
  expect(a.id).toBe(b.id);
  expect(s.store.get(id)?.state).toBe("installed");
  expect(await Bun.file(join(s.ws.apps, "demo/web/index.html")).text()).toBe("<p>Offline content</p>");
  expect(await Bun.file(join(s.ws.data, "demo/existing.txt")).text()).toBe("user data");
  expect(new PackageStore(s.db).spaceId).toBe(s.store.spaceId);
  expect((await s.installer.install(s.bytes, { allowUnsigned: true })).id).toBe(id);
});

test("never overwrites an existing checkout or symlink", async () => {
  const s = await setup();
  await Bun.write(join(s.ws.apps, "demo/owned.txt"), "existing checkout");
  const failed = await s.installer.install(s.bytes, { allowUnsigned: true });
  expect(failed.state).toBe("failed");
  expect(await Bun.file(join(s.ws.apps, "demo/owned.txt")).text()).toBe("existing checkout");
  await rm(join(s.ws.apps, "demo"), { recursive: true });
  await symlink(s.options.dir, join(s.ws.apps, "demo"));
  expect((await s.installer.install(s.bytes, { allowUnsigned: true })).state).toBe("failed");
  expect(await Bun.file(join(s.options.dir, "space.yaml")).exists()).toBe(true);
});

test("recovery validates published files and records interrupted staging without executing code", async () => {
  const s = await setup();
  const done = await s.installer.install(s.bytes, { allowUnsigned: true });
  s.db.query("UPDATE package_operations SET state='installing' WHERE id=?").run(done.id);
  expect((await s.installer.recover())[0]?.state).toBe("installed");
  s.db.query("UPDATE package_operations SET state='installing' WHERE id=?").run(done.id);
  await Bun.write(join(s.ws.apps, "demo/web/index.html"), "tampered");
  expect((await s.installer.recover())[0]?.state).toBe("failed");
  const pending = s.store.reserve(crypto.randomUUID(), "other", "1.0.0", "a".repeat(64)).operation;
  await mkdir(join(s.ws.run, "packages", pending.id));
  expect((await s.installer.recover())[0]?.state).toBe("failed");
});

test("API requires operator authorization, enforces same-origin writes and supports operation lookup", async () => {
  const s = await setup();
  const routes = guardBrowserWrites(createPackageRoutes({ installer: s.installer, token: "operator-key" })) as ReturnType<typeof createPackageRoutes>;
  const send = (headers: Record<string, string>) => routes["/api/packages"]!.POST!(Object.assign(new Request("http://localhost/api/packages", { method: "POST", headers: { "content-type": "application/octet-stream", ...headers }, body: new Uint8Array(s.bytes).buffer }), { params: {} }));
  expect((await send({})).status).toBe(401);
  expect((await send({ authorization: "Bearer wrong" })).status).toBe(401);
  expect((await send({ authorization: "Bearer operator-key" })).status).toBe(400);
  const result = await send({ authorization: "Bearer operator-key", "x-space-allow-unsigned": "true" });
  expect(result.status).toBe(200);
  const body = await result.json() as { operation: { id: string } };
  const read = await routes["/api/packages/operations/:id"]!.GET!(Object.assign(new Request("http://localhost/api/packages/operations/x", { headers: { authorization: "Bearer operator-key" } }), { params: { id: body.operation.id } }));
  expect(read.status).toBe(200);
  const unprotected = guardBrowserWrites(createPackageRoutes({ installer: s.installer, token: "" })) as ReturnType<typeof createPackageRoutes>;
  expect((await unprotected["/api/packages"]!.POST!(Object.assign(new Request("http://localhost/api/packages", { method: "POST", headers: { origin: "https://evil.example" } }), { params: {} }))).status).toBe(403);
});

test("a host trusted signature installs without an unsigned override", async () => {
  const s = await setup();
  const keys = generateKeyPairSync("ed25519");
  const signingKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const signed = await packApplication({ ...s.options, output: s.options.output + ".signed", signingKey });
  const bytes = await readPackageFile(signed.path);
  await expect(s.installer.install(bytes, { allowUnsigned: true })).rejects.toThrow(/signature/);
  expect((await s.installer.install(bytes, { trustedKeys: [publicKey] })).state).toBe("installed");
});
