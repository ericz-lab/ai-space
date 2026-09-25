import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelStore } from "./store.ts";
import type { ModelCallInput } from "./types.ts";

let dir: string;
let store: ModelStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "space-model-store-"));
  store = new ModelStore(join(dir, "space.db"), { retentionDays: 10 });
  expect(new ModelStore(join(dir, "keep.db")).add(call({ startedAt: T0 - 400 * DAY })).startedAt).toBe(T0 - 400 * DAY);
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

const DAY = 86400_000;
const T0 = Date.UTC(2026, 8, 16, 12);

const call = (over: Partial<ModelCallInput> = {}): ModelCallInput => ({
  app: "news",
  tag: "translate",
  model: "haiku",
  backend: "local",
  origin: "run",
  status: "ok",
  startedAt: T0,
  durationMs: 1000,
  promptChars: 100,
  outputChars: 50,
  usage: { inputTokens: 1, cacheWriteTokens: 2, cacheReadTokens: 3, outputTokens: 4 },
  costUsd: 0.01,
  ...over,
});

describe("ModelStore", () => {
  test("add, get and list round-trip; usage is absent when nothing was reported", () => {
    const a = store.add(call());
    const b = store.add(call({ tag: "story", startedAt: T0 + 1, status: "error", error: "boom", outputChars: undefined, usage: undefined, costUsd: undefined }));
    expect(store.get(a.id)).toEqual({ id: a.id, ...call() });
    expect(store.get(b.id)).toMatchObject({ status: "error", error: "boom", usage: undefined, costUsd: undefined, outputChars: undefined });
    expect(store.list().map((c) => c.id)).toEqual([b.id, a.id]);
    expect(store.list({ tag: "story" }).map((c) => c.id)).toEqual([b.id]);
    expect(store.list({ app: "other" })).toEqual([]);
  });

  test("totals and groups sum the four token kinds and count errors", () => {
    store.add(call());
    store.add(call({ tag: "story", model: "sonnet", status: "error", error: "x", usage: { inputTokens: 20, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, costUsd: 0.5 }));
    store.add(call({ app: "other", startedAt: T0 - 2 * DAY, usage: undefined, costUsd: undefined }));
    const all = store.totals(T0 - 3 * DAY);
    expect(all).toEqual({ calls: 3, errors: 1, inputTokens: 21, cacheWriteTokens: 2, cacheReadTokens: 3, outputTokens: 4, tokens: 30, costUsd: 0.51, durationMs: 3000 });
    expect(store.totals(T0 - 1)).toMatchObject({ calls: 2 });
    expect(store.totals(T0 - 3 * DAY, "other")).toMatchObject({ calls: 1, tokens: 0 });
    const byTag = store.groupBy(["app", "tag", "model"], T0 - 3 * DAY);
    expect(byTag.map((g) => [g.app, g.tag, g.model, g.tokens, g.errors])).toEqual([
      ["news", "story", "sonnet", 20, 1],
      ["news", "translate", "haiku", 10, 0],
      ["other", "translate", "haiku", 0, 0],
    ]);
    expect(store.groupBy(["backend", "origin"], T0 - 3 * DAY)).toEqual([expect.objectContaining({ backend: "local", origin: "run", calls: 3 })]);
    // Rows without a runtime (older rows, imports) group under the empty name.
    expect(store.groupBy(["runtime"], T0 - 3 * DAY).map((g) => [g.runtime, g.calls])).toEqual([["", 3]]);
    store.add(call({ runtime: "claude", startedAt: T0 + 1 }));
    expect(store.groupBy(["runtime"], T0 - 3 * DAY).map((g) => [g.runtime, g.calls])).toEqual([["", 3], ["claude", 1]]);
    expect(store.list({ limit: 1 })[0]).toMatchObject({ runtime: "claude" });
    expect(store.days(T0 - 3 * DAY).map((d) => [d.day, d.calls])).toEqual([
      ["2026-09-14", 1],
      ["2026-09-16", 3],
    ]);
  });

  test("rows older than the retention are pruned on insert", () => {
    store.add(call({ startedAt: T0 - 11 * DAY }));
    store.add(call({ startedAt: T0 - 9 * DAY }));
    expect(store.list({ since: 0 })).toHaveLength(2);
    store.add(call({ startedAt: T0 }));
    expect(store.list({ since: 0 }).map((c) => c.startedAt)).toEqual([T0, T0 - 9 * DAY]);
  });
});


test("the mode migration preserves older rows and survives reopening", () => {
  const old = store.add(call());
  store.db.exec("ALTER TABLE model_calls DROP COLUMN mode");
  store.close();
  store = new ModelStore(join(dir, "space.db"));
  expect(store.get(old.id)?.mode).toBeUndefined();
  const fresh = store.add(call({ mode: "full" }));
  store.close();
  store = new ModelStore(join(dir, "space.db"));
  expect(store.get(fresh.id)?.mode).toBe("full");
  expect(store.get(old.id)?.app).toBe("news");
});

describe("GPT API-equivalent costs", () => {
  test("historical NULL costs are estimated consistently without changing stored values", () => {
    const usage = { inputTokens: 1620, cacheWriteTokens: 0, cacheReadTokens: 1326, outputTokens: 78 };
    const c = store.add(call({ model: "gpt-6-luna", costUsd: undefined, usage }));
    const expected = (1620 * 0.1 + 1326 * 0.01 + 78 * 0.5) / 1e6;
    expect(c.costUsd).toBeCloseTo(expected, 10);
    expect(store.db.query("SELECT cost_usd FROM model_calls WHERE id = ?").get(c.id)).toEqual({ cost_usd: null });
    store.close();
    store = new ModelStore(join(dir, "space.db"));
    expect(store.get(c.id)?.costUsd).toBeCloseTo(expected, 10);
    expect(store.list()[0]?.costUsd).toBeCloseTo(expected, 10);
    expect(store.totals(T0).costUsd).toBeCloseTo(expected, 10);
    expect(store.groupBy(["app", "tag", "model"], T0)[0]?.costUsd).toBeCloseTo(expected, 10);
    expect(store.days(T0)[0]?.costUsd).toBeCloseTo(expected, 10);
    expect(store.totals(T0 + 1).costUsd).toBe(0);
  });

  test("long context is priced per call, not from the grouped token sum", () => {
    const usage = { inputTokens: 270000, cacheWriteTokens: 1000, cacheReadTokens: 1000, outputTokens: 1000 };
    const a = store.add(call({ model: "gpt-6-sol", costUsd: undefined, usage }));
    const b = store.add(call({ model: "gpt-6-sol", costUsd: undefined, usage }));
    expect(a.costUsd).toBeCloseTo(0.5527, 10);
    expect(b.costUsd).toBeCloseTo(0.5527, 10);
    expect(store.totals(T0).costUsd).toBeCloseTo(1.1054, 10);
    const long = store.add(call({ model: "gpt-6-sol", costUsd: undefined, usage: { ...usage, inputTokens: 270001 } }));
    expect(long.costUsd).toBeCloseTo(1.100404, 10);
  });

  test("reported costs win; unknown models and incomplete usage remain unpriced", () => {
    for (const costUsd of [0, 1.23]) {
      expect(store.add(call({ model: "gpt-6-luna", costUsd })).costUsd).toBe(costUsd);
    }
    for (const model of ["haiku", "gpt-unknown", "gpt-6-luna-custom"]) {
      expect(store.add(call({ model, costUsd: undefined })).costUsd).toBeUndefined();
    }
    expect(store.add(call({ model: "gpt-6-luna", costUsd: undefined, usage: undefined })).costUsd).toBeUndefined();
    expect(store.totals(T0).costUsd).toBe(1.23);
  });

  test.each([
    ["gpt-6-astra", 0.086], ["gpt-6-sol", 0.0172], ["gpt-6-luna", 0.00086],
    ["gpt-5.6-sol", 0.0344], ["gpt-5.6-terra", 0.0192], ["gpt-5.6-luna", 0.00192],
  ])("uses the rate for %s", (model, expected) => {
    const c = store.add(call({ model, costUsd: undefined, usage: { inputTokens: 1000, cacheWriteTokens: 2000, cacheReadTokens: 1000, outputTokens: 1000 } }));
    expect(c.costUsd).toBeCloseTo(expected, 10);
  });
});

test("shared catalogue covers older GPT models and snapshot ids without guessing cache writes", () => {
  const usage = { inputTokens: 1000, cacheWriteTokens: 0, cacheReadTokens: 2000, outputTokens: 1000 };
  expect(store.add(call({ model: "gpt-5.3-codex", usage, costUsd: undefined })).costUsd).toBeCloseTo(0.0161, 10);
  expect(store.add(call({ model: "gpt-5.4", usage, costUsd: undefined })).costUsd).toBeCloseTo(0.018, 10);
  expect(store.add(call({ model: "gpt-6-luna-2026-09-22", usage, costUsd: undefined })).costUsd).toBeCloseTo(0.00062, 10);
  expect(store.add(call({ model: "gpt-5.4", usage: { ...usage, cacheWriteTokens: 1 }, costUsd: undefined })).costUsd).toBeUndefined();
});
