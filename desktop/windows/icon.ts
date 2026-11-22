// Draws the Windows client's icon (AISpace/Assets/AISpace.ico) from the ai-space mark
// (docs/logo.svg): three blue circles and the cyan leaf, on a transparent ground, filling the
// canvas so it still reads at 16 pixels on a light or a dark taskbar. The mark is a few simple
// shapes, so they are rasterized here, supersampled for smooth edges, with no drawing library;
// each size is a PNG and the .ico holds them all (a 256 entry is written as 0).
// Run `bun run windows:icon` after the mark changes.
import { join } from "node:path";

type Shape = { color: [number, number, number]; inside: (x: number, y: number) => boolean };

const circle = (cx: number, cy: number, r: number) => (x: number, y: number) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

/** `M 340 71 H 443 V 175 A 71 71 0 0 1 372 246 H 269 V 142 A 71 71 0 0 1 340 71 Z`: a square with two opposite corners rounded. */
const leaf = (x: number, y: number) => {
  if (x < 269 || x > 443 || y < 71 || y > 246) return false;
  if (x > 372 && y > 175) return (x - 372) ** 2 + (y - 175) ** 2 <= 71 * 71;
  if (x < 340 && y < 142) return (x - 340) ** 2 + (y - 142) ** 2 <= 71 * 71;
  return true;
};

const BLUE: [number, number, number] = [0x3f, 0x63, 0xcf];
const CYAN: [number, number, number] = [0x2c, 0xc8, 0xdc];
// Painted in order: a later shape covers an earlier one.
export const MARK: Shape[] = [
  { color: BLUE, inside: circle(159, 159, 97) },
  { color: BLUE, inside: circle(159, 353, 97) },
  { color: BLUE, inside: circle(353, 353, 97) },
  { color: CYAN, inside: leaf },
];
/** The mark's extent in the logo's 512 grid: the circles reach from 62 to 450 on both axes. */
const FROM = 62;
const TO = 450;

/** RGBA pixels of the mark at `side` pixels, with a margin of `side / 32` on each edge. */
export function draw(side: number, samples = side <= 32 ? 16 : side <= 64 ? 8 : 4): Uint8Array {
  const margin = side / 32;
  const scale = (TO - FROM) / (side - 2 * margin);
  const out = new Uint8Array(side * side * 4);
  const n = samples * samples;
  for (let py = 0; py < side; py++) {
    for (let px = 0; px < side; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = FROM + (px + (sx + 0.5) / samples - margin) * scale;
          const y = FROM + (py + (sy + 0.5) / samples - margin) * scale;
          let hit: Shape | undefined;
          for (const s of MARK) if (s.inside(x, y)) hit = s;
          if (!hit) continue;
          r += hit.color[0];
          g += hit.color[1];
          b += hit.color[2];
          a++;
        }
      }
      const i = (py * side + px) * 4;
      if (a > 0) {
        // Average of the covered samples (not premultiplied), opacity from the coverage.
        out[i] = Math.round(r / a);
        out[i + 1] = Math.round(g / a);
        out[i + 2] = Math.round(b / a);
        out[i + 3] = Math.round((255 * a) / n);
      }
    }
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, Bun.hash.crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** An 8-bit RGBA PNG, every row unfiltered, compressed with zlib. */
export function png(side: number, rgba: Uint8Array): Uint8Array {
  const header = new Uint8Array(13);
  const h = new DataView(header.buffer);
  h.setUint32(0, side);
  h.setUint32(4, side);
  header.set([8, 6, 0, 0, 0], 8);
  const raw = new Uint8Array(side * (side * 4 + 1));
  for (let y = 0; y < side; y++) raw.set(rgba.subarray(y * side * 4, (y + 1) * side * 4), y * (side * 4 + 1) + 1);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", zlib(raw)), chunk("IEND", new Uint8Array())];
  return concat(parts);
}

/** The zlib stream PNG wants: raw deflate from Bun.deflateSync with the zlib header and the Adler-32 around it. */
function zlib(data: Uint8Array<ArrayBuffer>): Uint8Array {
  let a = 1, b = 0;
  for (const byte of data) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  const sum = new Uint8Array(4);
  new DataView(sum.buffer).setUint32(0, ((b << 16) | a) >>> 0);
  return concat([new Uint8Array([0x78, 0xda]), Bun.deflateSync(data, { level: 9, windowBits: -15 }), sum]);
}

/** PNG entries in one .ico. */
export function ico(images: { side: number; png: Uint8Array }[]): Uint8Array {
  const head = new Uint8Array(6 + 16 * images.length);
  const v = new DataView(head.buffer);
  v.setUint16(2, 1, true);
  v.setUint16(4, images.length, true);
  let offset = head.length;
  images.forEach(({ side, png }, i) => {
    const at = 6 + 16 * i;
    head[at] = side % 256;
    head[at + 1] = side % 256;
    v.setUint16(at + 4, 1, true);
    v.setUint16(at + 6, 32, true);
    v.setUint32(at + 8, png.length, true);
    v.setUint32(at + 12, offset, true);
    offset += png.length;
  });
  return concat([head, ...images.map((i) => i.png)]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export const SIDES = [16, 24, 32, 48, 64, 128, 256];

if (import.meta.main) {
  const images = SIDES.map((side) => ({ side, png: png(side, draw(side)) }));
  const target = join(import.meta.dir, "AISpace", "Assets", "AISpace.ico");
  await Bun.write(target, ico(images));
  // `--png <dir>` also writes each size as a PNG, to look at.
  const i = process.argv.indexOf("--png");
  if (i > 0 && process.argv[i + 1]) for (const { side, png } of images) await Bun.write(join(process.argv[i + 1]!, `AISpace-${side}.png`), png);
  console.log(`wrote ${target}`);
}
