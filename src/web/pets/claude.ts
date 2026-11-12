// Build the built-in Claude pet's sprite sheet (bun src/web/pets/claude.ts): Blender renders every frame of
// every animation from the 3D model in claude.py, and ImageMagick lays the frames out in the sheet's grid.
// Blender 4.2+ and ImageMagick 7 are needed only to rebuild the sheet; the result is committed.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CELL_W = 192;
export const CELL_H = 192;
// One column per frame of the longest animation; shorter rows leave their last cells empty.
export const COLS = 12;
export const ROWS = 5;
// Frames are rendered at twice the cell and scaled down, for clean edges.
const RENDER = 384;

export type Spec = Record<string, { row: number; frames: number; ms: number }>;

async function run(cmd: string[]): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd[0]} failed: ${err || out.slice(-2000)}`);
  return out;
}

const blender = (args: string[]) => run([process.env.BLENDER ?? "blender", "--background", "--factory-startup", "--python", join(import.meta.dir, "claude.py"), "--", ...args]);

/** The animations claude.py renders: row, frames and loop time. */
export async function spec(): Promise<Spec> {
  const line = (await blender(["--spec"])).split("\n").find((l) => l.startsWith("SPEC "));
  if (!line) throw new Error("claude.py printed no SPEC");
  return JSON.parse(line.slice(5)) as Spec;
}

export async function render(output: string) {
  const temp = await mkdtemp(join(tmpdir(), "space-pet-claude-"));
  try {
    const anims = await spec();
    await blender(["--out", temp, "--size", String(RENDER)]);
    // Lay the cells out by hand: `montage` wants a font even for unlabelled tiles.
    const rows: string[] = [];
    for (let row = 0; row < ROWS; row++) {
      const [name, anim] = Object.entries(anims).find(([, a]) => a.row === row)!;
      const cells = Array.from({ length: COLS }, (_, col) => (col < anim.frames ? join(temp, `${name}-${String(col).padStart(2, "0")}.png`) : "xc:none"));
      const strip = join(temp, `row-${row}.png`);
      await run(["magick", "-size", `${RENDER}x${RENDER}`, "-background", "none", ...cells, "-filter", "Lanczos", "-resize", `${CELL_W}x${CELL_H}`, "+append", `PNG32:${strip}`]);
      rows.push(strip);
    }
    await run(["magick", ...rows, "-background", "none", "-append", "-strip", "-quality", "92", "-define", "webp:alpha-quality=100", "-define", "webp:method=6", output]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const output = join(import.meta.dir, "../public/pet-claude.webp");
  await render(output);
  console.log("src/web/public/pet-claude.webp written");
}
