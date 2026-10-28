import type { Catalogue, Entry } from "./catalogue.ts";
import { entriesByKey } from "./catalogue.ts";

/**
 * The floating ball: a small round window over every app that takes a dropped picture and opens
 * into a dial of four sections, each handing text and pictures to an agent through Quick Chat.
 * These are its rules without GTK, ported from the Mac's `FloatingBallRules.swift`
 * (desktop/macos/AISpace/Services/), so `bun test` runs them. One difference: coordinates here
 * are the desktop's, y pointing down (X11 and GTK), where the Mac's point up.
 *
 * The ball itself runs in a process of its own (`src/ball/ball.ts`, GTK 3 on X11, through
 * XWayland on a Wayland desktop), because a Wayland client may neither stay above other windows
 * nor place itself; the two processes talk in the JSON lines below.
 */

export type Point = { x: number; y: number };
export type Size = { width: number; height: number };
export type Rect = { x: number; y: number; width: number; height: number };

export const DIAMETER = 52;
/** The ball never stands closer than this to the edge of the screen's work area. */
export const MARGIN = 12;

/**
 * Where the ball stands (its top-left corner): its saved place, kept inside the work area (a
 * screen that was unplugged must not take the ball with it); with no saved place, the right edge
 * a third of the way down, clear of the top bar, the dock and the corners.
 */
export function origin(saved: Point | undefined, size: Size, visible: Rect): Point {
  const minX = visible.x + MARGIN, maxX = visible.x + visible.width - size.width - MARGIN;
  const minY = visible.y + MARGIN, maxY = visible.y + visible.height - size.height - MARGIN;
  if (maxX < minX || maxY < minY) return { x: visible.x, y: visible.y };
  const wanted = saved ?? { x: maxX, y: visible.y + visible.height / 3 - size.height / 2 };
  return { x: Math.min(Math.max(wanted.x, minX), maxX), y: Math.min(Math.max(wanted.y, minY), maxY) };
}

// The dial

/** The glass disc that opens around the ball under the pointer (Design Studio's spec, design 11). */
export const DIAL_DIAMETER = 168;
/** The hub in the middle, where the section under the pointer is named. */
export const HUB_DIAMETER = 60;
/** The window around the disc: room for its shadow on every side. */
export const DIAL_WINDOW = DIAL_DIAMETER + 64;

/** The four places the dial opens, clockwise from the top; the index is the slot's. */
export const SECTIONS = ["keep", "assistant", "todo", "design"] as const;
export type Section = (typeof SECTIONS)[number];

/** The middle of each section, in degrees counterclockwise from the right (as on a clock face seen normally). */
export const ANGLE: Record<Section, number> = { keep: 90, assistant: 0, todo: 270, design: 180 };

/** The app of the Space each section stands for (an agent's app for the assistant). */
export const SECTION_APP: Record<Section, string> = { keep: "keep", assistant: "space", todo: "ai-todo", design: "ai-design" };

/** The name shown while the Space has no such entry. */
export const FALLBACK_TITLE: Record<Section, string> = { keep: "Keep", assistant: "Space Assistant", todo: "Todo", design: "Design Studio" };

/** The section under `point` of a dial centred on `center` (y down): none in the hub or past the rim. */
export function sectionAt(point: Point, center: Point): Section | undefined {
  const dx = point.x - center.x, dy = center.y - point.y;
  const r = Math.hypot(dx, dy);
  if (r < HUB_DIAMETER / 2 || r > DIAL_DIAMETER / 2) return undefined;
  let degrees = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (degrees < 0) degrees += 360;
  if (degrees >= 45 && degrees < 135) return "keep";
  if (degrees >= 135 && degrees < 225) return "design";
  if (degrees >= 225 && degrees < 315) return "todo";
  return "assistant";
}

/** Where the dial opens: centred on the ball, moved in just enough to stay whole on the screen. */
export function dialCenter(ball: Point, visible: Rect): Point {
  const r = DIAL_DIAMETER / 2 + 4;
  const minX = visible.x + r, maxX = visible.x + visible.width - r;
  const minY = visible.y + r, maxY = visible.y + visible.height - r;
  if (maxX < minX || maxY < minY) return { x: visible.x + visible.width / 2, y: visible.y + visible.height / 2 };
  return { x: Math.min(Math.max(ball.x, minX), maxX), y: Math.min(Math.max(ball.y, minY), maxY) };
}

const parts = (ref: string) => ref.split("/");

/**
 * The entry that shows a section (its icon and name) among the catalogue's refs (`<peer>/` before
 * a peer's): the app itself, or the Space Assistant agent for the assistant's section. This
 * machine's first, else the first peer that has it.
 */
export function refFor(section: Section, refs: string[]): string | undefined {
  const name = section === "assistant" ? "space/assistant" : SECTION_APP[section];
  const depth = parts(name).length;
  const matches = refs.filter((ref) => ref === name || (ref.endsWith(`/${name}`) && parts(ref).length === depth + 1));
  return matches.find((r) => r === name) ?? matches[0];
}

/** A configured section left empty; "" (or no setting) is the section's default app. */
export const EMPTY_SLOT = "-";

/** The section's setting for one Space: undefined for the default app, `EMPTY_SLOT` for none, else an entry key (`app:<ref>`, `agent:<ref>`). */
export function slot(section: Section, slots: string[] | undefined): string | undefined {
  const value = slots?.[SECTIONS.indexOf(section)];
  return value ? value : undefined;
}

/** Slots with one section set to `key` (undefined for the default), the others kept. */
export function setting(section: Section, key: string | undefined, slots: string[] | undefined): string[] {
  const out = [...(slots ?? [])];
  while (out.length < SECTIONS.length) out.push("");
  out[SECTIONS.indexOf(section)] = key ?? "";
  return out;
}

/**
 * The agent of an app (`<name>` or `<peer>/<name>`) among agent refs: one on the app's own machine
 * first, else the same app on another machine. Undefined when the app has no agent.
 */
export function agentForApp(app: string, refs: string[]): string | undefined {
  const p = parts(app);
  const name = p.at(-1);
  if (!name) return undefined;
  const peer = p.length > 1 ? p[0] : undefined;
  const matches = refs.filter((ref) => {
    const r = parts(ref);
    return (r.length === 2 || r.length === 3) && r[r.length - 2] === name;
  });
  return matches.find((ref) => {
    const r = parts(ref);
    return (r.length === 3 ? r[0] : undefined) === peer;
  }) ?? matches[0];
}

/**
 * The agent a section hands its text and pictures to, among agent refs (`<app>/<name>`, behind
 * `<peer>/` for a peer's): the app's own agent, this machine's first; for the assistant's section,
 * Space Assistant. Undefined when the app has no agent.
 */
export function agentFor(section: Section, refs: string[]): string | undefined {
  const matches = refs.filter((ref) => {
    const p = parts(ref);
    if (p.length !== 2 && p.length !== 3) return false;
    return p[p.length - 2] === SECTION_APP[section] && (section !== "assistant" || p.at(-1) === "assistant");
  });
  return matches.find((r) => parts(r).length === 2) ?? matches[0];
}

/** What a drag offers the ball. GTK has no file promises; `promised` stays for the Mac's rule. */
export type Offer = "file" | "picture" | "promise" | "nothing";

/**
 * `types` are the drag's targets (MIME types), `files` the content types of its files (one per
 * file), `promised` whether it carries a file promise; `isPicture` says whether a type is an
 * image. A file wins over data, so nothing is read twice; more than one file is refused, as a
 * section takes one picture at a time.
 */
export function offer(types: string[], files: string[], isPicture: (type: string) => boolean, promised = false): Offer {
  if (files.length) return files.length === 1 && isPicture(files[0]!) ? "file" : "nothing";
  if (types.some(isPicture)) return "picture";
  return promised ? "promise" : "nothing";
}

/** The MIME types a picture can arrive in, as data or as the content type of a file. */
export const isPictureType = (type: string) => /^image\/[\w.+-]+$/i.test(type.trim());

/** What one section of the dial shows and where its work goes, for one Space. */
export type DialEntry = {
  /** The entry shown (its icon and title); absent while the Space has none or Settings left it empty. */
  entry?: Entry;
  /** The agent's catalogue id (`<app>/<name>`, `<peer>/<app>/<name>`) that takes the work. */
  agent?: string;
  /** The app has no agent of its own: Space Assistant takes the work, told where it goes. */
  borrowed: boolean;
  /** Settings left this section empty. */
  hidden: boolean;
};

/**
 * Each section's entry and agent in a Space: what Settings set for it (an app or an agent, or
 * nothing), else the section's default app. An agent takes the work itself; an app hands it to
 * its own agent, or to Space Assistant when it has none. A widget never stands in a section.
 */
export function resolveDial(catalogue: Catalogue | undefined, slots: string[] | undefined): Record<Section, DialEntry> {
  const out = {} as Record<Section, DialEntry>;
  const byKey = catalogue ? entriesByKey(catalogue) : new Map<string, Entry>();
  const agentRefs = catalogue?.agentInfo.map((a) => a.id) ?? [];
  for (const section of SECTIONS) {
    const s = slot(section, slots);
    const hidden = s === EMPTY_SLOT;
    let entry: Entry | undefined;
    if (catalogue && !hidden) {
      if (s) entry = byKey.get(s);
      else {
        const pool = section === "assistant" ? catalogue.agents : catalogue.apps;
        const ref = refFor(section, pool.map((e) => e.ref));
        entry = pool.find((e) => e.ref === ref);
      }
    }
    if (!entry || entry.kind === "widget") {
      out[section] = { borrowed: false, hidden };
      continue;
    }
    const own = entry.kind === "agent" ? entry.ref : agentForApp(entry.ref, agentRefs);
    const agent = own ?? agentFor("assistant", agentRefs);
    out[section] = agent ? { entry, agent, borrowed: !own, hidden } : { borrowed: false, hidden };
  }
  return out;
}

// The two processes' messages, one JSON object per line.

/** What the dial draws in one section, worked out by the app: the ball process knows no Space. */
export type DialSection = {
  title: string;
  /** An emoji, or the path of a PNG on this computer; absent draws the section's symbol. */
  icon?: string;
  round?: boolean;
  /** It has an agent: a click opens it and a picture may be dropped on it. */
  usable: boolean;
  hidden: boolean;
};

/** App → ball. */
// Quick Chat beside the ball (the Mac's `QuickChat.position`)

/** Quick Chat's width (Design Studio's spec, design 12); it is 96 high while empty and grows up to `CHAT_MAX_HEIGHT`. */
export const CHAT_WIDTH = 380;
export const CHAT_MAX_HEIGHT = 420;

/**
 * Where Quick Chat stands (its top-left) when the ball opened it: 12 beside the ball, on its left
 * when there is room, else its right; its bottom 48 under the ball's middle, so as it grows taller
 * it grows upward past the ball. Kept 8 inside the work area.
 */
export function chatOrigin(ball: Rect, size: Size, visible: Rect): Point {
  const gap = 12, edge = 8;
  const left = ball.x - gap - size.width;
  let x = left >= visible.x ? left : ball.x + ball.width + gap;
  let y = ball.y + ball.height / 2 + 48 - size.height;
  x = Math.min(Math.max(x, visible.x + edge), visible.x + visible.width - size.width - edge);
  y = Math.min(Math.max(y, visible.y + edge), visible.y + visible.height - size.height - edge);
  return { x: Math.round(x), y: Math.round(y) };
}

export type ToBall =
  | { type: "init"; origin?: Point; markIcon?: string }
  /** Put the app's X11 window `xid` (Quick Chat) beside the ball and above other windows. */
  | { type: "place"; xid: number; width: number; height: number }
  | { type: "dial"; sections: Record<Section, DialSection>; dark: boolean; labels: { addInSettings: string; sendTo: string; hub: string; menu: { quickChat: string; settings: string; hide: string } } }
  | { type: "quit" };

/** Ball → app. A dropped picture comes as a file: one the person dragged, or one the ball wrote under the runtime directory (`temporary`). */
export type FromBall =
  | { type: "ready"; x11: boolean }
  | { type: "open"; section: Section; startupId?: string }
  | { type: "drop"; section?: Section; file: string; temporary: boolean; startupId?: string }
  | { type: "refuse"; reason: "several" | "not-a-picture" | "unreadable" }
  | { type: "moved"; origin: Point }
  | { type: "menu"; action: "quick-chat" | "settings" | "hide"; startupId?: string };

const SECTION_SET = new Set<string>(SECTIONS);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isPoint = (v: unknown): v is Point => typeof v === "object" && v !== null && isNum((v as Point).x) && isNum((v as Point).y);
const optString = (v: unknown) => v === undefined || typeof v === "string";

/** A line from the ball, checked: anything malformed is dropped, so the app trusts no field blindly. */
export function decodeFromBall(line: string): FromBall | undefined {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (typeof m !== "object" || m === null) return undefined;
  switch (m.type) {
    case "ready":
      return { type: "ready", x11: m.x11 === true };
    case "open":
      return typeof m.section === "string" && SECTION_SET.has(m.section) && optString(m.startupId) ? { type: "open", section: m.section as Section, ...(m.startupId ? { startupId: m.startupId as string } : {}) } : undefined;
    case "drop":
      if (typeof m.file !== "string" || !m.file.startsWith("/") || !optString(m.startupId)) return undefined;
      if (m.section !== undefined && !(typeof m.section === "string" && SECTION_SET.has(m.section))) return undefined;
      return { type: "drop", file: m.file, temporary: m.temporary === true, ...(m.section ? { section: m.section as Section } : {}), ...(m.startupId ? { startupId: m.startupId as string } : {}) };
    case "refuse":
      return m.reason === "several" || m.reason === "not-a-picture" || m.reason === "unreadable" ? { type: "refuse", reason: m.reason } : undefined;
    case "moved":
      return isPoint(m.origin) ? { type: "moved", origin: { x: Math.round(m.origin.x), y: Math.round(m.origin.y) } } : undefined;
    case "menu":
      return (m.action === "quick-chat" || m.action === "settings" || m.action === "hide") && optString(m.startupId) ? { type: "menu", action: m.action, ...(m.startupId ? { startupId: m.startupId as string } : {}) } : undefined;
  }
  return undefined;
}

/** A temporary drop the app may read and delete: a file of the ball's own folder, nothing else. */
export function isOwnDrop(file: string, folder: string): boolean {
  const base = folder.endsWith("/") ? folder : `${folder}/`;
  return file.startsWith(base) && !file.slice(base.length).includes("/") && !file.includes("..");
}

/** The lead put before the message when an app without an agent hands its work to Space Assistant (once). */
export function withLead(draft: string, lead: string): string {
  return draft.startsWith(lead) ? draft : `${lead}\n${draft}`;
}
