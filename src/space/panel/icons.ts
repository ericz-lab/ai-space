import type { Database } from "bun:sqlite";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentView, AppView, ServiceView } from "./view.ts";

/**
 * Icon packs: the panel's own icons for its tiles, over the ones the apps'
 * manifests declare (docs/panel.md#icon-packs). A pack is a directory of
 * image files under `<workspace>/icons/<pack>/`, one per tile; at most one pack
 * is active, recorded in space.db. The apps' repositories are never touched:
 * with no pack active, or no file for a tile in the active one, the tile
 * shows the manifest's icon.
 *
 *   <workspace>/icons/<pack>/app/<id>.<ext>     an app tile: `<app>`, or `<peer>~<app>` for a peer's app
 *   <workspace>/icons/<pack>/agent/<id>.<ext>   an agent tile: `<app>~<agent>`, or `<peer>~<app>~<agent>`
 *
 * Ids are the panel's layout keys with `/` written as `~` on disk. Overrides
 * belong to the machine whose panel shows them: a pack applies to the peers'
 * tiles on this panel too, and the snapshot this space gives a hub carries the
 * manifest icons, never this machine's pack.
 */

export type IconKind = "app" | "agent";
export type IconEntry = { kind: IconKind; id: string; url: string; type: string; size: number; updated: string };
export type IconPack = { name: string; icons: IconEntry[] };

const KEY = "icons.active";
const KINDS: readonly IconKind[] = ["app", "agent"];
const PACK_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const SEGMENT = "[a-z0-9][a-z0-9._-]{0,63}";
/** An app id has one or two segments (`app`, `peer/app`), an agent id two or three. */
const ID_RE: Record<IconKind, RegExp> = {
  app: new RegExp(`^${SEGMENT}(/${SEGMENT})?$`, "i"),
  agent: new RegExp(`^${SEGMENT}/${SEGMENT}(/${SEGMENT})?$`, "i"),
};
export const MAX_ICON_BYTES = 512 * 1024;
export const ICON_TYPES: Record<string, string> = { svg: "image/svg+xml", png: "image/png", webp: "image/webp" };
const EXT_OF: Record<string, string> = Object.fromEntries(Object.entries(ICON_TYPES).map(([ext, type]) => [type, ext]));

/** Headers for a served pack file: an SVG opened on its own must not run script on the panel's origin. */
export const ICON_HEADERS = {
  "cache-control": "no-cache",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
};

export class IconPacks {
  readonly dir: string;

  constructor(
    home: string,
    private readonly db: Database,
  ) {
    this.dir = join(home, "icons");
    db.exec("CREATE TABLE IF NOT EXISTS panel_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }

  active(): string | null {
    const row = this.db.query<{ value: string }, [string]>("SELECT value FROM panel_kv WHERE key = ?").get(KEY);
    return row?.value || null;
  }

  /** Make a pack the active one (it must exist), or go back to the manifests' icons with null. */
  async setActive(pack: string | null): Promise<void> {
    if (pack === null) {
      this.db.query("DELETE FROM panel_kv WHERE key = ?").run(KEY);
      return;
    }
    checkPack(pack);
    if (!(await this.exists(pack))) throw new NotFound(`unknown icon pack: ${pack}`);
    this.db.query("INSERT INTO panel_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(KEY, pack);
  }

  async packs(): Promise<IconPack[]> {
    const names = (await readdir(this.dir, { withFileTypes: true }).catch(() => []))
      .filter((d) => d.isDirectory() && PACK_RE.test(d.name))
      .map((d) => d.name)
      .sort();
    return Promise.all(names.map(async (name) => ({ name, icons: await this.list(name) })));
  }

  async list(pack: string): Promise<IconEntry[]> {
    checkPack(pack);
    const out: IconEntry[] = [];
    for (const kind of KINDS) {
      const files = await readdir(join(this.dir, pack, kind)).catch(() => [] as string[]);
      for (const file of files.sort()) {
        const parsed = parseFile(kind, file);
        if (!parsed) continue;
        const st = await stat(join(this.dir, pack, kind, file)).catch(() => null);
        if (!st?.isFile()) continue;
        out.push({ kind, id: parsed.id, url: fileUrl(pack, kind, parsed.id, st.mtimeMs), type: ICON_TYPES[parsed.ext]!, size: st.size, updated: st.mtime.toISOString() });
      }
    }
    return out;
  }

  /** Write one icon, replacing the tile's file in another format; creates the pack on its first icon. */
  async write(pack: string, kind: IconKind, id: string, type: string, bytes: Uint8Array): Promise<IconEntry> {
    checkPack(pack);
    checkId(kind, id);
    const ext = EXT_OF[type.split(";")[0]!.trim().toLowerCase()];
    if (!ext) throw new Error(`content-type must be one of ${Object.values(ICON_TYPES).join(", ")}`);
    if (bytes.byteLength === 0) throw new Error("the icon is empty");
    if (bytes.byteLength > MAX_ICON_BYTES) throw new Error(`the icon is larger than ${MAX_ICON_BYTES / 1024} KB`);
    const dir = join(this.dir, pack, kind);
    await mkdir(dir, { recursive: true });
    await this.removeFiles(pack, kind, id);
    const path = join(dir, `${diskId(id)}.${ext}`);
    await Bun.write(path, bytes);
    const st = await stat(path);
    return { kind, id, url: fileUrl(pack, kind, id, st.mtimeMs), type: ICON_TYPES[ext]!, size: st.size, updated: st.mtime.toISOString() };
  }

  /** The file of one icon, or undefined. */
  async file(pack: string, kind: IconKind, id: string): Promise<{ path: string; type: string } | undefined> {
    checkPack(pack);
    checkId(kind, id);
    for (const ext of Object.keys(ICON_TYPES)) {
      const path = join(this.dir, pack, kind, `${diskId(id)}.${ext}`);
      if (await Bun.file(path).exists()) return { path, type: ICON_TYPES[ext]! };
    }
    return undefined;
  }

  /** Remove one icon; false when the pack had none for the tile. */
  async remove(pack: string, kind: IconKind, id: string): Promise<boolean> {
    checkPack(pack);
    checkId(kind, id);
    return (await this.removeFiles(pack, kind, id)) > 0;
  }

  /** Remove a whole pack; the panel goes back to the manifests' icons when it was the active one. */
  async removePack(pack: string): Promise<boolean> {
    checkPack(pack);
    if (!(await this.exists(pack))) return false;
    await rm(join(this.dir, pack), { recursive: true, force: true });
    if (this.active() === pack) await this.setActive(null);
    return true;
  }

  /** The active pack's icons by tile id, read once per list request. */
  async overrides(): Promise<Overrides> {
    const pack = this.active();
    const empty: Overrides = { app: new Map(), agent: new Map() };
    if (!pack || !(await this.exists(pack))) return empty;
    for (const e of await this.list(pack)) empty[e.kind].set(e.id, e.url);
    return empty;
  }

  private async exists(pack: string): Promise<boolean> {
    return (await stat(join(this.dir, pack)).catch(() => null))?.isDirectory() ?? false;
  }

  private async removeFiles(pack: string, kind: IconKind, id: string): Promise<number> {
    let n = 0;
    for (const ext of Object.keys(ICON_TYPES)) {
      const path = join(this.dir, pack, kind, `${diskId(id)}.${ext}`);
      if (await Bun.file(path).exists()) {
        await rm(path);
        n++;
      }
    }
    return n;
  }
}

export type Overrides = Record<IconKind, Map<string, string>>;

/** The panel's own tiles, by name: their default icons and the pack ids that cover them (`space/<name>`). */
export const BUILTIN_ICONS = { inbox: "/inbox.svg", terminal: "/terminal.svg", settings: "/settings.svg" } as const;
export type BuiltinIcons = Record<keyof typeof BUILTIN_ICONS, string>;

export function builtinIcons(o: Overrides): BuiltinIcons {
  const out = { ...BUILTIN_ICONS } as BuiltinIcons;
  for (const k of Object.keys(out) as (keyof BuiltinIcons)[]) out[k] = o.app.get(`space/${k}`) ?? out[k];
  return out;
}

/** The app id a list entry's icon belongs to: `<app>`, or `<peer>/<app>`. */
const appKey = (v: { app: string; peer?: string }) => (v.peer ? `${v.peer}/${v.app}` : v.app);

export function applyToAgent(o: Overrides, a: AgentView): AgentView {
  const avatar = o.agent.get(a.id);
  const appIcon = o.app.get(appKey(a));
  return avatar || appIcon ? { ...a, ...(avatar ? { avatar } : {}), ...(appIcon ? { appIcon } : {}) } : a;
}

export function applyToApp(o: Overrides, v: AppView): AppView {
  const icon = o.app.get(v.id);
  return { ...v, ...(icon ? { icon } : {}), agents: v.agents.map((a) => applyToAgent(o, a)) };
}

export function applyToService(o: Overrides, s: ServiceView): ServiceView {
  const icon = o.app.get(appKey(s));
  return icon ? { ...s, icon } : s;
}

export function applyToWidget<W extends { app: string; peer?: string; icon: string }>(o: Overrides, w: W): W {
  const icon = o.app.get(appKey(w));
  return icon ? { ...w, icon } : w;
}

export function isIconKind(v: string): v is IconKind {
  return (KINDS as readonly string[]).includes(v);
}

export class NotFound extends Error {}

function checkPack(pack: string) {
  if (!PACK_RE.test(pack)) throw new Error("invalid pack name");
}
function checkId(kind: IconKind, id: string) {
  if (!ID_RE[kind].test(id)) throw new Error(kind === "app" ? "id must be <app> or <peer>/<app>" : "id must be <app>/<agent> or <peer>/<app>/<agent>");
}
const diskId = (id: string) => id.replaceAll("/", "~");
function parseFile(kind: IconKind, file: string): { id: string; ext: string } | undefined {
  const dot = file.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const ext = file.slice(dot + 1).toLowerCase();
  const id = file.slice(0, dot).replaceAll("~", "/");
  return ICON_TYPES[ext] && ID_RE[kind].test(id) ? { id, ext } : undefined;
}
/** The route a pack file is served at; the version changes with the file, so a replaced icon is fetched anew. */
function fileUrl(pack: string, kind: IconKind, id: string, mtimeMs: number): string {
  return `/api/panel/icons/${encodeURIComponent(pack)}/${kind}?id=${encodeURIComponent(id)}&v=${Math.floor(mtimeMs).toString(36)}`;
}
