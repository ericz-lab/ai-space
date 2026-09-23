/** Standard API-equivalent USD per million tokens, verified 2026-09-23.
 * Sources: https://developers.openai.com/api/docs/pricing and /models/<model>.
 * Exact model ids only. These estimates exclude tools, regional and service-tier
 * adjustments, which the ledger does not record. They are not subscription bills.
 */
const GPT_PRICES: Record<string, readonly [number, number, number, number]> = {
  // input, cache write, cache read, output
  "gpt-6-astra": [10, 12.5, 1, 50],
  "gpt-6-sol": [2, 2.5, 0.2, 10],
  "gpt-6-luna": [0.1, 0.125, 0.01, 0.5],
  "gpt-5.6-sol": [4, 5, 0.4, 20],
  "gpt-5.6-terra": [2, 2.5, 0.2, 12],
  "gpt-5.6-luna": [0.2, 0.25, 0.02, 1.2],
};

const input = "(input_tokens + COALESCE(cache_write_tokens, 0) + COALESCE(cache_read_tokens, 0))";

/** A per-row expression shared by individual calls and all aggregate queries.
 * Read-time fallback also covers historical rows without rewriting reported costs.
 * Incomplete usage and unknown models stay NULL; an explicitly reported zero wins.
 */
export const MODEL_COST_SQL = `COALESCE(cost_usd, CASE
  WHEN input_tokens >= 0 AND output_tokens >= 0
    AND COALESCE(cache_write_tokens, 0) >= 0 AND COALESCE(cache_read_tokens, 0) >= 0
  THEN CASE model
    ${Object.entries(GPT_PRICES).map(([model, [i, w, r, o]]) => `WHEN '${model}' THEN
      ((input_tokens * ${i} + COALESCE(cache_write_tokens, 0) * ${w} + COALESCE(cache_read_tokens, 0) * ${r})
        * CASE WHEN ${input} > 272000 THEN 2 ELSE 1 END
        + output_tokens * ${o} * CASE WHEN ${input} > 272000 THEN 1.5 ELSE 1 END) / 1000000.0`).join("\n")}
    ELSE NULL END
  ELSE NULL END)`;
