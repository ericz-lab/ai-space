import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importCalls, parseImportLine } from "./import.ts";
import { ModelStore } from "./store.ts";

let dir: string;
let store: ModelStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "space-model-import-"));
  store = new ModelStore(join(dir, "space.db"));
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

const line = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ ts: "2026-07-13T03:56:41.893Z", tag: "translate", model: "haiku", backend: "ssh:box", ok: true, durationMs: 5399, promptChars: 592, outputChars: 199, inputTokens: 10, outputTokens: 150, cacheTokens: 22000, costUsd: 0.0027, ...over });

describe("parseImportLine", () => {
  test("maps an app's row onto a ledger row; a combined cache figure counts as reads", () => {
    expect(parseImportLine("news", JSON.parse(line()), 1)).toEqual({
      app: "news",
      tag: "translate",
      model: "haiku",
      backend: "ssh:box",
      origin: "import",
      status: "ok",
      error: undefined,
      startedAt: Date.parse("2026-07-13T03:56:41.893Z"),
      durationMs: 5399,
      promptChars: 592,
      outputChars: 199,
      usage: { inputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 22000, outputTokens: 150 },
      costUsd: 0.0027,
    });
    const failed = parseImportLine("news", JSON.parse(line({ ok: 0, outputChars: null, inputTokens: null, outputTokens: null, cacheTokens: null, costUsd: null })), 2);
    expect(failed).toMatchObject({ status: "error", error: "failed", usage: undefined, costUsd: undefined, outputChars: undefined });
    expect(parseImportLine("news", { ts: 1_700_000_000_000, model: "m", ok: true, durationMs: 1 }, 3)).toMatchObject({ tag: "other", backend: "unknown", promptChars: 0 });
  });

  test("rejects malformed lines with the line number", () => {
    expect(() => parseImportLine("news", { model: "m", ok: true, durationMs: 1 }, 4)).toThrow(/line 4: ts/);
    expect(() => parseImportLine("news", { ts: "2026-01-01", ok: true, durationMs: 1 }, 5)).toThrow(/model is required/);
    expect(() => parseImportLine("news", { ts: "2026-01-01", model: "m", ok: "yes", durationMs: 1 }, 6)).toThrow(/ok must be boolean/);
    expect(() => parseImportLine("news", { ts: "2026-01-01", model: "m", ok: true }, 7)).toThrow(/durationMs is required/);
    expect(() => parseImportLine("news", { ts: "2026-01-01", model: "m", ok: true, durationMs: 1, tag: "Bad Tag" }, 8)).toThrow(/invalid tag/);
  });
});

describe("importCalls", () => {
  test("writes the rows once; a second run skips them; a bad line writes nothing", () => {
    const text = [line(), line({ ts: "2026-07-13T04:00:00.000Z", tag: "story" }), ""].join("\n");
    expect(importCalls(store, "news", text)).toEqual({ read: 2, imported: 2, skipped: 0 });
    expect(importCalls(store, "news", text)).toEqual({ read: 2, imported: 0, skipped: 2 });
    expect(store.list({ since: 0 }).map((c) => [c.tag, c.origin])).toEqual([
      ["story", "import"],
      ["translate", "import"],
    ]);
    expect(store.firstAt()).toBe(Date.parse("2026-07-13T03:56:41.893Z"));
    expect(() => importCalls(store, "news", `${line({ ts: "2026-08-01T00:00:00Z" })}\nnot json`)).toThrow(/line 2: not JSON/);
    expect(store.list({ since: 0 })).toHaveLength(2);
    expect(() => importCalls(store, "Bad App", "")).toThrow(/invalid app name/);
  });

  test("imported rows are kept whatever the retention, until a newer insert prunes them", () => {
    const short = new ModelStore(join(dir, "short.db"), { retentionDays: 1 });
    expect(importCalls(short, "news", line())).toMatchObject({ imported: 1 });
    expect(short.list({ since: 0 })).toHaveLength(1);
    short.close();
  });
});
