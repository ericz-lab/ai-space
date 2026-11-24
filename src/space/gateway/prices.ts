import { mkdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Usage } from "../runtimes/types.ts";
import { GATEWAY_SITES } from "./config.ts";
import type { GatewayProvider } from "./types.ts";

/**
 * What a call through the built-in model gateway costs (docs/model-gateway.md#prices). A price is
 * one provider's tariff for one model, in USD per million tokens. It is looked for in this order:
 *
 *  1. `<workspace>/gateway-prices.yaml`: the owner's price for `provider/model`;
 *  2. the same file's `provider/*`: every model of that provider (a relay's discount, a plan);
 *  3. models.dev's catalogue, for the models.dev provider that matches this provider's site.
 *
 * No price: the call is unpriced, never counted as free. A price file of its own, not a key of
 * gateway.yaml, whose parser refuses unknown keys: an older ai-space keeps its gateway on a rollback.
 */

export const PRICES_FILE = "gateway-prices.yaml";
export const MODELS_DEV_URL = "https://models.dev/api.json";
/** The trimmed catalogue: only what pricing reads, a few hundred KB instead of models.dev's 7 MB. */
export const MODELS_DEV_CACHE = join("run", "models-dev-prices.json");
const REFRESH_MS = 24 * 3600_000;

export type Price = {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Long-context prices: the whole call is at a tier's prices once its prompt is over `over` tokens. */
  tiers?: { over: number; input: number; output: number; cacheRead?: number; cacheWrite?: number }[];
};
export type PriceSource = "price file" | "price file (provider/*)" | `models.dev ${string}`;
export type PriceLookup = { price: Price; source: PriceSource };

/** models.dev, trimmed: provider id → its API base (when it lists one) and model id → price. */
export type PriceCatalog = { fetchedAt: string; providers: Record<string, { api?: string; models: Record<string, Price> }> };

/**
 * The models.dev provider for each preset, per site where the vendor has two (GATEWAY_SITES).
 * Checked against models.dev's api.json on 2026-11-24: its `minimax-cn`, `moonshotai-cn` and
 * `alibaba-cn` are the China sites' tariffs, in USD.
 */
export const MODELS_DEV_PROVIDERS: Record<string, string | { intl: string; cn: string }> = {
  anthropic: "anthropic",
  openai: "openai",
  groq: "groq",
  deepseek: "deepseek",
  zai: "zai",
  zhipu: "zhipuai",
  kimi: { intl: "moonshotai", cn: "moonshotai-cn" },
  minimax: { intl: "minimax", cn: "minimax-cn" },
  dashscope: { intl: "alibaba", cn: "alibaba-cn" },
};

type RawCost = { input?: unknown; output?: unknown; cache_read?: unknown; cache_write?: unknown; tiers?: unknown };

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

/** One models.dev `cost` as a Price, or undefined when it has no input and output price. */
export function priceFromModelsDev(cost: unknown): Price | undefined {
  if (!cost || typeof cost !== "object") return undefined;
  const c = cost as RawCost;
  const input = num(c.input);
  const output = num(c.output);
  if (input === undefined || output === undefined) return undefined;
  const p: Price = { input, output };
  if (num(c.cache_read) !== undefined) p.cacheRead = num(c.cache_read);
  if (num(c.cache_write) !== undefined) p.cacheWrite = num(c.cache_write);
  if (Array.isArray(c.tiers)) {
    const tiers = c.tiers.flatMap((t: RawCost & { tier?: { type?: unknown; size?: unknown } }) => {
      const over = num(t?.tier?.size);
      const ti = num(t?.input);
      const to = num(t?.output);
      if (t?.tier?.type !== "context" || over === undefined || ti === undefined || to === undefined) return [];
      return [{ over, input: ti, output: to, ...(num(t.cache_read) !== undefined ? { cacheRead: num(t.cache_read) } : {}), ...(num(t.cache_write) !== undefined ? { cacheWrite: num(t.cache_write) } : {}) }];
    });
    if (tiers.length) p.tiers = tiers.sort((a, b) => a.over - b.over);
  }
  return p;
}

/** models.dev's api.json, trimmed to the prices. */
export function trimModelsDev(raw: unknown, now = new Date()): PriceCatalog {
  const providers: PriceCatalog["providers"] = {};
  if (raw && typeof raw === "object") {
    for (const [id, v] of Object.entries(raw as Record<string, { api?: unknown; models?: Record<string, { cost?: unknown }> }>)) {
      const models: Record<string, Price> = {};
      for (const [mid, m] of Object.entries(v?.models ?? {})) {
        const p = priceFromModelsDev(m?.cost);
        if (p) models[mid] = p;
      }
      if (Object.keys(models).length) providers[id] = { ...(typeof v.api === "string" ? { api: v.api } : {}), models };
    }
  }
  return { fetchedAt: now.toISOString(), providers };
}

/** `[input, output, cacheRead?, cacheWrite?]`, USD per million tokens: magpie's order. */
function priceFromList(v: unknown, ctx: string): Price {
  if (!Array.isArray(v) || v.length < 2 || v.length > 4 || v.some((x) => num(x) === undefined)) {
    throw new Error(`${PRICES_FILE}: ${ctx} must be [input, output] or [input, output, cache read, cache write], USD per million tokens, each 0 or more`);
  }
  const [input, output, cacheRead, cacheWrite] = v as number[];
  return { input: input!, output: output!, ...(cacheRead !== undefined ? { cacheRead } : {}), ...(cacheWrite !== undefined ? { cacheWrite } : {}) };
}

/** `provider/model: [..]` or `provider/*: [..]` per line. */
export function parsePricesYaml(text: string): Record<string, Price> {
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(text);
  } catch (e) {
    throw new Error(`${PRICES_FILE}: invalid YAML: ${(e as Error).message}`);
  }
  if (doc === null || doc === undefined) return {};
  if (typeof doc !== "object" || Array.isArray(doc)) throw new Error(`${PRICES_FILE}: must be a mapping of provider/model to prices`);
  const out: Record<string, Price> = {};
  for (const [key, v] of Object.entries(doc as Record<string, unknown>)) {
    if (!/^[a-z][a-z0-9-]{0,31}\/\S+$/.test(key)) throw new Error(`${PRICES_FILE}: "${key}" must be provider/model or provider/*`);
    out[key] = priceFromList(v, key);
  }
  return out;
}

/** The cost of one answer's tokens at `price`; a missing cache price is the input price. */
export function costOf(price: Price, u: Usage): number {
  const prompt = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  const tier = [...(price.tiers ?? [])].reverse().find((t) => prompt > t.over);
  const p = tier ?? price;
  const read = p.cacheRead ?? price.cacheRead ?? p.input;
  const write = p.cacheWrite ?? price.cacheWrite ?? p.input;
  return (u.inputTokens * p.input + u.outputTokens * p.output + u.cacheReadTokens * read + u.cacheWriteTokens * write) / 1e6;
}

const host = (url: string | undefined) => {
  try {
    return url ? new URL(url).host : undefined;
  } catch {
    return undefined;
  }
};

export type PriceBookOptions = { home: string; fetch?: typeof fetch; now?: () => number; log?: (line: string) => void };

/**
 * The price file and the models.dev catalogue. The file is re-read when it changes; the catalogue
 * is read from its cache and refreshed in the background once a day (`refresh`), and a failed
 * refresh keeps the cache. Nothing here blocks a request.
 */
export class PriceBook {
  private readonly file: string;
  private readonly cache: string;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private own: Record<string, Price> = {};
  private ownMtime = -1;
  private ownError: string | undefined;
  private catalog: PriceCatalog | undefined;
  private refreshing: Promise<void> | undefined;

  constructor(o: PriceBookOptions) {
    this.file = join(o.home, PRICES_FILE);
    this.cache = join(o.home, MODELS_DEV_CACHE);
    this.doFetch = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((l) => console.log(`[gateway-prices] ${l}`));
  }

  /** Read both files; then refresh the catalogue in the background when it is a day old or missing. */
  async load(): Promise<void> {
    await this.readOwn();
    try {
      this.catalog = (await Bun.file(this.cache).json()) as PriceCatalog;
    } catch { /* no cache yet */ }
    const age = this.catalog ? this.now() - Date.parse(this.catalog.fetchedAt) : Infinity;
    if (!(age < REFRESH_MS)) void this.refresh();
  }

  /** Fetch models.dev now; one at a time. */
  refresh(): Promise<void> {
    this.refreshing ??= (async () => {
      try {
        const res = await this.doFetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(60_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const catalog = trimModelsDev(await res.json(), new Date(this.now()));
        await mkdir(dirname(this.cache), { recursive: true });
        await Bun.write(`${this.cache}.tmp`, JSON.stringify(catalog));
        await rename(`${this.cache}.tmp`, this.cache);
        this.catalog = catalog;
        this.log(`models.dev prices: ${Object.keys(catalog.providers).length} providers`);
      } catch (e) {
        this.log(`models.dev prices not refreshed (${(e as Error).message}); ${this.catalog ? `keeping those of ${this.catalog.fetchedAt}` : "calls not in the price file stay unpriced"}`);
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }

  /** When the catalogue was fetched, and why the price file did not load. */
  status(): { catalogFetchedAt?: string; fileError?: string } {
    return { ...(this.catalog ? { catalogFetchedAt: this.catalog.fetchedAt } : {}), ...(this.ownError ? { fileError: this.ownError } : {}) };
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

  /** The effective price of `model` at this provider, and where it came from. */
  async lookup(p: Pick<GatewayProvider, "name" | "preset" | "messages" | "openai">, model: string): Promise<PriceLookup | undefined> {
    await this.reload();
    return this.lookupSync(p, model);
  }

  lookupSync(p: Pick<GatewayProvider, "name" | "preset" | "messages" | "openai">, model: string): PriceLookup | undefined {
    const own = this.own[`${p.name}/${model}`];
    if (own) return { price: own, source: "price file" };
    const all = this.own[`${p.name}/*`];
    if (all) return { price: all, source: "price file (provider/*)" };
    const id = this.catalogProvider(p);
    const models = id ? this.catalog?.providers[id]?.models : undefined;
    if (!models) return undefined;
    const exact = models[model] ?? Object.entries(models).find(([k]) => k.toLowerCase() === model.toLowerCase())?.[1];
    return exact ? { price: exact, source: `models.dev ${id}` } : undefined;
  }

  /** The price file again when it changed (one stat when it did not); a bad file keeps the last good one and says why. */
  reload(): Promise<void> {
    return this.readOwn();
  }

  private async readOwn(): Promise<void> {
    let mtime: number;
    try {
      mtime = (await stat(this.file)).mtimeMs;
    } catch {
      this.own = {};
      this.ownMtime = -1;
      this.ownError = undefined;
      return;
    }
    if (mtime === this.ownMtime) return;
    this.ownMtime = mtime;
    try {
      this.own = parsePricesYaml(await Bun.file(this.file).text());
      this.ownError = undefined;
    } catch (e) {
      this.ownError = (e as Error).message;
      this.log(`${this.ownError}; keeping the prices read before`);
    }
  }
}
