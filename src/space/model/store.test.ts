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
    expect(store.days(T0 - 3 * DAY).map((d) => [d.day, d.calls])).toEqual([
      ["2026-09-14", 1],
      ["2026-09-16", 2],
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
