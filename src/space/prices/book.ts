import { mkdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { GATEWAY_SITES } from "../gateway/config.ts";
import type { GatewayProvider } from "../gateway/types.ts";
import { type Catalogue, CatalogueFeed, type VendorPrices } from "./catalogue.ts";
import { ModelWatchPrices, type ModelWatchStatus } from "./model-watch.ts";
import { MODELS_DEV_CACHE, MODELS_DEV_PROVIDERS, MODELS_DEV_URL, parsePricesYaml, PRICES_FILE, type Price, type PriceCatalog, type PriceLookup, trimModelsDev } from "./price.ts";

/**
 * Every price ai-space uses, from one place (docs/prices.md). Two questions, one set of sources:
 *
 *  - `forVendor("anthropic", "claude-opus-5")`: a vendor's list price, for a runtime call (Codex
 *    CLI, anthropic-api, deepseek-harness, speech straight to a vendor's own API):
 *      1. the owner's `<workspace>/gateway-prices.yaml`, key `<vendor>/<model>`;
 *      2. ai-space's price catalogue (catalogue.ts): fetched daily, or this release's own copy;
 *      3. models.dev's catalogue for that vendor.
 *  - `lookupSync(provider, model)`: what a call through the built-in gateway's `provider` costs:
 *      1. the owner's file, `<provider>/<model>`, then `<provider>/*` (a relay's discount, a plan);
 *      2. the catalogue: Model Watch's row for this provider's site (CNY at the owner's rate), then
 *         a vendor's list price when the provider is that vendor's own host;
 *      3. models.dev, for the models.dev provider that matches the provider's site.
 *
 * No price: unpriced, never free. The owner's file always wins and is re-read within a minute of an
 * edit; the catalogue and models.dev are fetched once a day, a failure keeping the last good copy.
 * Nothing here blocks a call. The owner's file is not a key of gateway.yaml (whose parser refuses
 * unknown keys), so an older ai-space keeps its gateway after a rollback.
 */

const DAY_MS = 24 * 3600_000;
const SNAPSHOT = /-\d{4}-\d{2}-\d{2}$/;

const host = (url: string | undefined) => {
  try {
    return url ? new URL(url).host : undefined;
  } catch {
    return undefined;
  }
};

export type PriceBookOptions = {
  /** The workspace; without one only the catalogue prices (tests, a CLI without a workspace). */
  home?: string;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
  /** Read for the CNY rate and the catalogue's URL (`SPACE_PRICES_URL`). */
  env?: Record<string, string | undefined>;
  /** Tests: Model Watch's prices instead of the catalogue's. */
  modelWatch?: ModelWatchPrices;
  /** Tests: the catalogue feed. */
  feed?: CatalogueFeed;
  /** No network: read the caches only (space codex-upgrade). */
  offline?: boolean;
};

type Provider = Pick<GatewayProvider, "name" | "preset" | "messages" | "openai">;

export class PriceBook {
  private readonly file: string | undefined;
  private readonly cache: string | undefined;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly env: Record<string, string | undefined>;
  private readonly fixedWatch: ModelWatchPrices | undefined;
  private readonly offline: boolean;
  readonly feed: CatalogueFeed;
  private watched: ModelWatchPrices;
  private watchedFor: Catalogue | undefined;
  private own: Record<string, Price> = {};
  private ownMtime = -1;
  private ownError: string | undefined;
  private catalog: PriceCatalog | undefined;
  private refreshing: Promise<void> | undefined;
  private readonly listeners: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Bumped on every change of a price: what derives from prices (the ledger's SQL) rebuilds on it. */
  version = 0;

  constructor(o: PriceBookOptions = {}) {
    this.file = o.home ? join(o.home, PRICES_FILE) : undefined;
    this.cache = o.home ? join(o.home, MODELS_DEV_CACHE) : undefined;
    this.doFetch = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((l) => console.log(`[prices] ${l}`));
    this.env = o.env ?? process.env;
    this.offline = o.offline ?? false;
    this.fixedWatch = o.modelWatch;
    this.feed = o.feed ?? new CatalogueFeed({ ...(o.home ? { home: o.home } : {}), url: this.env.SPACE_PRICES_URL ?? undefined, fetch: this.doFetch, now: this.now, log: this.log });
    this.watched = this.fixedWatch ?? new ModelWatchPrices({ env: this.env, data: this.feed.current().modelWatch });
    this.watchedFor = this.feed.current();
  }

  /** Model Watch's prices of the catalogue in force. */
  get modelWatch(): ModelWatchPrices {
    const c = this.feed.current();
    if (!this.fixedWatch && c !== this.watchedFor) {
      this.watched = new ModelWatchPrices({ env: this.env, data: c.modelWatch });
      this.watchedFor = c;
    }
    return this.watched;
  }

  /** Read the owner's file and the caches; then refresh what is a day old or missing, in the background. */
  async load(): Promise<void> {
    await this.readOwn();
    if (this.cache) {
      try {
        this.catalog = (await Bun.file(this.cache).json()) as PriceCatalog;
      } catch { /* no cache yet */ }
    }
    await this.feed.load();
    this.version++;
    if (this.offline) return;
    const age = this.catalog ? this.now() - Date.parse(this.catalog.fetchedAt) : Infinity;
    if (!(age < DAY_MS)) void this.refresh();
    if (!(this.feed.age() < DAY_MS)) void this.refreshCatalogue();
  }

  /** Fetch models.dev now; one at a time. */
  refresh(): Promise<void> {
    if (!this.cache) return Promise.resolve();
    const cache = this.cache;
    this.refreshing ??= (async () => {
      try {
        const res = await this.doFetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(60_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const catalog = trimModelsDev(await res.json(), new Date(this.now()));
        await mkdir(dirname(cache), { recursive: true });
        await Bun.write(`${cache}.tmp`, JSON.stringify(catalog));
        await rename(`${cache}.tmp`, cache);
        const changed = JSON.stringify(catalog.providers) !== JSON.stringify(this.catalog?.providers);
        this.catalog = catalog;
        this.log(`models.dev prices: ${Object.keys(catalog.providers).length} providers`);
        if (changed) this.changed();
      } catch (e) {
        this.log(`models.dev prices not refreshed (${(e as Error).message}); ${this.catalog ? `keeping those of ${this.catalog.fetchedAt}` : "calls priced nowhere else stay unpriced"}`);
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }

  /** Fetch ai-space's price catalogue now; earlier calls are costed again when it changed. */
  async refreshCatalogue(): Promise<void> {
    if (await this.feed.refresh()) this.changed();
  }

  /** Called after a price changed: the owner's file was edited, or a catalogue came back different. */
  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  /**
   * Keep the prices current without waiting for a call: the owner's file looked at every `fileMs`,
   * models.dev and the catalogue refreshed once a day. The timer does not keep the process alive.
   */
  watch(fileMs = 60_000): void {
    if (this.timer) return;
    let last = this.now();
    this.timer = setInterval(() => {
      void this.readOwn();
      if (this.offline) return;
      if (this.now() - last >= DAY_MS || (this.catalog && this.now() - Date.parse(this.catalog.fetchedAt) >= DAY_MS)) {
        last = this.now();
        void this.refresh();
      }
      if (this.feed.url && this.feed.age() >= DAY_MS) void this.refreshCatalogue();
    }, fileMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private changed(): void {
    this.version++;
    for (const l of this.listeners) {
      try {
        l();
      } catch (e) {
        this.log(`after a price change: ${(e as Error).message}`);
      }
    }
  }

  /** Use this models.dev catalogue, as if fetched (tests, and a peer handing its copy). */
  useCatalog(c: PriceCatalog | undefined): void {
    this.catalog = c;
    this.changed();
  }

  /** models.dev's catalogue as last read or fetched. */
  catalogue(): PriceCatalog | undefined {
    return this.catalog;
  }

  /** ai-space's price catalogue in force. */
  prices(): Catalogue {
    return this.feed.current();
  }

  /** When each source was read, and why the owner's file did not load. */
  status(): { catalogFetchedAt?: string; fileError?: string; modelWatch?: ModelWatchStatus; catalogue: ReturnType<CatalogueFeed["status"]> } {
    return {
      ...(this.catalog ? { catalogFetchedAt: this.catalog.fetchedAt } : {}), ...(this.ownError ? { fileError: this.ownError } : {}),
      modelWatch: this.modelWatch.status(), catalogue: this.feed.status(),
    };
  }

  /** The models.dev provider this gateway provider is priced from: by preset and site, else the one whose API host is its base's. */
  catalogProvider(p: Pick<GatewayProvider, "preset" | "messages" | "openai">): string | undefined {
    const mapped = p.preset ? MODELS_DEV_PROVIDERS[p.preset] : undefined;
    if (typeof mapped === "string") return mapped;
    if (mapped) {
      const sites = GATEWAY_SITES[p.preset!];
      const cn = sites?.cn.messages && host(sites.cn.messages) === host(p.messages);
      return cn ? mapped.cn : mapped.intl;
    }
    const hosts = new Set([host(p.messages), host(p.openai)].filter(Boolean));
    if (!hosts.size || !this.catalog) return undefined;
    const matches = Object.entries(this.catalog.providers).filter(([, v]) => hosts.has(host(v.api)));
    return matches.length === 1 ? matches[0]![0] : undefined;
  }

  /** The vendor whose own API is at this host (its list prices apply there), if any. */
  vendorAt(h: string | undefined): string | undefined {
    if (!h) return undefined;
    const bare = h.replace(/:\d+$/, "");
    return Object.entries(this.prices().vendors).find(([, v]) => v.hosts.includes(bare))?.[0];
  }

  /** The effective price of `model` at this provider, and where it came from. */
  async lookup(p: Provider, model: string): Promise<PriceLookup | undefined> {
    await this.reload();
    return this.lookupSync(p, model);
  }

  /** The price gateway calls are costed at; a CNY price waiting for its rate is none. */
  lookupSync(p: Provider, model: string): PriceLookup | undefined {
    const found = this.describe(p, model);
    return found?.needsRate ? undefined : found;
  }

  /** The price as Settings shows it: a CNY price waiting for its rate included. */
  describe(p: Provider, model: string): PriceLookup | undefined {
    const own = this.own[`${p.name}/${model}`];
    if (own) return { price: own, source: "price file" };
    const all = this.own[`${p.name}/*`];
    if (all) return { price: all, source: "price file (provider/*)" };
    const watched = this.modelWatch.lookup(p, model);
    if (watched && !watched.needsRate) return watched;
    // A CNY price waiting for its rate does not hide a USD one: the list price or models.dev's is used until the rate is set.
    const vendor = this.vendorAt(host(p.messages)) ?? this.vendorAt(host(p.openai));
    const listed = vendor ? this.listed(vendor, model) : undefined;
    if (listed) return listed;
    const id = this.catalogProvider(p);
    const exact = id ? this.fromModelsDev(id, model) : undefined;
    return exact ? { price: exact, source: `models.dev ${id}` } : watched;
  }

  /** A vendor's list price for a runtime call: the owner's `<vendor>/<model>`, the catalogue, models.dev. */
  forVendor(vendor: string, model: string): PriceLookup | undefined {
    const own = this.own[`${vendor}/${model}`] ?? (SNAPSHOT.test(model) ? this.own[`${vendor}/${model.replace(SNAPSHOT, "")}`] : undefined);
    if (own) return { price: own, source: "price file" };
    const listed = this.listed(vendor, model);
    if (listed) return listed;
    const dev = this.fromModelsDev(vendor, model) ?? (SNAPSHOT.test(model) ? this.fromModelsDev(vendor, model.replace(SNAPSHOT, "")) : undefined);
    return dev ? { price: dev, source: `models.dev ${vendor}` } : undefined;
  }

  /** Every model a vendor has a price for in any source: its catalogue entries, models.dev's, the owner's. */
  vendorModels(vendor: string): string[] {
    const ids = new Set([
      ...Object.keys(this.prices().vendors[vendor]?.models ?? {}),
      ...Object.keys(this.catalog?.providers[vendor]?.models ?? {}),
      ...Object.keys(this.own).filter((k) => k.startsWith(`${vendor}/`) && !k.endsWith("/*")).map((k) => k.slice(vendor.length + 1)),
    ]);
    return [...ids];
  }

  /** A vendor's catalogue entry, for its Fast multiplier (only ever from there). */
  vendorEntry(vendor: string, model: string): { vendor: VendorPrices; price?: Price } | undefined {
    const v = this.prices().vendors[vendor];
    return v ? { vendor: v, ...(v.models[model] ? { price: v.models[model] } : {}) } : undefined;
  }

  private listed(vendor: string, model: string): PriceLookup | undefined {
    const v = this.prices().vendors[vendor];
    const price = v?.models[model] ?? (SNAPSHOT.test(model) ? v?.models[model.replace(SNAPSHOT, "")] : undefined);
    return price ? { price, source: `ai-space ${vendor} ${v!.asOf}` } : undefined;
  }

  private fromModelsDev(id: string, model: string): Price | undefined {
    const models = this.catalog?.providers[id]?.models;
    return models ? models[model] ?? Object.entries(models).find(([k]) => k.toLowerCase() === model.toLowerCase())?.[1] : undefined;
  }

  /** The models the owner's file names for this provider (not `provider/*`): pictures and speech are often not in its model list. */
  fileModels(provider: string): string[] {
    const prefix = `${provider}/`;
    return Object.keys(this.own).filter((k) => k.startsWith(prefix) && k !== `${prefix}*`).map((k) => k.slice(prefix.length));
  }

  /** The owner's file again when it changed (one stat when it did not); a bad file keeps the last good one and says why. */
  reload(): Promise<void> {
    return this.readOwn();
  }

  private async readOwn(): Promise<void> {
    if (!this.file) return;
    let mtime: number;
    try {
      mtime = (await stat(this.file)).mtimeMs;
    } catch {
      const had = Object.keys(this.own).length > 0;
      this.own = {};
      this.ownMtime = -1;
      this.ownError = undefined;
      if (had) this.changed();
      return;
    }
    if (mtime === this.ownMtime) return;
    this.ownMtime = mtime;
    try {
      const next = parsePricesYaml(await Bun.file(this.file).text());
      const changed = JSON.stringify(next) !== JSON.stringify(this.own);
      this.own = next;
      this.ownError = undefined;
      if (changed) this.changed();
    } catch (e) {
      this.ownError = (e as Error).message;
      this.log(`${this.ownError}; keeping the prices read before`);
    }
  }
}

/**
 * The book every consumer asks (anthropic-api, deepseek-harness, speech, the ledger's GPT estimate).
 * The entry point sets the workspace's at boot; until then, and in tests, the catalogue alone.
 */
let active = new PriceBook({ offline: true, env: {} });

export function activePrices(): PriceBook {
  return active;
}

export function setActivePrices(book: PriceBook): void {
  active = book;
}
