// The widget area's layout, without the DOM (docs/panel.md#resize-a-widget): a flow of cards with a
// fixed gap, wrapped into rows. Each card has a frame `{ w, h }`: `w` a fraction of the area's width,
// `h` a height in px. A card `w` wide is `w * (W + GAP) - GAP` px in an area `W` wide, so fractions
// that sum to 1 fill a row exactly with `GAP` between the cards at any width. Every card of a row
// takes the row's height, the largest `h` in it, and rows are `GAP` apart. The page's bundle and the
// tests share this file; it imports nothing.

export const GAP = 20;
export const MIN_W = 200;
export const MIN_H = 140;
export const MAX_H = 900;
/** The smallest fraction the server keeps (src/space/panel/layout.ts). */
export const MIN_FRAC = 0.1;
/** Below this viewport width the area is one column, as the stylesheet's 700px breakpoint. */
export const ONE_COLUMN_BELOW = 700;
/** The old grid's column (`minmax(320px, 1fr)`) and the height a card without a frame gets per row. */
export const OLD_COLUMN = 320;
export const ROW_H = 300;
/** How close an edge has to come to a candidate to snap to it. */
export const SNAP_PX = 8;
/** The equal divisions of the area an edge snaps to. */
export const DIVISIONS = [1 / 4, 1 / 3, 1 / 2, 2 / 3, 3 / 4, 1];
/** Row sums may exceed 1 by this much (stored fractions are rounded) and still fit. */
const EPS = 1e-4;
/** The size class thresholds and the band around them that keeps a dragged card from flickering. */
export const WIDE_AT = 560;
export const TALL_AT = 480;
export const HYSTERESIS = 16;
/** The reference area the nearest classic size is judged in. */
const REFERENCE_W = 1100;

export type Frame = { w: number; h: number };
export type Align = "start" | "center";
export type Box = { x: number; y: number; width: number; height: number; row: number };
export type Placed = { boxes: Box[]; rows: number[][]; height: number };

export const pxOf = (w: number, W: number): number => w * (W + GAP) - GAP;
export const fracOf = (px: number, W: number): number => (px + GAP) / (W + GAP);
/** The smallest fraction a card can be in an area `W` wide: 200px, or the whole area when it is narrower. */
export const minFrac = (W: number): number => (W <= MIN_W ? 1 : Math.min(1, Math.max(MIN_FRAC, fracOf(MIN_W, W))));
export const clampH = (h: number): number => Math.min(MAX_H, Math.max(MIN_H, Math.round(Number.isFinite(h) ? h : ROW_H)));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** The number of 320px+ columns the old grid had in an area `W` wide. */
export const oldColumns = (W: number): number => Math.max(1, Math.floor((W + GAP) / (OLD_COLUMN + GAP)));

/** A classic size's columns and rows; anything else is 1x1. */
export function spanOf(size: string | undefined): [number, number] {
  const m = /^([12])x([12])$/.exec(size ?? "");
  return m ? [Number(m[1]), Number(m[2])] : [1, 1];
}

/** The frame of a card without one: its size's columns of the old grid at this width, and its rows' height. */
export function defaultFrame(size: string | undefined, W: number): Frame {
  const n = oldColumns(W);
  const [cols, rows] = spanOf(size);
  return { w: Math.min(cols, n) / n, h: rows === 1 ? ROW_H : 2 * ROW_H + GAP };
}

/** A frame as drawn in an area `W` wide: at least the minimum width, the height within its bounds. */
export function effective(f: Frame, W: number): Frame {
  return { w: clamp(Number.isFinite(f.w) ? f.w : 1, minFrac(W), 1), h: clampH(f.h) };
}

/** The frames of an area's cards as drawn: the stored frame, else the default from the size. */
export function resolveFrames(cards: { size?: string; frame?: Frame }[], W: number): Frame[] {
  return cards.map((c) => effective(c.frame ?? defaultFrame(c.size, W), W));
}

/** Rows of card indices: a card goes on the current row while the row's fractions stay at most 1. */
export function breakRows(ws: number[]): number[][] {
  const rows: number[][] = [];
  let cur: number[] = [];
  let used = 0;
  ws.forEach((w, i) => {
    if (cur.length && used + w > 1 + EPS) {
      rows.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(i);
    used += w;
  });
  if (cur.length) rows.push(cur);
  return rows;
}

/** The px width a row's cards take, gaps between them included. */
export const rowWidth = (frames: Frame[], row: number[], W: number): number => Math.min(W, sum(row.map((i) => frames[i]!.w)) * (W + GAP) - GAP);

/** Where every card goes; `frames` are as drawn (`effective`). */
export function place(frames: Frame[], W: number, align: Align = "start"): Placed {
  const rows = breakRows(frames.map((f) => f.w));
  const boxes: Box[] = new Array(frames.length);
  let y = 0;
  rows.forEach((row, r) => {
    const height = Math.max(...row.map((i) => frames[i]!.h));
    let x = align === "center" ? Math.max(0, (W - rowWidth(frames, row, W)) / 2) : 0;
    for (const i of row) {
      const width = Math.min(W, pxOf(frames[i]!.w, W));
      boxes[i] = { x, y, width, height, row: r };
      x += width + GAP;
    }
    y += height + GAP;
  });
  return { boxes, rows, height: Math.max(0, y - GAP) };
}

/**
 * Card `i` set to `px` wide. The default moves the boundary with the next card of its row, which
 * takes or gives the difference (both stay above the minimum); the last card of a row grows into
 * the row's free space and no further. `reflow` (Shift) changes this card only and lets the cards
 * after it wrap.
 */
export function setWidth(frames: Frame[], W: number, i: number, px: number, reflow = false): Frame[] {
  const out = frames.map((f) => ({ ...f }));
  const lo = minFrac(W);
  const want = fracOf(px, W);
  if (reflow) {
    out[i]!.w = clamp(want, lo, 1);
    return out;
  }
  const row = breakRows(frames.map((f) => f.w)).find((r) => r.includes(i))!;
  const k = row.indexOf(i);
  const next = row[k + 1];
  if (next !== undefined) {
    const pair = frames[i]!.w + frames[next]!.w;
    out[i]!.w = clamp(want, lo, Math.max(lo, pair - lo));
    out[next]!.w = pair - out[i]!.w;
    return out;
  }
  const free = Math.max(0, 1 - sum(row.map((j) => frames[j]!.w)));
  out[i]!.w = clamp(want, lo, Math.max(lo, frames[i]!.w + free));
  return out;
}

/** Every card in card `i`'s row set to `h` px tall. */
export function setRowHeight(frames: Frame[], i: number, h: number): Frame[] {
  const row = breakRows(frames.map((f) => f.w)).find((r) => r.includes(i))!;
  return frames.map((f, j) => (row.includes(j) ? { ...f, h: clampH(h) } : { ...f }));
}

/** The nearest candidate within `within` px of `value`, or null. */
export function snapTo(value: number, candidates: number[], within = SNAP_PX): { value: number; at: number } | null {
  let best: number | null = null;
  for (const c of candidates) if (Math.abs(c - value) <= within && (best === null || Math.abs(c - value) < Math.abs(best - value))) best = c;
  return best === null ? null : { value: best, at: best };
}

/**
 * Where card `i`'s right edge may snap, measured from its row's left edge: the area's equal
 * divisions, and the edges of the cards in other rows (a right edge, and a left edge less the gap,
 * so the card after this one lines up with it). In a centred area the other rows' edges are taken
 * relative to this row's offset at the start of the drag.
 */
export function edgeCandidates(placed: Placed, W: number, i: number): number[] {
  const me = placed.boxes[i]!;
  const off = placed.boxes[placed.rows[me.row]![0]!]!.x;
  const out = DIVISIONS.map((f) => pxOf(f, W));
  placed.boxes.forEach((b, j) => {
    if (b.row === me.row || j === i) return;
    out.push(b.x + b.width - off, b.x - GAP - off);
  });
  return out.filter((x) => x > 0 && x <= W + 0.5);
}

/** The heights of the rows other than card `i`'s, which its row's height may snap to. */
export function heightCandidates(placed: Placed, i: number): number[] {
  const me = placed.boxes[i]!.row;
  return [...new Set(placed.rows.filter((_, r) => r !== me).map((row) => placed.boxes[row[0]!]!.height))];
}

/**
 * Align: in every row each boundary moves to the nearest twelfth of the area (every card kept above
 * the minimum), and rows whose heights are within 24px of each other take the tallest of them.
 */
export function alignTwelfths(frames: Frame[], W: number): Frame[] {
  const out = frames.map((f) => ({ ...f }));
  const lo = minFrac(W);
  const rows = breakRows(frames.map((f) => f.w));
  for (const row of rows) {
    let prev = 0;
    let cum = 0;
    row.forEach((i, k) => {
      cum += frames[i]!.w;
      const rest = row.length - 1 - k;
      const min = prev + lo;
      const max = Math.max(min, 1 - rest * lo);
      let c = Math.round(cum * 12) / 12;
      if (c < min - 1e-9) c = Math.ceil(min * 12 - 1e-9) / 12;
      if (c > max + 1e-9) c = Math.floor(max * 12 + 1e-9) / 12;
      c = clamp(c, min, max);
      out[i]!.w = c - prev;
      prev = c;
    });
  }
  const heights = rows.map((row) => Math.max(...row.map((i) => frames[i]!.h)));
  const order = heights.map((h, r) => [h, r] as const).sort((a, b) => b[0] - a[0]);
  let top = Number.POSITIVE_INFINITY;
  for (const [h, r] of order) {
    if (top - h > 24) top = h;
    for (const i of rows[r]!) out[i]!.h = top;
  }
  return out;
}

/** Split evenly: the cards of every row get equal widths that fill it, every row the median height. */
export function splitEvenly(frames: Frame[]): Frame[] {
  const out = frames.map((f) => ({ ...f }));
  const rows = breakRows(frames.map((f) => f.w));
  const heights = rows.map((row) => Math.max(...row.map((i) => frames[i]!.h))).sort((a, b) => a - b);
  const mid = heights.length >> 1;
  const median = heights.length % 2 ? heights[mid]! : Math.round((heights[mid - 1]! + heights[mid]!) / 2);
  for (const row of rows) for (const i of row) out[i] = { w: 1 / row.length, h: median };
  return out;
}

/** A frame as stored: rounded, within the server's bounds. */
export function tidy(f: Frame): Frame {
  return { w: Math.round(clamp(f.w, MIN_FRAC, 1) * 1e6) / 1e6, h: clampH(f.h) };
}

export const sameFrame = (a: Frame | undefined, b: Frame | undefined): boolean => !!a && !!b && Math.abs(a.w - b.w) < 1e-6 && Math.abs(a.h - b.h) < 0.5;

/** The classic size closest to a frame, for clients that only know `sizes`: judged in a 1100px area. */
export function nearestSize(f: Frame): string {
  const cols = pxOf(f.w, REFERENCE_W) >= WIDE_AT ? 2 : 1;
  const rows = f.h >= TALL_AT ? 2 : 1;
  return `${cols}x${rows}`;
}

/**
 * The size class a card's inner layout follows (`1x1`, `2x1`, `1x2`, `2x2`), from its drawn box: wide
 * at 560px, tall at 480px. Once wide or tall it stays so until 16px below, so a dragged edge near a
 * threshold does not flip the layout back and forth.
 */
export function sizeClass(prev: string | undefined, width: number, height: number): string {
  const [pc, pr] = prev ? spanOf(prev) : [0, 0];
  const wide = pc === 2 ? width >= WIDE_AT - HYSTERESIS : width >= WIDE_AT;
  const tall = pr === 2 ? height >= TALL_AT - HYSTERESIS : height >= TALL_AT;
  return `${wide ? 2 : 1}x${tall ? 2 : 1}`;
}

/** A write to the layout: frames by widget id (`null` removes one), sizes alongside, the alignment. */
export type LayoutWrite = { frames?: Record<string, Frame | null>; sizes?: Record<string, string>; widgetAlign?: Align };

/**
 * The write that takes an area from `before` to `after` (frames as drawn), with the one that undoes
 * it. Only the cards whose frame changed are written; each also gets its nearest classic size.
 */
export function framesWrite(
  cards: { id: string; size: string; frame?: Frame }[],
  before: Frame[],
  after: Frame[],
): { write: LayoutWrite; undo: LayoutWrite } | null {
  const write: Required<Pick<LayoutWrite, "frames" | "sizes">> = { frames: {}, sizes: {} };
  const undo: Required<Pick<LayoutWrite, "frames" | "sizes">> = { frames: {}, sizes: {} };
  cards.forEach((c, i) => {
    if (sameFrame(before[i], after[i])) return;
    const f = tidy(after[i]!);
    write.frames[c.id] = f;
    write.sizes[c.id] = nearestSize(f);
    undo.frames[c.id] = c.frame ?? null;
    undo.sizes[c.id] = c.size;
  });
  return Object.keys(write.frames).length ? { write, undo } : null;
}

/**
 * A layout write applied to the page's widget list (frames and sizes), as the server stores it: a
 * size written without a frame for the same widget drops its frame (a client that only knows sizes).
 */
export function applyWrite<T extends { id: string; size: string; frame?: Frame }>(widgets: T[], write: LayoutWrite): T[] {
  return widgets.map((w) => {
    const hasFrame = !!write.frames && w.id in write.frames;
    const size = write.sizes?.[w.id];
    if (!hasFrame && !size) return w;
    const next = { ...w, ...(size ? { size } : {}) };
    const f = hasFrame ? write.frames![w.id] : null;
    if (f) next.frame = f;
    else delete next.frame;
    return next;
  });
}

/**
 * How many compact rows a card of a fixed height shows per page: the most rows such that every page
 * (its rows laid out in `cols` columns, a grid row as tall as its tallest cell, `gap` apart) fits in
 * the `avail` px under the hero; all of them when they fit at once, else with the pager's `pagerH`
 * kept free. Never fewer than one row per column.
 */
export function rowsThatFit(avail: number, heights: number[], gap: number, cols: number, pagerH: number): number {
  const total = heights.length;
  const c = Math.max(1, cols);
  if (total === 0) return 1;
  const pageHeight = (rows: number[]) => {
    let h = 0;
    for (let k = 0; k < rows.length; k += c) h += Math.max(...rows.slice(k, k + c)) + (k ? gap : 0);
    return h;
  };
  const fits = (n: number, room: number) => {
    for (let k = 0; k < total; k += n) if (pageHeight(heights.slice(k, k + n)) > room + 0.5) return false;
    return true;
  };
  if (fits(total, avail)) return total;
  for (let n = total - 1; n > c; n--) if (fits(n, avail - pagerH)) return n;
  return c;
}
