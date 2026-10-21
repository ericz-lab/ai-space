import type { Manifest } from "../scheduler/manifest.ts";
import type { ManifestPet, PetAnimation } from "./pet-spec.ts";
import type { AppRegistry } from "./registry.ts";
import { resolveLink } from "./view.ts";

/**
 * Desk pets that apps declare (`pets:`, docs/app-spec.md#pets). The panel lists them, loads each sheet
 * through ai-space and asks for the mood on the pet's `refresh`. Sources may be loopback addresses and
 * never reach the browser; only the fields of the contract do. A mood that cannot be read is reported
 * as `{ ok: false }` and the panel lets the pet rest, never invents one.
 */

export type PetView = {
  /** `<app>/<name>`. */
  id: string;
  app: string;
  name: string;
  title: string;
  i18n?: Record<string, { title?: string }>;
  /** Same-origin URL of the sheet. */
  sheet: string;
  columns: number;
  rows: number;
  width: number;
  pixelated: boolean;
  animations: Record<string, PetAnimation>;
  rest: string;
  hasMood: boolean;
  refreshMs: number;
};

/** What the pet does now: rest in `animation`, roam between rests or stay put, and say a line. */
export type PetMood = {
  ok: true;
  animation: string;
  move: "roam" | "stay";
  /** A short line over the pet, by language (`en` is the fallback); absent = nothing to say. */
  say?: Record<string, string>;
  /** Where a click on the pet goes; http(s) only. */
  link?: string;
  asOf?: string;
};
type MoodResult = PetMood | { ok: false; error: string };

const SHEET_TYPES = ["image/png", "image/webp", "image/gif"];
const MAX_SHEET_BYTES = 2 * 1024 * 1024;
const MAX_SAY = 80;
const ERROR_RETRY_MS = 15_000;

export class NoPet extends Error {}

export class PetFeed {
  private readonly moods = new Map<string, { at: number; data: MoodResult }>();
  private readonly sheets = new Map<string, { at: number; type: string; bytes: Uint8Array }>();

  constructor(
    private readonly registry: AppRegistry,
    private readonly opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
  ) {}

  list(hidden: Set<string> = new Set()): PetView[] {
    const out: PetView[] = [];
    for (const { manifest: m } of this.registry.list()) {
      if (!m.pets || m.status === "archived" || hidden.has(m.app)) continue;
      for (const p of m.pets) {
        const i18n = Object.fromEntries(Object.entries(m.i18n ?? {}).flatMap(([lang, t]) => (t.pets?.[p.name]?.title ? [[lang, { title: t.pets[p.name]!.title! }]] : [])));
        out.push({
          id: `${m.app}/${p.name}`,
          app: m.app,
          name: p.name,
          title: p.title ?? p.name,
          ...(Object.keys(i18n).length ? { i18n } : {}),
          sheet: `/api/pets/${encodeURIComponent(m.app)}/${encodeURIComponent(p.name)}/sheet`,
          columns: p.columns,
          rows: p.rows,
          width: p.width,
          pixelated: p.pixelated,
          animations: p.animations,
          rest: p.rest,
          hasMood: !!p.mood,
          refreshMs: p.refreshMs,
        });
      }
    }
    return out;
  }

  /** The sheet image, cached for an hour; only PNG, WebP and GIF pass. */
  async sheet(app: string, name: string): Promise<{ type: string; bytes: Uint8Array }> {
    const { m, p } = this.find(app, name);
    const key = `${app}/${name}`;
    const hit = this.sheets.get(key);
    if (hit && Date.now() - hit.at < 3_600_000) return hit;
    const r = await this.get(m, p.sheet);
    if (!r.ok) throw new Error(`sheet: HTTP ${r.status}`);
    const type = (r.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!SHEET_TYPES.includes(type)) throw new Error(`sheet: ${type || "no content type"} is not PNG, WebP or GIF`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes.byteLength > MAX_SHEET_BYTES) throw new Error("sheet: larger than 2 MB");
    const out = { at: Date.now(), type, bytes };
    this.sheets.set(key, out);
    return out;
  }

  async mood(app: string, name: string): Promise<MoodResult> {
    const { m, p } = this.find(app, name);
    if (!p.mood) return { ok: true, animation: p.rest, move: "roam" };
    const key = `${app}/${name}`;
    const hit = this.moods.get(key);
    const ttl = hit?.data.ok === false ? Math.min(p.refreshMs, ERROR_RETRY_MS) : p.refreshMs;
    if (hit && Date.now() - hit.at < ttl) return hit.data;
    let data: MoodResult;
    try {
      const r = await this.get(m, p.mood);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      data = sanitizeMood(m, p, await r.json());
    } catch (e) {
      data = { ok: false, error: String((e as Error).message ?? e).slice(0, 200) };
    }
    this.moods.set(key, { at: Date.now(), data });
    return data;
  }

  private find(app: string, name: string): { m: Manifest; p: ManifestPet } {
    const m = this.registry.get(app)?.manifest;
    const p = m?.status === "archived" ? undefined : m?.pets?.find((x) => x.name === name);
    if (!m || !p) throw new NoPet(`no pet: ${app}/${name}`);
    return { m, p };
  }

  private get(m: Manifest, src: string): Promise<Response> {
    const url = src.startsWith("/") ? `http://127.0.0.1:${m.service!.port}${src}` : src;
    return (this.opts.fetch ?? fetch)(url, { redirect: "error", signal: AbortSignal.timeout(this.opts.timeoutMs ?? 8_000) });
  }
}

/** Only the contract's fields; an animation the manifest does not declare (or `walk`) is refused. */
export function sanitizeMood(m: Manifest, p: ManifestPet, raw: unknown): MoodResult {
  const j = (raw ?? {}) as Record<string, unknown>;
  if (j.ok !== true) throw new Error(typeof j.error === "string" ? j.error.slice(0, 200) : "response is not { ok: true, animation }");
  const animation = j.animation;
  if (typeof animation !== "string" || animation === "walk" || !p.animations[animation]) throw new Error(`unknown animation: ${String(animation).slice(0, 40)}`);
  const out: PetMood = { ok: true, animation, move: j.move === "stay" ? "stay" : "roam" };
  const say = typeof j.say === "string" ? { en: j.say } : j.say && typeof j.say === "object" ? (j.say as Record<string, unknown>) : undefined;
  if (say) {
    const lines = Object.entries(say).filter((e): e is [string, string] => /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(e[0]) && typeof e[1] === "string" && !!e[1].trim());
    if (lines.length) out.say = Object.fromEntries(lines.slice(0, 8).map(([k, v]) => [k, v.trim().slice(0, MAX_SAY)]));
  }
  if (typeof j.link === "string" && j.link) {
    const abs = resolveLink(m, j.link);
    if (/^https?:\/\//.test(abs)) out.link = abs;
  }
  if (typeof j.asOf === "string" && !Number.isNaN(Date.parse(j.asOf))) out.asOf = j.asOf;
  return out;
}
