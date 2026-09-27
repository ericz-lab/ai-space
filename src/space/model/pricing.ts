import catalog from "./gpt-prices.json";

/** The versioned catalogue served to apps is also the ledger's sole GPT price source.
 * Rates are standard API-equivalent USD per unitTokens, not subscription charges.
 * NULL rates/multipliers mean unpriced, not free. Ledger rows do not record tiers.
 */
export const GPT_PRICING = catalog;

const input = "(input_tokens + COALESCE(cache_write_tokens, 0) + COALESCE(cache_read_tokens, 0))";

/** Per-call pricing at read time includes historical rows without rewriting costs.
 * Date-suffixed snapshot ids inherit the exact base model price; other ids do not.
 */
const modelId = "CASE WHEN model GLOB '*-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' THEN substr(model, 1, length(model) - 11) ELSE model END";
export const MODEL_COST_SQL = `COALESCE(cost_usd, CASE
  WHEN input_tokens >= 0 AND output_tokens >= 0
    AND COALESCE(cache_write_tokens, 0) >= 0 AND COALESCE(cache_read_tokens, 0) >= 0
  THEN CASE ${modelId}
    ${Object.entries(GPT_PRICING.models).map(([model, p]) => {
      const long = p.longContext;
      const im = long ? `CASE WHEN ${input} > ${long.threshold} THEN ${long.inputMultiplier} ELSE 1 END` : "1";
      const om = long ? `CASE WHEN ${input} > ${long.threshold} THEN ${long.outputMultiplier} ELSE 1 END` : "1";
      return `WHEN '${model}' THEN CASE WHEN ${p.cacheWrite === null ? "COALESCE(cache_write_tokens, 0) = 0" : "1"} THEN
        ((input_tokens * ${p.input} + COALESCE(cache_write_tokens, 0) * ${p.cacheWrite ?? 0} + COALESCE(cache_read_tokens, 0) * ${p.cacheRead}) * ${im}
          + output_tokens * ${p.output} * ${om}) / ${GPT_PRICING.unitTokens}.0 ELSE NULL END`;
    }).join("\n")}
    ELSE NULL END
  ELSE NULL END)`;
