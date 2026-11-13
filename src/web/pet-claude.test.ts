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

test("the Mac and iPhone pet plays the sheet as the web does", async () => {
  // desktop/macos/AISpace/Services/PetRules.swift holds the same table for the native clients.
  const swift = await Bun.file(join(import.meta.dir, "../../desktop/macos/AISpace/Services/PetRules.swift")).text();
  const sprite = BUILTIN.claude!.sprite;
  const anims: Record<string, { row: number; frames: number; ms: number; pause?: number }> = {};
  for (const m of swift.matchAll(/"(\w+)": PetAnimation\(row: (\d+), frames: (\d+), ms: (\d+)(?:, pause: (\d+))?\)/g)) {
    anims[m[1]!] = { row: Number(m[2]), frames: Number(m[3]), ms: Number(m[4]), ...(m[5] ? { pause: Number(m[5]) } : {}) };
  }
  expect(anims).toEqual(sprite.anims);
  expect(swift).toContain(`columns: ${sprite.columns}, rows: ${sprite.rows}, width: ${sprite.width}, speed: 55`);
  expect(swift).toContain(`rests: [${sprite.rests.map(([name, w]) => `("${name}", ${w})`).join(", ")}]`);
  const dict = (rec: Record<string, string>) => `[${Object.entries(rec).map(([k, v]) => `"${k}": "${v}"`).join(", ")}]`;
  expect(swift).toContain(`moodRests: ${dict(sprite.moods!.rest)}`);
  expect(swift).toContain(`moodOnce: ${dict(sprite.moods!.once!)}`);
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
