import { parseDuration } from "../scheduler/schedule.ts";

/**
 * An entry of the `pets:` manifest section (docs/app-spec.md#pets): a desk pet the panel can show walking
 * along the bottom of the page; an app may offer several. The app supplies a sprite sheet and, optionally, a mood: which of its animations
 * the pet rests in and whether it roams. The panel draws and moves the pet with its own code; nothing
 * from the app runs in the page.
 */

/**
 * One row of the sprite sheet: `frames` cells from the left, played over `ms`; with `pause`, the first
 * cell is held that much longer after each loop, so a bark can come in bursts.
 */
export type PetAnimation = { row: number; frames: number; ms: number; pause?: number };

export type ManifestPet = {
  name: string;
  title?: string;
  /** Path on the service or an https URL of a PNG, WebP or GIF sheet; never sent to the browser. */
  sheet: string;
  /** Cells across and down the sheet. */
  columns: number;
  rows: number;
  /** Width on the page in CSS pixels. */
  width: number;
  /** Draw the cells without smoothing (pixel art). */
  pixelated: boolean;
  /** `walk` faces right and is mirrored for walking left; the others are the poses a mood can name. */
  animations: Record<string, PetAnimation>;
  /** The animation the pet rests in while no mood is known. */
  rest: string;
  /** Path on the service or an https URL answering the mood; undefined = the pet always rests and roams. */
  mood?: string;
  refreshMs: number;
};

const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const MIN_REFRESH_MS = 15_000;
const MAX_ANIMATIONS = 16;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const int = (v: unknown, what: string, min: number, max: number): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new Error(`${what} must be an integer between ${min} and ${max}`);
  return v;
};
const source = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !v.trim()) throw new Error(`${what} is required`);
  const s = v.trim();
  if (!s.startsWith("/") && !s.startsWith("https://")) throw new Error(`${what} must be a path starting with / or an https URL`);
  return s;
};

export function parsePetSpec(raw: unknown, where = "pets[0]"): ManifestPet {
  if (!isRecord(raw)) throw new Error(`${where} must be a mapping with name / sheet / grid / animations`);
  for (const key of Object.keys(raw)) if (!["name", "title", "sheet", "grid", "width", "pixelated", "animations", "rest", "mood", "refresh"].includes(key)) throw new Error(`${where} has unknown key "${key}"`);
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) throw new Error(`${where}: invalid or missing name`);
  const pet = `pet "${name}"`;
  if (raw.title !== undefined && (typeof raw.title !== "string" || !raw.title.trim())) throw new Error(`${pet}: title must be a string`);
  const title = typeof raw.title === "string" ? raw.title.trim() : undefined;
  const sheet = source(raw.sheet, `${pet}: sheet`);
  const grid = typeof raw.grid === "string" ? raw.grid.match(/^(\d{1,2})x(\d{1,2})$/) : null;
  if (!grid) throw new Error(`${pet}: grid must be "<columns>x<rows>", for example 8x4`);
  const columns = int(Number(grid[1]), `${pet}: grid columns`, 1, 16);
  const rows = int(Number(grid[2]), `${pet}: grid rows`, 1, 16);
  const width = raw.width === undefined ? 70 : int(raw.width, `${pet}: width`, 24, 160);
  if (raw.pixelated !== undefined && typeof raw.pixelated !== "boolean") throw new Error(`${pet}: pixelated must be true or false`);
  if (!isRecord(raw.animations)) throw new Error(`${pet}: animations must map names to { row, frames, ms }`);
  const names = Object.keys(raw.animations);
  if (names.length > MAX_ANIMATIONS) throw new Error(`${pet}: animations holds at most ${MAX_ANIMATIONS} entries`);
  const animations: Record<string, PetAnimation> = {};
  for (const anim of names) {
    const ctx = `${pet} animation "${anim}"`;
    if (!NAME_RE.test(anim)) throw new Error(`${ctx}: invalid name`);
    const a = raw.animations[anim];
    if (!isRecord(a)) throw new Error(`${ctx} must be { row, frames, ms }`);
    for (const key of Object.keys(a)) if (!["row", "frames", "ms", "pause"].includes(key)) throw new Error(`${ctx} has unknown key "${key}"`);
    const pause = a.pause === undefined ? 0 : int(a.pause, `${ctx}: pause`, 0, 10_000);
    animations[anim] = { row: int(a.row, `${ctx}: row`, 0, rows - 1), frames: int(a.frames, `${ctx}: frames`, 1, columns), ms: int(a.ms, `${ctx}: ms`, 100, 10_000), ...(pause ? { pause } : {}) };
  }
  if (!animations.walk) throw new Error(`${pet}: animations needs walk (facing right)`);
  const rest = raw.rest === undefined ? names.find((n) => n !== "walk") : raw.rest;
  if (typeof rest !== "string" || rest === "walk" || !animations[rest]) throw new Error(`${pet}: rest must name an animation other than walk`);
  const mood = raw.mood === undefined ? undefined : source(raw.mood, `${pet}: mood`);
  const refreshMs = raw.refresh === undefined ? 30_000 : parseDuration(raw.refresh as string | number);
  if (refreshMs < MIN_REFRESH_MS) throw new Error(`${pet}: refresh must be at least 15s`);
  return { name, ...(title ? { title } : {}), sheet, columns, rows, width, pixelated: raw.pixelated === true, animations, rest, ...(mood ? { mood } : {}), refreshMs };
}
