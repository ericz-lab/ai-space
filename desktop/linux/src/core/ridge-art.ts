/**
 * The mountain range behind the welcome window, drawn in binary digits: peaks whose slopes meet,
 * with a little noise along the line, as an image-to-ASCII tool would draw a picture with a "01"
 * character set and ordered (Bayer) dithering. The crest is drawn whole; below it the slopes
 * facing the light (from the left) keep more digits than those turned away. The picture is the
 * same every time and the same as the Windows and Mac clients' (RidgeArt.cs, RidgeArt.swift).
 */

const SEED = 11;
// Peaks stand about SPACING picture-heights apart, LOW to HIGH of it tall; a wider picture shows
// more of them, not the same ones stretched.
const SPACING = 0.9;
const LOW = 0.5;
const HIGH = 0.96;
const SLOPE = 0.87;
const DENSITY = 0.14;

const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

/**
 * `rows` lines of `cols` characters each, "0", "1" or a space. `cellAspect` is a character's
 * width over the line height, so the slopes keep their angle whatever the font.
 */
export function ridgeLines(cols: number, rows: number, cellAspect = 0.6): string[] {
  if (cols <= 0 || rows <= 0) return [];
  const aspect = (cols * cellAspect) / rows;
  const heights = Array.from({ length: cols + 2 }, (_, x) => height((x - 0.5) / cols, aspect) * rows);
  const lines: string[] = [];
  for (let y = 0; y < rows; y++) {
    let line = "";
    for (let x = 0; x < cols; x++) {
      const h = heights[x + 1]!;
      const depth = y + 0.5 - (rows - h);
      let show = false;
      if (depth >= 0) {
        const left = heights[x]!;
        const right = heights[x + 2]!;
        // A steep slope drops more than a row per column: the crest fills the gap.
        const crest = Math.max(1, (h - Math.min(left, right)) * 0.9);
        const density = DENSITY * (right < left ? 1.25 : 0.65);
        show = depth < crest || density > (BAYER[y % 4]![x % 4]! + 0.5) / 16;
      }
      line += show ? (hash(x * 131 + y * 977) < 0.5 ? "0" : "1") : " ";
    }
    lines.push(line);
  }
  return lines;
}

/** The range's height at `u` (0 to 1 across), as a fraction of the picture's height. */
function height(u: number, aspect: number): number {
  // v: across the picture in picture-heights, 0 in the middle, so it grows from the centre.
  const v = (u - 0.5) * aspect;
  let h = 0;
  const last = Math.ceil(aspect / 2 / SPACING) + 1;
  for (let i = -last; i <= last; i++) {
    const px = (i - 0.5 + hash(SEED * 100 + i) * 0.8) * SPACING;
    const ph = LOW + (HIGH - LOW) * hash(SEED * 100 + i + 50);
    const s = SLOPE * (0.7 + 0.6 * hash(SEED * 100 + i + 90));
    h = Math.max(h, ph - Math.abs(v - px) * s);
  }
  return h + 0.035 * (noise(v * 1.2, SEED) - 0.5) + 0.015 * (noise(v * 4, SEED + 3) - 0.5);
}

function noise(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash(i * 7919 + seed) * (1 - u) + hash((i + 1) * 7919 + seed) * u;
}

/** A number in [0, 1) from `n`, the same on every machine (32-bit, as the other clients). */
export function hash(n: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}
