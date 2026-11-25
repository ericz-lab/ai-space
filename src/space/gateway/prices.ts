import { mkdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PriceBasis, PricedAnswer, Usage } from "../runtimes/types.ts";
import { GATEWAY_SITES } from "./config.ts";
import type { ModelWatchPrices, ModelWatchStatus } from "./model-watch.ts";
import type { GatewayProvider } from "./types.ts";

/**
 * What a call through the built-in model gateway costs (docs/model-gateway.md#prices). A price is
 * one provider's tariff for one model: USD per million tokens, and for pictures and speech per
 * picture, per minute of audio or per million characters. It is looked for in this order:
 *
 *  1. `<workspace>/gateway-prices.yaml`: the owner's price for `provider/model`;
 *  2. the same file's `provider/*`: every model of that provider (a relay's discount, a plan);
 *  3. Model Watch's copy of the vendor's pricing page, for the page of this provider's site
 *     (model-watch.ts), in USD or converted from CNY at the owner's rate;
 *  4. models.dev's catalogue, for the models.dev provider that matches this provider's site.
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
  /** USD per million tokens. A price of units only (below) has none. */
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Long-context prices: the whole call is at a tier's prices once its prompt is over `over` tokens. */
  tiers?: { over: number; input: number; output: number; cacheRead?: number; cacheWrite?: number }[];
  /** Per picture made, per minute of audio transcribed, per million characters spoken; each takes over from the tokens of a call that has it. */
  perImage?: number;
  perMinute?: number;
  perMillionChars?: number;
};
export type PriceSource = "price file" | "price file (provider/*)" | `Model Watch ${string}` | `models.dev ${string}`;
/**
 * `checkedAt`: when Model Watch last read the page. `currency` and `printed`: the page's currency and
 * figures when they were converted. `needsRate`: a CNY price with no rate set, shown but costing nothing.
 */
export type PriceLookup = { price: Price; source: PriceSource; checkedAt?: string; currency?: string; printed?: Price; needsRate?: true };

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

const PRICE_KEYS = ["input", "output", "cacheRead", "cacheWrite", "perImage", "perMinute", "perMillionChars"] as const;

/**
 * `[input, output, cacheRead?, cacheWrite?]`, USD per million tokens (magpie's order), or a mapping
 * of PRICE_KEYS: `{ perImage: 0.04 }`, `{ perMinute: 0.006 }`, `{ input: 2, output: 8, perImage: 0.02 }`.
 */
function priceFromEntry(v: unknown, ctx: string): Price {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const out: Price = {};
    for (const [k, x] of Object.entries(v)) {
      if (!(PRICE_KEYS as readonly string[]).includes(k)) throw new Error(`${PRICES_FILE}: ${ctx}: unknown key ${k} (${PRICE_KEYS.join(", ")})`);
      if (num(x) === undefined) throw new Error(`${PRICES_FILE}: ${ctx}: ${k} must be a number, 0 or more`);
      out[k as (typeof PRICE_KEYS)[number]] = x as number;
    }
    if ((out.input === undefined) !== (out.output === undefined)) throw new Error(`${PRICES_FILE}: ${ctx}: input and output go together`);
    if (out.input === undefined && out.perImage === undefined && out.perMinute === undefined && out.perMillionChars === undefined) throw new Error(`${PRICES_FILE}: ${ctx}: no price in it`);
    return out;
  }
  if (!Array.isArray(v) || v.length < 2 || v.length > 4 || v.some((x) => num(x) === undefined)) {
    throw new Error(`${PRICES_FILE}: ${ctx} must be [input, output] or [input, output, cache read, cache write], USD per million tokens, each 0 or more, or a mapping of ${PRICE_KEYS.join(", ")}`);
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
    out[key] = priceFromEntry(v, key);
  }
  return out;
}

/** One answer as the ledger keeps it: the model that answered and what it consumed, zeros left out. */
export function pricedAnswer(served: string, u: Usage | undefined, units: { images?: number; audioSeconds?: number; chars?: number } = {}): PricedAnswer {
  const a: PricedAnswer = { m: served };
  const put = (k: Exclude<keyof PricedAnswer, "m">, v: number | undefined) => {
    if (v && v > 0) a[k] = v;
  };
  put("i", u?.inputTokens);
  put("o", u?.outputTokens);
  put("cr", u?.cacheReadTokens);
  put("cw", u?.cacheWriteTokens);
  put("img", units.images);
  put("sec", units.audioSeconds);
  put("ch", units.chars);
  return a;
}

/**
 * The cost of one answer at `price`, or undefined when the price does not cover it. A unit price for
 * what the answer made (pictures, minutes, characters) takes over from its tokens; otherwise tokens
 * at the token prices, a missing cache price being the input's, a long prompt priced whole at its tier.
 */
export function costOf(price: Price, a: PricedAnswer): number | undefined {
  if (a.img && price.perImage !== undefined) return a.img * price.perImage;
  if (a.sec && price.perMinute !== undefined) return (a.sec / 60) * price.perMinute;
  if (a.ch && price.perMillionChars !== undefined) return (a.ch / 1e6) * price.perMillionChars;
  if (price.input === undefined || price.output === undefined) return undefined;
  const i = a.i ?? 0, o = a.o ?? 0, cr = a.cr ?? 0, cw = a.cw ?? 0;
  // Pictures, audio or speech with no tokens reported: the token prices say nothing about them.
  if (!(i || o || cr || cw) && (a.img || a.sec || a.ch)) return undefined;
  const prompt = i + cr + cw;
  const tier = [...(price.tiers ?? [])].reverse().find((t) => prompt > t.over);
  const p = tier ?? { input: price.input, output: price.output, cacheRead: price.cacheRead, cacheWrite: price.cacheWrite };
  const read = p.cacheRead ?? price.cacheRead ?? p.input;
  const write = p.cacheWrite ?? price.cacheWrite ?? p.input;
  return (i * p.input + o * p.output + cr * read + cw * write) / 1e6;
}

/**
 * A stored call priced again: its cost now, undefined when an answer has no price, or `keep` when
 * an answer's provider is gone from gateway.yaml (`priceOf` null) and today's prices cannot say.
 */
export function repriceBasis(basis: PriceBasis, priceOf: (served: string) => Price | undefined | null): { costUsd?: number } | "keep" {
  const prices = basis.map((a) => priceOf(a.m));
  if (!basis.length || prices.some((p) => p === null)) return "keep";
  const cost = basisCost(basis, (served) => prices[basis.findIndex((a) => a.m === served)] ?? undefined);
  return cost === undefined ? {} : { costUsd: cost };
}

/** A call's cost from its answers at today's prices; undefined when any answer has no price (or there are none). */
export function basisCost(basis: PriceBasis, priceOf: (served: string) => Price | undefined): number | undefined {
  if (!basis.length) return undefined;
  let sum = 0;
  for (const a of basis) {
    const p = priceOf(a.m);
    const c = p ? costOf(p, a) : undefined;
    if (c === undefined) return undefined;
    sum += c;
  }
  return sum;
}

const host = (url: string | undefined) => {
  try {
    return url ? new URL(url).host : undefined;
  } catch {
    return undefined;
  }
};

export type PriceBookOptions = { home: string; fetch?: typeof fetch; now?: () => number; log?: (line: string) => void; modelWatch?: ModelWatchPrices };

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
  private readonly listeners: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  readonly modelWatch: ModelWatchPrices | undefined;

  constructor(o: PriceBookOptions) {
    this.modelWatch = o.modelWatch;
    this.modelWatch?.onChange(() => this.changed());
    this.file = join(o.home, PRICES_FILE);
    this.cache = join(o.home, MODELS_DEV_CACHE);
    this.doFetch = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((l) => console.log(`[gateway-prices] ${l}`));
  }

  /** Read both files; then refresh the catalogue in the background when it is a day old or missing. */
  async load(): Promise<void> {
    await this.readOwn();
    await this.modelWatch?.load();
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
        const changed = JSON.stringify(catalog.providers) !== JSON.stringify(this.catalog?.providers);
        this.catalog = catalog;
        this.log(`models.dev prices: ${Object.keys(catalog.providers).length} providers`);
        if (changed) this.changed();
      } catch (e) {
        this.log(`models.dev prices not refreshed (${(e as Error).message}); ${this.catalog ? `keeping those of ${this.catalog.fetchedAt}` : "calls not in the price file stay unpriced"}`);
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }

  /** Called after a price changed: the file was edited, or the catalogue came back different. */
  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  /**
   * Keep the prices current without waiting for a call: the file looked at every `fileMs`, the
   * catalogue refreshed once a day. The timer does not keep the process alive.
   */
  watch(fileMs = 60_000): void {
    if (this.timer) return;
    let last = this.now();
    this.timer = setInterval(() => {
      void this.readOwn();
      this.modelWatch?.tick();
      if (this.now() - last >= REFRESH_MS || (this.catalog && this.now() - Date.parse(this.catalog.fetchedAt) >= REFRESH_MS)) {
        last = this.now();
        void this.refresh();
      }
    }, fileMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private changed(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch (e) {
        this.log(`after a price change: ${(e as Error).message}`);
      }
    }
  }

  /** When the catalogue was fetched, and why the price file did not load. */
  status(): { catalogFetchedAt?: string; fileError?: string; modelWatch?: ModelWatchStatus } {
    return { ...(this.catalog ? { catalogFetchedAt: this.catalog.fetchedAt } : {}), ...(this.ownError ? { fileError: this.ownError } : {}), ...(this.modelWatch ? { modelWatch: this.modelWatch.status() } : {}) };
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

  /** The price calls are costed at; a CNY price waiting for its rate is none. */
  lookupSync(p: Pick<GatewayProvider, "name" | "preset" | "messages" | "openai">, model: string): PriceLookup | undefined {
    const found = this.describe(p, model);
    return found?.needsRate ? undefined : found;
  }

  /** The price as Settings shows it: a CNY price waiting for its rate included. */
  describe(p: Pick<GatewayProvider, "name" | "preset" | "messages" | "openai">, model: string): PriceLookup | undefined {
    const own = this.own[`${p.name}/${model}`];
    if (own) return { price: own, source: "price file" };
    const all = this.own[`${p.name}/*`];
    if (all) return { price: all, source: "price file (provider/*)" };
    const watched = this.modelWatch?.lookup(p, model);
    if (watched) return watched;
    const id = this.catalogProvider(p);
    const models = id ? this.catalog?.providers[id]?.models : undefined;
    if (!models) return undefined;
    const exact = models[model] ?? Object.entries(models).find(([k]) => k.toLowerCase() === model.toLowerCase())?.[1];
    return exact ? { price: exact, source: `models.dev ${id}` } : undefined;
  }

  /** The models the price file names for this provider (not `provider/*`): pictures and speech are often not in its model list. */
  fileModels(provider: string): string[] {
    const prefix = `${provider}/`;
    return Object.keys(this.own).filter((k) => k.startsWith(prefix) && k !== `${prefix}*`).map((k) => k.slice(prefix.length));
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
