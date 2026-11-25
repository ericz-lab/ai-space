import bundled from "./tables/model-watch.json" with { type: "json" };
import type { Price } from "./price.ts";
import type { GatewayProvider } from "../gateway/types.ts";

/**
 * The prices Model Watch reads off the vendors' pricing pages (docs/model-gateway.md#from-model-watch),
 * the second place a gateway price is looked for, after gateway-prices.yaml and before models.dev.
 *
 * They ship with ai-space: `model-watch-prices.json` next to this file is written on the machine
 * that runs Model Watch by `bun run sync-prices` (scripts/sync-model-watch-prices.ts) and committed;
 * ai-space never asks Model Watch at run time. A row is used only when all of these hold:
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

/** USD for one CNY, set by the owner; never guessed. */
export const RATE_ENV = "SPACE_GATEWAY_USD_PER_CNY";

export type WatchRow = {
  source: string; id: string; name: string; variant: string; currency: string | null; unit: string | null;
  input: number | null; cachedInput: number | null; output: number | null;
};
export type WatchSource = { id: string; name: string; pricingUrl: string | null; site: string | null; currencies: string[]; checkedAt: string | null; error: string | null };
export type WatchPayload = { sources: WatchSource[]; prices: WatchRow[] };
/** The synced file: when, from which database, and Model Watch's sources and rows as printed. */
export type WatchFile = WatchPayload & { syncedAt: string; from: string };

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
  /** When the bundled file was synced from Model Watch. */
  syncedAt?: string;
  rate?: { usdPerCny: number; from: string };
  rateError?: string;
  /** CNY pages are in use and no rate is set. */
  needsRate: boolean;
  sources: { id: string; name: string; site: string; label?: string; checkedAt?: string; currency: string; skipped: Record<string, number> }[];
};

export type ModelWatchOptions = {
  env?: Record<string, string | undefined>;
  /** The prices; the file shipped with ai-space when not given (tests give their own). */
  data?: WatchFile;
};

export class ModelWatchPrices {
  private readonly env: Record<string, string | undefined>;
  private readonly copy: WatchFile | undefined;
  private readonly bySource = new Map<string, WatchRow[]>();

  constructor(o: ModelWatchOptions = {}) {
    this.env = o.env ?? process.env;
    const data = o.data ?? (bundled as unknown as WatchFile);
    this.copy = Array.isArray(data?.sources) && Array.isArray(data?.prices) ? data : undefined;
    for (const r of this.copy?.prices ?? []) this.bySource.set(r.source, [...(this.bySource.get(r.source) ?? []), r]);
  }

  /** The page that prices this provider, by its base. */
  sourceFor(p: Pick<GatewayProvider, "messages" | "openai">): WatchSource | undefined {
    const bases = [p.messages, p.openai].filter((b): b is string => Boolean(b)).map((b) => b.replace(/\/+$/, ""));
    return this.copy?.sources.find((s) => {
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
    const sources = (this.copy?.sources ?? []).filter((s) => s.site && MODEL_WATCH_SITES[s.site]).map((s) => {
      const rows = this.bySource.get(s.id) ?? [];
      const skipped: Record<string, number> = {};
      for (const r of rows) if ((SKIPPED_UNITS as readonly string[]).includes(r.unit ?? "")) skipped[r.unit!] = (skipped[r.unit!] ?? 0) + 1;
      return { id: s.id, name: s.name, site: s.site!, label: MODEL_WATCH_SITES[s.site!]!.label, ...(s.checkedAt ? { checkedAt: s.checkedAt } : {}), currency: s.currencies.join(", "), skipped };
    });
    return {
      ...(this.copy ? { syncedAt: this.copy.syncedAt } : {}),
      ...(rate && !("error" in rate) ? { rate } : {}),
      ...(rate && "error" in rate ? { rateError: rate.error } : {}),
      needsRate: !(rate && !("error" in rate)) && sources.some((s) => s.currency.includes("CNY")),
      sources,
    };
  }
}
