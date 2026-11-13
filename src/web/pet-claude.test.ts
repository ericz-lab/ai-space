import { expect, test } from "bun:test";
import { join } from "node:path";
import { BUILTIN } from "./Pet.tsx";
import { CELL_H, CELL_W, COLS, ROWS } from "./pets/claude.ts";

test("the Claude pet's sprite says what pets/claude.py renders", async () => {
  const sprite = BUILTIN.claude!.sprite;
  // claude.py's ANIMS is a Python dict of plain literals, which is also JSON.
  const py = await Bun.file(join(import.meta.dir, "pets/claude.py")).text();
  const anims = JSON.parse(/^ANIMS = (\{[\s\S]*?\n\})/m.exec(py)![1]!.replace(/,(\s*\})/g, "$1")) as Record<string, { row: number; frames: number; ms: number }>;
  expect(Object.fromEntries(Object.entries(sprite.anims).map(([name, a]) => [name, { row: a.row, frames: a.frames, ms: a.ms }]))).toEqual(anims);
  expect([sprite.columns, sprite.rows]).toEqual([COLS, ROWS]);
  for (const a of Object.values(anims)) expect(a.frames).toBeLessThanOrEqual(COLS);
  // The scuttle is drawn for this width and the panel's speed.
  expect(py).toContain(`WIDTH_PX, SPEED = ${sprite.width}, 55`);
  for (const [name] of sprite.rests) expect(sprite.anims[name]).toBeDefined();
  expect(sprite.anims[sprite.right]).toBeDefined();
  expect(sprite.anims[sprite.click!]).toBeDefined();
  // The Space's mood (docs/app-spec.md#space-mood) names only animations the sheet has.
  for (const name of [...Object.values(sprite.moods!.rest), ...Object.values(sprite.moods!.once ?? {})]) expect(sprite.anims[name]).toBeDefined();
});

test("the bundled sheet is a WebP of the grid's size", async () => {
  const bytes = new Uint8Array(await Bun.file(join(import.meta.dir, "public/pet-claude.webp")).arrayBuffer());
  const text = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));
  expect([text(0, 4), text(8, 12)]).toEqual(["RIFF", "WEBP"]);
  // An extended (VP8X) file, as one with alpha is, carries the canvas size minus one in 24-bit fields.
  expect(text(12, 16)).toBe("VP8X");
  const u24 = (at: number) => bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
  expect([u24(24) + 1, u24(27) + 1]).toEqual([CELL_W * COLS, CELL_H * ROWS]);
});
