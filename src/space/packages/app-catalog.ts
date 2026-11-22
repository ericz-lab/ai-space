import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isOperator } from "../auth.ts";
import { whichUsable } from "../host-tools.ts";
import { buildSource, sourceDir, StudioError, type StudioDeps } from "../studio.ts";
import { DEFAULT_ARCHIVE_LIMIT } from "./archive.ts";
import { allowedLocation } from "./catalog-sources.ts";
import { integer, releaseVersion } from "./contract.ts";
import { inspectPackage, readPackageFile, sha256 } from "./pack.ts";
import { keyIdOf } from "./publishers.ts";
import { buildEnv } from "./release.ts";
import { placeSource, sourceCondition, type SourceOutcome } from "./source-copy.ts";

/**
 * The app catalog (docs/app-catalog.md): apps someone published for any Space, listed in a
 * `catalog.json` that the Space reads from `SPACE_APP_CATALOG` (default: the ai-space-apps
 * repository). Each app installs one of two ways, and either upgrades the other:
 *
 * - **package** (the default): the release's `.spaceapp` is downloaded, checked against the
 *   catalog's SHA-256 and the publisher's signature, and handed to the package installer, or to the
 *   lifecycle's upgrade. Nothing is cloned, no dependency is fetched, no script runs.
 * - **source**: the app's repository is cloned into `app-src/<app>` at the release tag (or a branch
 *   such as `main`), built on this machine by its `build:` section and installed through App Studio's
 *   build. Change it there and `space app build <app>` makes your own version.
 *
 * Trust: a package signed by a publisher this Space trusts (packages/publishers.json, or
 * `SPACE_PACKAGE_TRUST_KEYS`) installs without a question. Any other publisher the catalog names
 * needs the owner's confirmation once (`trust: true`); the Space then remembers its key. A package
 * that is unsigned, or signed by a key its catalog does not name, never installs from a catalog.
 */

export const CATALOG_FORMAT = 1;
const CACHE_TTL_MS = 6 * 3600_000;
const MAX_CATALOG_BYTES = 1024 * 1024;
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TOKEN_RE = /^[a-z][a-z0-9-]{0,31}$/;

export type Localized = { en: string; zh?: string };
export type CatalogPackage = { url: string; sha256: string };
export type CatalogRelease = { version: string; tag: string; package: CatalogPackage; sourcePackage?: CatalogPackage; requires: { spaceApi: number; bun?: string } };
export type CatalogPublisher = { id: string; name: string; keyId: string; publicKey: string; url?: string };
export type CatalogApp = {
  name: string;
  publisher: string;
  title: Localized;
  description: Localized;
  icon?: string;
  repo: string;
  license: string;
  recommended: boolean;
  /** What the app needs from the Space beyond itself: `model`, `s3`, `claude-code`, ... */
  needs: string[];
  /** What only works online. */
  online: Localized[];
  latest?: CatalogRelease;
};
export type Catalog = { catalog: 1; publishers: CatalogPublisher[]; apps: CatalogApp[] };

export class CatalogError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "invalid",
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------------------------
// Parsing. Unknown keys are ignored so that an older Space reads a newer catalog of format 1;
// every key it knows is checked strictly.

function obj(raw: unknown, where: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where} must be an object`);
  return raw as Record<string, unknown>;
}
function str(raw: unknown, where: string, max = 300): string {
  if (typeof raw !== "string" || !raw.trim() || raw.length > max || /[\x00-\x08\x0b-\x1f\x7f]/.test(raw)) throw new Error(`${where} must be a non-empty string of at most ${max} characters`);
  return raw;
}
function list(raw: unknown, where: string, max: number): unknown[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > max) throw new Error(`${where} must be a list of at most ${max}`);
  return raw;
}
function localized(raw: unknown, where: string, max = 300): Localized {
  if (typeof raw === "string") return { en: str(raw, where, max) };
  const o = obj(raw, where);
  return { en: str(o.en, `${where}.en`, max), ...(o.zh === undefined ? {} : { zh: str(o.zh, `${where}.zh`, max) }) };
}
function location(raw: unknown, where: string): string {
  const value = str(raw, where, 2048);
  // Relative references resolve against the catalog's own location (a mirror keeps packages beside it).
  const url = new URL(value, "https://catalog.invalid/");
  if (url.username || url.password || !["https:", "http:", "file:"].includes(url.protocol)) throw new Error(`${where} must be an https URL or a relative path`);
  return value;
}
function pkg(raw: unknown, where: string): CatalogPackage {
  const o = obj(raw, where);
  const digest = str(o.sha256, `${where}.sha256`, 64);
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`${where}.sha256 must be a lowercase SHA-256 digest`);
  return { url: location(o.url, `${where}.url`), sha256: digest };
}

export function parseCatalog(raw: unknown): Catalog {
  const doc = obj(raw, "catalog");
  if (doc.catalog !== CATALOG_FORMAT) throw new Error(`unsupported catalog format ${String(doc.catalog)}; this Space reads format ${CATALOG_FORMAT}`);
  const publishers = list(doc.publishers, "publishers", 200).map((raw, i): CatalogPublisher => {
    const at = `publishers[${i}]`, p = obj(raw, at);
    const id = str(p.id, `${at}.id`, 64);
    if (!NAME_RE.test(id)) throw new Error(`${at}.id is not a valid id`);
    const publicKey = str(p.publicKey, `${at}.publicKey`, 1024);
    const keyId = str(p.keyId, `${at}.keyId`, 64);
    let actual: string;
    try { actual = keyIdOf(publicKey); } catch { throw new Error(`${at}.publicKey is not an Ed25519 public key`); }
    if (actual !== keyId) throw new Error(`${at}.keyId does not match its public key`);
    return { id, name: str(p.name, `${at}.name`, 100), keyId, publicKey, ...(p.url === undefined ? {} : { url: location(p.url, `${at}.url`) }) };
  });
  const ids = new Set(publishers.map((p) => p.id));
  if (ids.size !== publishers.length) throw new Error("publisher ids must be unique");
  const names = new Set<string>();
  const apps = list(doc.apps, "apps", 1000).map((raw, i): CatalogApp => {
    const at = `apps[${i}]`, a = obj(raw, at);
    const name = str(a.name, `${at}.name`, 64);
    if (!NAME_RE.test(name) || name === "space") throw new Error(`${at}.name is not a valid app name`);
    if (names.has(name)) throw new Error(`${at}: ${name} is listed twice`);
    names.add(name);
    const publisher = str(a.publisher, `${at}.publisher`, 64);
    if (!ids.has(publisher)) throw new Error(`${at}.publisher names no publisher of this catalog`);
    const repo = str(a.repo, `${at}.repo`, 500);
    // file: repositories serve local mirrors and tests; they are used only from a local catalog.
    if (!/^(https|file):\/\/[^\s@]+$/.test(repo)) throw new Error(`${at}.repo must be an https URL`);
    const needs = list(a.needs, `${at}.needs`, 20).map((n, j) => {
      if (typeof n !== "string" || !TOKEN_RE.test(n)) throw new Error(`${at}.needs[${j}] must be a lowercase word`);
      return n;
    });
    let latest: CatalogRelease | undefined;
    if (a.latest !== undefined && a.latest !== null) {
      const l = obj(a.latest, `${at}.latest`);
      const r = obj(l.requires, `${at}.latest.requires`);
      const tag = str(l.tag, `${at}.latest.tag`, 100);
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(tag)) throw new Error(`${at}.latest.tag is not a valid tag`);
      latest = {
        version: releaseVersion(l.version, `${at}.latest.version`), tag,
        package: pkg(l.package, `${at}.latest.package`),
        ...(l.sourcePackage === undefined ? {} : { sourcePackage: pkg(l.sourcePackage, `${at}.latest.sourcePackage`) }),
        requires: { spaceApi: integer(r.spaceApi, `${at}.latest.requires.spaceApi`, 1, Number.MAX_SAFE_INTEGER), ...(r.bun === undefined ? {} : { bun: releaseVersion(r.bun, `${at}.latest.requires.bun`) }) },
      };
    }
    if (a.recommended !== undefined && typeof a.recommended !== "boolean") throw new Error(`${at}.recommended must be true or false`);
    return {
      name, publisher,
      title: localized(a.title, `${at}.title`, 100),
      description: localized(a.description, `${at}.description`, 1000),
      ...(a.icon === undefined ? {} : { icon: location(a.icon, `${at}.icon`) }),
      repo, license: str(a.license, `${at}.license`, 64), recommended: a.recommended === true, needs,
      online: list(a.online, `${at}.online`, 20).map((o, j) => localized(o, `${at}.online[${j}]`)),
      ...(latest ? { latest } : {}),
    };
  });
  return { catalog: 1, publishers, apps };
}

/** True when `a` is a later major.minor.patch than `b`. */
export function newerVersion(a: string, b: string): boolean {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

// ---------------------------------------------------------------------------------------------

export type SourceState = { url: string; ok: boolean; fetchedAt?: string; stale?: boolean; error?: string; apps: number };
type Loaded = { url: string; catalog?: Catalog; fetchedAt?: number; error?: string; stale?: boolean };
type Origin = { app: string; origin: "package" | "source"; catalog: string; ref: string | null; variant: string | null; version: string };

export type AppState = "available" | "installed" | "update" | "unreleased" | "legacy";
export type CatalogEntryView = {
  name: string;
  title: Localized;
  description: Localized;
  icon?: string;
  repo: string;
  license: string;
  recommended: boolean;
  needs: string[];
  online: Localized[];
  catalog: string;
  publisher: { id: string; name: string; keyId: string; url?: string; trusted: boolean };
  latest: { version: string; tag: string; sourcePackage: boolean; requires: CatalogRelease["requires"] } | null;
  /** `source`: the copy in app-src the Space made, untouched or changed by the owner; `own` for a directory that is not such a copy (a checkout, an app made here); absent without one. */
  installed: { version: string; origin: "package" | "source" | "local"; ref: string | null; dev: boolean; source?: "pristine" | "modified" | "own" } | null;
  state: AppState;
};
export type CatalogView = { sources: SourceState[]; apps: CatalogEntryView[]; trusted: { keyId: string; name: string }[]; git: boolean };

/**
 * `withSource`: a package install takes the release's source package when it has one, and puts an
 * editable copy in `app-src/<app>`; `false` takes the bundle alone. `replaceSource`: on an upgrade,
 * a copy the owner changed is moved aside and the new release's takes its place.
 */
export type InstallRequest = { from?: "package" | "source"; withSource?: boolean; replaceSource?: boolean; ref?: string; trust?: boolean };
/** Where an install or upgrade in flight is: the page shows it while the request waits (it answers when everything is done). */
export type ProgressStage = "download" | "verify" | "install" | "source" | "clone" | "pull" | "build";
export type Progress = { app: string; kind: "install" | "upgrade"; stage: ProgressStage; received?: number; total?: number; since: string };
/** What the panel's tile shows without reading a catalog: the apps here with a newer release in the last copy read. */
export type UpdatesView = { count: number; apps: { name: string; installed: string; latest: string }[]; fetchedAt?: string };

export type InstallResult = { app: string; version: string; action: "installed" | "upgraded"; from: "package" | "source"; dir?: string; ref?: string | null; source?: SourceOutcome };

export type AppCatalogDeps = {
  db: Database;
  sources: string[];
  studio: StudioDeps;
  /** Public keys (PEM) this Space trusts for every package: built-in publishers and SPACE_PACKAGE_TRUST_KEYS. */
  trustedKeys: string[];
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  /** `git`, or null when the host has none; default: found on PATH. */
  git?: string | null;
};

export class AppCatalog {
  private readonly memory = new Map<string, Loaded>();
  private readonly fetchFn: (url: string, init?: RequestInit) => Promise<Response>;
  private readonly now: () => number;
  private busy: Promise<unknown> = Promise.resolve();
  private readonly inFlight = new Map<string, Progress>();
  private readonly refreshing = new Map<string, Promise<unknown>>();

  constructor(private readonly d: AppCatalogDeps) {
    this.fetchFn = d.fetch ?? ((url, init) => fetch(url, init));
    this.now = d.now ?? Date.now;
    d.db.exec(`CREATE TABLE IF NOT EXISTS app_catalog_origins (
      app TEXT PRIMARY KEY, origin TEXT NOT NULL CHECK(origin IN ('package','source')), catalog TEXT NOT NULL,
      ref TEXT, variant TEXT, version TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS app_catalog_trust (key_id TEXT PRIMARY KEY, name TEXT NOT NULL, public_key TEXT NOT NULL, created_at INTEGER NOT NULL);`);
  }

  private get ws() { return this.d.studio.ws; }
  private get cacheDir() { return join(this.ws.run, "app-catalog"); }
  private git(): string | null { return this.d.git === undefined ? whichUsable("git") ?? null : this.d.git; }

  /** One mutation at a time: two would race on the same source checkout and package lifecycle. */
  private serial<T>(f: () => Promise<T>): Promise<T> {
    const next = this.busy.then(f, f);
    this.busy = next.catch(() => {});
    return next;
  }

  private origin(app: string): Origin | undefined {
    return this.d.db.query<Origin, [string]>("SELECT app, origin, catalog, ref, variant, version FROM app_catalog_origins WHERE app=?").get(app) ?? undefined;
  }
  private setOrigin(o: Origin): void {
    this.d.db.query("INSERT INTO app_catalog_origins (app, origin, catalog, ref, variant, version, updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(app) DO UPDATE SET origin=excluded.origin, catalog=excluded.catalog, ref=excluded.ref, variant=excluded.variant, version=excluded.version, updated_at=excluded.updated_at")
      .run(o.app, o.origin, o.catalog, o.ref, o.variant, o.version, this.now());
  }

  /** Publishers the owner confirmed from a catalog, beside the Space's own trusted keys. */
  confirmed(): { keyId: string; name: string; publicKey: string }[] {
    return this.d.db.query<{ keyId: string; name: string; publicKey: string }, []>("SELECT key_id AS keyId, name, public_key AS publicKey FROM app_catalog_trust ORDER BY created_at").all();
  }
  forget(keyId: string): boolean {
    return this.d.db.query("DELETE FROM app_catalog_trust WHERE key_id=?").run(keyId).changes > 0;
  }
  private trustedKeyIds(): Set<string> {
    const ids = new Set(this.confirmed().map((c) => c.keyId));
    for (const pem of this.d.trustedKeys) {
      try { ids.add(keyIdOf(pem)); } catch {}
    }
    return ids;
  }

  // -- reading -------------------------------------------------------------------------------

  private cacheFile(url: string): string {
    return join(this.cacheDir, `${createHash("sha256").update(url).digest("hex").slice(0, 32)}.json`);
  }

  private async fetchText(url: URL, limit: number, timeoutMs: number, onBytes?: (received: number, total?: number) => void): Promise<Uint8Array> {
    if (url.protocol === "file:") {
      const file = Bun.file(fileURLToPath(url));
      if (file.size > limit) throw new Error("too large");
      return new Uint8Array(await file.arrayBuffer());
    }
    const res = await this.fetchFn(url.href, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json, application/octet-stream" } });
    if (res.url && !allowedLocation(new URL(res.url), false)) throw new Error("redirected to a location that is not https");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (Number(res.headers.get("content-length") ?? 0) > limit) throw new Error("too large");
    const reader = res.body?.getReader();
    if (!reader) return new Uint8Array();
    const declared = Number(res.headers.get("content-length") ?? 0) || undefined;
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) { await reader.cancel(); throw new Error("too large"); }
      chunks.push(value);
      onBytes?.(total, declared);
    }
    return Buffer.concat(chunks, total);
  }

  private async loadOne(url: string, refresh: boolean): Promise<Loaded> {
    let cached = this.memory.get(url);
    if (!cached) {
      const file = Bun.file(this.cacheFile(url));
      if (await file.exists()) {
        try {
          const saved = (await file.json()) as { url: string; fetchedAt: number; body: unknown };
          if (saved.url === url) cached = { url, catalog: parseCatalog(saved.body), fetchedAt: saved.fetchedAt };
        } catch {}
      }
    }
    // A local file is read every time: it is the operator's own and costs nothing.
    const local = url.startsWith("file:");
    if (cached?.catalog && !refresh && !local && this.now() - (cached.fetchedAt ?? 0) < CACHE_TTL_MS) return cached;
    try {
      const body = JSON.parse(new TextDecoder().decode(await this.fetchText(new URL(url), MAX_CATALOG_BYTES, 15_000)));
      const loaded: Loaded = { url, catalog: parseCatalog(body), fetchedAt: this.now() };
      this.memory.set(url, loaded);
      if (!local) {
        await mkdir(this.cacheDir, { recursive: true });
        await Bun.write(this.cacheFile(url), JSON.stringify({ url, fetchedAt: loaded.fetchedAt, body }));
      }
      return loaded;
    } catch (e) {
      const error = (e as Error).message;
      // The last good copy stays usable offline; say it is old.
      const kept: Loaded = cached?.catalog ? { ...cached, stale: true, error } : { url, error };
      this.memory.set(url, kept);
      return kept;
    }
  }

  private async loadAll(refresh = false): Promise<Loaded[]> {
    return Promise.all(this.d.sources.map((url) => this.loadOne(url, refresh)));
  }

  /** An app's entry: the first catalog listing it wins. */
  private async find(name: string): Promise<{ entry: CatalogApp; publisher: CatalogPublisher; catalog: string }> {
    for (const loaded of await this.loadAll()) {
      const entry = loaded.catalog?.apps.find((a) => a.name === name);
      if (entry) return { entry, publisher: loaded.catalog!.publishers.find((p) => p.id === entry.publisher)!, catalog: loaded.url };
    }
    throw new CatalogError(`${name} is not in the app catalog`, 404, "not-found");
  }

  /** A spec-1 deployment of the same name: the package installer will not take its directory. */
  private async legacy(app: string): Promise<boolean> {
    if (this.d.studio.store.installed(app)) return false;
    return lstat(join(this.ws.apps, app)).then(() => true, () => false);
  }

  async view(refresh = false): Promise<CatalogView> {
    const loaded = await this.loadAll(refresh);
    const trusted = this.trustedKeyIds();
    const seen = new Set<string>();
    const apps: CatalogEntryView[] = [];
    for (const l of loaded) {
      for (const a of l.catalog?.apps ?? []) {
        if (seen.has(a.name)) continue;
        seen.add(a.name);
        const p = l.catalog!.publishers.find((x) => x.id === a.publisher)!;
        const op = this.d.studio.store.installed(a.name);
        const origin = op ? this.origin(a.name) : undefined;
        const condition = op ? await sourceCondition(sourceDir(this.ws, a.name)).catch(() => undefined) : undefined;
        const installed = op ? {
          version: op.version,
          origin: origin && origin.version === op.version ? origin.origin : "local" as const,
          ref: origin?.ref ?? null,
          // A source install that follows a branch rather than the release tag is a development version.
          dev: origin?.origin === "source" && origin.version === op.version && !!origin.ref && origin.ref !== a.latest?.tag,
          ...(condition && condition.state !== "absent" ? { source: condition.state === "unmanaged" ? "own" as const : condition.state } : {}),
        } : null;
        const state: AppState = installed ? (a.latest && newerVersion(a.latest.version, installed.version) ? "update" : "installed")
          : await this.legacy(a.name) ? "legacy" : a.latest ? "available" : "unreleased";
        apps.push({
          name: a.name, title: a.title, description: a.description, ...(a.icon ? { icon: new URL(a.icon, l.url).href } : {}),
          repo: a.repo, license: a.license, recommended: a.recommended, needs: a.needs, online: a.online, catalog: l.url,
          publisher: { id: p.id, name: p.name, keyId: p.keyId, ...(p.url ? { url: p.url } : {}), trusted: trusted.has(p.keyId) },
          latest: a.latest ? { version: a.latest.version, tag: a.latest.tag, sourcePackage: !!a.latest.sourcePackage, requires: a.latest.requires } : null,
          installed, state,
        });
      }
    }
    const sources = loaded.map((l): SourceState => ({
      url: l.url, ok: !!l.catalog && !l.stale, apps: l.catalog?.apps.length ?? 0,
      ...(l.fetchedAt ? { fetchedAt: new Date(l.fetchedAt).toISOString() } : {}),
      ...(l.stale ? { stale: true } : {}), ...(l.error ? { error: l.error } : {}),
    }));
    return { sources, apps, trusted: this.confirmed().map(({ keyId, name }) => ({ keyId, name })), git: !!this.git() };
  }

  /**
   * The apps installed here that the last copy of each catalog has a newer release of. Never waits
   * for the network: a copy older than the cache's 6 hours (or none yet) is read again in the
   * background, and the next call counts from it. Cheap enough for a tile's badge.
   */
  async updates(): Promise<UpdatesView> {
    const seen = new Set<string>();
    const apps: UpdatesView["apps"] = [];
    let oldest: number | undefined;
    for (const url of this.d.sources) {
      const l = await this.cached(url);
      if (!l?.catalog || url.startsWith("file:") || this.now() - (l.fetchedAt ?? 0) >= CACHE_TTL_MS) this.refreshLater(url);
      if (l?.fetchedAt !== undefined) oldest = oldest === undefined ? l.fetchedAt : Math.min(oldest, l.fetchedAt);
      for (const a of l?.catalog?.apps ?? []) {
        if (seen.has(a.name)) continue;
        seen.add(a.name);
        const op = this.d.studio.store.installed(a.name);
        if (op && a.latest && newerVersion(a.latest.version, op.version)) apps.push({ name: a.name, installed: op.version, latest: a.latest.version });
      }
    }
    return { count: apps.length, apps, ...(oldest !== undefined ? { fetchedAt: new Date(oldest).toISOString() } : {}) };
  }

  /** The copy in memory, else the one on disk; never the network. */
  private async cached(url: string): Promise<Loaded | undefined> {
    const mem = this.memory.get(url);
    if (mem) return mem;
    const file = Bun.file(this.cacheFile(url));
    if (!(await file.exists())) return undefined;
    try {
      const saved = (await file.json()) as { url: string; fetchedAt: number; body: unknown };
      if (saved.url !== url) return undefined;
      const loaded: Loaded = { url, catalog: parseCatalog(saved.body), fetchedAt: saved.fetchedAt };
      this.memory.set(url, loaded);
      return loaded;
    } catch {
      return undefined;
    }
  }

  /** One background read of a catalog at a time; its failure is the next view's to report. */
  private refreshLater(url: string): void {
    if (this.refreshing.has(url)) return;
    const run = this.loadOne(url, false).catch(() => {}).finally(() => this.refreshing.delete(url));
    this.refreshing.set(url, run);
  }

  /** Installs and upgrades in flight, for the page to show while their requests wait. */
  progress(): Progress[] {
    return [...this.inFlight.values()];
  }
  private stage(app: string, kind: Progress["kind"], stage: ProgressStage, bytes?: { received: number; total?: number }): void {
    const prev = this.inFlight.get(app);
    this.inFlight.set(app, { app, kind, stage, ...(bytes ? { received: bytes.received, ...(bytes.total ? { total: bytes.total } : {}) } : {}), since: prev?.stage === stage ? prev.since : new Date(this.now()).toISOString() });
  }
  /** Runs one change with its progress tracked from the first step to the answer. */
  private tracked<T>(app: string, work: () => Promise<T>): Promise<T> {
    return work().finally(() => this.inFlight.delete(app));
  }

  // -- installing -----------------------------------------------------------------------------

  install(name: string, req: InstallRequest = {}): Promise<InstallResult> {
    return this.serial(async () => {
      const found = await this.find(name);
      if (await this.legacy(name)) throw new CatalogError(`${name} already runs from a source deployment here; move it to a package first (docs/package-migration.md)`, 409, "legacy");
      return this.tracked(name, () => ((req.from ?? "package") === "source" ? this.fromSource(found, req, false) : this.fromPackage(found, req)));
    });
  }

  /** The newer release (package), or the checkout brought forward and built again (source). */
  upgrade(name: string, req: InstallRequest = {}): Promise<InstallResult> {
    return this.serial(async () => {
      const found = await this.find(name);
      if (!this.d.studio.store.installed(name)) throw new CatalogError(`${name} is not installed`, 409, "not-installed");
      const from = req.from ?? (this.origin(name)?.origin === "source" ? "source" : "package");
      return this.tracked(name, () => (from === "source" ? this.fromSource(found, req, true) : this.fromPackage(found, req)));
    });
  }

  /** The owner's yes to a publisher this Space does not trust yet; asked before anything of theirs runs. */
  private requireTrust(publisher: CatalogPublisher, req: InstallRequest, what: string): void {
    if (this.trustedKeyIds().has(publisher.keyId)) return;
    if (!req.trust) {
      throw new CatalogError(`${what} comes from ${publisher.name}, a publisher this Space does not trust yet; confirm to trust them`, 409, "trust-required", { publisher: { id: publisher.id, name: publisher.name, keyId: publisher.keyId, ...(publisher.url ? { url: publisher.url } : {}) } });
    }
    this.d.db.query("INSERT OR IGNORE INTO app_catalog_trust (key_id, name, public_key, created_at) VALUES (?,?,?,?)").run(publisher.keyId, publisher.name, publisher.publicKey, this.now());
  }

  private async fromPackage({ entry, publisher, catalog }: { entry: CatalogApp; publisher: CatalogPublisher; catalog: string }, req: InstallRequest): Promise<InstallResult> {
    const release = entry.latest;
    if (!release) throw new CatalogError(`${entry.name} has no release yet; install it from source`, 409, "unreleased");
    const installed = this.d.studio.store.installed(entry.name);
    const kind = installed ? "upgrade" : "install";
    if (installed && !newerVersion(release.version, installed.version)) throw new CatalogError(`${entry.name} ${installed.version} is installed; the catalog's release is ${release.version}`, 409, "current");
    this.requireTrust(publisher, req, entry.name);
    const variant = req.withSource !== false && release.sourcePackage ? "source" : "bundle";
    const editable = sourceDir(this.ws, entry.name);
    if (installed && variant === "source" && !req.replaceSource) {
      // Taking the release would run code without the owner's changes: their call, not ours.
      const condition = await sourceCondition(editable);
      if (condition.state === "modified") {
        throw new CatalogError(`you changed the source of ${entry.name} (app-src/${entry.name}: ${condition.changed.slice(0, 5).join(", ")}${condition.changed.length > 5 ? ", …" : ""}); keep running yours, or take the release and have your copy moved aside`, 409, "source-modified", { changed: condition.changed, dir: editable });
      }
    }
    const chosen = variant === "source" ? release.sourcePackage! : release.package;
    const url = new URL(chosen.url, catalog);
    if (!allowedLocation(url, catalog.startsWith("file:"))) throw new CatalogError(`the package location ${url.href} is not allowed`, 409, "location");
    let bytes: Uint8Array;
    this.stage(entry.name, kind, "download", { received: 0 });
    try {
      bytes = url.protocol === "file:" ? await readPackageFile(fileURLToPath(url)) : await this.fetchText(url, DEFAULT_ARCHIVE_LIMIT, 300_000, (received, total) => this.stage(entry.name, kind, "download", { received, total }));
    } catch (e) {
      throw new CatalogError(`could not download ${entry.name} ${release.version}: ${(e as Error).message}`, 502, "download");
    }
    this.stage(entry.name, kind, "verify");
    if (sha256(bytes) !== chosen.sha256) throw new CatalogError(`the downloaded package of ${entry.name} does not match the catalog's checksum`, 502, "checksum");
    const keys = [...this.d.trustedKeys, ...this.confirmed().map((c) => c.publicKey)];
    const inspected = await inspectPackage(bytes, keys).catch((e) => { throw new CatalogError(`the package of ${entry.name} is invalid: ${(e as Error).message}`, 502, "invalid-package"); });
    if (inspected.signature.status !== "verified" || inspected.signature.keyId !== publisher.keyId) {
      throw new CatalogError(`the package of ${entry.name} is not signed by ${publisher.name}`, 502, "signature");
    }
    if (inspected.manifest.app !== entry.name || inspected.manifest.version !== release.version) throw new CatalogError(`the package is ${inspected.manifest.app} ${inspected.manifest.version}, the catalog says ${entry.name} ${release.version}`, 502, "mismatch");
    const s = this.d.studio;
    this.stage(entry.name, kind, "install");
    if (installed) {
      const change = await s.lifecycle.upgrade(bytes, { trustedKeys: keys });
      if (change.state !== "done") throw new CatalogError(`upgrade failed: ${change.error ?? change.state}`, 409, "upgrade-failed");
    } else {
      const op = await s.installer.install(bytes, { trustedKeys: keys });
      if (op.state !== "installed") throw new CatalogError(`install failed: ${op.error ?? op.state}`, 409, "install-failed");
      await s.activate(entry.name);
    }
    this.setOrigin({ app: entry.name, origin: "package", catalog, ref: release.tag, variant, version: release.version });
    s.log?.(`${installed ? "upgraded" : "installed"} ${entry.name} ${release.version} from the catalog`);
    let source: SourceOutcome | undefined;
    if (variant === "source") {
      // The app is installed and running; a copy that cannot be made is reported, not a failed install.
      this.stage(entry.name, kind, "source");
      try { source = await placeSource(await s.installer.load(entry.name), editable, entry.name, release.version, { replace: req.replaceSource === true }); }
      catch (e) { s.log?.(`${entry.name}: could not put its source in ${editable}: ${(e as Error).message}`); }
    }
    return { app: entry.name, version: release.version, action: installed ? "upgraded" : "installed", from: "package", ref: release.tag, ...(source ? { source, dir: source.dir } : {}) };
  }

  private async runGit(args: string[], cwd: string): Promise<string> {
    const git = this.git();
    if (!git) throw new CatalogError("installing from source needs git on this machine", 409, "git-missing");
    const proc = Bun.spawn([git, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...buildEnv(), GIT_TERMINAL_PROMPT: "0" } });
    const timer = setTimeout(() => proc.kill("SIGKILL"), 300_000);
    try {
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      if (code !== 0) throw new CatalogError(`git ${args[0]}: ${err.trim().split("\n").slice(-3).join(" ") || `exit ${code}`}`, 409, "git");
      return out.trimEnd(); // not trim(): `status --porcelain` lines start with a meaningful space
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * `space app build` raises the declaration's version when it is not above the installed one and
   * writes it back. That one line is ours, not the owner's change: put it back before updating the
   * checkout, so the next release's own version applies.
   */
  private async undoVersionBump(dir: string): Promise<void> {
    const changed = (await this.runGit(["status", "--porcelain"], dir)).split("\n").filter(Boolean);
    if (changed.length !== 1) return;
    const file = changed[0]!.slice(3);
    if (!/^ M (space\.release\.yaml|space\.yaml)$/.test(changed[0]!)) return;
    const diff = (await this.runGit(["diff", "-U0", "--", file], dir)).split("\n").filter((l) => /^[-+](?![-+])/.test(l));
    if (diff.length === 2 && diff.every((l) => /^[-+]version:\s*\S+\s*$/.test(l))) await this.runGit(["checkout", "--quiet", "--", file], dir);
  }

  private async fromSource({ entry, publisher, catalog }: { entry: CatalogApp; publisher: CatalogPublisher; catalog: string }, req: InstallRequest, upgrade: boolean): Promise<InstallResult> {
    // A source build runs the publisher's own build scripts here: the same trust as their package.
    this.requireTrust(publisher, req, `building ${entry.name} from source`);
    if (req.ref !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(req.ref)) throw new CatalogError("ref must be a branch or tag name", 400);
    if (!allowedLocation(new URL(entry.repo), catalog.startsWith("file:"))) throw new CatalogError(`the repository ${entry.repo} is not allowed`, 409, "location");
    const dir = sourceDir(this.ws, entry.name);
    const kind = upgrade ? "upgrade" : "install";
    // A copy the Space made from a package is not a checkout: an untouched one gives way to the clone, a changed one is the owner's.
    const copy = await sourceCondition(dir);
    if (copy.state === "modified") throw new CatalogError(`app-src/${entry.name} holds the source you changed, not a checkout of the repository; build it with: space app build ${entry.name}, or move it away to install from the repository`, 409, "source-modified", { changed: copy.changed, dir });
    if (copy.state === "pristine") await rm(dir, { recursive: true, force: true });
    const present = await lstat(dir).then(() => true, () => false);
    let ref: string | null = req.ref ?? entry.latest?.tag ?? null;
    if (!present) {
      // Clone beside the final place and move it in, so a failed clone leaves nothing behind.
      const parent = join(this.ws.home, "app-src");
      await mkdir(parent, { recursive: true });
      const temp = join(parent, `.${entry.name}.clone-${crypto.randomUUID().slice(0, 8)}`);
      this.stage(entry.name, kind, "clone");
      try {
        await this.runGit(["clone", "--quiet", ...(ref ? ["--branch", ref] : []), "--", entry.repo, temp], parent);
        if (!ref) ref = await this.runGit(["rev-parse", "--abbrev-ref", "HEAD"], temp);
        await rename(temp, dir);
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    } else if (upgrade || req.ref) {
      // Bring a clean checkout forward; local changes are the owner's and are never overwritten.
      this.stage(entry.name, kind, "pull");
      await this.undoVersionBump(dir);
      if (await this.runGit(["status", "--porcelain"], dir)) throw new CatalogError(`app-src/${entry.name} has local changes; commit or set them aside, or build them as they are with: space app build ${entry.name}`, 409, "dirty");
      const branch = await this.runGit(["symbolic-ref", "-q", "--short", "HEAD"], dir).catch(() => "");
      if (req.ref && req.ref !== branch) {
        await this.runGit(["fetch", "--quiet", "--tags", "origin"], dir);
        await this.runGit(["checkout", "--quiet", req.ref], dir);
        ref = req.ref;
      } else if (branch) {
        await this.runGit(["pull", "--quiet", "--ff-only"], dir);
        ref = branch;
      } else if (entry.latest) {
        await this.runGit(["fetch", "--quiet", "--tags", "origin"], dir);
        await this.runGit(["checkout", "--quiet", entry.latest.tag], dir);
        ref = entry.latest.tag;
      }
    } else {
      ref = this.origin(entry.name)?.ref ?? null;
    }
    let build;
    this.stage(entry.name, kind, "build");
    try {
      build = await buildSource(this.d.studio, entry.name);
    } catch (e) {
      if (e instanceof StudioError) throw new CatalogError(e.message, e.status, "build");
      throw e;
    }
    this.setOrigin({ app: entry.name, origin: "source", catalog, ref, variant: null, version: build.version });
    return { app: entry.name, version: build.version, action: build.action, from: "source", dir, ref };
  }
}

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });

/**
 *   GET    /api/app-catalog[?refresh=1]                  owner: catalogs, apps with their state, confirmed publishers
 *   POST   /api/app-catalog/:app/install  {from?, withSource?, replaceSource?, ref?, trust?}   owner
 *   POST   /api/app-catalog/:app/upgrade  {from?, ref?, trust?}               owner
 *   GET    /api/app-catalog/updates                       owner: installed apps with a newer release, from the cached catalogs (no network wait)
 *   GET    /api/app-catalog/progress                      owner: installs and upgrades in flight, with their step and downloaded bytes
 *   DELETE /api/app-catalog/publishers/:keyId             owner: stop trusting a confirmed publisher
 */
export function createAppCatalogRoutes(catalog: AppCatalog, token: string) {
  type Req = Request & { params: Record<string, string> };
  const guard = async (req: Request, work: () => Promise<Record<string, unknown>>) => {
    if (!isOperator(req, token)) return json({ ok: false, error: "unauthorized" }, 401);
    try {
      return json({ ok: true, ...(await work()) });
    } catch (e) {
      if (e instanceof CatalogError) return json({ ok: false, error: e.message, code: e.code, ...e.detail }, e.status);
      return json({ ok: false, error: (e as Error).message }, 500);
    }
  };
  const body = async (req: Request): Promise<InstallRequest> => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (b.from !== undefined && b.from !== "package" && b.from !== "source") throw new CatalogError("from is package or source");
    if (b.ref !== undefined && typeof b.ref !== "string") throw new CatalogError("ref must be a string");
    return { ...(b.from ? { from: b.from as "package" | "source" } : {}), ...(typeof b.withSource === "boolean" ? { withSource: b.withSource } : {}), ...(b.replaceSource === true ? { replaceSource: true } : {}), ...(typeof b.ref === "string" ? { ref: b.ref } : {}), trust: b.trust === true };
  };
  return {
    "/api/app-catalog": {
      GET: (req: Request) => guard(req, async () => catalog.view(new URL(req.url).searchParams.get("refresh") === "1") as unknown as Record<string, unknown>),
    },
    "/api/app-catalog/updates": {
      GET: (req: Request) => guard(req, async () => (await catalog.updates()) as unknown as Record<string, unknown>),
    },
    "/api/app-catalog/progress": {
      GET: (req: Request) => guard(req, async () => ({ progress: catalog.progress() })),
    },
    "/api/app-catalog/:app/install": {
      POST: (req: Req) => guard(req, async () => ({ result: await catalog.install(req.params.app!, await body(req)) })),
    },
    "/api/app-catalog/:app/upgrade": {
      POST: (req: Req) => guard(req, async () => ({ result: await catalog.upgrade(req.params.app!, await body(req)) })),
    },
    "/api/app-catalog/publishers/:keyId": {
      DELETE: (req: Req) => guard(req, async () => ({ removed: catalog.forget(req.params.keyId!) })),
    },
  };
}
