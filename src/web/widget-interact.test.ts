import { afterEach, expect, test } from "bun:test";
import type { WidgetBlock } from "../space/panel/blocks.ts";
import { blockChanges, loadView, nearestIndex, pagesOf, saveView, swipePage } from "./widget-interact.ts";

test("nearestIndex: the slot under the pointer, clamped; one point alone owns the first slot", () => {
  expect(nearestIndex(0, 200, 10)).toBe(0);
  expect(nearestIndex(19.9, 200, 10)).toBe(0);
  expect(nearestIndex(20, 200, 10)).toBe(1);
  expect(nearestIndex(199, 200, 10)).toBe(9);
  expect(nearestIndex(260, 200, 10)).toBe(9);
  expect(nearestIndex(-5, 200, 10)).toBe(0);
  expect(nearestIndex(150, 200, 1)).toBe(0);
  expect(nearestIndex(10, 0, 5)).toBe(-1);
  expect(nearestIndex(10, 100, 0)).toBe(-1);
});

test("pagesOf: one page when the rows fit, else pages of `per`", () => {
  expect(pagesOf([1, 2], 2)).toEqual([[1, 2]]);
  expect(pagesOf([], 2)).toEqual([[]]);
  expect(pagesOf([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  expect(pagesOf(Array.from({ length: 11 }, (_, i) => i), 10).map((p) => p.length)).toEqual([10, 1]);
});

test("swipePage: a clear horizontal swipe moves one page, within bounds", () => {
  expect(swipePage(0, 3, -80, 5)).toBe(1);
  expect(swipePage(1, 3, 80, 5)).toBe(0);
  expect(swipePage(2, 3, -80, 0)).toBe(2);
  expect(swipePage(0, 3, -20, 0)).toBe(0);
  expect(swipePage(0, 3, -60, 60)).toBe(0);
});

test("blockChanges: numbers up or down, text changed, matched by place, type and label", () => {
  const m = (label: string, value: number | null): WidgetBlock => ({ type: "metric", label, value });
  const s = (label: string, value: string): WidgetBlock => ({ type: "status", label, value });
  const tr = (v: (number | null)[]): WidgetBlock => ({ type: "trend", label: "t", style: "line", points: v.map((x, i) => ({ t: `2026-11-0${i + 1}`, v: x })) });
  expect(blockChanges(undefined, [m("a", 1)])).toEqual([undefined]);
  expect(blockChanges([m("a", 1), m("b", 5), s("c", "up"), m("d", 1), tr([1, 2])], [m("a", 2), m("b", 4), s("c", "down"), m("other", 9), tr([1, 2, null])])).toEqual([
    "up",
    "down",
    "text",
    undefined,
    undefined,
  ]);
  expect(blockChanges([m("a", null)], [m("a", 3)])).toEqual(["text"]);
  expect(blockChanges([m("a", 3)], [m("a", 3)])).toEqual([undefined]);
  expect(blockChanges([tr([1, 2])], [tr([1, 2, 1])])).toEqual(["down"]);
  // A block that moved to another place is a different thing there: no flash.
  expect(blockChanges([m("a", 1), m("b", 2)], [m("b", 3), m("a", 1)])).toEqual([undefined, undefined]);
});

const store = new Map<string, string>();
const fakeStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
afterEach(() => {
  store.clear();
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

test("the chosen view is kept per widget and falls back to the first when gone", () => {
  (globalThis as { localStorage?: unknown }).localStorage = fakeStorage;
  expect(loadView("usage/spend", ["today", "7d"])).toBe("today");
  saveView("usage/spend", "7d");
  saveView("other/w", "b");
  expect(loadView("usage/spend", ["today", "7d"])).toBe("7d");
  expect(loadView("usage/spend", ["today", "30d"])).toBe("today");
  expect(JSON.parse(store.get("panel-widget-views")!)).toEqual({ "usage/spend": "7d", "other/w": "b" });
  store.set("panel-widget-views", "not json");
  expect(loadView("usage/spend", ["today", "7d"])).toBe("today");
});

test("without storage the first view is used and saving does not throw", () => {
  expect(loadView("usage/spend", ["today", "7d"])).toBe("today");
  expect(() => saveView("usage/spend", "7d")).not.toThrow();
});
