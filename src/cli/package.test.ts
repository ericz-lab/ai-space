import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./testing.ts";

test("pack and inspect work without a running Space or network calls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "space-package-cli-"));
  try {
    await Bun.write(join(dir, "app/space.yaml"), "spec: 2\nname: task-app\nversion: 1.0.0\nrequires: { spaceApi: 1 }\noffline: { features: [], online: [] }\n");
    const packed = await runCli(["app", "pack", "app", "--output", "task.spaceapp", "--json"], undefined, { cwd: dir });
    expect(packed.code).toBe(0);
    expect(packed.calls).toHaveLength(0);
    expect(JSON.parse(packed.out.join("\n"))).toMatchObject({ app: "task-app", files: 1 });
    const inspected = await runCli(["app", "inspect-package", "task.spaceapp", "--check-host", "--json"], undefined, { cwd: dir });
    expect(inspected.code).toBe(0);
    expect(inspected.calls).toHaveLength(0);
    expect(JSON.parse(inspected.out.join("\n"))).toMatchObject({ app: "task-app", signature: { status: "unsigned" } });
    expect((await runCli(["app", "pack", "app"], undefined, { cwd: dir })).code).toBe(2);
    const installed = await runCli(["app", "install", "task.spaceapp", "--allow-unsigned", "--operation-id", "d620b707-7e26-42bc-86cd-aaeb32d47e6a"], undefined, { cwd: dir });
    expect(installed.code).toBe(0);
    expect(installed.calls[0]?.headers).toMatchObject({ "content-type": "application/octet-stream", "x-space-allow-unsigned": "true", "idempotency-key": "d620b707-7e26-42bc-86cd-aaeb32d47e6a", authorization: "Bearer op-token" });
    expect(installed.calls[0]?.body).toBeInstanceOf(Uint8Array);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("connection grants only share named local apps and package removal requires confirmation", async () => {
  const grant = await runCli(["connection", "grant", "connection-id", "--apps", ""]);
  expect(grant.code).toBe(0); expect(grant.calls[0]?.body).toEqual({ apps: [] });
  const denied = await runCli(["app", "remove-package", "demo"]);
  expect(denied.calls).toHaveLength(0); expect(denied.code).not.toBe(0);
  const remove = await runCli(["app", "remove-package", "demo", "--yes"]);
  expect(remove.calls[0]?.url).toEndWith("/api/packages/apps/demo");
  expect(remove.calls[0]?.method).toBe("DELETE");
  expect((await runCli(["connection", "rm", "connection-id"])).calls).toHaveLength(0);
  const gone = await runCli(["connection", "rm", "connection-id", "--yes"]);
  expect(gone.calls[0]).toMatchObject({ method: "DELETE", url: expect.stringMatching(/\/api\/connections\/connection-id$/) });
});

test("install and upgrade take a catalog app by name and a package file by path", async () => {
  const result = { app: "notes", version: "1.0.0", action: "installed", from: "package", ref: "v1.0.0" };
  const byName = await runCli(["app", "install", "notes", "--with-source"], (t) => t.scripted.reply({ status: 200, body: { ok: true, result } }));
  expect(byName.code).toBe(0);
  expect(byName.calls[0]).toMatchObject({ method: "POST", url: expect.stringMatching(/\/api\/app-catalog\/notes\/install$/), body: { withSource: true } });
  expect(byName.out.join("\n")).toContain("notes 1.0.0 installed from package (v1.0.0)");
  const source = await runCli(["app", "install", "notes", "--ref", "main"], (t) => t.scripted.reply({ status: 200, body: { ok: true, result: { ...result, from: "source", ref: "main", dir: "/ws/app-src/notes" } } }));
  expect(source.calls[0]?.body).toEqual({ from: "source", ref: "main" });
  expect(source.out.join("\n")).toContain("space app build notes");
  const upgrade = await runCli(["app", "upgrade", "notes", "--package"], (t) => t.scripted.reply({ status: 200, body: { ok: true, result: { ...result, action: "upgraded" } } }));
  expect(upgrade.calls[0]).toMatchObject({ url: expect.stringMatching(/\/api\/app-catalog\/notes\/upgrade$/), body: { from: "package" } });
  // A file goes to the package installer, even after a flag with a value.
  const file = await runCli(["app", "install", "--operation-id", "d620b707-7e26-42bc-86cd-aaeb32d47e6a", "./missing.spaceapp"]);
  expect(file.code).not.toBe(0);
  expect(file.calls).toHaveLength(0);
});

test("a publisher the Space does not trust is named, and --trust is needed without a terminal", async () => {
  const publisher = { id: "lab", name: "Some Lab", keyId: "a".repeat(64) };
  const r = await runCli(["app", "install", "other"], (t) => t.scripted.reply({ status: 409, body: { ok: false, code: "trust-required", error: "not trusted", publisher } }));
  expect(r.code).toBe(1);
  expect(r.err.join("\n")).toContain("Some Lab");
  expect(r.err.join("\n")).toContain("--trust");
  const ok = await runCli(["app", "install", "other", "--trust"], (t) => t.scripted.reply({ status: 200, body: { ok: true, result: { app: "other", version: "1.0.0", action: "installed", from: "package" } } }));
  expect(ok.calls[0]?.body).toEqual({ trust: true });
});

test("catalog lists apps and says when a catalog cannot be read", async () => {
  const view = { sources: [{ url: "https://example.com/c.json", ok: false, stale: true, error: "offline", apps: 1 }], git: true, apps: [
    { name: "notes", title: { en: "Notes" }, needs: ["model"], publisher: { id: "p", name: "Lab", keyId: "k", trusted: true }, latest: { version: "1.1.0", tag: "v1.1.0", sourcePackage: true }, installed: { version: "1.0.0", origin: "package", ref: "v1.0.0", dev: false }, state: "update" },
  ] };
  const r = await runCli(["app", "catalog"], (t) => t.scripted.reply({ status: 200, body: { ok: true, ...view } }));
  expect(r.code).toBe(0);
  expect(r.err.join("\n")).toContain("showing the last copy; offline");
  expect(r.out.join("\n")).toMatch(/notes\s+Notes\s+1\.1\.0\s+1\.0\.0 \(package\)\s+update\s+model\s+Lab/);
});

test("release builds packages from a checkout without a Space", async () => {
  const dir = await mkdtemp(join(tmpdir(), "space-release-cli-"));
  try {
    await Bun.write(join(dir, "app/space.release.yaml"), "spec: 2\nname: rel\nversion: 2.0.0\nrequires: { spaceApi: 1 }\noffline: { features: [], online: [] }\nlaunch: { kind: static, root: web }\nbuild:\n  run: mkdir -p web && echo hi > web/index.html\n  include: [web]\n");
    await Bun.write(join(dir, "app/space.yaml"), "spec: 1\nname: rel\n");
    const keys = await runCli(["app", "keygen", "--out", "signing.pem", "--json"], undefined, { cwd: dir });
    expect(keys.code).toBe(0);
    const key = JSON.parse(keys.out.join("\n")) as { keyId: string; publicKey: string };
    expect(key.keyId).toMatch(/^[a-f0-9]{64}$/);
    expect((await Bun.file(join(dir, "signing.pem")).stat()).mode & 0o777).toBe(0o600);
    const r = await runCli(["app", "release", "app", "--output-dir", "out", "--sign-key", "signing.pem", "--json"], undefined, { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.calls).toHaveLength(0);
    const out = JSON.parse(r.out.join("\n")) as { packages: { variant: string; path: string }[] };
    expect(out.packages.map((p) => p.variant)).toEqual(["bundle", "source"]);
    const inspected = await runCli(["app", "inspect-package", "out/rel-2.0.0.spaceapp", "--trusted-key", "signing.pem.pub", "--json"], undefined, { cwd: dir });
    expect(JSON.parse(inspected.out.join("\n"))).toMatchObject({ app: "rel", version: "2.0.0", signature: { status: "verified", keyId: key.keyId } });
    // A key is never overwritten.
    expect((await runCli(["app", "keygen", "--out", "signing.pem"], undefined, { cwd: dir })).code).not.toBe(0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
