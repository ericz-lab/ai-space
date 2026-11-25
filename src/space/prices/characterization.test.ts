import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Today's surfaces; the refactor changes these imports, never the figures below.
import { apiCost } from "../runtimes/anthropic-api.ts";
import { dshCost } from "../runtimes/deepseek-harness.ts";
import { OpenAiAdapter } from "../speech/openai.ts";
import { MinimaxAdapter } from "../speech/minimax.ts";
import { ModelStore } from "../model/store.ts";
import { GATEWAY_PRESETS } from "../gateway/config.ts";
import { activePrices, gptPricing, ModelWatchPrices, costOf, MODELS_DEV_CACHE, PriceBook, PRICES_FILE, pricedAnswer, trimModelsDev } from "./index.ts";
import type { WatchFile } from "./model-watch.ts";
import watchFixture from "./fixtures/model-watch-prices.json";

/**
 * Characterization: what a spread of real calls costs, pinned before the price module was unified
 * (docs/prices.md). A figure that unification changed on purpose is pinned at its new value with the
 * old one named beside it.
 */

const M = 1_000_000;
const usage = (inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0) => ({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens });
const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });
const home = async () => { const d = await mkdtemp(join(tmpdir(), "space-prices-char-")); dirs.push(d); return d; };

// models.dev's api.json, cut down to what these cases read (values as listed on 2026-11-24).
const MODELS_DEV = {
  openai: { api: "https://api.openai.com/v1", models: { "gpt-9-nova": { cost: { input: 3, output: 12, cache_read: 0.3 } } } },
  anthropic: { api: "https://api.anthropic.com/v1", models: { "claude-opus-5-5": { cost: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 } }, "claude-opus-5": { cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 } } } },
  deepseek: { api: "https://api.deepseek.com", models: { "deepseek-flash": { cost: { input: 0.15, output: 0.6, cache_read: 0.003 } } } },
  "minimax-cn": { api: "https://api.minimaxi.com/anthropic/v1", models: { "MiniMax-M3": { cost: { input: 0.3137, output: 1.2549, cache_read: 0.0627 } } } },
};

const book = async (env: Record<string, string | undefined> = {}, own = "") => {
  const h = await home();
  if (own) await writeFile(join(h, PRICES_FILE), own);
  await Bun.write(join(h, MODELS_DEV_CACHE), JSON.stringify(trimModelsDev(MODELS_DEV, new Date())));
  const b = new PriceBook({ home: h, modelWatch: new ModelWatchPrices({ env, data: watchFixture as unknown as WatchFile }), fetch: (async () => { throw new Error("offline"); }) as unknown as typeof fetch, log: () => {}, offline: true });
  await b.load();
  return b;
};
const gw = (b: PriceBook, p: { name: string; preset?: string; messages?: string; openai?: string }, model: string, a: ReturnType<typeof usage> | Record<string, number> = {}) => {
  const found = b.lookupSync(p, model);
  return found ? { source: found.source, usd: costOf(found.price, { ...("inputTokens" in a ? pricedAnswer("x", a as ReturnType<typeof usage>) : a), m: `${p.name}/${model}` }) } : undefined;
};

test("Codex ledger rows: GPT list prices, long context and cache reads, read-time estimate", async () => {
  const h = await home();
  const store = new ModelStore(join(h, "space.db"));
  const row = (model: string, u: ReturnType<typeof usage>) => store.add({ app: "a", tag: "t", model, backend: "local", origin: "run", status: "ok", startedAt: Date.now(), durationMs: 1, promptChars: 1, usage: u }).costUsd;
  // gpt-6-astra, 300K prompt: over 272K, input and cache at twice, output at 1.5 times.
  expect(row("gpt-6-astra", usage(250_000, 10_000, 50_000))).toBeCloseTo((250_000 * 10 + 50_000 * 1) * 2 / M + 10_000 * 50 * 1.5 / M, 9);
  // A cached Codex row under the threshold.
  expect(row("gpt-6.1-sol", usage(20_000, 2_000, 180_000))).toBeCloseTo((20_000 * 2 + 180_000 * 0.1 + 2_000 * 10) / M, 9);
  // A snapshot id takes its base model's price; cache writes on a model without a write price stay unpriced.
  expect(row("gpt-6-luna-2026-09-01", usage(1000, 1000))).toBeCloseTo((1000 * 0.1 + 1000 * 0.5) / M, 12);
  expect(row("gpt-5.3-codex", usage(1000, 1000, 0, 10))).toBeUndefined();
  expect(row("gpt-9-nova", usage(1000, 1000))).toBeUndefined();
  activePrices().useCatalog(trimModelsDev(MODELS_DEV, new Date("2026-11-24T00:00:00Z")));
  try {
    expect(row("gpt-9-nova", usage(1000, 1000, 1000))).toBeCloseTo((1000 * 3 + 1000 * 0.3 + 1000 * 12) / M, 12);
  } finally {
    activePrices().useCatalog(undefined);
    store.close();
  }
});

test("GET /api/model/pricing version 1: the GPT rates as released", () => {
  const p = gptPricing();
  expect({ version: p.version, currency: p.currency, unitTokens: p.unitTokens, source: p.source }).toEqual({ version: 1, currency: "USD", unitTokens: M, source: "https://developers.openai.com/api/docs/pricing" });
  expect(p.models["gpt-6-astra"]).toEqual({ input: 10, cacheWrite: 12.5, cacheRead: 1, output: 50, longContext: { threshold: 272000, inputMultiplier: 2, outputMultiplier: 1.5 }, fastMultiplier: 2 });
  expect(p.models["gpt-5.3-codex"]).toEqual({ input: 1.75, cacheWrite: null, cacheRead: 0.175, output: 14, longContext: null, fastMultiplier: 2 });
  expect(Object.keys(p.models).sort()).toEqual(["gpt-5.3-codex", "gpt-5.4", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-astra", "gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6.2-astra", "gpt-6.2-sol"]);
});

test("gateway calls: each of the four layers", async () => {
  const minimaxCn = { name: "mm", preset: "minimax", messages: "https://api.minimaxi.com/anthropic" };
  const b = await book({}, "relay/glm-5.4: [1, 3]\nrelay/*: [0.5, 2, 0.1]\nark/doubao-seedream-5-5: { perImage: 0.03 }\n");
  const relay = { name: "relay", messages: "https://relay.example/anthropic" };
  expect(gw(b, relay, "glm-5.4", usage(M, M))).toEqual({ source: "price file", usd: 4 });
  expect(gw(b, relay, "other", usage(M, M, M))).toEqual({ source: "price file (provider/*)", usd: 2.6 });
  // A picture at its per-picture price.
  expect(gw(b, { name: "ark", preset: "ark", ...GATEWAY_PRESETS.ark! }, "doubao-seedream-5-5", { img: 2 })).toEqual({ source: "price file", usd: 0.06 });
  // Model Watch's CNY page for MiniMax China: no rate, so models.dev's USD price is used.
  expect(gw(b, minimaxCn, "MiniMax-M3", usage(M, M))?.source).toBe("models.dev minimax-cn");
  expect(gw(b, minimaxCn, "MiniMax-M3", usage(M, M))?.usd).toBeCloseTo(0.3137 + 1.2549, 9);
  // models.dev for Anthropic's own host.
  expect(gw(b, { name: "anthropic", preset: "anthropic", ...GATEWAY_PRESETS.anthropic! }, "claude-opus-5-5", usage(M, M, M, M))).toEqual({ source: "models.dev anthropic", usd: 4 + 20 + 0.2 + 5 });
});

test("gateway calls: a CNY Model Watch price with the owner's rate", async () => {
  const minimaxCn = { name: "mm", preset: "minimax", messages: "https://api.minimaxi.com/anthropic" };
  const b = await book({ SPACE_GATEWAY_USD_PER_CNY: "0.14" });
  const got = gw(b, minimaxCn, "MiniMax-M3", usage(1000, 1000));
  expect(got?.source).toBe("Model Watch minimax");
  const printed = b.describe(minimaxCn, "MiniMax-M3")!.printed!;
  expect(got!.usd).toBeCloseTo((printed.input! + printed.output!) * 0.14 / 1000, 12);
  expect(got!.usd).toBeCloseTo(0.00147, 12);
});

test("speech: ASR minutes at OpenAI's list price, TTS characters at MiniMax's", () => {
  const openai = new OpenAiAdapter({ name: "openai", kind: "openai-compatible", url: "https://api.openai.com/v1", asrModel: "gpt-4o-mini-transcribe", ttsModel: "tts-1", selfHosted: false });
  expect(openai.cost("transcribe", { audioSeconds: 90 })).toBe(0.0045);
  expect(openai.cost("speak", { chars: 2000 })).toBe(0.03);
  // A self-hosted server under the same model names costs nothing known.
  expect(new OpenAiAdapter({ name: "local", kind: "openai-compatible", url: "http://127.0.0.1:9000/v1", asrModel: "whisper-1", ttsModel: "tts-1", selfHosted: true }).cost("transcribe", { audioSeconds: 60 })).toBeUndefined();
  const minimax = new MinimaxAdapter({ name: "mm", kind: "minimax", url: "https://api.minimax.io", asrModel: "asr-1.0", ttsModel: "speech-2.8-hd" });
  expect(minimax.cost("speak", { chars: 10_000 })).toBe(1);
  expect(minimax.cost("transcribe", { audioSeconds: 3600 })).toBe(0.379998);
  // The China site lists CNY only: unpriced.
  expect(new MinimaxAdapter({ name: "mc", kind: "minimax", url: "https://api.minimaxi.com", asrModel: "asr-1.0", ttsModel: "speech-2.8-hd" }).cost("speak", { chars: 10_000 })).toBeUndefined();
});

test("runtimes: anthropic-api and deepseek-harness at their list prices (DeepSeek at peak)", () => {
  expect(apiCost("claude-opus-5", usage(M, M, M, M))).toBeCloseTo(5 + 25 + 0.5 + 6.25, 9);
  expect(apiCost("claude-haiku-4-5", usage(M, 0))).toBeCloseTo(1, 9);
  expect(apiCost("claude-sonnet-5", usage(0, M, 0, M))).toBeCloseTo(10 + 2.5, 9);
  expect(dshCost("deepseek-flash", usage(M, M, M, M))).toBeCloseTo(0.3 + 1.2 + 0.006 + 0.3, 9);
  expect(dshCost("deepseek-v4-pro", usage(M, M))).toBeCloseTo(1.32 + 3.96, 9);
  expect(dshCost("deepseek-unknown", usage(M, M))).toBeUndefined();
});

test("changed on purpose: one list price per vendor whatever the path (old figure beside the new)", async () => {
  // A gateway provider on DeepSeek's own host with no CNY rate set: was models.dev's figure
  // (0.15 / 0.6 per million, $0.75 here), now DeepSeek's peak list price, as deepseek-harness pays.
  const b = await book();
  const ds = { name: "ds", preset: "deepseek", ...GATEWAY_PRESETS.deepseek! };
  expect(gw(b, ds, "deepseek-flash", usage(M, M))).toEqual({ source: "ai-space deepseek 2026-11-24", usd: 1.5 });
  // deepseek-v4-flash through deepseek-harness: was unpriced, now the flash peak price.
  expect(dshCost("deepseek-v4-flash", usage(M, M))).toBeCloseTo(1.5, 9);
  // anthropic-api naming a model outside its three: was unpriced, now models.dev's list price.
  activePrices().useCatalog(trimModelsDev(MODELS_DEV, new Date("2026-11-24T00:00:00Z")));
  try {
    expect(apiCost("claude-opus-5-5", usage(M, M))).toBeCloseTo(24, 9);
  } finally {
    activePrices().useCatalog(undefined);
  }
});
