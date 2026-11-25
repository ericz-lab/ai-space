import type { Price, PriceCatalog } from "../gateway/prices.ts";
import catalog from "./gpt-prices.json";

/** One GPT model's standard API rates, USD per `unitTokens`. NULL means unpriced, not free. */
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

/** `GET /api/model/pricing`, version 1 (docs/model.md#gpt-cost-estimates). */
export type GptCatalog = {
  version: 1;
  asOf: string;
  currency: "USD";
  unitTokens: number;
  source: string;
  models: Record<string, GptRate>;
  /** The models not in gpt-prices.json, priced from models.dev's catalogue: id → where. */
  filled: Record<string, string>;
  /** Anthropic's list prices from models.dev, for apps that price Claude transcripts; absent without the catalogue. */
  anthropic?: { source: string; fetchedAt: string; unitTokens: number; models: Record<string, VendorRate> };
};

/** The curated table: it wins over models.dev, and it alone carries the Fast multiplier. */
export const GPT_FILE = catalog as unknown as Omit<GptCatalog, "filled" | "anthropic">;

const GPT_ID = /^gpt-[a-z0-9.-]+$/;
const CLAUDE_ID = /^claude-[a-z0-9.-]+$/;
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

/**
 * One models.dev price as a rate of this table, or undefined when it does not fit: a long-context
 * price must be one tier whose input, cache read and cache write all move by the same multiplier
 * (the table has one input multiplier). A missing cache write stays null: such calls are unpriced
 * when they wrote to the cache. models.dev has no Fast price, so a filled model has none.
 */
export function rateFromModelsDev(p: Price): VendorRate | undefined {
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
    if (p.cacheWrite !== undefined && !close((t.cacheWrite ?? p.cacheWrite * im) / p.cacheWrite, im)) return undefined;
    longContext = { threshold: t.over, inputMultiplier: +im.toFixed(6), outputMultiplier: +om.toFixed(6) };
  }
  return { input: p.input, cacheWrite: p.cacheWrite ?? null, cacheRead: p.cacheRead ?? p.input, output: p.output, longContext };
}

/** gpt-prices.json, then the GPT models only models.dev's `openai` lists; plus its Anthropic prices. */
export function mergeGptPricing(dev: PriceCatalog | undefined): GptCatalog {
  const models: Record<string, GptRate> = { ...GPT_FILE.models };
  const filled: Record<string, string> = {};
  for (const [id, p] of Object.entries(dev?.providers.openai?.models ?? {})) {
    if (!GPT_ID.test(id) || models[id]) continue;
    const r = rateFromModelsDev(p);
    if (!r) continue;
    models[id] = { ...r, fastMultiplier: null };
    filled[id] = `models.dev ${dev!.fetchedAt.slice(0, 10)}`;
  }
  const out: GptCatalog = { ...GPT_FILE, models, filled };
  const claude: Record<string, VendorRate> = {};
  for (const [id, p] of Object.entries(dev?.providers.anthropic?.models ?? {})) {
    const r = CLAUDE_ID.test(id) ? rateFromModelsDev(p) : undefined;
    if (r) claude[id] = r;
  }
  if (dev && Object.keys(claude).length) out.anthropic = { source: "https://models.dev", fetchedAt: dev.fetchedAt, unitTokens: 1_000_000, models: claude };
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

let current = mergeGptPricing(undefined);
let currentSql = costSql(current);

/** The GPT prices in force: the ledger's estimate and what `/api/model/pricing` serves. */
export function gptPricing(): GptCatalog {
  return current;
}

/** The ledger's per-row cost expression at the prices in force. */
export function modelCostSql(): string {
  return currentSql;
}

/** Take models.dev's catalogue (at boot and whenever it changes); returns the GPT ids it now prices. */
export function useModelsDev(dev: PriceCatalog | undefined): string[] {
  current = mergeGptPricing(dev);
  currentSql = costSql(current);
  return Object.keys(current.filled);
}
