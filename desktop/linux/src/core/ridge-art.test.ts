import { describe, expect, test } from "bun:test";
import { ridgeLines } from "./ridge-art.ts";

describe("ridgeLines", () => {
  test("fills the given size with binary digits, the same every time", () => {
    const lines = ridgeLines(120, 30);
    expect(lines).toHaveLength(30);
    for (const l of lines) expect(l).toMatch(/^[01 ]{120}$/);
    expect(ridgeLines(120, 30)).toEqual(lines);
  });

  for (const [cols, rows] of [
    [120, 30],
    [60, 20],
    [240, 24],
  ] as const) {
    test(`at ${cols} × ${rows} the sky is empty and the crest runs across every column`, () => {
      const lines = ridgeLines(cols, rows);
      expect(lines[0]!.trim()).toBe("");
      expect(lines.slice(0, rows / 2).some((l) => l.trim().length > 0)).toBe(true);
      // A wide window shows more peaks, never a gap between them.
      for (let x = 0; x < cols; x++) expect(lines.some((l) => l[x] !== " ")).toBe(true);
    });
  }

  test("is the Windows client's picture", () => {
    // Two of RidgeArt.cs's lines at 240 × 32, the first 120 columns, a dot for each space.
    const lines = ridgeLines(240, 32).map((l) => l.slice(0, 120).replaceAll(" ", "."));
    expect(lines[11]).toBe(".......................111................................................0....................................10.......");
    expect(lines[23]).toBe("...................................................10...00..............................................................");
  });

  test("draws nothing in no room", () => {
    expect(ridgeLines(0, 10)).toEqual([]);
    expect(ridgeLines(10, 0)).toEqual([]);
  });
});
