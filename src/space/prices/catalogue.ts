import { mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import anthropic from "./tables/anthropic.json" with { type: "json" };
import deepseek from "./tables/deepseek.json" with { type: "json" };
import minimax from "./tables/minimax.json" with { type: "json" };
import modelWatch from "./tables/model-watch.json" with { type: "json" };
import openai from "./tables/openai.json" with { type: "json" };
import type { WatchFile } from "./model-watch.ts";
import type { Price } from "./price.ts";

/**
 * ai-space's price catalogue (docs/prices.md#the-catalogue): one versioned JSON document built from
 * the checked-in data files next to this one (tables/<vendor>.json, tables/model-watch.json), published
 * at one public URL on every merge to main, and fetched by every Space once a day. The copy built
 * from the release's own data files is the fallback until a fetch succeeds, and wins when it is the
 * newer one (a release newer than the last publish).
 *
 * A fetched catalogue can only supply prices: it is validated whole (shape, sizes, every figure a
 * sane number) before use, a bad one is refused and the last good copy kept, and nothing in it is
 * read but the fields below.
 */

export const CATALOGUE_SCHEMA = 1;
/** Where the published catalogue lives; `SPACE_PRICES_URL` overrides it, and an empty value turns the fetch off. */
export const CATALOGUE_URL = "https://bucket.ai-space.me/prices/v1.json";
export const CATALOGUE_URL_ENV = "SPACE_PRICES_URL";
export const CATALOGUE_CACHE = join("run", "prices-catalogue.json");
/** A fetched document larger than this is refused unread. */
export const CATALOGUE_MAX_BYTES = 4_000_000;

/** One vendor's list prices: the hosts of its own API (whose gateway providers they price), and model id → price. */
export type VendorPrices = { name: string; asOf: string; source: string; hosts: string[]; note?: string; models: Record<string, Price> };
export type Catalogue = {
  schema: 1;
  /** The newest date of its data: a vendor's `asOf` or Model Watch's `syncedAt`. The newer of the fetched and the bundled copy is used. */
  asOf: string;
  vendors: Record<string, VendorPrices>;
  modelWatch?: WatchFile;
};

/** The catalogue of this release's own data files. */
export function bundledCatalogue(): Catalogue {
  const vendors = { openai, anthropic, deepseek, minimax } as unknown as Record<string, VendorPrices>;
  const mw = modelWatch as unknown as WatchFile;
  const asOf = [...Object.values(vendors).map((v) => v.asOf), mw.syncedAt].sort().at(-1)!;
  return { schema: CATALOGUE_SCHEMA, asOf, vendors, modelWatch: mw };
}

const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
/** A figure: USD per million tokens, per picture, per minute, per million characters. Above this it is a misreading. */
const MAX_FIGURE = 100_000;
const figure = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= MAX_FIGURE;
const PRICE_KEYS = new Set(["input", "output", "cacheRead", "cacheWrite", "tiers", "perImage", "perMinute", "perMillionChars", "fastMultiplier"]);
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
const VENDOR_ID = /^[a-z][a-z0-9-]{0,31}$/;
const HOST = /^[a-z0-9.-]{1,253}$/;
const DATE = /^\d{4}-\d{2}-\d{2}([T ][0-9:.]+Z?)?$/;
const short = (x: unknown, n = 2000) => typeof x === "string" && x.length <= n;

function checkPrice(p: unknown, where: string): Price {
  if (!isObject(p)) throw new Error(`${where}: not a price`);
  for (const k of Object.keys(p)) if (!PRICE_KEYS.has(k)) throw new Error(`${where}: unknown key ${k}`);
  for (const k of ["input", "output", "cacheRead", "perImage", "perMinute", "perMillionChars"] as const) if (p[k] !== undefined && !figure(p[k])) throw new Error(`${where}: ${k} is not a price`);
  if (p.cacheWrite !== undefined && p.cacheWrite !== null && !figure(p.cacheWrite)) throw new Error(`${where}: cacheWrite is not a price`);
  if ((p.input === undefined) !== (p.output === undefined)) throw new Error(`${where}: input and output go together`);
  if (p.input === undefined && p.perImage === undefined && p.perMinute === undefined && p.perMillionChars === undefined) throw new Error(`${where}: no price in it`);
  if (p.fastMultiplier !== undefined && !(typeof p.fastMultiplier === "number" && p.fastMultiplier >= 1 && p.fastMultiplier <= 10)) throw new Error(`${where}: fastMultiplier out of range`);
  if (p.tiers !== undefined) {
    if (!Array.isArray(p.tiers) || p.tiers.length > 8 || p.input === undefined) throw new Error(`${where}: tiers`);
    for (const t of p.tiers) {
      if (!isObject(t) || !(typeof t.over === "number" && t.over > 0 && t.over < 1e9) || !figure(t.input) || !figure(t.output) ||
          (t.cacheRead !== undefined && !figure(t.cacheRead)) || (t.cacheWrite !== undefined && !figure(t.cacheWrite))) throw new Error(`${where}: a tier is not a price`);
      for (const k of Object.keys(t)) if (!["over", "input", "output", "cacheRead", "cacheWrite"].includes(k)) throw new Error(`${where}: tier key ${k}`);
    }
  }
  return p as Price;
}

function checkModelWatch(raw: unknown): WatchFile {
  if (!isObject(raw) || !short(raw.syncedAt, 40) || !short(raw.from, 200) || !Array.isArray(raw.sources) || !Array.isArray(raw.prices) ||
      raw.sources.length > 100 || raw.prices.length > 20_000) throw new Error("modelWatch: not Model Watch's prices");
  for (const s of raw.sources) {
    if (!isObject(s) || !short(s.id, 64) || !short(s.name, 200) || !(s.site === null || short(s.site, 253)) || !(s.pricingUrl === null || short(s.pricingUrl, 500)) ||
        !Array.isArray(s.currencies) || !s.currencies.every((c) => short(c, 8)) || !(s.checkedAt === null || short(s.checkedAt, 40)) || !(s.error === null || short(s.error, 500))) throw new Error("modelWatch: a source");
  }
  for (const r of raw.prices) {
    if (!isObject(r) || !short(r.source, 64) || !short(r.id, 200) || !short(r.name, 200) || !short(r.variant ?? "", 300) || !(r.currency === null || short(r.currency, 8)) || !(r.unit === null || short(r.unit, 40)) ||
        ![r.input, r.cachedInput, r.output].every((x) => x === null || (typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1e6))) throw new Error("modelWatch: a row");
  }
  return raw as unknown as WatchFile;
}

/**
 * A catalogue read from anywhere but this release, checked whole: the schema, every vendor, every
 * price a sane figure, and not absurd as a whole (empty, or every token price zero). Throws why not.
 * Only the known fields are kept.
 */
export function parseCatalogue(raw: unknown): Catalogue {
  if (!isObject(raw) || raw.schema !== CATALOGUE_SCHEMA) throw new Error(`not a schema ${CATALOGUE_SCHEMA} price catalogue`);
  if (typeof raw.asOf !== "string" || !DATE.test(raw.asOf)) throw new Error("asOf is not a date");
  if (!isObject(raw.vendors) || Object.keys(raw.vendors).length > 50) throw new Error("vendors");
  const vendors: Record<string, VendorPrices> = {};
  let tokenPrices = 0;
  let nonZero = 0;
  for (const [id, v] of Object.entries(raw.vendors)) {
    if (!VENDOR_ID.test(id) || !isObject(v)) throw new Error(`vendor ${id}`);
    if (!short(v.name, 100) || typeof v.asOf !== "string" || !DATE.test(v.asOf) || !short(v.source, 500) || !(v.note === undefined || short(v.note)) ||
        !Array.isArray(v.hosts) || v.hosts.length > 20 || !v.hosts.every((h) => typeof h === "string" && HOST.test(h)) || !isObject(v.models) || Object.keys(v.models).length > 2000) throw new Error(`vendor ${id}: its fields`);
    const models: Record<string, Price> = {};
    for (const [m, p] of Object.entries(v.models)) {
      if (!MODEL_ID.test(m)) throw new Error(`${id}: model id ${m.slice(0, 40)}`);
      const price = checkPrice(p, `${id}/${m}`);
      if (price.input !== undefined) {
        tokenPrices++;
        if (price.input > 0 || price.output! > 0) nonZero++;
      }
      models[m] = price;
    }
    vendors[id] = { name: v.name as string, asOf: v.asOf, source: v.source as string, hosts: v.hosts as string[], ...(v.note ? { note: v.note as string } : {}), models };
  }
  if (!Object.values(vendors).some((v) => Object.keys(v.models).length)) throw new Error("no prices in it");
  if (tokenPrices && !nonZero) throw new Error("every token price is zero");
  return { schema: CATALOGUE_SCHEMA, asOf: raw.asOf, vendors, ...(raw.modelWatch !== undefined ? { modelWatch: checkModelWatch(raw.modelWatch) } : {}) };
}

/** The cache of the last good fetch, with what a conditional request needs. */
type Cached = { fetchedAt: string; etag?: string; lastModified?: string; catalogue: Catalogue };

export type CatalogueFeedOptions = {
  home?: string;
  /** The published URL; "" turns the fetch off. Default: `SPACE_PRICES_URL`, else CATALOGUE_URL. */
  url?: string;
  bundled?: Catalogue;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
};

/**
 * The bundled catalogue and the last good fetched one, kept in `run/prices-catalogue.json`. The
 * request carries nothing about this install: no token, no machine, a generic user agent, and
 * `If-None-Match` / `If-Modified-Since` from the last answer, so an unchanged catalogue costs a 304.
 */
export class CatalogueFeed {
  readonly url: string;
  private readonly cache: string | undefined;
  private readonly bundled: Catalogue;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private fetched: Cached | undefined;
  private lastError: string | undefined;
  private inflight: Promise<boolean> | undefined;

  constructor(o: CatalogueFeedOptions = {}) {
    this.url = (o.url ?? process.env[CATALOGUE_URL_ENV] ?? CATALOGUE_URL).trim();
    this.cache = o.home ? join(o.home, CATALOGUE_CACHE) : undefined;
    this.bundled = o.bundled ?? bundledCatalogue();
    this.doFetch = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((l) => console.log(`[prices] ${l}`));
  }

  /** The catalogue in force: the fetched one, unless the release's own is newer. */
  current(): Catalogue {
    const f = this.fetched?.catalogue;
    return f && f.asOf >= this.bundled.asOf ? f : this.bundled;
  }

  /** "fetched" or "bundled", for the status line. */
  origin(): "fetched" | "bundled" {
    return this.current() === this.bundled ? "bundled" : "fetched";
  }

  /** When the last good copy was fetched (ISO), if ever. */
  fetchedAt(): string | undefined {
    return this.fetched?.fetchedAt;
  }

  status(): { url: string; asOf: string; origin: "fetched" | "bundled"; fetchedAt?: string; error?: string } {
    return { url: this.url, asOf: this.current().asOf, origin: this.origin(), ...(this.fetched ? { fetchedAt: this.fetched.fetchedAt } : {}), ...(this.lastError ? { error: this.lastError } : {}) };
  }

  /** Read the last good copy from the workspace; a broken cache is ignored. */
  async load(): Promise<void> {
    if (!this.cache) return;
    try {
      const c = (await Bun.file(this.cache).json()) as Cached;
      this.fetched = { ...c, catalogue: parseCatalogue(c.catalogue) };
    } catch { /* none yet, or unreadable: the next fetch replaces it */ }
  }

  /** Age of the last good fetch in ms; Infinity when there is none. */
  age(): number {
    return this.fetched ? this.now() - Date.parse(this.fetched.fetchedAt) : Infinity;
  }

  /** Fetch once (one at a time); resolves true when the prices in force changed. Never throws. */
  refresh(): Promise<boolean> {
    if (!this.url) return Promise.resolve(false);
    this.inflight ??= this.fetchOnce().finally(() => { this.inflight = undefined; });
    return this.inflight;
  }

  private async fetchOnce(): Promise<boolean> {
    const before = JSON.stringify(this.current());
    try {
      const headers: Record<string, string> = { accept: "application/json", "user-agent": "ai-space" };
      if (this.fetched?.etag) headers["if-none-match"] = this.fetched.etag;
      if (this.fetched?.lastModified) headers["if-modified-since"] = this.fetched.lastModified;
      const res = await this.doFetch(this.url, { headers, signal: AbortSignal.timeout(30_000), redirect: "follow" });
      if (res.status === 304 && this.fetched) {
        this.fetched = { ...this.fetched, fetchedAt: new Date(this.now()).toISOString() };
        await this.save();
        this.lastError = undefined;
        return false;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > CATALOGUE_MAX_BYTES) throw new Error(`${declared} bytes, more than ${CATALOGUE_MAX_BYTES}`);
      const text = await res.text();
      if (text.length > CATALOGUE_MAX_BYTES) throw new Error(`${text.length} bytes, more than ${CATALOGUE_MAX_BYTES}`);
      const catalogue = parseCatalogue(JSON.parse(text));
      this.fetched = {
        fetchedAt: new Date(this.now()).toISOString(), catalogue,
        ...(res.headers.get("etag") ? { etag: res.headers.get("etag")! } : {}),
        ...(res.headers.get("last-modified") ? { lastModified: res.headers.get("last-modified")! } : {}),
      };
      await this.save();
      this.lastError = undefined;
      const changed = JSON.stringify(this.current()) !== before;
      if (changed) this.log(`price catalogue of ${catalogue.asOf} from ${this.url}${this.origin() === "bundled" ? " (this release's own is newer and stays in force)" : ""}`);
      return changed;
    } catch (e) {
      this.lastError = (e as Error).message;
      this.log(`price catalogue not fetched from ${this.url} (${this.lastError}); keeping ${this.origin() === "fetched" ? `the copy of ${this.current().asOf}` : "this release's own"}`);
      return false;
    }
  }

  private async save(): Promise<void> {
    if (!this.cache || !this.fetched) return;
    await mkdir(dirname(this.cache), { recursive: true });
    await Bun.write(`${this.cache}.tmp`, JSON.stringify(this.fetched));
    await rename(`${this.cache}.tmp`, this.cache);
  }
}

/** Every figure of a catalogue as `key → number`, for comparing two of them (guard.ts). */
export function flatten(c: Catalogue): Map<string, number> {
  const out = new Map<string, number>();
  for (const [v, vp] of Object.entries(c.vendors)) {
    for (const [m, p] of Object.entries(vp.models)) {
      for (const [k, x] of Object.entries(p)) {
        if (typeof x === "number") out.set(`${v}/${m} ${k}`, x);
        if (k === "tiers") (x as NonNullable<Price["tiers"]>).forEach((t) => { for (const [tk, tx] of Object.entries(t)) if (tk !== "over") out.set(`${v}/${m} tier>${t.over} ${tk}`, tx as number); });
      }
    }
  }
  for (const r of c.modelWatch?.prices ?? []) {
    const key = `model-watch ${r.source}/${r.id}${r.variant ? ` [${r.variant}]` : ""} (${r.unit ?? "?"}, ${r.currency ?? "?"})`;
    for (const k of ["input", "cachedInput", "output"] as const) if (r[k] !== null) out.set(`${key} ${k}`, r[k]!);
  }
  return out;
}
