import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WINDOWS } from "../space/testing.ts";
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

test("connection scopes, full trust and the alias are set and shown", async () => {
  const set = await runCli(["connection", "scopes", "c1", "--scopes", "panel, agents"]);
  expect(set.code).toBe(0);
  expect(set.calls[0]).toMatchObject({ method: "PATCH", url: expect.stringMatching(/\/api\/connections\/c1$/), body: { scopes: ["panel", "agents"] } });
  expect((await runCli(["connection", "scopes", "c1", "--scopes", ""])).calls[0]?.body).toEqual({ scopes: [] });
  // Full trust is asked for; without a terminal it needs --yes.
  expect((await runCli(["connection", "scopes", "c1", "--full-trust", "on"])).calls).toHaveLength(0);
  expect((await runCli(["connection", "scopes", "c1", "--full-trust", "on", "--yes"])).calls[0]?.body).toEqual({ fullTrust: true });
  expect((await runCli(["connection", "scopes", "c1", "--full-trust", "off"])).calls[0]?.body).toEqual({ fullTrust: false });
  expect((await runCli(["connection", "scopes", "c1", "--full-trust", "maybe"])).code).toBe(2);
  expect((await runCli(["connection", "scopes", "c1"])).code).toBe(2);
  expect((await runCli(["connection", "alias", "c1", "office"])).calls[0]?.body).toEqual({ alias: "office" });
  expect((await runCli(["connection", "alias", "c1", "--clear"])).calls[0]?.body).toEqual({ alias: null });
  const created = await runCli(["connection", "create", "incoming", "0d8ce940-9bc8-4082-bab2-0ccb7e5dbd87", "--scopes", "panel", "--alias", "box"]);
  expect(created.calls[0]?.body).toEqual({ direction: "incoming", remoteSpaceId: "0d8ce940-9bc8-4082-bab2-0ccb7e5dbd87", apps: [], scopes: ["panel"], alias: "box" });
  expect((await runCli(["connection", "create", "incoming", "0d8ce940-9bc8-4082-bab2-0ccb7e5dbd87", "--full-trust"])).calls).toHaveLength(0);
  const row = { id: "c1", remoteSpaceId: "0d8ce940-9bc8-4082-bab2-0ccb7e5dbd87", direction: "outgoing", enabled: true, connected: true, apps: [], scopes: ["panel"], fullTrust: false, alias: null, remoteName: "hub", peer: { name: "hub", state: "peer", granted: { scopes: [], fullTrust: true } } };
  const listed = await runCli(["connection", "ls"], (t) => t.scripted.reply({ status: 200, body: { spaceId: "me", connections: [row, { ...row, id: "c2", fullTrust: true, peer: { name: "x", state: "no-panel", reason: "no panel scope", granted: { scopes: [], fullTrust: false } } }] } }));
  expect(listed.code).toBe(0);
  const text = listed.out.join("\n");
  expect(text).toMatch(/c1\s+outgoing\s+\S+\s+hub\s+up\s+-\s+panel\s+yes \(full trust\)/);
  expect(text).toMatch(/c2\s+.*full trust\s+no: no panel scope/);
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
    // Windows has no permission bits to set or read back.
    if (!WINDOWS) expect((await Bun.file(join(dir, "signing.pem")).stat()).mode & 0o777).toBe(0o600);
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

test("connection verbs say what they did in one sentence, and the route's answer under --json", async () => {
  const connection = { id: "c1", remoteSpaceId: "r", direction: "incoming", apps: [], enabled: true };
  const created = await runCli(["connection", "create", "incoming", "0d8ce940-9bc8-4082-bab2-0ccb7e5dbd87"], (t) => t.scripted.reply({ status: 200, body: { ok: true, connection, token: "sct_once" } }));
  expect(created.out).toEqual(["incoming connection c1 created", "token (shown only now; store it on the other Space): sct_once"]);
  const ok = (t: Parameters<NonNullable<Parameters<typeof runCli>[1]>>[0]) => t.scripted.reply({ status: 200, body: { ok: true, connection } });
  expect((await runCli(["connection", "grant", "c1", "--apps", "notes,mail"], ok)).out).toEqual(["connection c1 now shares notes, mail"]);
  expect((await runCli(["connection", "grant", "c1", "--apps", ""], ok)).out).toEqual(["connection c1 now shares no apps"]);
  expect((await runCli(["connection", "scopes", "c1", "--scopes", "panel"], ok)).out).toEqual(["connection c1 scopes updated"]);
  expect((await runCli(["connection", "alias", "c1", "office"], ok)).out).toEqual(["connection c1 is now called office"]);
  expect((await runCli(["connection", "disable", "c1"], ok)).out).toEqual(["connection c1 disabled"]);
  expect((await runCli(["connection", "enable", "c1"], ok)).out).toEqual(["connection c1 enabled"]);
  // -y is --yes, as for task rm.
  const removed = await runCli(["connection", "rm", "c1", "-y"], ok);
  expect(removed.code).toBe(0);
  expect(removed.out).toEqual(["connection c1 removed"]);
  expect((await runCli(["connection", "scopes", "c1", "--full-trust", "on", "-y"], ok)).calls[0]?.body).toEqual({ fullTrust: true });
  expect((await runCli(["connection", "create", "incoming", "0d8ce940-9bc8-4082-bab2-0ccb7e5dbd87", "--full-trust", "-y"], ok)).calls).toHaveLength(1);
  const json = await runCli(["connection", "enable", "c1", "--json"], ok);
  expect(JSON.parse(json.out.join("\n"))).toEqual({ ok: true, connection });
});

test("connection and package usage mistakes exit 2 with the usage line", async () => {
  const direction = await runCli(["connection", "create", "sideways", "x"]);
  expect(direction.code).toBe(2);
  expect(direction.err).toEqual(["space: direction must be incoming or outgoing", expect.stringContaining("usage: space connection create")]);
  expect((await runCli(["connection", "grant", "c1"])).code).toBe(2);
  expect((await runCli(["app", "install", "notes", "--source", "--package"])).code).toBe(2);
  expect((await runCli(["app", "pack", "app", "--output", "x.spaceapp", "--target", "a/b/c"])).code).toBe(2);
});

test("a question answered no does nothing and says so; questions name what they affect", async () => {
  const no = await runCli(["connection", "rm", "c1"], undefined, { isTTY: true, prompt: async () => "n" });
  expect(no.code).toBe(1);
  expect(no.calls).toHaveLength(0);
  expect(no.err).toEqual(["nothing done"]);
  let asked = "";
  await runCli(["app", "remove-package", "notes"], undefined, { isTTY: true, prompt: async (q) => ((asked = q), "n") });
  expect(asked).toStartWith("Remove package notes?");
  await runCli(["connection", "scopes", "c1", "--full-trust", "on"], undefined, { isTTY: true, prompt: async (q) => ((asked = q), "n") });
  expect(asked).toStartWith("Grant full trust to c1?");
});

test("packages is a table, install and package changes say what was done", async () => {
  const operations = [{ id: "op-1", app: "notes", version: "1.2.0", state: "installed", error: null, digest: "d", createdAt: "2026-11-25T00:00:00.000Z", updatedAt: "2026-11-25T00:00:00.000Z" }];
  const listed = await runCli(["app", "packages"], (t) => t.scripted.reply({ status: 200, body: { ok: true, spaceId: "me", operations } }));
  expect(listed.out[0]).toBe("this Space: me");
  expect(listed.out[1]).toMatch(/^APP\s+VERSION\s+STATE\s+OPERATION/);
  expect(listed.out[2]).toMatch(/^notes\s+1\.2\.0\s+installed\s+op-1/);
  const json = await runCli(["app", "packages", "--json"], (t) => t.scripted.reply({ status: 200, body: { ok: true, spaceId: "me", operations } }));
  expect(JSON.parse(json.out.join("\n"))).toMatchObject({ spaceId: "me", operations: [{ id: "op-1" }] });
  const removed = await runCli(["app", "remove-package", "notes", "-y"], (t) => t.scripted.reply({ status: 200, body: { ok: true, change: { app: "notes", kind: "uninstall", state: "done" }, data: "retained" } }));
  expect(removed.code).toBe(0);
  expect(removed.out).toEqual(["notes removed; its data is kept"]);
  const back = await runCli(["app", "rollback", "notes", "op-0", "--yes"], (t) => t.scripted.reply({ status: 200, body: { ok: true, change: { app: "notes", kind: "rollback", state: "done" } } }));
  expect(back.out).toEqual(["notes rolled back to operation op-0"]);
});

test("a package file install says what was installed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "space-package-cli-"));
  try {
    await Bun.write(join(dir, "app/space.yaml"), "spec: 2\nname: task-app\nversion: 1.0.0\nrequires: { spaceApi: 1 }\noffline: { features: [], online: [] }\n");
    expect((await runCli(["app", "pack", "app", "--output", "task.spaceapp"], undefined, { cwd: dir })).code).toBe(0);
    const operation = { id: "op-1", app: "task-app", version: "1.0.0", state: "installed", error: null };
    const r = await runCli(["app", "install", "task.spaceapp", "--allow-unsigned"], (t) => t.scripted.reply({ status: 200, body: { ok: true, operation } }), { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.out).toEqual(["task-app 1.0.0 installed"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("long operations announce themselves on stderr before the request", async () => {
  const result = { app: "notes", version: "1.0.0", action: "installed", from: "source", ref: "main" };
  const source = await runCli(["app", "install", "notes", "--source", "--json"], (t) => t.scripted.reply({ status: 200, body: { ok: true, result } }));
  expect(source.err).toEqual(["installing notes from source; building can take a few minutes..."]);
  expect(JSON.parse(source.out.join("\n"))).toMatchObject({ result });
  const build = { app: "notes", version: "1.0.1", action: "upgraded" };
  const created = await runCli(["app", "create", "notes"], (t) => t.scripted.reply({ status: 200, body: { ok: true, dir: "/ws/app-src/notes", build } }));
  expect(created.err).toEqual(["creating notes: making its source, packing and installing it..."]);
  const built = await runCli(["app", "build", "notes"], (t) => t.scripted.reply({ status: 200, body: { ok: true, build } }));
  expect(built.err).toEqual(["building notes: packing and installing it..."]);
  expect(built.out).toEqual(["notes 1.0.1 upgraded"]);
});
