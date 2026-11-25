import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fixture from "./fixtures/model-watch-prices.json";
import { GATEWAY_PRESETS, GATEWAY_SITES } from "./config.ts";
import { MODEL_WATCH_CACHE, ModelWatchPrices, RATE_ENV, matchRows, modelKey, priceFromRows, type WatchPayload, type WatchRow } from "./model-watch.ts";
import { costOf, MODELS_DEV_CACHE, PriceBook, PRICES_FILE } from "./prices.ts";

// Rows copied from a Model Watch database on 2026-11-25 (its /api/prices answer), never the live one.
const PAYLOAD = fixture as unknown as WatchPayload;
const rows = (source: string) => PAYLOAD.prices.filter((r) => r.source === source) as WatchRow[];
const priced = (source: string, model: string) => {
  const m = matchRows(rows(source), model);
  return m.length ? { id: m[0]!.id, ...priceFromRows(m) } : undefined;
};

const ark = { name: "ark", preset: "ark", ...GATEWAY_PRESETS.ark! };
const minimaxCn = { name: "mm", preset: "minimax", messages: "https://api.minimax.cn/anthropic", auth: "bearer" as const };
const minimaxOldCn = { name: "mm2", preset: "minimax", ...GATEWAY_SITES.minimax!.cn };
const minimaxIntl = { name: "mmi", preset: "minimax", ...GATEWAY_PRESETS.minimax! };
const zhipu = { name: "zp", preset: "zhipu", ...GATEWAY_PRESETS.zhipu! };
const zai = { name: "za", preset: "zai", ...GATEWAY_PRESETS.zai! };
const kimiCn = { name: "ki", preset: "kimi", ...GATEWAY_SITES.kimi!.cn };
const kimiIntl = { name: "kii", preset: "kimi", ...GATEWAY_PRESETS.kimi! };
const arkCoding = { name: "ac", preset: "ark-coding", ...GATEWAY_PRESETS["ark-coding"]! };
const arkPlan = { name: "ap", preset: "ark-plan", ...GATEWAY_PRESETS["ark-plan"]! };

test("ids: an API id matches its page name with the date dropped; 正式版 is -ga; two models never share a price", () => {
  expect(modelKey("doubao-seedream-5-5-261028")).toBe(modelKey("doubao-seedream-5-5"));
  expect(modelKey("deepseek-v4-pro-ga-260813")).toBe(modelKey("deepseek-v4-pro-正式版"));
  expect(priced("ark", "doubao-seedream-5-5-261028")?.id).toBe("doubao-seedream-5-5");
  expect(priced("ark", "doubao-seed-2-1-pro-260915")?.id).toBe("doubao-seed-2.1-pro");
  expect(priced("ark", "kimi-k3-1-pro-261024")?.id).toBe("kimi-k3.1-pro");
  // The economy and the pro flash are other models than deepseek-v4-1-flash.
  expect(priced("ark", "deepseek-v4-1-flash-261017")?.id).toBe("deepseek-v4-1-flash");
  expect(priced("ark", "deepseek-v4-pro-260813")).toBeUndefined();
  expect(priced("minimax", "MiniMax-M3")?.id).toBe("minimax-m3");
  expect(priced("minimax", "MiniMax-M3.1-Flash")?.id).toBe("minimax-m3.1-flash");
  // By its name when its id is the page's own: DeepSeek-V4.1-Flash-1017.
  expect(priced("deepseek", "deepseek-v4.1-flash")?.id).toBe("deepseek-flash");
  expect(priced("deepseek", "deepseek-chat")).toBeUndefined();
  // Two page models normalising alike: neither.
  const twins = [{ ...rows("kimi")[0]!, id: "x-1", name: "X 1" }, { ...rows("kimi")[0]!, id: "x1", name: "X1" }];
  expect(matchRows(twins, "X-1")).toHaveLength(1);
  expect(matchRows(twins, "x_1")).toEqual([]);
});

test("variants: the base condition, input-length bands as tiers, the smallest picture size; anything else prices nothing", () => {
  // MiniMax-M3: ≤ 512k at the base, > 512k a tier.
  expect(priced("minimax", "MiniMax-M3")).toMatchObject({ currency: "CNY", price: { input: 2.1, output: 8.4, cacheRead: 0.42, tiers: [{ over: 512_000, input: 4.2, output: 16.8, cacheRead: 0.84 }] } });
  // doubao-seed-2.0-lite: the 非音频 rows of its three bands.
  expect(priced("ark", "doubao-seed-2-0-lite-260215")).toMatchObject({ price: { input: 0.6, output: 3.6, cacheRead: 0.12, tiers: [{ over: 32_000, input: 0.9 }, { over: 128_000, input: 1.8 }] } });
  // [0, 32K) then ≥32K: the tier from 32000 tokens on.
  expect(priced("glm", "glm-5.1")).toMatchObject({ price: { input: 6, tiers: [{ over: 31_999, input: 8 }] } });
  // DeepSeek's peak price, the higher of the two.
  expect(priced("ark", "deepseek-v4-1-flash-261017")).toMatchObject({ price: { input: 2, output: 8, cacheRead: 0.04 } });
  // Seedream: the smallest size band, the output side of a picture row.
  expect(priced("ark", "doubao-seedream-5-5-261028")).toMatchObject({ price: { perImage: 0.13 } });
  expect(priced("ark", "doubao-seedream-5-0-pro-260628")).toMatchObject({ price: { perImage: 0.3 } });
  // 文本输入 with a discount clause past a size.
  expect(priced("minimax", "MiniMax-H3-Image")).toMatchObject({ price: { input: 15, output: 25 } });
  // An embedding: input only.
  expect(priced("ark", "doubao-embedding-vision")).toMatchObject({ price: { input: 0.7, output: 0 } });
  // Output-length bands, video resolutions, per-second video: not priced.
  expect(priced("glm", "glm-4.7")).toMatchObject({ reason: expect.stringContaining("not one this reads") });
  expect(priced("ark", "seedance-2.5")).toMatchObject({ reason: expect.any(String) });
  expect(priced("minimax", "MiniMax-Hailuo-2.3")).toMatchObject({ reason: "priced per video" });
  const perSecond = rows("minimax").find((r) => r.unit === "second")!;
  expect(priceFromRows([perSecond])).toEqual({ reason: "priced per second" });
});

test("units: 10K characters per million, an hour per minute, a picture per picture", () => {
  expect(priced("minimax", "speech-2.8-hd")).toMatchObject({ price: { perMillionChars: 350 } });
  expect(priced("minimax", "speech-2.8-turbo")).toMatchObject({ price: { perMillionChars: 200 } });
  expect((priced("minimax", "speech-to-text") as { price: { perMinute: number } }).price.perMinute).toBeCloseTo(2.5 / 60, 8);
  expect(priced("minimax", "image-01")).toMatchObject({ price: { perImage: 0.025 } });
});

const watch = async (env: Record<string, string> = {}, payload: unknown = PAYLOAD) => {
  const home = await mkdtemp(join(tmpdir(), "mw-"));
  const w = new ModelWatchPrices({ home, env, log: () => {} });
  w.start(async () => ({ from: "mac", res: Response.json({ ok: true, ...(payload as object) }) }));
  await w.refresh();
  return { home, w };
};

test("sites: China pages price the China bases only, Ark's pay-as-you-go page the pay-as-you-go base only", async () => {
  const { w } = await watch({ [RATE_ENV]: "0.14" });
  expect(w.lookup(minimaxCn, "MiniMax-M3")?.source).toBe("Model Watch minimax");
  expect(w.lookup(minimaxOldCn, "MiniMax-M3")?.source).toBe("Model Watch minimax");
  expect(w.lookup(minimaxIntl, "MiniMax-M3")).toBeUndefined();
  expect(w.lookup(zhipu, "glm-5.1")?.source).toBe("Model Watch glm");
  expect(w.lookup(zai, "glm-5.1")).toBeUndefined();
  expect(w.lookup(kimiCn, "kimi-k3")?.source).toBe("Model Watch kimi");
  expect(w.lookup(kimiIntl, "kimi-k3")).toBeUndefined();
  expect(w.lookup(ark, "doubao-seedream-5-5-261028")?.source).toBe("Model Watch ark");
  expect(w.lookup({ openai: "https://ark.cn-beijing.volces.com/api/v3" }, "doubao-seedream-5-5-261028")?.source).toBe("Model Watch ark");
  expect(w.lookup(arkCoding, "doubao-seed-2.1-pro")).toBeUndefined();
  expect(w.lookup(arkPlan, "doubao-seed-2.1-pro")).toBeUndefined();
  // OpenAI's page is left to models.dev.
  expect(w.lookup({ ...GATEWAY_PRESETS.openai! }, "gpt-5")).toBeUndefined();
});

test("currency: CNY at the owner's rate; with no rate shown but not used; a bad rate is said", async () => {
  const { w } = await watch({ [RATE_ENV]: "0.14" });
  const got = w.lookup(ark, "doubao-seedream-5-5-261028")!;
  expect(got).toMatchObject({ currency: "CNY", printed: { perImage: 0.13 }, checkedAt: expect.any(String) });
  expect(got.price.perImage).toBeCloseTo(0.0182, 9);
  expect(got.needsRate).toBeUndefined();
  expect(w.status()).toMatchObject({ rate: { usdPerCny: 0.14, from: RATE_ENV }, needsRate: false, from: "mac" });
  const none = (await watch()).w;
  expect(none.lookup(ark, "doubao-seedream-5-5-261028")).toMatchObject({ price: { perImage: 0.13 }, needsRate: true });
  expect(none.status().needsRate).toBe(true);
  const bad = (await watch({ [RATE_ENV]: "seven" })).w;
  expect(bad.status()).toMatchObject({ needsRate: true, rateError: expect.stringContaining(RATE_ENV) });
  // The skipped units of each page, by count.
  expect(none.status().sources.find((s) => s.id === "minimax")!.skipped).toMatchObject({ second: expect.any(Number), video: expect.any(Number), voice: expect.any(Number) });
});

test("the copy: kept in the workspace, read after a restart, kept when the machine is unreachable", async () => {
  const { home } = await watch({ [RATE_ENV]: "0.14" });
  expect(await Bun.file(join(home, MODEL_WATCH_CACHE)).exists()).toBe(true);
  const after = new ModelWatchPrices({ home, env: { [RATE_ENV]: "0.14" }, log: () => {} });
  await after.load();
  after.start(async () => {
    throw new Error("peer mac is down");
  });
  await after.refresh();
  expect(after.lookup(minimaxCn, "MiniMax-M3")?.price.input).toBeCloseTo(0.294, 9);
  expect(after.status()).toMatchObject({ error: "peer mac is down", fetchedAt: expect.any(String) });
});

test("the price book: the owner's file, then Model Watch, then models.dev; a CNY price without a rate costs nothing", async () => {
  const run = async (env: Record<string, string>) => {
    const { home, w } = await watch(env);
    await writeFile(join(home, PRICES_FILE), "ark/doubao-seed-2-1-pro-260915: [1, 2]\n");
    await Bun.write(join(home, MODELS_DEV_CACHE), JSON.stringify({ fetchedAt: new Date().toISOString(), providers: { "minimax-cn": { models: { "MiniMax-M3": { input: 0.3, output: 1.2 }, "MiniMax-M2": { input: 0.2, output: 0.8 } } } } }));
    const book = new PriceBook({ home, fetch: (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch, log: () => {}, modelWatch: w });
    await book.load();
    return book;
  };
  const book = await run({ [RATE_ENV]: "0.14" });
  expect(book.lookupSync(ark, "doubao-seed-2-1-pro-260915")).toEqual({ price: { input: 1, output: 2 }, source: "price file" });
  const m3 = book.lookupSync(minimaxOldCn, "MiniMax-M3")!;
  expect(m3.source).toBe("Model Watch minimax");
  // Under the 512K band: the base price; past it, the band's.
  expect(costOf(m3.price, { m: "mm2/MiniMax-M3", i: 100_000, o: 100_000 })).toBeCloseTo(((2.1 + 8.4) * 0.14) / 10, 9);
  expect(costOf(m3.price, { m: "mm2/MiniMax-M3", i: 1_000_000, o: 1_000_000 })).toBeCloseTo((4.2 + 16.8) * 0.14, 9);
  expect(book.lookupSync(minimaxOldCn, "MiniMax-M2")?.source).toBe("models.dev minimax-cn");
  expect(book.status().modelWatch?.rate?.usdPerCny).toBe(0.14);
  const noRate = await run({});
  expect(noRate.lookupSync(minimaxOldCn, "MiniMax-M3")).toBeUndefined();
  expect(noRate.describe(minimaxOldCn, "MiniMax-M3")).toMatchObject({ needsRate: true, source: "Model Watch minimax" });
});
