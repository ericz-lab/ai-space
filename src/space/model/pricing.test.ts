import { expect, test } from "bun:test";
import type { PriceCatalog } from "../gateway/prices.ts";
import { GPT_FILE, mergeGptPricing, rateFromModelsDev } from "./pricing.ts";

const dev = (openai: PriceCatalog["providers"][string]["models"], anthropic: PriceCatalog["providers"][string]["models"] = {}): PriceCatalog => ({
  fetchedAt: "2026-11-24T12:00:00.000Z",
  providers: { openai: { models: openai }, ...(Object.keys(anthropic).length ? { anthropic: { models: anthropic } } : {}) },
});

test("models.dev's long-context tier becomes the table's multipliers", () => {
  // gpt-6.2-astra as models.dev listed it on 2026-11-17, a week before it was added by hand.
  expect(rateFromModelsDev({ input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10, tiers: [{ over: 272000, input: 16, output: 60, cacheRead: 0.8, cacheWrite: 20 }] }))
    .toEqual({ input: 8, cacheWrite: 10, cacheRead: 0.4, output: 40, longContext: { threshold: 272000, inputMultiplier: 2, outputMultiplier: 1.5 } });
  expect(GPT_FILE.models["gpt-6.2-astra"]).toMatchObject({ input: 8, cacheWrite: 10, cacheRead: 0.4, output: 40, longContext: { threshold: 272000, inputMultiplier: 2, outputMultiplier: 1.5 } });
});

test("a price that does not fit the table is left out rather than guessed", () => {
  // Cache reads move by another multiplier than input: one input multiplier cannot say it.
  expect(rateFromModelsDev({ input: 1, output: 4, cacheRead: 0.1, tiers: [{ over: 200000, input: 2, output: 6, cacheRead: 0.5 }] })).toBeUndefined();
  expect(rateFromModelsDev({ input: 1, output: 4, tiers: [{ over: 1, input: 2, output: 6 }, { over: 2, input: 3, output: 8 }] })).toBeUndefined();
  expect(rateFromModelsDev({ perImage: 0.04 })).toBeUndefined();
  expect(rateFromModelsDev({ input: 0, output: 0 })).toBeUndefined();
  // No cache write price: null, so a call that wrote to the cache stays unpriced.
  expect(rateFromModelsDev({ input: 1, output: 4 })).toEqual({ input: 1, cacheWrite: null, cacheRead: 1, output: 4, longContext: null });
});

test("gpt-prices.json wins; only GPT ids it lacks are filled, without a Fast price", () => {
  const m = mergeGptPricing(dev({
    "gpt-6-luna": { input: 99, output: 99 },
    "gpt-9-nova": { input: 3, output: 12, cacheRead: 0.3, cacheWrite: 3.75 },
    "o9-mini": { input: 1, output: 2 },
    "gpt-x'; DROP TABLE model_calls; --": { input: 1, output: 2 },
  }));
  expect(m.models["gpt-6-luna"]).toEqual(GPT_FILE.models["gpt-6-luna"]!);
  expect(m.models["gpt-9-nova"]).toEqual({ input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 12, longContext: null, fastMultiplier: null });
  expect(m.filled).toEqual({ "gpt-9-nova": "models.dev 2026-11-24" });
  expect(Object.keys(m.models).filter((k) => !/^gpt-[a-z0-9.-]+$/.test(k))).toEqual([]);
  expect(m).toMatchObject({ version: 1, asOf: GPT_FILE.asOf, currency: "USD", unitTokens: 1_000_000 });
});

test("without the catalogue the table is the file, with no Anthropic section", () => {
  const m = mergeGptPricing(undefined);
  expect(m.models).toEqual(GPT_FILE.models);
  expect(m.filled).toEqual({});
  expect(m.anthropic).toBeUndefined();
});

test("Anthropic's list prices are served beside the GPT table", () => {
  const m = mergeGptPricing(dev({}, {
    "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
    "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, tiers: [{ over: 100000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }] },
    "not a claude id": { input: 1, output: 1 },
  }));
  expect(m.anthropic).toEqual({
    source: "https://models.dev", fetchedAt: "2026-11-24T12:00:00.000Z", unitTokens: 1_000_000,
    models: {
      "claude-opus-5-5": { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20, longContext: null },
      "claude-haiku-5-5": { input: 0.1, cacheWrite: 0.125, cacheRead: 0.01, output: 0.5, longContext: { threshold: 100000, inputMultiplier: 5, outputMultiplier: 5 } },
    },
  });
});
