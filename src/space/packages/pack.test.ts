import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { readArchive, writeArchive } from "./archive.ts";
import { inspectPackage, packApplication } from "./pack.ts";

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "space-package-")); dirs.push(root);
  const dir = join(root, "app");
  await mkdir(join(dir, "web"), { recursive: true });
  await Bun.write(join(dir, "space.yaml"), `spec: 2\nname: demo\nversion: 1.0.0\nrequires: { spaceApi: 1 }\noffline: { features: [Read], online: [] }\nlaunch: { kind: static, root: web }\n`);
  await Bun.write(join(dir, "web/index.html"), "<!doctype html><title>Offline demo</title><p>Hello</p>");
  return { dir, output: join(root, "demo.spaceapp"), include: ["web"], target: { os: "any", arch: "any" } as const, sourceIncluded: false };
}

test("package round trip is deterministic, offline and contains only selected files", async () => {
  const opts = await fixture();
  await Bun.write(join(opts.dir, "private.txt"), "not selected");
  await Bun.write(join(opts.dir, "web/.env"), "SECRET=not-in-package");
  const result = await packApplication(opts);
  expect(result.excluded).toEqual(["web/.env"]);
  const bytes = new Uint8Array(await Bun.file(opts.output).arrayBuffer());
  const verified = await inspectPackage(bytes);
  expect(verified.manifest.app).toBe("demo");
  expect(verified.signature.status).toBe("unsigned");
  expect([...verified.files.keys()]).toEqual(["space.yaml", "web/index.html"]);
  const second = await packApplication({ ...opts, output: opts.output + ".second" });
  expect(second.sha256).toBe(result.sha256);
  await expect(packApplication(opts)).rejects.toThrow(/exist/);
});

test("release manifest overrides leave legacy source unchanged and exclude named environment files", async () => {
  const opts = await fixture();
  const release = await Bun.file(join(opts.dir, "space.yaml")).text();
  const legacy = "spec: 1\nname: demo\nservice: {command: bun app.ts, port: 8980}\n";
  await Bun.write(join(opts.dir, "space.yaml"), legacy);
  await Bun.write(join(opts.dir, "config.env"), "SECRET=not-shipped");
  await packApplication({ ...opts, manifest: release, include: [...opts.include, "config.env"] });
  const inspected = await inspectPackage(new Uint8Array(await Bun.file(opts.output).arrayBuffer()));
  expect(inspected.manifest.spec).toBe(2);
  expect(inspected.files.has("config.env")).toBe(false);
  expect(await Bun.file(join(opts.dir, "space.yaml")).text()).toBe(legacy);
});

test("signatures cover the exact inventory and require an independently trusted key", async () => {
  const opts = await fixture();
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  await packApplication({ ...opts, signingKey: privatePem });
  const bytes = new Uint8Array(await Bun.file(opts.output).arrayBuffer());
  expect((await inspectPackage(bytes)).signature.status).toBe("untrusted");
  expect((await inspectPackage(bytes, [publicPem])).signature.status).toBe("verified");
  const entries = await readArchive(bytes);
  const metadata = entries.find((e) => e.path === "package.json")!;
  metadata.bytes = new TextEncoder().encode(new TextDecoder().decode(metadata.bytes) + " ");
  await expect(inspectPackage(writeArchive(entries), [publicPem])).rejects.toThrow(/signature/);
});

test("payload changes, extra files and missing files cannot bypass the index", async () => {
  const opts = await fixture(); await packApplication(opts);
  const entries = await readArchive(new Uint8Array(await Bun.file(opts.output).arrayBuffer()));
  const changed = entries.map((e) => e.path === "app/web/index.html" ? { ...e, bytes: new Uint8Array([1]) } : e);
  await expect(inspectPackage(writeArchive(changed))).rejects.toThrow(/integrity/);
  await expect(inspectPackage(writeArchive([...entries, { path: "app/extra", bytes: new Uint8Array(), executable: false }]))).rejects.toThrow(/count/);
  await expect(inspectPackage(writeArchive(entries.filter((e) => e.path !== "app/web/index.html")))).rejects.toThrow(/count/);
});

test("rejects source links, links in include ancestors, missing entry and native portable payload", async () => {
  const opts = await fixture();
  await symlink("index.html", join(opts.dir, "web/link"));
  await expect(packApplication(opts)).rejects.toThrow(/symlink/);
  await symlink("web", join(opts.dir, "linked"));
  await expect(packApplication({ ...opts, include: ["linked/index.html"] })).rejects.toThrow(/ancestor/);
  await expect(packApplication({ ...opts, include: [] })).rejects.toThrow(/index is absent/);
  await Bun.write(join(opts.dir, "binary"), new Uint8Array([0x7f, 69, 76, 70]));
  await expect(packApplication({ ...opts, include: ["web/index.html", "binary"] })).rejects.toThrow(/native binary/);
  await chmod(join(opts.dir, "space.yaml"), 0o755);
  await expect(packApplication({ ...opts, include: ["web/index.html"] })).rejects.toThrow(/non-executable/);
});

test("reader enforces actual decompression bounds, file types and checksum", async () => {
  await expect(readArchive(gzipSync(Buffer.alloc(16_384)), 1024)).rejects.toThrow(/limit/);
  const good = writeArchive([{ path: "app/file", bytes: new Uint8Array([42]), executable: false }]);
  const tar = gunzipSync(good);
  tar[156] = 50; // symlink; recompute checksum so it reaches type validation.
  tar.fill(32, 148, 156);
  const sum = tar.subarray(0, 512).reduce((n, b) => n + b, 0);
  tar.write(sum.toString(8).padStart(7, "0") + "\0", 148, 8, "ascii");
  await expect(readArchive(gzipSync(tar))).rejects.toThrow(/regular files/);
  tar[0] = 99;
  await expect(readArchive(gzipSync(tar))).rejects.toThrow(/checksum/);
  await expect(readArchive(writeArchive([{ path: "a", bytes: new Uint8Array(), executable: false }, { path: "A", bytes: new Uint8Array(), executable: false }]))).rejects.toThrow(/duplicate/);
});

test("archive bounds apply before output is created and long paths round trip", async () => {
  const opts = await fixture();
  await expect(packApplication({ ...opts, limit: 100 })).rejects.toThrow(/limit/);
  expect(await Bun.file(opts.output).exists()).toBe(false);
  const path = "app/" + "a".repeat(90) + "/" + "b".repeat(90);
  expect((await readArchive(writeArchive([{ path, bytes: new Uint8Array([1, 2]), executable: true }])))[0]?.path).toBe(path);
});
