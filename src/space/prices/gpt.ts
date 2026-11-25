import { activePrices, type PriceBook } from "./book.ts";
import type { Price, PriceCatalog } from "./price.ts";

/**
 * The vendor list prices in the shape apps read (`GET /api/model/pricing`, version 1) and the
 * ledger's read-time GPT estimate, both derived from the price book (docs/prices.md): the owner's
 * `openai/<model>`, the catalogue, models.dev. Rebuilt whenever a price changes.
 */

/** One model's standard API rates, USD per `unitTokens`. NULL means unpriced, not free. */
export type GptRate = {
  input: number;
  cacheWrite: number | null;
  cacheRead: number;
  output: number;
  longContext: { threshold: number; inputMultiplier: number; outputMultiplier: number } | null;
  fastMultiplier: number | null;
};
/** A list price of another vendor in the same shape, without the GPT-only Fast multiplier. */
export type VendorRate = Omit<GptRate, "fastMultiplier">;
export type VendorSection = { source: string; fetchedAt: string; unitTokens: number; models: Record<string, VendorRate>; sources: Record<string, string> };

/** `GET /api/model/pricing`, version 1 (docs/model.md#gpt-cost-estimates). */
export type GptCatalog = {
  version: 1;
  asOf: string;
  currency: "USD";
  unitTokens: number;
  source: string;
  models: Record<string, GptRate>;
  /** The GPT models priced from models.dev: id → where. */
  filled: Record<string, string>;
  /** Where each GPT price came from: id → price file, ai-space openai <asOf>, models.dev openai. */
  sources: Record<string, string>;
  /** Anthropic's and DeepSeek's list prices, for apps that price Claude and DeepSeek transcripts. */
  anthropic?: VendorSection;
  deepseek?: VendorSection;
};

const GPT_ID = /^gpt-[a-z0-9.-]+$/;
const CLAUDE_ID = /^claude-[a-z0-9.-]+$/;
const DEEPSEEK_ID = /^deepseek-[a-z0-9.-]+$/;
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

/**
 * A price as a rate of this shape, or undefined when it does not fit: a long-context price must be
 * one tier whose input, cache read and cache write all move by the same multiplier (the shape has
 * one input multiplier). A missing cache write is null: such calls are unpriced when they wrote to
 * the cache. Unit prices (pictures, speech) have no rate here.
 */
export function rateFromPrice(p: Price): VendorRate | undefined {
  if (p.input === undefined || p.output === undefined || p.input <= 0 || p.output <= 0) return undefined;
  if (p.perImage !== undefined || p.perMinute !== undefined || p.perMillionChars !== undefined) return undefined;
  let longContext: VendorRate["longContext"] = null;
  if (p.tiers?.length) {
    const t = p.tiers[0]!;
    if (p.tiers.length > 1) return undefined;
    const im = t.input / p.input;
    const om = t.output / p.output;
    if (!(im > 0 && om > 0)) return undefined;
    if (p.cacheRead !== undefined && !close((t.cacheRead ?? p.cacheRead * im) / p.cacheRead, im)) return undefined;
    if (typeof p.cacheWrite === "number" && !close((t.cacheWrite ?? p.cacheWrite * im) / p.cacheWrite, im)) return undefined;
    longContext = { threshold: t.over, inputMultiplier: +im.toFixed(6), outputMultiplier: +om.toFixed(6) };
  }
  return { input: p.input, cacheWrite: p.cacheWrite ?? null, cacheRead: p.cacheRead ?? p.input, output: p.output, longContext };
}
/** The name PR 214 gave it. */
export const rateFromModelsDev = rateFromPrice;

function section(book: PriceBook, vendor: string, idPattern: RegExp): { models: Record<string, VendorRate>; sources: Record<string, string> } {
  const models: Record<string, VendorRate> = {};
  const sources: Record<string, string> = {};
  for (const id of book.vendorModels(vendor).sort()) {
    if (!idPattern.test(id)) continue;
    const found = book.forVendor(vendor, id);
    const r = found ? rateFromPrice(found.price) : undefined;
    if (!r) continue;
    models[id] = r;
    sources[id] = found!.source;
  }
  return { models, sources };
}

/** The whole document from a price book. */
export function pricingFrom(book: PriceBook): GptCatalog {
  const cat = book.prices();
  const openai = cat.vendors.openai;
  const dev = book.catalogue();
  const gpt = section(book, "openai", GPT_ID);
  const models: Record<string, GptRate> = {};
  const filled: Record<string, string> = {};
  for (const [id, r] of Object.entries(gpt.models)) {
    // The Fast multiplier only ever from ai-space's own data, whatever priced the rest.
    const fast = book.vendorEntry("openai", id)?.price?.fastMultiplier;
    models[id] = { ...r, fastMultiplier: fast ?? null };
    if (gpt.sources[id]!.startsWith("models.dev")) filled[id] = `models.dev ${dev?.fetchedAt.slice(0, 10) ?? ""}`.trim();
  }
  const out: GptCatalog = {
    version: 1, asOf: openai?.asOf ?? cat.asOf.slice(0, 10), currency: "USD", unitTokens: 1_000_000,
    source: openai?.source ?? "https://developers.openai.com/api/docs/pricing", models, filled, sources: gpt.sources,
  };
  for (const [vendor, pattern] of [["anthropic", CLAUDE_ID], ["deepseek", DEEPSEEK_ID]] as const) {
    const s = section(book, vendor, pattern);
    if (!Object.keys(s.models).length) continue;
    out[vendor] = { source: cat.vendors[vendor]?.source ?? "https://models.dev", fetchedAt: dev?.fetchedAt ?? cat.asOf, unitTokens: 1_000_000, ...s };
  }
  return out;
}

const input = "(input_tokens + COALESCE(cache_write_tokens, 0) + COALESCE(cache_read_tokens, 0))";

/** Per-call pricing at read time includes historical rows without rewriting costs.
 * Date-suffixed snapshot ids inherit the exact base model price; other ids do not.
 */
const modelId = "CASE WHEN model GLOB '*-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' THEN substr(model, 1, length(model) - 11) ELSE model END";

/** Rates are standard API-equivalent USD per unitTokens, not subscription charges. Ledger rows do not record tiers. */
function costSql(p: GptCatalog): string {
  // A row priced by the built-in model gateway (price_basis) keeps the gateway's figure: no estimate fills its gap.
  return `CASE WHEN price_basis IS NOT NULL THEN cost_usd ELSE COALESCE(cost_usd, CASE
  WHEN input_tokens >= 0 AND output_tokens >= 0
    AND COALESCE(cache_write_tokens, 0) >= 0 AND COALESCE(cache_read_tokens, 0) >= 0
  THEN CASE ${modelId}
    ${Object.entries(p.models).filter(([model]) => GPT_ID.test(model)).map(([model, r]) => {
      const long = r.longContext;
      const im = long ? `CASE WHEN ${input} > ${long.threshold} THEN ${long.inputMultiplier} ELSE 1 END` : "1";
      const om = long ? `CASE WHEN ${input} > ${long.threshold} THEN ${long.outputMultiplier} ELSE 1 END` : "1";
      return `WHEN '${model}' THEN CASE WHEN ${r.cacheWrite === null ? "COALESCE(cache_write_tokens, 0) = 0" : "1"} THEN
        ((input_tokens * ${r.input} + COALESCE(cache_write_tokens, 0) * ${r.cacheWrite ?? 0} + COALESCE(cache_read_tokens, 0) * ${r.cacheRead}) * ${im}
          + output_tokens * ${r.output} * ${om}) / ${p.unitTokens}.0 ELSE NULL END`;
    }).join("\n")}
    ELSE NULL END
  ELSE NULL END) END`;
}

let built: { book: PriceBook; version: number; pricing: GptCatalog; sql: string } | undefined;

function current() {
  const book = activePrices();
  if (!built || built.book !== book || built.version !== book.version) {
    const pricing = pricingFrom(book);
    built = { book, version: book.version, pricing, sql: costSql(pricing) };
  }
  return built;
}

/** The list prices in force: the ledger's estimate and what `/api/model/pricing` serves. */
export function gptPricing(): GptCatalog {
  return current().pricing;
}

/** The ledger's per-row cost expression at the prices in force. */
export function modelCostSql(): string {
  return current().sql;
}

/** Tests: a models.dev catalogue for the active book, as if it had been fetched. */
export type { PriceCatalog };
