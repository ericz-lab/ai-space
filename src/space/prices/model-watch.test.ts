import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fixture from "./fixtures/model-watch-prices.json";
import { GATEWAY_PRESETS, GATEWAY_SITES } from "../gateway/config.ts";
import { ModelWatchPrices, RATE_ENV, matchRows, modelKey, priceFromRows, type WatchFile, type WatchPayload, type WatchRow } from "./model-watch.ts";
import bundled from "./tables/model-watch.json";
import { diffPrices, formatPrices, readModelWatch } from "../../../scripts/sync-model-watch-prices.ts";
import { costOf, MODELS_DEV_CACHE, PriceBook, PRICES_FILE } from "./index.ts";

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

const FILE: WatchFile = { syncedAt: "2026-11-25T01:28:33.815Z", from: "fixture", sources: PAYLOAD.sources, prices: PAYLOAD.prices };
const watch = async (env: Record<string, string> = {}, data: WatchFile = FILE) => {
  const home = await mkdtemp(join(tmpdir(), "mw-"));
  return { home, w: new ModelWatchPrices({ env, data }) };
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
  expect(w.status()).toMatchObject({ rate: { usdPerCny: 0.14, from: RATE_ENV }, needsRate: false, syncedAt: FILE.syncedAt });
  const none = (await watch()).w;
  expect(none.lookup(ark, "doubao-seedream-5-5-261028")).toMatchObject({ price: { perImage: 0.13 }, needsRate: true });
  expect(none.status().needsRate).toBe(true);
  const bad = (await watch({ [RATE_ENV]: "seven" })).w;
  expect(bad.status()).toMatchObject({ needsRate: true, rateError: expect.stringContaining(RATE_ENV) });
  // The skipped units of each page, by count.
  expect(none.status().sources.find((s) => s.id === "minimax")!.skipped).toMatchObject({ second: expect.any(Number), video: expect.any(Number), voice: expect.any(Number) });
});

test("the file shipped with ai-space: read with no workspace copy and no app, and its rows are Model Watch's", () => {
  const f = bundled as unknown as WatchFile;
  expect(f.syncedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(f.sources.length).toBeGreaterThan(0);
  expect(f.prices.length).toBeGreaterThan(0);
  const w = new ModelWatchPrices({ env: { [RATE_ENV]: "0.14" } });
  expect(w.status()).toMatchObject({ syncedAt: f.syncedAt, needsRate: false });
  // An unreadable file prices nothing and says there are no prices.
  const empty = new ModelWatchPrices({ env: {}, data: {} as WatchFile });
  expect(empty.status()).toMatchObject({ needsRate: false, sources: [] });
  expect(empty.lookup(minimaxCn, "MiniMax-M3")).toBeUndefined();
});

test("the sync script: Model Watch's database read only, rows in a stable order, a diff by row", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mw-db-"));
  const path = join(dir, "main.db");
  const db = new Database(path);
  db.exec(`CREATE TABLE sources (id TEXT PRIMARY KEY, name TEXT, pricing_url TEXT, pricing_checked_at TEXT, pricing_error TEXT, enabled INTEGER, added_at TEXT);
    CREATE TABLE prices (source_id TEXT, price_key TEXT, model_id TEXT, name TEXT, variant TEXT DEFAULT '', pos INTEGER, currency TEXT, unit TEXT, input REAL, cached_input REAL, output REAL, text TEXT, present INTEGER, first_seen_at TEXT, updated_at TEXT);`);
  db.exec(`INSERT INTO sources VALUES ('mm', 'MiniMax', 'https://platform.minimax.cn/docs/guides/pricing', '2026-11-25T01:00:00Z', NULL, 1, '1'),
    ('off', 'Off', 'https://example.com/p', NULL, NULL, 0, '2'), ('nopage', 'No page', NULL, NULL, NULL, 1, '3');
    INSERT INTO prices VALUES ('mm', 'b', 'minimax-m3', 'MiniMax-M3', '', 1, 'CNY', '1M tokens', 2.1, 0.42, 8.4, '¥2.1', 1, 'x', 'x'),
    ('mm', 'a', 'speech-2.8-hd', 'speech-2.8-hd', '', 0, 'CNY', '10K characters', NULL, NULL, 3.5, '¥3.5', 1, 'x', 'x'),
    ('mm', 'c', 'gone', 'Gone', '', 2, 'CNY', '1M tokens', 1, NULL, 1, '', 0, 'x', 'x'),
    ('off', 'a', 'x', 'X', '', 0, 'USD', '1M tokens', 1, NULL, 1, '', 1, 'x', 'x');`);
  db.close();
  const f = readModelWatch(path, new Date("2026-11-25T02:00:00Z"));
  expect(f.sources.map((s) => [s.id, s.site, s.currencies])).toEqual([["mm", "platform.minimax.cn", ["CNY"]]]);
  // Present rows of enabled pages only, by key, whatever order the page printed them in.
  expect(f.prices.map((r) => r.id)).toEqual(["speech-2.8-hd", "minimax-m3"]);
  expect(f.prices[1]).toMatchObject({ source: "mm", currency: "CNY", unit: "1M tokens", input: 2.1, cachedInput: 0.42, output: 8.4 });
  // The written file reads back the same, one row per line.
  const text = formatPrices(f);
  expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(f)));
  expect(text.split("\n").filter((l) => l.includes('"source":"mm"'))).toHaveLength(2);
  // The ai-space side reads it: priced from the file at the rate.
  const w = new ModelWatchPrices({ env: { [RATE_ENV]: "0.14" }, data: f });
  expect(w.lookup(minimaxCn, "MiniMax-M3")?.price.input).toBeCloseTo(0.294, 9);
  const next = { ...f, prices: [{ ...f.prices[0]!, output: 3 }, { ...f.prices[1]!, id: "minimax-m3.5", name: "MiniMax-M3.5" }] };
  expect(diffPrices(f, next)).toEqual({ added: ["mm/minimax-m3.5 (1M tokens)"], removed: ["mm/minimax-m3 (1M tokens)"], changed: ["mm/speech-2.8-hd (10K characters)"] });
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
  // Without a rate a USD price from models.dev is still used; a model only Model Watch prices waits for the rate.
  expect(noRate.lookupSync(minimaxOldCn, "MiniMax-M3")).toMatchObject({ source: "models.dev minimax-cn", price: { input: 0.3 } });
  expect(noRate.lookupSync(minimaxOldCn, "MiniMax-M3.1-Flash")).toBeUndefined();
  expect(noRate.describe(minimaxOldCn, "MiniMax-M3.1-Flash")).toMatchObject({ needsRate: true, source: "Model Watch minimax" });
});
