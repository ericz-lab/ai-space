import type { Screen } from "../../../../src/space/panel/layout.ts";
import { HOME, addScreen, move, pin, removeScreen, unpin } from "../../../../src/web/screens.ts";

/**
 * The screens of each saved Space as this computer lays them out (the Mac's and iPhone's
 * ScreenStore): the first catalogue of a Space copies the panel's screens once, and from then on
 * what is added, removed, moved or made here stays here; nothing is written to the Space. The
 * operations are the panel's own (src/web/screens.ts). A key whose entry is gone keeps its place,
 * so it comes back with the entry.
 */

export type { Screen };
export { HOME, addScreen, move, pin, removeScreen, unpin };

/** As many as the panel allows (MAX_SCREENS in src/space/panel/layout.ts). */
export const LIMIT = 20;

/** The `builtin:` tiles this client draws: the panel's own (BUILTINS in src/web/screens.ts, in its order), and the web panel itself. */
export const BUILTIN_NAMES = ["store", "inbox", "shortcuts", "terminal", "panel", "settings"] as const;
export type BuiltinName = (typeof BUILTIN_NAMES)[number];

/**
 * The picture of each of the panel's own tiles as the panel ships it (`BUILTIN_ICONS` in
 * src/space/panel/icons.ts: a file of src/web/public), copied into the build as
 * `data/builtin/<file>`. A Space names its own in `GET /api/apps` (`builtins`, an icon pack's
 * included) and that one is drawn; this is what shows until it loads, or when the Space names
 * none. The web panel's tile is this client's own and has no such picture.
 */
export const BUILTIN_ART = { store: "store.svg", inbox: "inbox.svg", shortcuts: "shortcuts.svg", terminal: "terminal.svg", settings: "settings.svg" } as const satisfies Partial<Record<BuiltinName, string>>;
export const builtinArt = (name: BuiltinName): string | undefined => (BUILTIN_ART as Partial<Record<BuiltinName, string>>)[name];

/** The page of the panel a tile opens in a tab, for the ones this client has no view of its own for (docs/panel.md#built-in-pages). */
export const builtinPage = (name: BuiltinName): string | undefined => (name === "store" || name === "shortcuts" ? `/?page=${name}` : name === "panel" ? "/" : undefined);

export type ScreenRecord = { screens: Screen[]; seeded: boolean };
/** screens.json: one record per saved Space, by connection id. */
export type ScreenFile = Record<string, ScreenRecord>;

const emptyHome = (): Screen => ({ id: HOME, name: "", items: [] });

const keeps = (key: string) => /^(app|agent|widget):./.test(key) || BUILTIN_NAMES.some((b) => key === `builtin:${b}`);

/** Home exists and comes first, ids are unique, there are no more screens than the limit, and no key twice on one screen. */
export function normalize(screens: Screen[]): Screen[] {
  const seen = new Set<string>();
  const out = screens.filter((s) => !seen.has(s.id) && seen.add(s.id)).map((s) => ({ ...s, items: [...new Set(s.items)] }));
  const i = out.findIndex((s) => s.id === HOME);
  if (i > 0) out.unshift(...out.splice(i, 1));
  else if (i < 0) out.unshift(emptyHome());
  return out.slice(0, LIMIT);
}

/** The panel's screens as this client keeps them: only entries of a kind it draws. */
export const copyPanel = (panel: Screen[]) => normalize(panel.map((s) => ({ id: s.id, name: s.name ?? "", items: s.items.filter(keeps) })));

export const screensOf = (file: ScreenFile, conn: string): Screen[] => file[conn]?.screens ?? [emptyHome()];

/**
 * Takes the panel's screens as this computer's first layout, once per Space; undefined when nothing
 * changes. The home screen is where the window opens, so it never starts empty: when the panel has
 * nothing pinned there (a panel whose owner emptied it, or keeps everything on later screens), it
 * gets what a new panel's home would (`defaults`: the panel's own tiles, then the first apps,
 * agents and widgets).
 */
export function seed(file: ScreenFile, conn: string, panel: Screen[], defaults: Screen[] = []): ScreenFile | undefined {
  if (file[conn]?.seeded) return undefined;
  let copy = copyPanel(panel);
  if (!copy[0]!.items.length) {
    const home = copyPanel(defaults)[0]!.items;
    copy = copy.map((s) => (s.id === HOME ? { ...s, items: home } : s));
  }
  // Nothing to show anywhere is not a layout yet: wait for a catalogue that has something.
  if (!copy.some((s) => s.items.length)) return undefined;
  return { ...file, [conn]: { screens: copy, seeded: true } };
}

/** The library's page of Home; every other page is a screen, by its id. */
export const LIBRARY = "library";

/** Home's pages from left to right: the library, then the screens, the home screen first. */
export const pagesOf = (screens: Screen[]): string[] => [LIBRARY, ...normalize(screens).map((s) => s.id)];

/**
 * The page the window opens on, and a Space is first shown on: the home screen (主屏幕), which is
 * the first screen and the one the tiles are pinned to. Not the library on its left, which is the
 * carousel's first page, and not a later screen, whatever they hold.
 */
export const openingPage = (_screens: Screen[]): string => HOME;

/** The page to show once the screens changed: the one on show while it is still there, else the home screen. */
export const pageAfter = (shown: string, screens: Screen[]): string => (pagesOf(screens).includes(shown) ? shown : openingPage(screens));

/** Replaces this computer's layout with the panel's as it is now, when the person asks for it. */
export const reset = (file: ScreenFile, conn: string, panel: Screen[]): ScreenFile => ({ ...file, [conn]: { screens: copyPanel(panel), seeded: true } });

/** A change made here; a layout made by hand is never overwritten by a later copy. */
export const edit = (file: ScreenFile, conn: string, change: (s: Screen[]) => Screen[]): ScreenFile => ({ ...file, [conn]: { screens: normalize(change(screensOf(file, conn))), seeded: true } });

export function forget(file: ScreenFile, conn: string): ScreenFile {
  const { [conn]: _, ...rest } = file;
  return rest;
}

/** Reads screens.json, skipping anything malformed. */
export function decodeScreenFile(raw: unknown): ScreenFile {
  const out: ScreenFile = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [conn, r] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof r !== "object" || r === null || !Array.isArray((r as ScreenRecord).screens)) continue;
    const screens = (r as ScreenRecord).screens
      .filter((s) => typeof s === "object" && s !== null && typeof s.id === "string" && Array.isArray(s.items))
      .map((s) => ({ id: s.id, name: typeof s.name === "string" ? s.name : "", items: s.items.filter((k): k is string => typeof k === "string") }));
    out[conn] = { screens: normalize(screens), seeded: (r as ScreenRecord).seeded === true };
  }
  return out;
}

/** A new empty screen at the end; undefined at the limit. */
export function newScreen(screens: Screen[]): { screens: Screen[]; id: string } | undefined {
  return screens.length >= LIMIT ? undefined : addScreen(screens, "");
}

export const rename = (screens: Screen[], id: string, name: string) => screens.map((s) => (s.id === id ? { ...s, name: name.trim().slice(0, 60) } : s));

/** Screens carry the name given them, else Main, Screen 2, Screen 3… by position (the Mac's titles). */
export const screenTitle = (screens: Screen[], index: number, t: { main: string; numbered: (n: number) => string }) => screens[index]?.name || (index === 0 ? t.main : t.numbered(index + 1));
