import { mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Price } from "./prices.ts";
import type { GatewayProvider } from "./types.ts";

/**
 * The prices Model Watch reads off the vendors' pricing pages (docs/model-gateway.md#prices), the
 * second place a gateway price is looked for, after gateway-prices.yaml and before models.dev.
 *
 * Model Watch offers them as the bus capability `model-watch/prices`, on this machine or on a peer.
 * They are fetched every few hours and kept in `run/model-watch-prices.json`, so a restart or an
 * unreachable machine keeps the last copy. A row is used only when all of these hold:
 *
 *  - its page is one of MODEL_WATCH_SITES, and the provider's base is that site's API base: the
 *    China pages price the China bases only, Ark's pay-as-you-go page its pay-as-you-go bases only;
 *  - its model is the gateway's model (`matchRows`: same id, or the same once both are normalised,
 *    and no other model of that page normalises to the same);
 *  - its variants read as one base price (`priceFromRows`), in a unit that maps to a Price field;
 *  - its currency is USD, or CNY with `SPACE_GATEWAY_USD_PER_CNY` set.
 *
 * A model none of this prices falls through to models.dev.
 */

export const MODEL_WATCH_APP = "model-watch";
export const MODEL_WATCH_CAPABILITY = "prices";
export const MODEL_WATCH_CACHE = join("run", "model-watch-prices.json");
/** USD for one CNY, set by the owner; never guessed. */
export const RATE_ENV = "SPACE_GATEWAY_USD_PER_CNY";
const REFRESH_MS = 6 * 3600_000;
const RETRY_MS = 10 * 60_000;

export type WatchRow = {
  source: string; id: string; name: string; variant: string; currency: string | null; unit: string | null;
  input: number | null; cachedInput: number | null; output: number | null;
};
export type WatchSource = { id: string; name: string; pricingUrl: string | null; site: string | null; currencies: string[]; checkedAt: string | null; error: string | null };
export type WatchPayload = { sources: WatchSource[]; prices: WatchRow[] };
type Cache = { fetchedAt: string; from: string; payload: WatchPayload };

/**
 * The pricing pages whose rows price a gateway provider, by the page's host, and the API bases
 * (prefixes of the provider's Messages or OpenAI base) they price. Checked 2026-11-24/25:
 *  - platform.minimax.cn is MiniMax's China site (platform.minimaxi.com redirects to it); its docs
 *    give api.minimax.cn, and api.minimaxi.com (GATEWAY_SITES.minimax.cn) answers too. Not api.minimax.io.
 *  - docs.bigmodel.cn is Zhipu's China site: the `zhipu` preset, not `zai` (api.z.ai).
 *  - platform.kimi.com is Moonshot's China console; its docs give api.moonshot.cn, the `kimi` China site.
 *  - Volcengine's 82379/1544106 is Ark's pay-as-you-go page: the `ark` preset's base and the
 *    OpenAI-style /api/v3, not the Coding Plan (/api/coding) or the Agent Plan (/api/plan), which
 *    are subscriptions: their calls stay unpriced unless gateway-prices.yaml prices them.
 *  - api-docs.deepseek.com is DeepSeek's CNY page for api.deepseek.com.
 * OpenAI's, Anthropic's and Gemini's pages are left to models.dev: their rows are split by date and
 * by modality in ways models.dev already structures.
 */
export const MODEL_WATCH_SITES: Record<string, { label: string; bases: string[] }> = {
  "platform.minimax.cn": { label: "MiniMax China", bases: ["https://api.minimax.cn", "https://api.minimaxi.com"] },
  "docs.bigmodel.cn": { label: "Zhipu (bigmodel.cn)", bases: ["https://open.bigmodel.cn"] },
  "platform.kimi.com": { label: "Kimi China", bases: ["https://api.moonshot.cn"] },
  "www.volcengine.com": { label: "Ark pay-as-you-go", bases: ["https://ark.cn-beijing.volces.com/api/compatible", "https://ark.cn-beijing.volces.com/api/v3"] },
  "api-docs.deepseek.com": { label: "DeepSeek", bases: ["https://api.deepseek.com"] },
};

/** Units priced per call of a kind the gateway does not cost: listed in the status, never priced. */
export const SKIPPED_UNITS = ["second", "video", "3D file", "request", "song", "voice"] as const;

/**
 * Model Watch's own normaliser (model-watch/watch.ts, `watchKey`): lower case, a trailing date (`-0813`,
 * `-261028`, `-20261028`) dropped, then everything but letters and digits.
 */
export const watchKey = (s: string) => s.toLowerCase().replace(/[\s_-](\d{4}|\d{6}|\d{8})$/, "").replace(/[^\p{L}\p{N}]+/gu, "");
/** The same, with one name the pages and the APIs spell apart: Ark's 正式版 is its API's `-ga` (general availability). */
export const modelKey = (s: string) => watchKey(s).replace(/正式版$/u, "ga");

/**
 * The rows of `model` on one page: those of the Model Watch model whose id is the model's (any
 * case), else the one whose id, else whose name, normalises to the model's. Two models of the page
 * normalising alike match neither: a price is never taken from another model.
 */
export function matchRows(rows: WatchRow[], model: string): WatchRow[] {
  const byId = new Map<string, WatchRow[]>();
  for (const r of rows) byId.set(r.id, [...(byId.get(r.id) ?? []), r]);
  const exact = [...byId.keys()].filter((id) => id.toLowerCase() === model.toLowerCase());
  if (exact.length === 1) return byId.get(exact[0]!)!;
  const key = modelKey(model);
  if (!key) return [];
  for (const field of ["id", "name"] as const) {
    const ids = [...byId.entries()].filter(([, rs]) => rs.some((r) => modelKey(r[field]) === key)).map(([id]) => id);
    if (ids.length === 1) return byId.get(ids[0]!)!;
    if (ids.length > 1) return [];
  }
  return [];
}

/** One clause of a variant ("输入长度 (32, 128]K", "非音频", "P ≤ 2.61M"), read. */
type Clause = { kind: "base" } | { kind: "over"; over: number } | { kind: "drop" } | { kind: "unknown"; text: string };

/** The default condition, and the other conditions whose rows are left out. */
const BASE_CONDITIONS = new Set(["非音频", "文本输入", "单图生成", "高峰时段"]);
const OTHER_CONDITIONS = new Set(["音频", "视频", "图片输入", "图层拆分", "空闲时段"]);
const K = 1000;

function clause(raw: string): Clause {
  const s = raw.trim();
  if (!s || BASE_CONDITIONS.has(s)) return { kind: "base" };
  if (OTHER_CONDITIONS.has(s)) return { kind: "drop" };
  // A discount past a size ("≥ 1660 万像素整次请求五折"): the base price is the one without it.
  if (/五折|折扣|折$/.test(s)) return { kind: "base" };
  // Input-length bands: "输入长度 [0, 32K)", "输入长度 (32, 128]K", "输入 [32K, 200K)".
  const band = /^输入(?:长度)?\s*([[(])\s*(\d+(?:\.\d+)?)\s*K?\s*,\s*\d+(?:\.\d+)?\s*K?\s*[\])]\s*K?$/i.exec(s);
  if (band) {
    const lower = Number(band[2]) * K;
    return lower === 0 ? { kind: "base" } : { kind: "over", over: band[1] === "[" ? lower - 1 : lower };
  }
  const atLeast = /^输入(?:长度)?\s*≥\s*(\d+(?:\.\d+)?)\s*K$/i.exec(s);
  if (atLeast) return { kind: "over", over: Number(atLeast[1]) * K - 1 };
  if (/^[≤<]=?\s*\d+(?:\.\d+)?\s*k\s*输入\s*tokens$/i.test(s)) return { kind: "base" };
  const over = /^>\s*(\d+(?:\.\d+)?)\s*k\s*输入\s*tokens$/i.exec(s);
  if (over) return { kind: "over", over: Number(over[1]) * K };
  // Picture sizes: the smallest band is the default picture size (1024x1024 is 1.05M pixels).
  if (/^P\s*[≤<]/.test(s)) return { kind: "base" };
  if (/^[\d.]+\s*M\s*<\s*P/.test(s) || /^P\s*>/.test(s)) return { kind: "drop" };
  return { kind: "unknown", text: s };
}

export type RowsPrice = { price: Price; currency: string } | { reason: string };

const r9 = (n: number) => Math.round(n * 1e9) / 1e9;

/**
 * One model's rows as one Price, in the page's currency, or why they are not one. The variant rule:
 *  - each variant is split at "，" and "；" into clauses; the default condition (非音频,
 *    文本输入, 单图生成, 高峰时段) is kept, the other conditions (音频, 视频, 图片输入, 图层拆分, 空闲时段)
 *    and the larger picture-size bands are left out, a discount clause is ignored;
 *  - an input-length band from 0 is the base price, a higher band a `tiers` entry over its lower
 *    bound (K = 1000 tokens); an output-length band, or any clause not read here, prices nothing;
 *  - exactly one base row per unit must be left, or nothing is priced.
 * Units: 1M tokens → input, output, cacheRead (an input-only row, an embedding, has output 0);
 * image → perImage (the output side); minute and hour → perMinute; 10K and 1M characters → perMillionChars.
 */
export function priceFromRows(rows: WatchRow[]): RowsPrice {
  const currencies = new Set(rows.map((r) => r.currency ?? ""));
  if (currencies.size !== 1) return { reason: "rows in several currencies" };
  const currency = rows[0]!.currency ?? "";
  const priced = rows.filter((r) => !(SKIPPED_UNITS as readonly string[]).includes(r.unit ?? ""));
  if (!priced.length) return { reason: `priced per ${rows[0]!.unit ?? "unknown unit"}` };
  const price: Price = {};
  const units = new Set(priced.map((r) => r.unit ?? ""));
  for (const unit of units) {
    const base: WatchRow[] = [];
    const tiers: { over: number; row: WatchRow }[] = [];
    for (const r of priced.filter((x) => (x.unit ?? "") === unit)) {
      const clauses = r.variant.split(/[，；]/).map(clause);
      const unknown = clauses.find((c): c is Extract<Clause, { kind: "unknown" }> => c.kind === "unknown");
      if (unknown) return { reason: `variant "${r.variant}" is not one this reads` };
      if (clauses.some((c) => c.kind === "drop")) continue;
      const over = clauses.find((c): c is Extract<Clause, { kind: "over" }> => c.kind === "over");
      if (over) tiers.push({ over: over.over, row: r });
      else base.push(r);
    }
    if (base.length !== 1) return { reason: base.length ? `${base.length} base prices per ${unit}` : `no base price per ${unit}` };
    const b = base[0]!;
    const one = b.output ?? b.input;
    if (unit === "1M tokens") {
      if (b.input === null) return { reason: "no input price" };
      Object.assign(price, { input: b.input, output: b.output ?? 0, ...(b.cachedInput !== null ? { cacheRead: b.cachedInput } : {}) });
      const t = tiers.filter((x) => x.row.input !== null).sort((x, y) => x.over - y.over);
      if (t.length !== tiers.length || new Set(t.map((x) => x.over)).size !== t.length) return { reason: "long-context bands not read" };
      if (t.length) price.tiers = t.map(({ over, row }) => ({ over, input: row.input!, output: row.output ?? 0, ...(row.cachedInput !== null ? { cacheRead: row.cachedInput } : {}) }));
    } else if (tiers.length) {
      return { reason: `length bands per ${unit}` };
    } else if (one === null) {
      return { reason: `no price per ${unit}` };
    } else if (unit === "image") price.perImage = one;
    else if (unit === "minute") price.perMinute = one;
    else if (unit === "hour") price.perMinute = r9(one / 60);
    else if (unit === "10K characters") price.perMillionChars = r9(one * 100);
    else if (unit === "1M characters") price.perMillionChars = one;
    else return { reason: `priced per ${unit}` };
  }
  return { price, currency };
}

/** Every figure of a price times `rate`. */
export function convertPrice(p: Price, rate: number): Price {
  const out: Price = {};
  for (const [k, v] of Object.entries(p) as [keyof Price, unknown][]) {
    if (k === "tiers") out.tiers = p.tiers!.map((t) => ({ ...t, input: r9(t.input * rate), output: r9(t.output * rate), ...(t.cacheRead !== undefined ? { cacheRead: r9(t.cacheRead * rate) } : {}), ...(t.cacheWrite !== undefined ? { cacheWrite: r9(t.cacheWrite * rate) } : {}) }));
    else if (typeof v === "number") (out as Record<string, number>)[k] = r9(v * rate);
  }
  return out;
}

/** The rate from the environment: a positive number, else why not. */
export function readRate(env: Record<string, string | undefined>): { usdPerCny: number; from: string } | { error: string } | undefined {
  const raw = env[RATE_ENV]?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 10) return { error: `${RATE_ENV}="${raw}" is not a rate (USD for one CNY, such as 0.14)` };
  return { usdPerCny: n, from: RATE_ENV };
}

export type WatchLookup = {
  price: Price;
  source: `Model Watch ${string}`;
  /** When Model Watch last read the page. */
  checkedAt?: string;
  currency: string;
  /** The figures as the page prints them, when they were converted. */
  printed?: Price;
  /** A CNY price with no rate set: shown, not used for costs. */
  needsRate?: true;
};

export type ModelWatchStatus = {
  fetchedAt?: string;
  /** The peer it came from; "" for this machine. */
  from?: string;
  error?: string;
  rate?: { usdPerCny: number; from: string };
  rateError?: string;
  /** CNY pages are in use and no rate is set. */
  needsRate: boolean;
  sources: { id: string; name: string; site: string; label?: string; checkedAt?: string; currency: string; skipped: Record<string, number> }[];
};

export type ModelWatchOptions = {
  home: string;
  env?: Record<string, string | undefined>;
  now?: () => number;
  log?: (line: string) => void;
};

/** Fetches `model-watch/prices`: the answer and the machine that gave it ("" for this one). */
export type WatchFetch = () => Promise<{ from: string; res: Response }>;

export class ModelWatchPrices {
  private readonly cache: string;
  private readonly env: Record<string, string | undefined>;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private copy: Cache | undefined;
  private error: string | undefined;
  private lastTry = 0;
  private fetcher: WatchFetch | undefined;
  private refreshing: Promise<void> | undefined;
  private readonly listeners: (() => void)[] = [];
  private bySource = new Map<string, WatchRow[]>();

  constructor(o: ModelWatchOptions) {
    this.cache = join(o.home, MODEL_WATCH_CACHE);
    this.env = o.env ?? process.env;
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((l) => console.log(`[gateway-prices] ${l}`));
  }

  /** The copy kept from the last fetch. */
  async load(): Promise<void> {
    try {
      this.set((await Bun.file(this.cache).json()) as Cache);
    } catch { /* none yet */ }
  }

  /** Where to fetch from, once the bus and the peers are up; fetches now when the copy is old. */
  start(fetcher: WatchFetch): void {
    this.fetcher = fetcher;
    this.tick();
  }

  /**
   * Called on the price book's timer (every minute): refetch every six hours, ten minutes after a
   * failure, and every minute while there is no copy at all (at boot the app or the peer that has
   * Model Watch is often not there yet).
   */
  tick(): void {
    if (!this.fetcher) return;
    const age = this.copy ? this.now() - Date.parse(this.copy.fetchedAt) : Infinity;
    const wait = !this.copy ? 0 : this.error ? RETRY_MS : REFRESH_MS;
    if (age >= REFRESH_MS && this.now() - this.lastTry >= (this.lastTry ? wait : 0)) void this.refresh();
  }

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  refresh(): Promise<void> {
    if (!this.fetcher) return Promise.resolve();
    this.refreshing ??= (async () => {
      this.lastTry = this.now();
      try {
        const { from, res } = await this.fetcher!();
        if (!res.ok) throw new Error(`HTTP ${res.status}${await res.text().then((t) => (t ? `: ${t.slice(0, 200)}` : ""), () => "")}`);
        const body = (await res.json()) as Partial<WatchPayload>;
        if (!Array.isArray(body.sources) || !Array.isArray(body.prices)) throw new Error("the answer has no sources and prices");
        const next: Cache = { fetchedAt: new Date(this.now()).toISOString(), from, payload: { sources: body.sources, prices: body.prices } };
        await mkdir(dirname(this.cache), { recursive: true });
        await Bun.write(`${this.cache}.tmp`, JSON.stringify(next));
        await rename(`${this.cache}.tmp`, this.cache);
        const changed = JSON.stringify(next.payload) !== JSON.stringify(this.copy?.payload);
        this.set(next);
        this.error = undefined;
        this.log(`Model Watch prices${from ? ` from ${from}` : ""}: ${next.payload.prices.length} rows of ${next.payload.sources.length} pages`);
        if (changed) for (const l of this.listeners) l();
      } catch (e) {
        const said = this.error;
        this.error = (e as Error).message;
        // Said once per reason: with no copy it is tried every minute.
        if (this.error !== said) this.log(`Model Watch prices not refreshed (${this.error}); ${this.copy ? `keeping those of ${this.copy.fetchedAt}` : "none yet"}`);
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }

  private set(c: Cache): void {
    this.copy = c;
    this.bySource = new Map();
    for (const r of c.payload.prices) this.bySource.set(r.source, [...(this.bySource.get(r.source) ?? []), r]);
  }

  /** The page that prices this provider, by its base. */
  sourceFor(p: Pick<GatewayProvider, "messages" | "openai">): WatchSource | undefined {
    const bases = [p.messages, p.openai].filter((b): b is string => Boolean(b)).map((b) => b.replace(/\/+$/, ""));
    return this.copy?.payload.sources.find((s) => {
      const site = s.site ? MODEL_WATCH_SITES[s.site] : undefined;
      return site?.bases.some((pre) => bases.some((b) => b === pre || b.startsWith(`${pre}/`)));
    });
  }

  /** The price of `model` at this provider from its page, converted to USD when a rate is set. */
  lookup(p: Pick<GatewayProvider, "messages" | "openai">, model: string): WatchLookup | undefined {
    const s = this.sourceFor(p);
    if (!s) return undefined;
    const rows = matchRows(this.bySource.get(s.id) ?? [], model);
    if (!rows.length) return undefined;
    const got = priceFromRows(rows);
    if ("reason" in got) return undefined;
    const base = { source: `Model Watch ${s.id}` as const, ...(s.checkedAt ? { checkedAt: s.checkedAt } : {}), currency: got.currency };
    if (got.currency === "USD") return { ...base, price: got.price };
    if (got.currency !== "CNY") return undefined;
    const rate = readRate(this.env);
    if (!rate || "error" in rate) return { ...base, price: got.price, printed: got.price, needsRate: true };
    return { ...base, price: convertPrice(got.price, rate.usdPerCny), printed: got.price };
  }

  status(): ModelWatchStatus {
    const rate = readRate(this.env);
    const sources = (this.copy?.payload.sources ?? []).filter((s) => s.site && MODEL_WATCH_SITES[s.site]).map((s) => {
      const rows = this.bySource.get(s.id) ?? [];
      const skipped: Record<string, number> = {};
      for (const r of rows) if ((SKIPPED_UNITS as readonly string[]).includes(r.unit ?? "")) skipped[r.unit!] = (skipped[r.unit!] ?? 0) + 1;
      return { id: s.id, name: s.name, site: s.site!, label: MODEL_WATCH_SITES[s.site!]!.label, ...(s.checkedAt ? { checkedAt: s.checkedAt } : {}), currency: s.currencies.join(", "), skipped };
    });
    return {
      ...(this.copy ? { fetchedAt: this.copy.fetchedAt, from: this.copy.from } : {}),
      ...(this.error ? { error: this.error } : {}),
      ...(rate && !("error" in rate) ? { rate } : {}),
      ...(rate && "error" in rate ? { rateError: rate.error } : {}),
      needsRate: !(rate && !("error" in rate)) && sources.some((s) => s.currency.includes("CNY")),
      sources,
    };
  }
}
