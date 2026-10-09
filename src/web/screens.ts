import type { Screen } from "../space/panel/layout.ts";

/**
 * The panel's screens (docs/panel.md#screens): the library of everything on the left, the home
 * screen the panel opens on, then the operator's own screens. A screen holds entry keys, in order;
 * pinning or unpinning only changes the screen, never the app, agent or widget behind the key.
 * Pure functions: App.tsx keeps the state and stores the result in the layout.
 */

export type { Screen };
export type EntryKind = "app" | "agent" | "widget" | "builtin";
export const HOME = "home";
/** The panel's own tiles, in the order the library and a seeded home screen show them. */
export const BUILTINS = ["inbox", "terminal", "settings"] as const;
export type Builtin = (typeof BUILTINS)[number];

/** The widget sizes a card can take; the server's list is `WIDGET_SIZES` in scheduler/manifest.ts, kept out of the page's bundle. */
export const WIDGET_SIZES = ["1x1", "2x1", "1x2", "2x2"] as const;

export const entryKey = (kind: EntryKind, id: string) => `${kind}:${id}`;
export const parseKey = (key: string): { kind: EntryKind; id: string } | null => {
  const i = key.indexOf(":");
  const kind = key.slice(0, i);
  return i > 0 && (kind === "app" || kind === "agent" || kind === "widget" || kind === "builtin") ? { kind, id: key.slice(i + 1) } : null;
};

/** How many entries of each kind a first home screen takes from the panel's previous order. */
export const SEED = { apps: 8, agents: 4, widgets: 4 };

/**
 * The home screen of a panel that has no screens yet: its own tiles, then the first apps, agents
 * and widgets of the order the panel showed before. Everything else stays in the library, and what
 * is installed later lands there too, not here.
 */
export function seedScreens(apps: string[], agents: string[], widgets: string[]): Screen[] {
  const items = [
    ...apps.slice(0, SEED.apps).map((id) => entryKey("app", id)),
    ...BUILTINS.map((b) => entryKey("builtin", b)),
    ...agents.slice(0, SEED.agents).map((id) => entryKey("agent", id)),
    ...widgets.slice(0, SEED.widgets).map((id) => entryKey("widget", id)),
  ];
  return [{ id: HOME, name: "", items }];
}

const mapScreen = (screens: Screen[], id: string, fn: (s: Screen) => Screen) => screens.map((s) => (s.id === id ? fn(s) : s));

/** Adds the entry at the end of the screen; an entry already there stays where it is. */
export const pin = (screens: Screen[], screenId: string, key: string) =>
  mapScreen(screens, screenId, (s) => (s.items.includes(key) ? s : { ...s, items: [...s.items, key] }));

export const unpin = (screens: Screen[], screenId: string, key: string) => mapScreen(screens, screenId, (s) => ({ ...s, items: s.items.filter((k) => k !== key) }));

/** The screens an entry is pinned to, by id. */
export const screensOf = (screens: Screen[], key: string) => screens.filter((s) => s.items.includes(key)).map((s) => s.id);

/**
 * Moves one entry of a group (the tiles, or the widgets, which a screen draws apart) before or
 * after another of the same group; entries outside the group keep their places.
 */
export function move(screens: Screen[], screenId: string, group: string[], from: number, to: number): Screen[] {
  if (from === to || !group[from] || !group[to]) return screens;
  const next = group.slice();
  const [x] = next.splice(from, 1);
  next.splice(to, 0, x as string);
  return mapScreen(screens, screenId, (s) => {
    const inGroup = new Set(group);
    let i = 0;
    return { ...s, items: s.items.map((k) => (inGroup.has(k) ? (next[i++] as string) : k)) };
  });
}

/** A new empty screen at the end, with an id no other screen has. */
export function addScreen(screens: Screen[], name: string): { screens: Screen[]; id: string } {
  let n = screens.length;
  while (screens.some((s) => s.id === `s${n}`)) n++;
  const id = `s${n}`;
  return { screens: [...screens, { id, name: name.trim().slice(0, 60), items: [] }], id };
}

/** The home screen cannot be deleted; deleting a screen leaves its entries in the library. */
export const removeScreen = (screens: Screen[], id: string) => (id === HOME ? screens : screens.filter((s) => s.id !== id));

/** What a library search matches: every word of the query somewhere in the entry's text, case-insensitively. */
export function matches(query: string, ...text: (string | undefined)[]): boolean {
  const hay = text.filter(Boolean).join(" ").toLocaleLowerCase();
  return query
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}
