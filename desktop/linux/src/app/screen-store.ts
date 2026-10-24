import { type Screen, type ScreenFile, decodeScreenFile, edit, forget, reset, screensOf, seed } from "../core/screens.ts";
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

  /** The panel's screens become this computer's, the first time a Space has some. */
  seed(conn: string, panel: Screen[]): void {
    const next = seed(this.file, conn, panel);
    if (next) this.write(next, false);
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
