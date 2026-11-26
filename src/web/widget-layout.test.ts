import { describe, expect, test } from "bun:test";
import {
  GAP,
  MAX_H,
  MIN_H,
  MIN_W,
  alignTwelfths,
  applyWrite,
  breakRows,
  defaultFrame,
  edgeCandidates,
  effective,
  fracOf,
  framesWrite,
  heightCandidates,
  keyStep,
  minFrac,
  nudge,
  nearestSize,
  oldColumns,
  place,
  pxOf,
  resizeTo,
  resolveFrames,
  setRowHeight,
  setWidth,
  rowsThatFit,
  sizeClass,
  snapTo,
  splitEvenly,
  startResize,
  tidy,
  type Frame,
  type Placed,
} from "./widget-layout.ts";

const near = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

/** Every invariant of a placement: rows fit, cards never overlap, gaps are exactly GAP, rows line up. */
function checkPlaced(p: Placed, frames: Frame[], W: number) {
  for (const row of p.rows) {
    const s = row.reduce((a, i) => a + frames[i]!.w, 0);
    expect(s).toBeLessThanOrEqual(1 + 1e-4);
    const boxes = row.map((i) => p.boxes[i]!);
    for (let k = 1; k < boxes.length; k++) near(boxes[k]!.x - (boxes[k - 1]!.x + boxes[k - 1]!.width), GAP, 1e-6);
    expect(new Set(boxes.map((b) => b.height)).size).toBe(1);
    expect(new Set(boxes.map((b) => b.y)).size).toBe(1);
    expect(boxes[0]!.x).toBeGreaterThanOrEqual(-1e-9);
    expect(boxes.at(-1)!.x + boxes.at(-1)!.width).toBeLessThanOrEqual(W + 0.2);
    for (const b of boxes) expect(b.width).toBeGreaterThanOrEqual(Math.min(MIN_W, W) - 1e-6);
  }
  for (let r = 1; r < p.rows.length; r++) {
    const above = p.boxes[p.rows[r - 1]![0]!]!;
    near(p.boxes[p.rows[r]![0]!]!.y - (above.y + above.height), GAP);
  }
}

describe("px and fractions", () => {
  test("a fraction's width and back, and fractions summing to 1 fill the area with GAP between", () => {
    for (const W of [320, 720, 1100, 1440, 2560]) {
      near(pxOf(1, W), W);
      near(fracOf(pxOf(0.37, W), W), 0.37);
      near(pxOf(0.5, W) * 2 + GAP, W);
      near(pxOf(1 / 3, W) * 3 + 2 * GAP, W);
      near(pxOf(0.25, W) + pxOf(0.75, W) + GAP, W);
    }
  });

  test("the minimum width is 200px, or the whole area when it is narrower, and never under the stored floor", () => {
    near(pxOf(minFrac(1100), 1100), MIN_W);
    expect(minFrac(180)).toBe(1);
    expect(minFrac(200)).toBe(1);
    expect(minFrac(4000)).toBe(0.1);
    expect(effective({ w: 0.05, h: 50 }, 1100)).toEqual({ w: minFrac(1100), h: MIN_H });
    expect(effective({ w: 3, h: 5000 }, 1100)).toEqual({ w: 1, h: MAX_H });
  });
});

describe("defaults from sizes", () => {
  test("the old grid's columns at this width, the size's columns clamped to them, a fixed height per row", () => {
    expect(oldColumns(952)).toBe(2);
    expect(oldColumns(1100)).toBe(3);
    expect(oldColumns(300)).toBe(1);
    expect(defaultFrame("1x1", 1100)).toEqual({ w: 1 / 3, h: 300 });
    expect(defaultFrame("2x1", 1100)).toEqual({ w: 2 / 3, h: 300 });
    expect(defaultFrame("2x2", 952)).toEqual({ w: 1, h: 620 });
    expect(defaultFrame("2x1", 300)).toEqual({ w: 1, h: 300 });
    expect(defaultFrame("weird", 1100)).toEqual({ w: 1 / 3, h: 300 });
    // A stored frame wins over the default.
    expect(resolveFrames([{ size: "1x1", frame: { w: 0.5, h: 400 } }, { size: "2x1" }], 1100)).toEqual([{ w: 0.5, h: 400 }, { w: 2 / 3, h: 300 }]);
  });
});

describe("rows", () => {
  test("cards wrap when the next one does not fit, with rounding slack", () => {
    expect(breakRows([0.5, 0.5, 0.5])).toEqual([[0, 1], [2]]);
    expect(breakRows([1 / 3, 1 / 3, 1 / 3, 1])).toEqual([[0, 1, 2], [3]]);
    expect(breakRows([0.333334, 0.333334, 0.333334])).toEqual([[0, 1, 2]]);
    expect(breakRows([0.6, 0.5, 0.4])).toEqual([[0], [1, 2]]);
    expect(breakRows([])).toEqual([]);
  });

  test("placement: rows take their tallest card, are GAP apart, and never overlap, at any width", () => {
    const frames: Frame[] = [
      { w: 0.5, h: 300 },
      { w: 0.25, h: 420 },
      { w: 0.6, h: 200 },
      { w: 0.4, h: 260 },
      { w: 1, h: 500 },
      { w: 0.3, h: 140 },
    ];
    for (const W of [400, 720, 952, 1100, 1440]) {
      const eff = frames.map((f) => effective(f, W));
      for (const align of ["start", "center"] as const) {
        const p = place(eff, W, align);
        checkPlaced(p, eff, W);
        expect(p.height).toBe(p.rows.reduce((a, row) => a + p.boxes[row[0]!]!.height, 0) + GAP * (p.rows.length - 1));
      }
    }
    const p = place(frames, 1100);
    expect(p.rows).toEqual([[0, 1], [2, 3], [4], [5]]);
    expect(p.boxes[0]!.height).toBe(420);
    // Centred: the free space of a short row is split on both sides.
    const c = place(frames, 1100, "center");
    near(c.boxes[0]!.x, (1100 - (0.75 * 1120 - 20)) / 2);
    near(c.boxes[2]!.x, 0);
  });
});

describe("dragging", () => {
  const W = 1100;
  test("a boundary between two cards moves: the neighbour takes the difference, both stay above the minimum", () => {
    const frames: Frame[] = [
      { w: 0.5, h: 300 },
      { w: 0.5, h: 300 },
      { w: 1, h: 300 },
    ];
    const out = setWidth(frames, W, 0, pxOf(0.5, W) + 112);
    near(out[0]!.w, 0.6);
    near(out[1]!.w, 0.4);
    near(out[0]!.w + out[1]!.w, 1);
    expect(out[2]).toEqual(frames[2]!);
    checkPlaced(place(out, W), out, W);
    const squeezed = setWidth(frames, W, 0, 5000);
    near(pxOf(squeezed[1]!.w, W), MIN_W);
    const tiny = setWidth(frames, W, 0, 10);
    near(pxOf(tiny[0]!.w, W), MIN_W);
    near(tiny[0]!.w + tiny[1]!.w, 1);
  });

  test("the last card of a row grows into the free space and no further; it can always shrink", () => {
    const frames: Frame[] = [
      { w: 0.5, h: 300 },
      { w: 0.25, h: 300 },
    ];
    near(setWidth(frames, W, 1, 5000)[1]!.w, 0.5);
    near(setWidth(frames, W, 1, pxOf(0.4, W))[1]!.w, 0.4);
    near(pxOf(setWidth(frames, W, 1, 0)[1]!.w, W), MIN_W);
    expect(setWidth(frames, W, 1, 5000)[0]).toEqual(frames[0]!);
  });

  test("with Shift only this card changes and the next ones re-flow", () => {
    const frames: Frame[] = [
      { w: 0.5, h: 300 },
      { w: 0.5, h: 300 },
    ];
    const out = setWidth(frames, W, 0, pxOf(0.7, W), true);
    near(out[0]!.w, 0.7);
    expect(out[1]!.w).toBe(0.5);
    expect(breakRows(out.map((f) => f.w))).toEqual([[0], [1]]);
    expect(setWidth(frames, W, 0, 99999, true)[0]!.w).toBe(1);
  });

  test("a row's height is set on every card of the row, within bounds", () => {
    const frames: Frame[] = [
      { w: 0.5, h: 300 },
      { w: 0.5, h: 200 },
      { w: 1, h: 250 },
    ];
    expect(setRowHeight(frames, 1, 412.4).map((f) => f.h)).toEqual([412, 412, 250]);
    expect(setRowHeight(frames, 0, 10).map((f) => f.h)).toEqual([MIN_H, MIN_H, 250]);
    expect(setRowHeight(frames, 2, 9999)[2]!.h).toBe(MAX_H);
  });
});

describe("snapping", () => {
  const W = 1100;
  test("the nearest candidate within 8px wins; nothing beyond", () => {
    expect(snapTo(100, [93, 105, 200])).toEqual({ value: 105, at: 105 });
    expect(snapTo(100, [91, 109])).toBeNull();
    expect(snapTo(100, [92, 108])?.value).toBe(92);
  });

  test("edge candidates: the area's divisions and the edges of cards in other rows", () => {
    const frames: Frame[] = [
      { w: 0.5, h: 300 },
      { w: 0.5, h: 300 },
      { w: 0.3, h: 300 },
      { w: 0.7, h: 300 },
    ];
    const p = place(frames, W);
    const c = edgeCandidates(p, W, 0);
    for (const f of [1 / 4, 1 / 3, 1 / 2, 2 / 3, 3 / 4, 1]) expect(c.some((x) => Math.abs(x - pxOf(f, W)) < 1e-6)).toBe(true);
    // The other row's boundary: its right edge, and its neighbour's left edge less the gap (the same line).
    expect(c.some((x) => Math.abs(x - pxOf(0.3, W)) < 1e-6)).toBe(true);
    // Not the card's own row.
    expect(c.filter((x) => Math.abs(x - pxOf(0.5, W)) < 1e-6).length).toBe(1);
    expect(heightCandidates(place(setRowHeight(frames, 2, 444), W), 0)).toEqual([444]);
  });
});

describe("toolbar operations", () => {
  const W = 1100;
  const messy: Frame[] = [
    { w: 0.47, h: 310 },
    { w: 0.51, h: 296 },
    { w: 0.29, h: 500 },
    { w: 0.33, h: 330 },
    { w: 0.31, h: 480 },
    { w: 0.9, h: 200 },
  ];

  test("align snaps every boundary to a twelfth, keeps mins, groups close heights, and is idempotent", () => {
    const a = alignTwelfths(messy, W);
    for (const row of breakRows(a.map((f) => f.w))) {
      let cum = 0;
      for (const i of row) {
        cum += a[i]!.w;
        near(cum * 12, Math.round(cum * 12), 1e-6);
        expect(a[i]!.w).toBeGreaterThanOrEqual(minFrac(W) - 1e-9);
      }
    }
    expect(a.map((f) => f.h)).toEqual([310, 310, 500, 500, 500, 200]);
    checkPlaced(place(a, W), a, W);
    expect(alignTwelfths(a, W)).toEqual(a);
    expect(alignTwelfths(a.map(tidy), W).map(tidy)).toEqual(a.map(tidy));
  });

  test("align keeps a card at the minimum when the nearest twelfth would cut it", () => {
    const W2 = 720;
    const lo = minFrac(W2);
    const a = alignTwelfths([{ w: lo, h: 300 }, { w: lo, h: 300 }, { w: 1 - 2 * lo, h: 300 }], W2);
    for (const f of a) expect(f.w).toBeGreaterThanOrEqual(lo - 1e-9);
    expect(alignTwelfths(a, W2)).toEqual(a);
  });

  test("split evenly fills every row with equal widths and gives rows the median height; idempotent", () => {
    const s = splitEvenly(messy);
    expect(breakRows(s.map((f) => f.w))).toEqual(breakRows(messy.map((f) => f.w)));
    for (const row of breakRows(s.map((f) => f.w))) for (const i of row) near(s[i]!.w, 1 / row.length);
    expect(new Set(s.map((f) => f.h))).toEqual(new Set([310]));
    expect(splitEvenly(s)).toEqual(s);
    checkPlaced(place(s, W), s, W);
    expect(splitEvenly(s.map(tidy)).map(tidy)).toEqual(s.map(tidy));
  });
});

describe("sizes and classes", () => {
  test("the nearest classic size, judged in a 1100px area", () => {
    expect(nearestSize({ w: 1 / 3, h: 300 })).toBe("1x1");
    expect(nearestSize({ w: fracOf(560, 1100), h: 479 })).toBe("2x1");
    expect(nearestSize({ w: fracOf(559, 1100), h: 480 })).toBe("1x2");
    expect(nearestSize({ w: 1, h: 900 })).toBe("2x2");
  });

  test("the size class from the drawn box, with a 16px band that keeps it from flickering", () => {
    expect(sizeClass(undefined, 559, 479)).toBe("1x1");
    expect(sizeClass(undefined, 560, 480)).toBe("2x2");
    expect(sizeClass("2x2", 550, 470)).toBe("2x2");
    expect(sizeClass("2x2", 543, 463)).toBe("1x1");
    expect(sizeClass("1x1", 555, 475)).toBe("1x1");
    expect(sizeClass("2x1", 550, 475)).toBe("2x1");
  });
});

describe("writes", () => {
  test("only the changed cards are written, each with its nearest size, with the write that undoes it", () => {
    const cards = [
      { id: "a/w", size: "1x1" },
      { id: "b/w", size: "1x1", frame: { w: 0.5, h: 300 } },
      { id: "c/w", size: "2x1" },
    ];
    const before: Frame[] = [
      { w: 0.5, h: 300 },
      { w: 0.5, h: 300 },
      { w: 1, h: 300 },
    ];
    const after = setWidth(before, 1100, 0, pxOf(0.7, 1100));
    const r = framesWrite(cards, before, after)!;
    expect(Object.keys(r.write.frames!)).toEqual(["a/w", "b/w"]);
    expect(r.write.sizes).toEqual({ "a/w": "2x1", "b/w": "1x1" });
    expect(r.undo).toEqual({ frames: { "a/w": null, "b/w": { w: 0.5, h: 300 } }, sizes: { "a/w": "1x1", "b/w": "1x1" } });
    expect(framesWrite(cards, before, before)).toBeNull();
    const applied = applyWrite(cards, r.write);
    expect(applied[0]).toMatchObject({ size: "2x1", frame: { w: 0.7, h: 300 } });
    expect(applyWrite(applied, r.undo)).toEqual(cards);
    // A size alone drops the frame, as the server does.
    expect(applyWrite(applied, { sizes: { "a/w": "1x2" } })[0]).toEqual({ id: "a/w", size: "1x2" });
  });

  test("stored frames are rounded and within the server's bounds", () => {
    expect(tidy({ w: 0.123456789, h: 333.6 })).toEqual({ w: 0.123457, h: 334 });
    expect(tidy({ w: 0.01, h: 50 })).toEqual({ w: 0.1, h: MIN_H });
  });
});

describe("rows per page", () => {
  test("all rows when they fit, else the most whose every page fits above the pager, at least one per column", () => {
    expect(rowsThatFit(234, [32, 32, 32, 32, 56], 2, 1, 26)).toBe(5);
    expect(rowsThatFit(200, [30, 30, 30, 30, 30, 30, 30, 30, 30], 2, 1, 26)).toBe(5);
    // Mixed heights: a page must fit with its tallest rows.
    expect(rowsThatFit(130, [30, 30, 30, 60, 30, 30], 2, 1, 26)).toBe(2);
    // Two columns: a grid row is as tall as its taller cell.
    expect(rowsThatFit(200, Array(20).fill(30), 2, 2, 26)).toBe(10);
    expect(rowsThatFit(10, [30, 30, 30, 30], 2, 1, 26)).toBe(1);
    expect(rowsThatFit(-50, [30, 30, 30, 30], 2, 2, 26)).toBe(2);
    expect(rowsThatFit(100, [], 2, 1, 26)).toBe(1);
  });
});

describe("a drag from the press (startResize, resizeTo) and the keys (nudge, keyStep)", () => {
  const W = 1100;
  const two: Frame[] = [{ w: 0.5, h: 300 }, { w: 0.5, h: 300 }, { w: 1 / 3, h: 400 }];

  test("the right edge moves the boundary with the next card; Alt stops the snap, Shift re-flows", () => {
    const s = startResize(two, W, "start", 0, "x");
    const snapped = resizeTo(s, 5, 0);
    // The edge starts on the area's half: a 5px move stays within 8px of it and snaps back.
    near(snapped.frames[0]!.w, 0.5);
    expect(snapped.guides.x.length).toBe(1);
    const free = resizeTo(s, 5, 0, { free: true });
    near(pxOf(free.frames[0]!.w, W), pxOf(0.5, W) + 5);
    near(free.frames[0]!.w + free.frames[1]!.w, 1);
    expect(free.guides.x).toEqual([]);
    const reflow = resizeTo(s, 100, 0, { reflow: true, free: true });
    near(pxOf(reflow.frames[0]!.w, W), pxOf(0.5, W) + 100);
    near(reflow.frames[1]!.w, 0.5);
  });

  test("the bottom edge sets the row's height and snaps to another row's", () => {
    const s = startResize(two, W, "start", 1, "y");
    const r = resizeTo(s, 0, 96);
    expect(r.frames[0]!.h).toBe(400);
    expect(r.frames[1]!.h).toBe(400);
    expect(r.frames[2]!.h).toBe(400);
    expect(r.guides.y.length).toBe(2);
    expect(resizeTo(s, 0, 96, { free: true }).frames[1]!.h).toBe(396);
  });

  test("the last card of a centred row grows twice the pointer's travel", () => {
    const s = startResize(two, W, "center", 2, "x");
    const r = resizeTo(s, 50, 0, { free: true });
    near(pxOf(r.frames[2]!.w, W), pxOf(1 / 3, W) + 100);
  });

  test("the keys move a handle 8px, 1px with Shift, and only along its own axis", () => {
    expect(keyStep("x", "right", false)).toEqual({ dx: 8, dy: 0 });
    expect(keyStep("x", "down", false)).toEqual({ dx: 0, dy: 0 });
    expect(keyStep("y", "up", true)).toEqual({ dx: 0, dy: -1 });
    expect(keyStep("xy", "left", true)).toEqual({ dx: -1, dy: 0 });
    const f = nudge(two, W, "start", 0, 8, 8);
    near(pxOf(f[0]!.w, W), pxOf(0.5, W) + 8);
    expect(f[1]!.h).toBe(308);
  });
});
