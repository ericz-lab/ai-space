import type { Database } from "bun:sqlite";
import { WIDGET_SIZES, type WidgetSize } from "../scheduler/manifest.ts";

/**
 * A screen of the panel: a named page of entries pinned to it, in order. Entries are keys of the
 * form `app:<id>`, `agent:<id>`, `widget:<id>` or `builtin:<name>`; the library shows everything
 * else. The first screen is the home screen, the one the panel opens on.
 */
export type Screen = { id: string; name: string; items: string[] };

/**
 * Panel layout: the order of tiles and cards and the set of hidden apps.
 * Panel-owned state, kept in ai-space's own database so it follows the
 * workspace and never touches an app's repository.
 */

export type Layout = {
  order: { apps: string[]; agents: string[]; widgets: string[] };
  /** App names hidden from the panel; the apps stay registered and scheduled. */
  hidden: string[];
  /** Widget sizes the operator chose on the panel, by widget id; they override the manifest's `size`. */
  sizes: Record<string, WidgetSize>;
  /** Widget ids removed from the panel; the app and its other widgets stay. */
  hiddenWidgets: string[];
  /** The screens, home first; `null` until the panel stores its first set (it seeds the home screen then). */
  screens: Screen[] | null;
  /**
   * The stepless layout's frames by widget id (docs/panel.md#resize-a-widget): `w` a fraction of the
   * widget area's width, `h` a height in px. A widget without one is drawn from its size.
   */
  frames: Record<string, WidgetFrame>;
  /** Where a row's free space goes: after its cards, or split on both sides. */
  widgetAlign: "start" | "center";
};

export type WidgetFrame = { w: number; h: number };
export const FRAME_W = [0.1, 1] as const;
export const FRAME_H = [140, 900] as const;

/**
 * `sizes` merges: a size sets the widget, `null` returns it to the manifest's.
 * `hiddenWidgets` merges too: `true` removes the widget from the panel, `false` shows it again.
 * `frames` merges the same way, `null` removing one. A size written for a widget without a frame in
 * the same patch drops the widget's frame: a client that only knows sizes (the native apps) chose a
 * classic size, and the panel shows that one.
 */
export type LayoutPatch = Partial<{
  order: Partial<Layout["order"]>;
  hidden: string[];
  sizes: Record<string, string | null>;
  hiddenWidgets: Record<string, boolean>;
  screens: Screen[];
  frames: Record<string, WidgetFrame | null>;
  widgetAlign: string;
}>;

const EMPTY: Layout = { order: { apps: [], agents: [], widgets: [] }, hidden: [], sizes: {}, hiddenWidgets: [], screens: null, frames: {}, widgetAlign: "start" };
const KEY = "layout";
const MAX_NAMES = 500;
const MAX_SCREENS = 20;
export const HOME_SCREEN = "home";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS panel_kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export class LayoutStore {
  constructor(private readonly db: Database) {
    db.exec(SCHEMA);
  }

  read(): Layout {
    const row = this.db.query<{ value: string }, [string]>("SELECT value FROM panel_kv WHERE key = ?").get(KEY);
    if (!row) return structuredClone(EMPTY);
    try {
      const parsed = JSON.parse(row.value) as Partial<Layout>;
      return {
        order: {
          apps: names(parsed.order?.apps),
          agents: names(parsed.order?.agents),
          widgets: names(parsed.order?.widgets),
        },
        hidden: names(parsed.hidden),
        sizes: sizes(parsed.sizes),
        hiddenWidgets: names(parsed.hiddenWidgets),
        screens: Array.isArray(parsed.screens) ? screens(parsed.screens) : null,
        frames: frames(parsed.frames),
        widgetAlign: parsed.widgetAlign === "center" ? "center" : "start",
      };
    } catch {
      return structuredClone(EMPTY);
    }
  }

  /** Merge a patch into the stored layout; lists given replace the stored ones. */
  update(patch: LayoutPatch): Layout {
    const cur = this.read();
    if (patch.order !== undefined) {
      if (typeof patch.order !== "object" || patch.order === null) throw new Error("order must be an object");
      for (const k of ["apps", "agents", "widgets"] as const) {
        const v = patch.order[k];
        if (v === undefined) continue;
        if (!Array.isArray(v)) throw new Error(`order.${k} must be a list of names`);
        cur.order[k] = names(v);
      }
    }
    if (patch.hidden !== undefined) {
      if (!Array.isArray(patch.hidden)) throw new Error("hidden must be a list of names");
      cur.hidden = names(patch.hidden);
    }
    if (patch.sizes !== undefined) {
      if (typeof patch.sizes !== "object" || patch.sizes === null || Array.isArray(patch.sizes)) throw new Error("sizes must be an object of widget id to size");
      const framed = patch.frames && typeof patch.frames === "object" ? patch.frames : {};
      for (const [id, size] of Object.entries(patch.sizes)) {
        if (size === null) delete cur.sizes[id];
        else if (isSize(size)) cur.sizes[id] = size;
        else throw new Error(`sizes.${id}: size must be one of ${WIDGET_SIZES.join(", ")} or null`);
        if (!Object.hasOwn(framed, id)) delete cur.frames[id];
      }
      if (Object.keys(cur.sizes).length > MAX_NAMES) throw new Error("too many sizes");
    }
    if (patch.frames !== undefined) {
      if (typeof patch.frames !== "object" || patch.frames === null || Array.isArray(patch.frames)) throw new Error("frames must be an object of widget id to { w, h }");
      for (const [id, f] of Object.entries(patch.frames)) {
        if (f === null) delete cur.frames[id];
        else if (isFrame(f)) cur.frames[id] = { w: f.w, h: f.h };
        else throw new Error(`frames.${id}: must be { w, h } with w in [${FRAME_W.join(", ")}] and h in [${FRAME_H.join(", ")}], or null`);
      }
      if (Object.keys(cur.frames).length > MAX_NAMES) throw new Error("too many frames");
    }
    if (patch.widgetAlign !== undefined) {
      if (patch.widgetAlign !== "start" && patch.widgetAlign !== "center") throw new Error('widgetAlign must be "start" or "center"');
      cur.widgetAlign = patch.widgetAlign;
    }
    if (patch.hiddenWidgets !== undefined) {
      const hw = patch.hiddenWidgets;
      if (typeof hw !== "object" || hw === null || Array.isArray(hw)) throw new Error("hiddenWidgets must be an object of widget id to true or false");
      const set = new Set(cur.hiddenWidgets);
      for (const [id, hide] of Object.entries(hw)) {
        if (typeof hide !== "boolean") throw new Error(`hiddenWidgets.${id}: must be true or false`);
        if (hide) set.add(id);
        else set.delete(id);
      }
      if (set.size > MAX_NAMES) throw new Error("too many hidden widgets");
      cur.hiddenWidgets = names([...set]);
    }
    if (patch.screens !== undefined) cur.screens = screens(patch.screens, true);
    this.db.query("INSERT INTO panel_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(KEY, JSON.stringify(cur));
    return cur;
  }

  hide(app: string, hidden: boolean): Layout {
    const cur = this.read();
    const set = new Set(cur.hidden);
    if (hidden) set.add(app);
    else set.delete(app);
    return this.update({ hidden: [...set] });
  }
}

/**
 * A widget as the panel lists it: the operator's size over the manifest's, and the frame when one is
 * stored. A frame that came with the widget (a peer's own panel) is not this panel's and is dropped.
 */
export function withLayout<T extends { id: string; size: string }>(lay: Layout, w: T): T & { frame?: WidgetFrame } {
  const { frame: _, ...rest } = w as T & { frame?: unknown };
  const size = lay.sizes[w.id];
  const frame = lay.frames[w.id];
  return { ...(rest as T), ...(size ? { size } : {}), ...(frame ? { frame } : {}) };
}

/**
 * Sort by a stored order; names not in it follow, by tier (local entries
 * before peer entries) and then alphabetically.
 */
export function orderBy<T>(items: T[], order: string[], nameOf: (item: T) => string, tierOf: (item: T) => number = () => 0): T[] {
  const pos = new Map(order.map((n, i) => [n, i]));
  return items.slice().sort((a, b) => {
    const pa = pos.get(nameOf(a)) ?? Number.MAX_SAFE_INTEGER;
    const pb = pos.get(nameOf(b)) ?? Number.MAX_SAFE_INTEGER;
    return pa - pb || tierOf(a) - tierOf(b) || nameOf(a).localeCompare(nameOf(b));
  });
}

function names(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 200))].slice(0, MAX_NAMES);
}

/**
 * Screens as stored: the home screen first (added when missing), ids and names unique and short,
 * items de-duplicated per screen. `strict` (a patch) throws on a malformed list instead of dropping.
 */
function screens(v: unknown, strict = false): Screen[] {
  const bad = (msg: string): never => {
    throw new Error(msg);
  };
  if (!Array.isArray(v)) return strict ? bad("screens must be a list of { id, name, items }") : [];
  if (v.length > MAX_SCREENS) {
    if (strict) bad(`at most ${MAX_SCREENS} screens`);
    v = v.slice(0, MAX_SCREENS);
  }
  const out: Screen[] = [];
  const ids = new Set<string>();
  for (const s of v as unknown[]) {
    const o = (typeof s === "object" && s !== null ? s : {}) as Record<string, unknown>;
    const id = typeof o.id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(o.id) ? o.id : null;
    if (!id || ids.has(id)) {
      if (strict) bad("each screen needs a unique id of letters, digits, - or _");
      continue;
    }
    if (o.items !== undefined && !Array.isArray(o.items)) {
      if (strict) bad(`screens.${id}.items must be a list of entry keys`);
      continue;
    }
    ids.add(id);
    const name = typeof o.name === "string" ? o.name.trim().slice(0, 60) : "";
    out.push({ id, name, items: names(o.items) });
  }
  const home = out.findIndex((s) => s.id === HOME_SCREEN);
  if (home < 0) out.unshift({ id: HOME_SCREEN, name: "", items: [] });
  else if (home > 0) out.unshift(...out.splice(home, 1));
  return out;
}

const isSize = (v: unknown): v is WidgetSize => typeof v === "string" && (WIDGET_SIZES as readonly string[]).includes(v);

const isFrame = (v: unknown): v is WidgetFrame => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const { w, h } = v as Record<string, unknown>;
  return typeof w === "number" && typeof h === "number" && Number.isFinite(w) && Number.isFinite(h) && w >= FRAME_W[0] && w <= FRAME_W[1] && h >= FRAME_H[0] && h <= FRAME_H[1];
};

function frames(v: unknown): Record<string, WidgetFrame> {
  const out: Record<string, WidgetFrame> = {};
  if (typeof v !== "object" || v === null || Array.isArray(v)) return out;
  for (const [id, f] of Object.entries(v as Record<string, unknown>).slice(0, MAX_NAMES)) if (id && isFrame(f)) out[id] = { w: f.w, h: f.h };
  return out;
}

function sizes(v: unknown): Record<string, WidgetSize> {
  const out: Record<string, WidgetSize> = {};
  if (typeof v !== "object" || v === null) return out;
  for (const [id, size] of Object.entries(v as Record<string, unknown>).slice(0, MAX_NAMES)) if (typeof id === "string" && isSize(size)) out[id] = size;
  return out;
}
