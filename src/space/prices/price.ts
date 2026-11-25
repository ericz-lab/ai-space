import { join } from "node:path";
import type { PriceBasis, PricedAnswer, Usage } from "../runtimes/types.ts";

/**
 * One price and the arithmetic on it (docs/prices.md). A price is one tariff for one model: USD per
 * million tokens, and for pictures and speech per picture, per minute of audio or per million
 * characters. Where prices come from and in which order is book.ts; this file has no state.
 */

/** The owner's prices, in the workspace (docs/prices.md#the-owners-file). */
export const PRICES_FILE = "gateway-prices.yaml";
export const MODELS_DEV_URL = "https://models.dev/api.json";
/** The trimmed catalogue: only what pricing reads, a few hundred KB instead of models.dev's 7 MB. */
export const MODELS_DEV_CACHE = join("run", "models-dev-prices.json");

export type Price = {
  /** USD per million tokens. A price of units only (below) has none. */
  input?: number;
  output?: number;
  cacheRead?: number;
  /** Absent: the input price. null: the model has no cache-write price, so a call that wrote to the cache is unpriced. */
  cacheWrite?: number | null;
  /** Long-context prices: the whole call is at a tier's prices once its prompt is over `over` tokens. */
  tiers?: { over: number; input: number; output: number; cacheRead?: number; cacheWrite?: number }[];
  /** Per picture made, per minute of audio transcribed, per million characters spoken; each takes over from the tokens of a call that has it. */
  perImage?: number;
  perMinute?: number;
  perMillionChars?: number;
  /** The Fast (priority) tier's multiplier. Only ever from ai-space's own data (tables/*.json), never from the owner's file or models.dev. */
  fastMultiplier?: number;
};
/**
 * Where a price came from: the owner's file, ai-space's price catalogue (`ai-space <vendor> <asOf>`:
 * fetched daily, or the copy in the release), Model Watch's row for a provider's site, or models.dev.
 */
export type PriceSource = "price file" | "price file (provider/*)" | `ai-space ${string}` | `Model Watch ${string}` | `models.dev ${string}`;
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
  if (cw && price.cacheWrite === null) return undefined;
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

