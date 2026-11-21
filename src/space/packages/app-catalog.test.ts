import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { workspacePaths } from "../workspace.ts";
import { AppCatalog, CatalogError, createAppCatalogRoutes, newerVersion, parseCatalog } from "./app-catalog.ts";
import { catalogSources, DEFAULT_CATALOG_URL } from "./catalog-sources.ts";
import { PackageInstaller } from "./install.ts";
import { PackageLifecycle } from "./lifecycle.ts";
import { keyIdOf } from "./publishers.ts";
import { buildRelease } from "./release.ts";
import { readSourceRecord, sourceCondition } from "./source-copy.ts";
import { buildSource } from "../studio.ts";
import { PackageRuntime } from "./runtime.ts";
import { PackageStore } from "./store.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });

function keypair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ type: "spki", format: "pem" }).toString();
  return { private: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), public: pub, keyId: keyIdOf(pub) };
}

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "init.defaultBranch=main", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

/** A static app's repository: spec-1 space.yaml for its git deployment, the release declaration with a build beside it. */
async function appRepo(root: string, name: string, version: string) {
  const dir = join(root, "repos", name);
  await mkdir(join(dir, "src"), { recursive: true });
  await Bun.write(join(dir, "space.yaml"), `spec: 1\nname: ${name}\n`);
  await Bun.write(join(dir, "space.release.yaml"), releaseYaml(name, version));
  await Bun.write(join(dir, "src", "index.html"), `<p>${name} ${version}</p>`);
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "first");
  git(dir, "tag", `v${version}`);
  return dir;
}
const releaseYaml = (name: string, version: string) => `spec: 2\nname: ${name}\nversion: ${version}\nrequires: {spaceApi: 1}\noffline: {features: [Read], online: []}\nlaunch: {kind: static, root: web}\nbuild:\n  run: mkdir -p web && cp src/index.html web/index.html\n  include: [web]\n`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "space-app-catalog-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const ws = workspacePaths(join(root, "workspace"));
  for (const d of [ws.home, ws.data, ws.run, ws.logs]) await mkdir(d, { recursive: true });
  const db = new Database(":memory:");
  cleanup.push(() => db.close());
  const store = new PackageStore(db), installer = new PackageInstaller(ws, store);
  const runtime = new PackageRuntime({ logDir: ws.logs, envFor: async () => ({}) });
  cleanup.push(() => runtime.close(0));
  const activate = async (app: string) => { await runtime.register(await installer.load(app)); };
  const lifecycle = new PackageLifecycle(installer, { suspend: (app) => runtime.suspend(app), activate, remove: (app) => runtime.remove(app), verify: (app) => runtime.verify(app) });
  const ours = keypair(), theirs = keypair();
  const mirror = join(root, "mirror");
  await mkdir(mirror, { recursive: true });

  /** Build a release of a repository into the mirror, as the publisher's workflow would. */
  const publish = async (name: string, key: { private: string }) => {
    const r = await buildRelease({ dir: join(root, "repos", name), outDir: mirror, variants: ["bundle", "source"], signingKey: key.private });
    const [bundle, source] = r.packages;
    return { version: r.version, tag: `v${r.version}`, package: { url: bundle!.path.split("/").pop()!, sha256: bundle!.sha256 }, sourcePackage: { url: source!.path.split("/").pop()!, sha256: source!.sha256 }, requires: { spaceApi: 1 } };
  };
  await appRepo(root, "notes", "1.0.0");
  await appRepo(root, "other", "1.0.0");
  await appRepo(root, "draft", "0.1.0");
  const apps: Record<string, unknown>[] = [
    { name: "notes", publisher: "ours", title: { en: "Notes", zh: "笔记" }, description: { en: "Short notes" }, repo: pathToFileURL(join(root, "repos", "notes")).href, license: "MIT", recommended: true, needs: ["model"], online: [{ en: "Summaries", zh: "摘要" }], latest: await publish("notes", ours) },
    { name: "other", publisher: "theirs", title: "Other", description: "Someone else's", repo: pathToFileURL(join(root, "repos", "other")).href, license: "MIT", latest: await publish("other", theirs) },
    { name: "draft", publisher: "ours", title: "Draft", description: "Not released yet", repo: pathToFileURL(join(root, "repos", "draft")).href, license: "MIT" },
  ];
  const catalogFile = join(mirror, "catalog.json");
  const writeCatalog = () => Bun.write(catalogFile, JSON.stringify({
    catalog: 1,
    publishers: [{ id: "ours", name: "Our Lab", keyId: ours.keyId, publicKey: ours.public }, { id: "theirs", name: "Their Lab", keyId: theirs.keyId, publicKey: theirs.public, url: "https://example.com" }],
    apps,
  }));
  await writeCatalog();
  const catalog = new AppCatalog({ db, sources: [pathToFileURL(catalogFile).href], studio: { ws, installer, lifecycle, store, activate }, trustedKeys: [ours.public] });
  return { root, ws, store, installer, lifecycle, runtime, catalog, apps, writeCatalog, publish, ours, theirs, mirror };
}

const state = async (c: AppCatalog) => Object.fromEntries((await c.view()).apps.map((a) => [a.name, a.state]));

describe("app catalog", () => {
  test("lists apps with their state and publisher trust", async () => {
    const f = await fixture();
    const view = await f.catalog.view();
    expect(view.sources).toHaveLength(1);
    expect(view.sources[0]).toMatchObject({ ok: true, apps: 3 });
    expect(Object.fromEntries(view.apps.map((a) => [a.name, [a.state, a.publisher.trusted]]))).toEqual({ notes: ["available", true], other: ["available", false], draft: ["unreleased", true] });
    const notes = view.apps.find((a) => a.name === "notes")!;
    expect(notes).toMatchObject({ title: { en: "Notes", zh: "笔记" }, recommended: true, needs: ["model"], latest: { version: "1.0.0", tag: "v1.0.0", sourcePackage: true }, installed: null });
  });

  test("installs a signed package, refuses a tampered one, upgrades to a newer release", async () => {
    const f = await fixture();
    // A package whose bytes differ from the catalog's checksum never installs.
    const latest = f.apps[0]!.latest as { package: { sha256: string } };
    const good = latest.package.sha256;
    latest.package.sha256 = "0".repeat(64);
    await f.writeCatalog();
    expect(await f.catalog.install("notes", { withSource: false }).catch((e: CatalogError) => e.code)).toBe("checksum");
    latest.package.sha256 = good;
    await f.writeCatalog();

    const r = await f.catalog.install("notes", { withSource: false });
    expect(r).toMatchObject({ app: "notes", version: "1.0.0", action: "installed", from: "package" });
    expect(r.source).toBeUndefined();
    expect(await Bun.file(join(f.ws.apps, "notes", "web", "index.html")).text()).toBe("<p>notes 1.0.0</p>");
    expect(await Bun.file(join(f.ws.apps, "notes", "src", "index.html")).exists()).toBe(false);
    expect(await Bun.file(join(f.ws.home, "app-src", "notes", "space.yaml")).exists()).toBe(false);
    expect((await f.catalog.view()).apps.find((a) => a.name === "notes")!.installed).toEqual({ version: "1.0.0", origin: "package", ref: "v1.0.0", dev: false });
    expect(await f.catalog.install("notes").catch((e: CatalogError) => e.code)).toBe("current");

    // The publisher releases 1.1.0.
    const repo = join(f.root, "repos", "notes");
    await Bun.write(join(repo, "space.release.yaml"), releaseYaml("notes", "1.1.0"));
    await Bun.write(join(repo, "src", "index.html"), "<p>notes 1.1.0</p>");
    git(repo, "commit", "-qam", "1.1.0");
    git(repo, "tag", "v1.1.0");
    f.apps[0]!.latest = await f.publish("notes", f.ours);
    await f.writeCatalog();
    expect((await state(f.catalog)).notes).toBe("update");
    const up = await f.catalog.upgrade("notes", { withSource: true });
    expect(up).toMatchObject({ version: "1.1.0", action: "upgraded", from: "package" });
    expect(await Bun.file(join(f.ws.apps, "notes", "src", "index.html")).exists()).toBe(true);
    expect((await state(f.catalog)).notes).toBe("installed");
  });

  test("a publisher the Space does not trust needs the owner's yes once", async () => {
    const f = await fixture();
    const e = await f.catalog.install("other").catch((x) => x) as CatalogError;
    expect(e.code).toBe("trust-required");
    expect(e.detail.publisher).toMatchObject({ id: "theirs", name: "Their Lab", keyId: f.theirs.keyId });
    expect(f.store.installed("other")).toBeUndefined();
    expect((await f.catalog.install("other", { trust: true })).action).toBe("installed");
    const view = await f.catalog.view();
    expect(view.trusted).toEqual([{ keyId: f.theirs.keyId, name: "Their Lab" }]);
    expect(view.apps.find((a) => a.name === "other")!.publisher.trusted).toBe(true);
    expect(f.catalog.forget(f.theirs.keyId)).toBe(true);
    expect((await f.catalog.view()).apps.find((a) => a.name === "other")!.publisher.trusted).toBe(false);
  });

  test("a package signed by another key than its publisher's is refused", async () => {
    const f = await fixture();
    // `other` claims to be ours, but its package is signed with their key.
    f.apps[1]!.publisher = "ours";
    await f.writeCatalog();
    expect(await f.catalog.install("other").catch((e: CatalogError) => e.code)).toBe("signature");
  });

  test("an app comes with source the owner can change; a release never overwrites their changes", async () => {
    const f = await fixture();
    const src = join(f.ws.home, "app-src", "notes");
    const notes = async () => (await f.catalog.view()).apps.find((a) => a.name === "notes")!;
    const release = async (version: string) => {
      const repo = join(f.root, "repos", "notes");
      await Bun.write(join(repo, "space.release.yaml"), releaseYaml("notes", version));
      await Bun.write(join(repo, "src", "index.html"), `<p>notes ${version}</p>`);
      git(repo, "commit", "-qam", version);
      git(repo, "tag", `v${version}`);
      f.apps[0]!.latest = await f.publish("notes", f.ours);
      await f.writeCatalog();
    };

    // By default the release's source package is taken, and its files are put where they can be edited.
    const r = await f.catalog.install("notes");
    expect(r).toMatchObject({ version: "1.0.0", from: "package", dir: src, source: { dir: src, action: "copied" } });
    expect(await Bun.file(join(src, "src", "index.html")).text()).toBe("<p>notes 1.0.0</p>");
    expect(await Bun.file(join(src, "space.yaml")).text()).toContain("build:");
    expect((await readSourceRecord(src))!.version).toBe("1.0.0");
    expect(await sourceCondition(src)).toEqual({ state: "pristine", version: "1.0.0" });
    expect((await notes()).installed).toMatchObject({ origin: "package", source: "pristine" });

    // Untouched: the next release replaces the copy; what the owner's tools left beside it stays.
    await Bun.write(join(src, "node_modules", "dep", "index.js"), "x");
    await release("1.1.0");
    expect((await f.catalog.upgrade("notes")).source).toEqual({ dir: src, action: "updated" });
    expect(await Bun.file(join(src, "src", "index.html")).text()).toBe("<p>notes 1.1.0</p>");
    expect(await Bun.file(join(src, "node_modules", "dep", "index.js")).exists()).toBe(true);
    expect(await sourceCondition(src)).toEqual({ state: "pristine", version: "1.1.0" });

    // The owner changes a file, adds one, and builds: their version runs (the version line the build raised is not a change of theirs).
    await Bun.write(join(src, "src", "index.html"), "<p>mine</p>");
    await Bun.write(join(src, "src", "extra.txt"), "new");
    const built = await buildSource({ ws: f.ws, installer: f.installer, lifecycle: f.lifecycle, store: f.store, activate: async (app) => { await f.runtime.register(await f.installer.load(app)); } }, "notes");
    expect(built).toMatchObject({ version: "1.1.1", action: "upgraded" });
    expect(await Bun.file(join(f.ws.apps, "notes", "web", "index.html")).text()).toBe("<p>mine</p>");
    expect(await sourceCondition(src)).toEqual({ state: "modified", version: "1.1.0", changed: ["src/extra.txt", "src/index.html"] });
    expect((await notes()).installed).toMatchObject({ version: "1.1.1", origin: "local", source: "modified" });

    // A newer release: refused until the owner decides, and nothing changed meanwhile.
    await release("1.2.0");
    const refused = await f.catalog.upgrade("notes").catch((e: CatalogError) => e);
    expect(refused).toMatchObject({ code: "source-modified", status: 409, detail: { dir: src, changed: ["src/extra.txt", "src/index.html"] } });
    expect(await Bun.file(join(f.ws.apps, "notes", "web", "index.html")).text()).toBe("<p>mine</p>");
    expect(await f.catalog.install("notes", { from: "source" }).catch((e: CatalogError) => e.code)).toBe("source-modified");

    // Taking the release moves their copy aside, whole, and puts the release's in its place.
    const taken = await f.catalog.upgrade("notes", { replaceSource: true });
    expect(taken).toMatchObject({ version: "1.2.0", action: "upgraded", source: { action: "replaced" } });
    expect(taken.source!.saved).toMatch(/app-src\/notes\.saved-\d{8}-\d{6}$/);
    expect(await Bun.file(join(taken.source!.saved!, "src", "index.html")).text()).toBe("<p>mine</p>");
    expect(await Bun.file(join(taken.source!.saved!, "src", "extra.txt")).text()).toBe("new");
    expect(await Bun.file(join(src, "src", "index.html")).text()).toBe("<p>notes 1.2.0</p>");
    expect(await Bun.file(join(f.ws.apps, "notes", "web", "index.html")).text()).toBe("<p>notes 1.2.0</p>");
    expect(await sourceCondition(src)).toEqual({ state: "pristine", version: "1.2.0" });
  });

  test("a directory in app-src the Space did not make is the owner's and is left alone", async () => {
    const f = await fixture();
    const src = join(f.ws.home, "app-src", "notes");
    await Bun.write(join(src, "README.md"), "my own checkout");
    const r = await f.catalog.install("notes");
    expect(r.source).toEqual({ dir: src, action: "kept" });
    expect((await readdir(src)).sort()).toEqual(["README.md"]);
    expect((await f.catalog.view()).apps.find((a) => a.name === "notes")!.installed).toMatchObject({ source: "own" });
  });

  test("installs from source at the release tag, then upgrades the checkout", async () => {
    const f = await fixture();
    await f.catalog.install("notes");
    // From source over the package: cloned at v1.0.0, built here, the version raised past the installed one.
    const r = await f.catalog.install("notes", { from: "source" });
    expect(r).toMatchObject({ app: "notes", version: "1.0.1", action: "upgraded", from: "source", ref: "v1.0.0" });
    const dir = join(f.ws.home, "app-src", "notes");
    expect(git(dir, "describe", "--tags")).toBe("v1.0.0");
    expect(await Bun.file(join(f.ws.apps, "notes", "web", "index.html")).text()).toBe("<p>notes 1.0.0</p>");
    expect((await f.catalog.view()).apps.find((a) => a.name === "notes")!.installed).toMatchObject({ origin: "source", ref: "v1.0.0", dev: false });

    // Upstream moves on: the upgrade puts back our version line, follows the new tag, builds again.
    const repo = join(f.root, "repos", "notes");
    await Bun.write(join(repo, "space.release.yaml"), releaseYaml("notes", "1.2.0"));
    await Bun.write(join(repo, "src", "index.html"), "<p>notes 1.2.0</p>");
    git(repo, "commit", "-qam", "1.2.0");
    git(repo, "tag", "v1.2.0");
    f.apps[0]!.latest = await f.publish("notes", f.ours);
    await f.writeCatalog();
    const up = await f.catalog.upgrade("notes");
    expect(up).toMatchObject({ version: "1.2.0", action: "upgraded", from: "source", ref: "v1.2.0" });
    expect(await Bun.file(join(f.ws.apps, "notes", "web", "index.html")).text()).toBe("<p>notes 1.2.0</p>");

    // The owner's own change is never overwritten.
    await Bun.write(join(dir, "src", "index.html"), "<p>mine</p>");
    expect(await f.catalog.upgrade("notes").catch((e: CatalogError) => e.code)).toBe("dirty");
  });

  test("a source install may follow a branch: a development version", async () => {
    const f = await fixture();
    const r = await f.catalog.install("draft", { from: "source", ref: "main" });
    expect(r).toMatchObject({ version: "0.1.0", action: "installed", from: "source", ref: "main" });
    expect((await f.catalog.view()).apps.find((a) => a.name === "draft")!.installed).toMatchObject({ origin: "source", ref: "main", dev: true });
    expect(await f.catalog.install("draft").catch((e: CatalogError) => e.code)).toBe("unreleased");
  });

  test("an app that runs from a source deployment is not replaced", async () => {
    const f = await fixture();
    await mkdir(join(f.ws.apps, "notes"), { recursive: true });
    expect((await state(f.catalog)).notes).toBe("legacy");
    expect(await f.catalog.install("notes").catch((e: CatalogError) => e.code)).toBe("legacy");
  });

  test("routes need the operator and answer with codes", async () => {
    const f = await fixture();
    const routes = createAppCatalogRoutes(f.catalog, "secret");
    const call = (path: keyof typeof routes, method: string, init: RequestInit = {}, params: Record<string, string> = {}) =>
      (routes[path] as Record<string, (r: Request & { params: Record<string, string> }) => Promise<Response>>)[method]!(Object.assign(new Request(`http://x${path}`, { method, ...init }), { params }));
    expect((await call("/api/app-catalog", "GET")).status).toBe(401);
    const auth = { authorization: "Bearer secret" };
    const list = await (await call("/api/app-catalog", "GET", { headers: auth })).json() as { apps: unknown[] };
    expect(list.apps).toHaveLength(3);
    const refused = await call("/api/app-catalog/:app/install", "POST", { headers: auth, body: "{}" }, { app: "other" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ ok: false, code: "trust-required", publisher: { id: "theirs" } });
    const missing = await call("/api/app-catalog/:app/install", "POST", { headers: auth, body: "{}" }, { app: "nope" });
    expect(missing.status).toBe(404);
  });
});

describe("catalog sources and format", () => {
  test("SPACE_APP_CATALOG", () => {
    expect(catalogSources(undefined, "/ws")).toEqual([DEFAULT_CATALOG_URL]);
    expect(catalogSources("none", "/ws")).toEqual([]);
    expect(catalogSources("", "/ws")).toEqual([]);
    expect(catalogSources("default, https://example.com/c.json, mirror/catalog.json", "/ws")).toEqual([DEFAULT_CATALOG_URL, "https://example.com/c.json", "file:///ws/mirror/catalog.json"]);
    expect(catalogSources("http://127.0.0.1:9000/c.json", "/ws")).toEqual(["http://127.0.0.1:9000/c.json"]);
    expect(() => catalogSources("http://example.com/c.json", "/ws")).toThrow();
    expect(() => catalogSources("ftp://example.com/c.json", "/ws")).toThrow();
  });

  test("a catalog is checked strictly where it matters and read leniently where it grows", () => {
    const k = keypair();
    const base = () => ({ catalog: 1, publishers: [{ id: "p", name: "P", keyId: k.keyId, publicKey: k.public }], apps: [{ name: "a", publisher: "p", title: "A", description: "a", repo: "https://example.com/a", license: "MIT", future: { anything: true } }] });
    expect(parseCatalog(base()).apps[0]).toMatchObject({ name: "a", title: { en: "A" }, recommended: false, needs: [], online: [] });
    const bad: ((c: ReturnType<typeof base>) => void)[] = [
      (c) => { (c as Record<string, unknown>).catalog = 2; },
      (c) => { c.publishers[0]!.keyId = "0".repeat(64); },
      (c) => { c.apps[0]!.publisher = "nobody"; },
      (c) => { c.apps.push({ ...c.apps[0]! }); },
      (c) => { c.apps[0]!.name = "Bad Name"; },
      (c) => { c.apps[0]!.repo = "http://example.com/a"; },
      (c) => { (c.apps[0] as Record<string, unknown>).latest = { version: "1.0", tag: "v1", package: { url: "a.spaceapp", sha256: "0".repeat(64) }, requires: { spaceApi: 1 } }; },
      (c) => { (c.apps[0] as Record<string, unknown>).latest = { version: "1.0.0", tag: "v1", package: { url: "a.spaceapp", sha256: "XYZ" }, requires: { spaceApi: 1 } }; },
      (c) => { (c.apps[0] as Record<string, unknown>).needs = ["Model!"]; },
    ];
    for (const change of bad) {
      const c = base();
      change(c);
      expect(() => parseCatalog(c)).toThrow();
    }
  });

  test("a fetched catalog is cached for hours and kept when the network fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-app-catalog-cache-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const ws = workspacePaths(join(root, "ws"));
    for (const d of [ws.home, ws.run]) await mkdir(d, { recursive: true });
    const db = new Database(":memory:");
    cleanup.push(() => db.close());
    const k = keypair();
    const body = { catalog: 1, publishers: [{ id: "p", name: "P", keyId: k.keyId, publicKey: k.public }], apps: [{ name: "a", publisher: "p", title: "A", description: "a", repo: "https://example.com/a", license: "MIT" }] };
    let calls = 0, online = true, now = 1_000_000;
    const fetch = async () => {
      calls++;
      if (!online) throw new Error("offline");
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    };
    const store = new PackageStore(db);
    const make = () => new AppCatalog({ db, sources: ["https://example.com/catalog.json"], studio: { ws, store, installer: new PackageInstaller(ws, store), lifecycle: undefined as never, activate: async () => {} }, trustedKeys: [], fetch, now: () => now, git: null });
    const c = make();
    expect((await c.view()).apps).toHaveLength(1);
    expect((await c.view()).apps).toHaveLength(1);
    expect(calls).toBe(1);
    // A new process reads the cache from the run directory.
    expect((await make().view()).apps).toHaveLength(1);
    expect(calls).toBe(1);
    now += 7 * 3600_000;
    online = false;
    const stale = await c.view();
    expect(calls).toBe(2);
    expect(stale.apps).toHaveLength(1);
    expect(stale.sources[0]).toMatchObject({ ok: false, stale: true, error: "offline" });
    expect(stale.git).toBe(false);
  });
});

test("versions compare by number", () => {
  expect(newerVersion("1.10.0", "1.9.9")).toBe(true);
  expect(newerVersion("1.0.0", "1.0.0")).toBe(false);
  expect(newerVersion("0.9.0", "1.0.0")).toBe(false);
});
