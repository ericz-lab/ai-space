import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { basisCost, costOf, MODELS_DEV_CACHE, parsePricesYaml, PriceBook, PRICES_FILE, priceFromModelsDev, pricedAnswer, repriceBasis, trimModelsDev } from "./prices.ts";

const usage = (inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0) => pricedAnswer("p/m", { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens });

// The shape of models.dev's api.json, cut down.
const MODELS_DEV = {
  minimax: { api: "https://api.minimax.io/anthropic/v1", models: { "MiniMax-M3": { cost: { input: 0.3, output: 1.2, cache_read: 0.06, tiers: [{ input: 0.6, output: 2.4, cache_read: 0.12, tier: { type: "context", size: 512000 } }] } } } },
  "minimax-cn": { api: "https://api.minimax.cn/anthropic/v1", models: { "MiniMax-M3": { cost: { input: 0.3137, output: 1.2549, cache_read: 0.0627 } } } },
  relayco: { api: "https://relay.example/v1", models: { "glm-5.4": { cost: { input: 1, output: 3 } } } },
  free: { models: { nothing: { name: "no cost listed" } } },
};

test("models.dev costs: the four prices and long-context tiers; models without a cost are left out", () => {
  expect(priceFromModelsDev({ input: 1, output: 2, cache_read: 0.1, cache_write: 1.25 })).toEqual({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 });
  expect(priceFromModelsDev({ input: 1 })).toBeUndefined();
  const trimmed = trimModelsDev(MODELS_DEV, new Date("2026-11-24T00:00:00Z"));
  expect(trimmed.providers.minimax!.models["MiniMax-M3"]!.tiers).toEqual([{ over: 512000, input: 0.6, output: 2.4, cacheRead: 0.12 }]);
  expect(trimmed.providers.free).toBeUndefined();
});

test("cost: tokens at their prices, a missing cache price is the input's, and a long prompt is priced whole at its tier", () => {
  const p = { input: 2, output: 8, cacheRead: 0.5, tiers: [{ over: 1000, input: 4, output: 12 }] };
  expect(costOf(p, usage(100, 10, 20, 30))).toBeCloseTo((100 * 2 + 10 * 8 + 20 * 0.5 + 30 * 2) / 1e6, 12);
  // 900 + 101 prompt tokens is over 1000: every part at the tier, cache reads at the base cache price.
  expect(costOf(p, usage(900, 10, 101))).toBeCloseTo((900 * 4 + 10 * 12 + 101 * 0.5) / 1e6, 12);
});

test("pictures, minutes and characters: a unit price takes over from tokens; tokens priced without one; nothing to price is no cost", () => {
  expect(pricedAnswer("ark/seedream", undefined, { images: 2 })).toEqual({ m: "ark/seedream", img: 2 });
  expect(pricedAnswer("x/y", { inputTokens: 5, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toEqual({ m: "x/y", i: 5 });
  expect(costOf({ perImage: 0.03 }, { m: "a/b", img: 2 })).toBeCloseTo(0.06, 12);
  // gpt-image reports tokens: priced at the token prices when no per-picture price is set.
  expect(costOf({ input: 5, output: 40 }, { m: "a/b", i: 100, o: 4000, img: 1 })).toBeCloseTo((100 * 5 + 4000 * 40) / 1e6, 12);
  expect(costOf({ input: 5, output: 40 }, { m: "a/b", img: 1 })).toBeUndefined();
  expect(costOf({ perMinute: 0.006 }, { m: "a/b", sec: 90, i: 40 })).toBeCloseTo(0.009, 12);
  expect(costOf({ perMillionChars: 15 }, { m: "a/b", ch: 2000 })).toBeCloseTo(0.03, 12);
  expect(costOf({ perImage: 0.03 }, { m: "a/b", i: 10, o: 10 })).toBeUndefined();
});

test("a call's answers: summed, unpriced when any is, kept as they are when a provider is gone", () => {
  const basis = [{ m: "a/x", i: 1_000_000 }, { m: "b/y", img: 1 }];
  const prices: Record<string, { input?: number; output?: number; perImage?: number } | undefined | null> = { "a/x": { input: 1, output: 2 }, "b/y": { perImage: 0.5 } };
  expect(basisCost(basis, (m) => prices[m] ?? undefined)).toBeCloseTo(1.5, 12);
  expect(repriceBasis(basis, (m) => prices[m])).toEqual({ costUsd: 1.5 });
  prices["b/y"] = undefined;
  expect(repriceBasis(basis, (m) => prices[m])).toEqual({});
  prices["b/y"] = null;
  expect(repriceBasis(basis, (m) => prices[m])).toBe("keep");
  expect(repriceBasis([], () => ({ input: 1, output: 1 }))).toBe("keep");
});

test("the price file: unit prices as a mapping; unknown keys, input without output, an empty mapping refused", () => {
  expect(parsePricesYaml("ark/seedream-5: { perImage: 0.03 }\nopenai/whisper-1: { perMinute: 0.006 }\nopenai/gpt-image-2: { input: 5, output: 40 }\n")).toEqual({
    "ark/seedream-5": { perImage: 0.03 },
    "openai/whisper-1": { perMinute: 0.006 },
    "openai/gpt-image-2": { input: 5, output: 40 },
  });
  expect(() => parsePricesYaml("a/b: { perPicture: 1 }")).toThrow("unknown key perPicture");
  expect(() => parsePricesYaml("a/b: { input: 1 }")).toThrow("input and output go together");
  expect(() => parsePricesYaml("a/b: {}")).toThrow("no price in it");
  expect(() => parsePricesYaml("a/b: { perImage: -1 }")).toThrow("0 or more");
});

test("a change of price is told: an edited file, a catalogue that came back different; not an unchanged one", async () => {
  const home = await mkdtemp(join(tmpdir(), "prices-"));
  let catalog: unknown = MODELS_DEV;
  const book = new PriceBook({ home, fetch: (async () => Response.json(catalog)) as unknown as typeof fetch, log: () => {} });
  await Bun.write(join(home, PRICES_FILE), "a/b: [1, 2]\n");
  await book.load();
  await book.refresh();
  let told = 0;
  book.onChange(() => told++);
  await book.refresh();
  expect(told).toBe(0);
  catalog = { ...MODELS_DEV, relayco: { api: "https://relay.example/v1", models: { "glm-5.4": { cost: { input: 2, output: 3 } } } } };
  await book.refresh();
  expect(told).toBe(1);
  await Bun.sleep(5);
  await Bun.write(join(home, PRICES_FILE), "a/b: [1, 2]\n");
  await book.reload();
  expect(told).toBe(1);
  await Bun.sleep(5);
  await Bun.write(join(home, PRICES_FILE), "a/b: [1, 3]\nopenai/whisper-1: { perMinute: 0.006 }\n");
  await book.reload();
  expect(told).toBe(2);
  expect(book.fileModels("openai")).toEqual(["whisper-1"]);
});

test("the price file: provider/model or provider/*, two or four numbers; anything else is refused", () => {
  expect(parsePricesYaml("ds/deepseek-v4-pro: [1.32, 3.96, 0.044, 1.32]\nrelay/*: [0.5, 1]\n")).toEqual({
    "ds/deepseek-v4-pro": { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 1.32 },
    "relay/*": { input: 0.5, output: 1 },
  });
  expect(parsePricesYaml("")).toEqual({});
  expect(() => parsePricesYaml("deepseek-v4-pro: [1, 2]")).toThrow("provider/model");
  expect(() => parsePricesYaml("ds/x: [1]")).toThrow("[input, output]");
  expect(() => parsePricesYaml("ds/x: [1, -2]")).toThrow("each 0 or more");
});

test("lookup order: the file's model, the file's provider/*, then models.dev for the provider's site or base host", async () => {
  const home = await mkdtemp(join(tmpdir(), "prices-"));
  await Bun.write(join(home, MODELS_DEV_CACHE), JSON.stringify(trimModelsDev(MODELS_DEV, new Date())));
  await Bun.write(join(home, PRICES_FILE), "mm/special: [9, 9]\nrelay/*: [0.1, 0.2]\n");
  let fetched = 0;
  const book = new PriceBook({ home, fetch: (async () => (fetched++, new Response("{}"))) as unknown as typeof fetch, log: () => {} });
  await book.load();
  expect(fetched).toBe(0); // the cache is fresh
  const intl = { name: "mm", preset: "minimax", messages: "https://api.minimax.io/anthropic" };
  const cn = { name: "mmcn", preset: "minimax", messages: "https://api.minimaxi.com/anthropic" };
  expect(await book.lookup(intl, "MiniMax-M3")).toMatchObject({ source: "models.dev minimax", price: { input: 0.3 } });
  expect(await book.lookup(cn, "minimax-m3")).toMatchObject({ source: "models.dev minimax-cn", price: { input: 0.3137 } });
  expect(await book.lookup(intl, "special")).toEqual({ source: "price file", price: { input: 9, output: 9 } });
  expect(await book.lookup(intl, "MiniMax-M9")).toBeUndefined();
  expect(await book.lookup({ name: "relay", messages: "https://relay.example/anthropic" }, "anything")).toMatchObject({ source: "price file (provider/*)" });
  // A custom provider at a host models.dev lists: priced from that provider.
  expect(await book.lookup({ name: "r2", messages: "https://relay.example/anthropic" }, "glm-5.4")).toMatchObject({ source: "models.dev relayco" });
  // A changed file is read again; a broken one keeps the last good prices and says why.
  await Bun.sleep(5);
  await Bun.write(join(home, PRICES_FILE), "mm/special: [1, 1]\n");
  expect((await book.lookup(intl, "special"))?.price.input).toBe(1);
  await Bun.sleep(5);
  await Bun.write(join(home, PRICES_FILE), "mm/special: oops\n");
  expect((await book.lookup(intl, "special"))?.price.input).toBe(1);
  expect(book.status().fileError).toContain(PRICES_FILE);
});

test("refresh: models.dev fetched and cached when the cache is missing; a failure keeps what there was", async () => {
  const home = await mkdtemp(join(tmpdir(), "prices-"));
  let answer: Response = Response.json(MODELS_DEV);
  const book = new PriceBook({ home, fetch: (async () => answer) as unknown as typeof fetch, log: () => {} });
  await book.load();
  await book.refresh();
  expect(book.status().catalogFetchedAt).toBeDefined();
  expect(Object.keys((await Bun.file(join(home, MODELS_DEV_CACHE)).json()).providers)).toContain("minimax-cn");
  answer = new Response("down", { status: 503 });
  await book.refresh();
  expect(await book.lookup({ name: "d", preset: "minimax", messages: "https://api.minimax.io/anthropic" }, "MiniMax-M3")).toMatchObject({ source: "models.dev minimax" });
});
