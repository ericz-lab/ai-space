import { describe, expect, test } from "bun:test";
import { MAX_BLOCKS, sanitizeBlock, sanitizeBlocks } from "./blocks.ts";

describe("widget blocks", () => {
  test("a metric keeps the contract's fields and drops the rest", () => {
    const b = sanitizeBlock({
      type: "metric",
      label: { en: "Today", zh: "今日", "not a tag!": "x" },
      value: 11.02,
      format: "currency",
      currency: "USD",
      decimals: 2,
      delta: { value: -12.5, format: "percent", label: "vs avg", tone: "positive", extra: 1 },
      tone: "loud",
      extra: true,
    });
    expect(b).toEqual({
      type: "metric",
      label: { en: "Today", zh: "今日" },
      value: 11.02,
      format: "currency",
      currency: "USD",
      decimals: 2,
      delta: { value: -12.5, format: "percent", label: "vs avg", tone: "positive" },
    });
  });

  test("a missing value stays null; a block without a label or a value is skipped", () => {
    expect(sanitizeBlock({ type: "metric", label: "Quota", value: null })).toEqual({ type: "metric", label: "Quota", value: null });
    expect(sanitizeBlock({ type: "metric", label: "Quota" })).toBeUndefined();
    expect(sanitizeBlock({ type: "metric", label: "Quota", value: "12" })).toBeUndefined();
    expect(sanitizeBlock({ type: "metric", label: "  ", value: 1 })).toBeUndefined();
    expect(sanitizeBlock({ type: "chart", label: "x", value: 1 })).toBeUndefined();
  });

  test("a trend keeps null points, drops undated ones and keeps the latest 90", () => {
    const points = Array.from({ length: 100 }, (_, i) => ({ t: `2026-01-01T00:${String(i % 60).padStart(2, "0")}:00Z`, v: i }));
    const b = sanitizeBlock({ type: "trend", label: "Flow", style: "bar", signed: true, points: [...points, { t: "2026-10-08", v: null }, { t: "soon", v: 1 }, { t: "2026-10-09", v: "x" }] });
    if (b?.type !== "trend") throw new Error("not a trend");
    expect(b.style).toBe("bar");
    expect(b.signed).toBe(true);
    expect(b.points.length).toBe(90);
    expect(b.points.at(-1)).toEqual({ t: "2026-10-09", v: null });
    expect(b.points.at(-2)).toEqual({ t: "2026-10-08", v: null });
    expect(sanitizeBlock({ type: "trend", label: "x", points: [] })).toEqual({ type: "trend", label: "x", style: "line", points: [] });
  });

  test("progress and gauge need a sane range; gauge zones are sorted", () => {
    expect(sanitizeBlock({ type: "progress", label: "Week", value: 27 })).toEqual({ type: "progress", label: "Week", value: 27, max: 100 });
    expect(sanitizeBlock({ type: "progress", label: "Week", value: 27, max: 0 })).toBeUndefined();
    expect(sanitizeBlock({ type: "gauge", label: "F&G", value: 64, min: 10, max: 5 })).toBeUndefined();
    const g = sanitizeBlock({ type: "gauge", label: "F&G", value: 64, zones: [{ to: 100, tone: "positive" }, { to: 25, tone: "negative", label: "Fear" }, { to: 50, tone: "bright" }] });
    expect(g).toEqual({ type: "gauge", label: "F&G", value: 64, min: 0, max: 100, zones: [{ to: 25, tone: "negative", label: "Fear" }, { to: 100, tone: "positive" }] });
  });

  test("status takes a text value and an ISO time", () => {
    expect(sanitizeBlock({ type: "status", label: "Sync", value: "ok", tone: "positive", time: "2026-10-08T01:00:00Z" })).toEqual({ type: "status", label: "Sync", value: "ok", tone: "positive", time: "2026-10-08T01:00:00Z" });
    expect(sanitizeBlock({ type: "status", label: "Sync", value: "ok", time: "later" })).toEqual({ type: "status", label: "Sync", value: "ok" });
  });

  test("a payload without blocks has none; at most MAX_BLOCKS are kept", () => {
    expect(sanitizeBlocks(undefined)).toBeUndefined();
    expect(sanitizeBlocks({})).toBeUndefined();
    expect(sanitizeBlocks([1, null, { type: "metric", label: "a", value: 1 }])).toEqual([{ type: "metric", label: "a", value: 1 }]);
    expect(sanitizeBlocks(Array.from({ length: 20 }, () => ({ type: "metric", label: "a", value: 1 })))?.length).toBe(MAX_BLOCKS);
  });
});
