import { expect, test } from "bun:test";
import { ago, bytes, cell, duration, renderTable, span, tokens, until, usd } from "./output.ts";

test("renderTable pads columns from the rows, right-aligns numbers on request, drops trailing space", () => {
  const rows = [
    { name: "a", n: 1, note: "" },
    { name: "longer", n: 1234, note: "x" },
  ];
  const lines = renderTable(rows, [
    { title: "name", get: (r) => r.name },
    { title: "n", get: (r) => r.n, align: "right" },
    { title: "note", get: (r) => r.note },
  ]);
  expect(lines).toEqual(["NAME       N  NOTE", "a          1", "longer  1234  x"]);
  expect(renderTable(rows, [{ title: "name", get: (r) => r.name }], { header: false })).toEqual(["a", "longer"]);
});

test("cell renders booleans, arrays, objects and squashes whitespace", () => {
  expect(cell(true)).toBe("yes");
  expect(cell(undefined)).toBe("");
  expect(cell([1, "b"])).toBe("1, b");
  expect(cell({ a: 1 })).toBe('{"a":1}');
  expect(cell("a\n  b")).toBe("a b");
  expect(cell(1.234)).toBe("1.23");
});

test("relative times", () => {
  const now = Date.parse("2026-09-22T12:00:00Z");
  expect(ago("2026-09-22T11:57:00Z", now)).toBe("3m ago");
  expect(ago("2026-09-22T11:59:58Z", now)).toBe("just now");
  expect(ago("2026-09-20T10:00:00Z", now)).toBe("2d 2h ago");
  expect(ago(undefined, now)).toBe("");
  expect(until("2026-09-22T13:30:00Z", now)).toBe("in 1h 30m");
  expect(until("2026-09-22T11:50:00Z", now)).toBe("overdue 10m");
  expect(span(45_000)).toBe("45s");
  expect(span(3600_000 * 30)).toBe("30h");
  expect(span(3600_000 * 50)).toBe("2d 2h");
});

test("sizes, tokens, money, durations", () => {
  expect(bytes(512)).toBe("512 B");
  expect(bytes(1536)).toBe("1.5 KB");
  expect(tokens(999)).toBe("999");
  expect(tokens(12_345)).toBe("12.3k");
  expect(tokens(2_500_000)).toBe("2.50M");
  expect(usd(0.004)).toBe("<$0.01");
  expect(usd(1.5)).toBe("$1.50");
  expect(duration(250)).toBe("250ms");
  expect(duration(2500)).toBe("2.5s");
  expect(duration(120_000)).toBe("2m");
});
