import { describe, expect, test } from "bun:test";
import { MAX_BLOCKS, MAX_COPY, declaredActions, dedupeActionIds, sanitizeActions, sanitizeBlock, sanitizeBlocks, sanitizeViews } from "./blocks.ts";

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

  test("tanks keep at most three valid tanks and need one", () => {
    const b = sanitizeBlock({
      type: "tanks", label: "R2", unit: "GB",
      tanks: [
        { label: "a", value: 7.5, max: 10, tone: "warning", display: "7.5 GB" },
        { label: "", value: 1, max: 10 },
        { label: "b", value: null, max: 10, tone: "bright" },
        { label: "c", value: 12, max: 10 },
        { label: "d", value: 1, max: 0 },
        { label: "e", value: 1, max: 10 },
        { label: "f", value: 1, max: 10 },
      ],
    });
    expect(b).toEqual({ type: "tanks", label: "R2", unit: "GB", tanks: [
      { label: "a", value: 7.5, max: 10, tone: "warning", display: "7.5 GB" },
      { label: "b", value: null, max: 10 },
      { label: "c", value: 12, max: 10 },
    ] });
    expect(sanitizeBlock({ type: "tanks", label: "R2", tanks: [] })).toBeUndefined();
    expect(sanitizeBlock({ type: "tanks", label: "R2" })).toBeUndefined();
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

describe("widget interactions: copy, actions, views", () => {
  const m = (label: string, extra: Record<string, unknown> = {}) => ({ type: "metric", label, value: 1, ...extra });

  test("copy is a string of 1 to 8000 characters, kept as is", () => {
    expect(sanitizeBlock(m("a", { copy: "  prompt\n" }))?.copy).toBe("  prompt\n");
    expect(sanitizeBlock(m("a", { copy: "x".repeat(MAX_COPY) }))?.copy?.length).toBe(MAX_COPY);
    expect(sanitizeBlock(m("a", { copy: "x".repeat(MAX_COPY + 1) }))?.copy).toBeUndefined();
    expect(sanitizeBlock(m("a", { copy: "" }))?.copy).toBeUndefined();
    expect(sanitizeBlock(m("a", { copy: { en: "x" } }))?.copy).toBeUndefined();
  });

  test("a block action is check or button with a valid id and a label", () => {
    expect(sanitizeBlock({ type: "status", label: "Milk", value: "today", action: { id: "done:42", kind: "check", label: { en: "Done", zh: "完成" }, confirm: "Sure?", extra: 1 } })?.action)
      .toEqual({ id: "done:42", kind: "check", label: { en: "Done", zh: "完成" }, confirm: "Sure?" });
    expect(sanitizeBlock(m("a", { action: { id: "run", kind: "button", label: "Run" } }))?.action).toEqual({ id: "run", kind: "button", label: "Run" });
    for (const action of [
      { id: "add", kind: "input", label: "Add" },
      { id: "bad id", kind: "button", label: "x" },
      { id: "x".repeat(129), kind: "button", label: "x" },
      { id: "", kind: "button", label: "x" },
      { id: "ok", kind: "button" },
      { id: 4, kind: "button", label: "x" },
      "done:1",
    ]) expect(sanitizeBlock(m("a", { action }))?.action).toBeUndefined();
    // A bad action drops the action only, not the block.
    expect(sanitizeBlock(m("a", { action: { id: "?", kind: "check", label: "x" } }))).toEqual({ type: "metric", label: "a", value: 1 });
  });

  test("card actions: input or button, at most 3, one input, unique ids, placeholder only on input", () => {
    expect(sanitizeActions([
      { id: "add", kind: "input", label: "Add", placeholder: "Add a task…" },
      { id: "add2", kind: "input", label: "Second input" },
      { id: "add", kind: "button", label: "Same id" },
      { id: "rerun", kind: "button", label: "Run now", placeholder: "dropped", confirm: { en: "Run?" } },
      { id: "check", kind: "check", label: "Not a card kind" },
      { id: "x", kind: "button" },
      { id: "a", kind: "button", label: "A" },
      { id: "b", kind: "button", label: "B" },
    ])).toEqual([
      { id: "add", kind: "input", label: "Add", placeholder: "Add a task…" },
      { id: "rerun", kind: "button", label: "Run now", confirm: { en: "Run?" } },
      { id: "a", kind: "button", label: "A" },
    ]);
    expect(sanitizeActions([{ id: "x", kind: "check", label: "x" }])).toBeUndefined();
    expect(sanitizeActions("add")).toBeUndefined();
  });

  test("views: 2 to 4 with valid unique ids, a label and a valid block; fewer than 2 drops the field", () => {
    const v = (id: unknown, blocks: unknown[] = [m("x")], label: unknown = "L") => ({ id, label, blocks });
    expect(sanitizeViews([v("today"), v("7d")])?.map((x) => x.id)).toEqual(["today", "7d"]);
    expect(sanitizeViews([v("today"), v("Bad"), v("-x"), v("a".repeat(33)), v("today"), v("e", []), v("f", [{ type: "nope", label: "x" }]), v("g", [m("x")], "")])).toBeUndefined();
    expect(sanitizeViews([v("a"), v("b"), v("c"), v("d"), v("e")])?.map((x) => x.id)).toEqual(["a", "b", "c", "d"]);
    expect(sanitizeViews([v("a"), v("b", [m("x"), { type: "nope" }])])?.[1]?.blocks).toEqual([{ type: "metric", label: "x", value: 1 }]);
    expect(sanitizeViews([v("a", Array.from({ length: 20 }, (_, i) => m(`r${i}`))), v("b")])?.[0]?.blocks.length).toBe(MAX_BLOCKS);
    expect(sanitizeViews({ a: 1 })).toBeUndefined();
  });

  test("duplicate action ids: the later is dropped; the same action may recur in another view", () => {
    const act = (id: string, kind = "check") => ({ action: { id, kind, label: "x" } });
    const blocks = sanitizeBlocks([m("a", act("done:1")), m("b", act("done:1")), m("c", act("add", "button"))])!;
    const views = sanitizeViews([
      { id: "today", label: "Today", blocks: [m("a", act("done:1")), m("d", act("done:2"))] },
      { id: "all", label: "All", blocks: [m("e", act("done:2", "button")), m("f", act("done:3"))] },
    ])!;
    const actions = sanitizeActions([{ id: "add", kind: "input", label: "Add" }])!;
    const p = { blocks, views, actions };
    dedupeActionIds(p);
    expect(p.blocks.map((b) => b.action?.id)).toEqual(["done:1", undefined, undefined]);
    expect(p.views[0]!.blocks.map((b) => b.action?.id)).toEqual(["done:1", "done:2"]);
    expect(p.views[1]!.blocks.map((b) => b.action?.id)).toEqual([undefined, "done:3"]);
    expect([...declaredActions(p)]).toEqual([["add", "input"], ["done:1", "check"], ["done:2", "check"], ["done:3", "check"]]);
  });
});
