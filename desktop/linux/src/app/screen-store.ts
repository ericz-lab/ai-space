import { type Screen, type ScreenFile, adopt, decodeScreenFile, edit, forget, reset, screensOf, seed } from "../core/screens.ts";
import { dirs, logError, path, readTextSync, writeText } from "./env.ts";

/**
 * This computer's screens of every saved Space, in `~/.config/ai-space/screens.json` beside the
 * saved Spaces (core/screens.ts has the rules). Nothing here is written to a Space.
 */
const FILE = path(dirs.config, "screens.json");

export class ScreenStore {
  private file: ScreenFile;
  private readonly listeners = new Set<() => void>();

  constructor() {
    let raw: unknown = {};
    try {
      raw = JSON.parse(readTextSync(FILE) ?? "{}");
    } catch {}
    this.file = decodeScreenFile(raw);
  }

  on(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  screens(conn: string): Screen[] {
    return screensOf(this.file, conn);
  }

  /** The panel's screens become this computer's, the first time a Space has some; `defaults` fill a home screen the panel left empty. */
  seed(conn: string, panel: Screen[], defaults: Screen[]): void {
    const next = seed(this.file, conn, panel, defaults);
    if (next) this.write(next, false);
  }

  /** Apps new to the Space that its panel pinned to its home screen (the App Store's installs) go on this computer's. */
  adopt(conn: string, apps: string[], panel: Screen[]): void {
    const next = adopt(this.file, conn, apps, panel);
    if (next) this.write(next, next[conn]?.screens !== this.file[conn]?.screens);
  }

  edit(conn: string, change: (s: Screen[]) => Screen[]): void {
    this.write(edit(this.file, conn, change));
  }

  reset(conn: string, panel: Screen[]): void {
    this.write(reset(this.file, conn, panel));
  }

  /** A removed Space's screens go with it. */
  keepOnly(conns: string[]): void {
    let next = this.file;
    for (const id of Object.keys(next)) if (!conns.includes(id)) next = forget(next, id);
    if (next !== this.file) this.write(next, false);
  }

  private write(next: ScreenFile, notify = true): void {
    this.file = next;
    void writeText(FILE, `${JSON.stringify(next, null, 2)}\n`).catch((e) => logError(e, "could not save the screens"));
    if (notify) for (const fn of [...this.listeners]) fn();
  }
}
