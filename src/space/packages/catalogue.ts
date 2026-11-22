import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { ICON_TYPES, MAX_ICON_BYTES } from "../panel/icons.ts";
import type { AppView } from "../panel/view.ts";
import type { Manifest } from "../scheduler/manifest.ts";
import { PEER_SCOPES, type PeerScope } from "../peers/scopes.ts";
import { peerLabel } from "./connections.ts";
import type { PackageLinks, SharedApp } from "./links.ts";
import type { RuntimeApp } from "./runtime.ts";

type Icon = { version: string; type: string; bytes: Uint8Array };
/** What the other Space lets this one do through its `/api/peer/*` (connections.ts `grantedScopes`), from its catalogue. */
export type RemotePeerGrant = { scopes: PeerScope[]; fullTrust: boolean };
type Entry = { name?: string; spaceId: string; apps: SharedApp[]; ok: boolean; icons: Map<string, Icon>; peer: RemotePeerGrant };

/** How a package's manifest icon travels to a connected Space: a short text as it is, an image file by request. */
export function sharedIcon(app: RuntimeApp): { text?: string; file?: { path: string; type: string } } {
  const icon = (app.manifest as { icon?: unknown }).icon;
  if (typeof icon !== "string" || !icon) return {};
  const type = ICON_TYPES[icon.split(".").pop()!.toLowerCase()];
  // Only a file the package's own index lists: the manifest cannot name a path outside the installation.
  if (type && app.index.files.some((f) => f.path === icon)) return { file: { path: join(app.dir, icon), type } };
  return !type && icon.length <= 16 && !/[\/\\.<>]/.test(icon) ? { text: icon } : {};
}

/**
 * The local spec-1 (git-deployed) apps a connection can share next to the installed packages: those with a
 * `service.port`, not archived, and not a package. They are shared API-only (`page: false`): the owning
 * side serves a granted request's `/api/` paths from the service port (gateway.ts `servicePort`).
 * A spec-1 app carries no version; its icon travels only as a short text.
 */
export function sourceSharedApps(manifests: readonly Manifest[], isPackage: (app: string) => boolean): SharedApp[] {
  return manifests.filter((m) => m.spec !== 2 && m.service?.port && m.status !== "archived" && !isPackage(m.app)).map((m) => ({
    app: m.app, title: m.title ?? m.app, version: "", page: false,
    ...(m.icon && m.icon.length <= 16 && !/[\/\\.<>:]/.test(m.icon) ? { icon: m.icon } : {}),
  }));
}

export async function sharedIconResponse(app: RuntimeApp | undefined): Promise<Response | undefined> {
  const file = app && sharedIcon(app).file;
  if (!file) return undefined;
  const stat = await lstat(file.path).catch(() => null);
  if (!stat?.isFile() || stat.size > MAX_ICON_BYTES) return undefined;
  return new Response(await Bun.file(file.path).arrayBuffer(), { headers: { "content-type": file.type } });
}

/**
 * What connected Spaces share with this one, kept for the panel's app list: the list is read on
 * every page poll and must not wait on a remote machine. An unreachable Space keeps its last
 * known apps, marked stale; a removed or disabled connection drops them.
 */
export class RemoteCatalogue {
  private readonly entries = new Map<string, Entry>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly unsubscribe: () => void;
  private soon?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;

  constructor(private readonly links: PackageLinks, opts: { refreshMs?: number; timeoutMs?: number } = {}) {
    this.timeoutMs = opts.timeoutMs ?? 3000;
    this.timer = setInterval(() => void this.refresh(), opts.refreshMs ?? 30_000); this.timer.unref();
    // A connection made, enabled, disabled, rotated or removed reopens its channel: ask again once it had
    // time to reconnect. A change of this Space's own grants keeps the channel and changes nothing listed
    // here, which shows what the OTHER Space shares; that Space sees it on its next round (`refreshMs`).
    this.unsubscribe = links.connections.onChange((_id, change) => {
      this.prune();
      this.updated();
      if (change.kind !== "reset") return;
      clearTimeout(this.soon);
      this.soon = setTimeout(() => void this.refresh(), 6000); this.soon.unref();
    });
  }
  private readonly timeoutMs: number;
  private readonly listeners = new Set<() => void>();

  refresh(): Promise<void> {
    return this.running ??= this.load().finally(() => { this.running = undefined; this.updated(); });
  }

  /** Called after every round and every connection change, for what follows the catalogue (peers/connection-peers.ts). */
  onUpdate(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  /**
   * What each connected Space, as last read, lets this one do through its `/api/peer/*`, with the label it
   * goes by here (connections.ts `peerLabel`) and whether that read is current.
   */
  peerGrants(): { connection: string; spaceId: string; label: string; grant: RemotePeerGrant; ok: boolean }[] {
    return [...this.entries].map(([connection, e]) => ({ connection, spaceId: e.spaceId, label: this.label(connection, e), grant: e.peer, ok: e.ok }));
  }

  /** One tile per shared app that has a page; ids are `<label>/<app>`, like a peer's. */
  views(hidden: Set<string>): AppView[] {
    const out: AppView[] = [];
    for (const [connection, e] of this.entries) {
      const label = this.label(connection, e);
      for (const a of e.apps) {
        const id = `${label}/${a.app}`;
        out.push({
          id, name: a.app, peer: label, connection, stale: !e.ok, title: a.title,
          icon: e.icons.has(a.app) ? `/api/panel/shared-apps/${connection}/${encodeURIComponent(a.app)}/icon?v=${encodeURIComponent(a.version)}` : a.icon ?? "",
          ...(a.page === false ? {} : { url: `/_space/connections/${connection}/apps/${encodeURIComponent(a.app)}` }),
          status: "active", manifestOnly: false, hidden: hidden.has(id), agents: [], widgets: [],
        });
      }
    }
    return out;
  }

  /**
   * The connection whose Space is labelled `label` (its name, or the start of its UUID, as `views`
   * names it) and whose last catalogue shares `app`: where the hub's `/api/peers/<label>/apps/<app>/proxy/*`
   * goes when no legacy peer has that name. A stale entry still answers, so the caller reports the Space offline.
   */
  find(label: string, app: string): string | undefined {
    for (const [connection, e] of this.entries) {
      if (this.label(connection, e) === label && e.apps.some((a) => a.app === app)) return connection;
    }
    return undefined;
  }

  private label(connection: string, e: Entry): string {
    const c = this.links.connections.get(connection);
    return c ? peerLabel({ ...c, remoteName: c.remoteName ?? e.name?.toLowerCase() ?? null }) : e.name ?? e.spaceId.slice(0, 8);
  }
  private updated(): void { for (const fn of this.listeners) { try { fn(); } catch (e) { console.error(`[connections] ${(e as Error).message}`); } } }

  /** The image a shared app's tile shows, as last fetched from the Space that owns the app. */
  icon(connection: string, app: string): { type: string; bytes: Uint8Array } | undefined {
    return this.entries.get(connection)?.icons.get(app);
  }

  close(): void { clearInterval(this.timer); clearTimeout(this.soon); this.unsubscribe(); this.entries.clear(); }

  private prune(): void {
    const live = new Set(this.links.connections.list().filter((c) => c.enabled).map((c) => c.id));
    for (const id of [...this.entries.keys()]) if (!live.has(id)) this.entries.delete(id);
  }

  private async load(): Promise<void> {
    this.prune();
    await Promise.all(this.links.connections.list().filter((c) => c.enabled).map(async (c) => {
      try {
        const response = await this.links.request(c.id, { operation: "catalogue" }, null, AbortSignal.timeout(this.timeoutMs));
        // An answer not read holds its stream on both sides: an error's body is let go at once.
        if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error("catalogue unavailable"); }
        const data = await response.json() as { spaceId?: unknown; name?: unknown; apps?: unknown; peer?: unknown };
        // The connection is bound to one Space identity; an answer from another is not its catalogue.
        if (data.spaceId !== c.remoteSpaceId || !Array.isArray(data.apps)) throw new Error("catalogue does not match the connection");
        const apps = data.apps.filter(isSharedApp).slice(0, 1000);
        const name = typeof data.name === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(data.name) ? data.name : undefined;
        const icons = new Map<string, Icon>();
        const known = this.entries.get(c.id)?.icons;
        for (const a of apps) {
          if (!a.iconFile) continue;
          const have = known?.get(a.app);
          // An icon is fetched once per version; a failed fetch leaves the tile on its fallback until the next round.
          const icon = have?.version === a.version ? have : await this.fetchIcon(c.id, a).catch(() => undefined);
          if (icon) icons.set(a.app, icon);
        }
        if (this.links.connections.get(c.id)?.enabled) {
          this.entries.set(c.id, { spaceId: c.remoteSpaceId, apps, ok: true, icons, peer: peerGrant(data.peer), ...(name ? { name } : {}) });
          this.links.connections.setRemoteName(c.id, name);
        }
      } catch {
        const last = this.entries.get(c.id);
        if (last) last.ok = false;
      }
    }));
  }

  private async fetchIcon(connection: string, a: SharedApp): Promise<Icon | undefined> {
    const response = await this.links.request(connection, { operation: "icon", app: a.app }, null, AbortSignal.timeout(this.timeoutMs));
    const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim();
    if (!response.ok || !Object.values(ICON_TYPES).includes(type)) { await response.body?.cancel(); return undefined; }
    if (Number(response.headers.get("content-length") ?? 0) > MAX_ICON_BYTES) { await response.body?.cancel(); return undefined; }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.length && bytes.length <= MAX_ICON_BYTES ? { version: a.version, type, bytes } : undefined;
  }
}

/** The `peer` part of a catalogue: known scope names only; an older Space without it grants nothing. */
function peerGrant(raw: unknown): RemotePeerGrant {
  const p = raw as { scopes?: unknown; fullTrust?: unknown } | null;
  const scopes = Array.isArray(p?.scopes) ? PEER_SCOPES.filter((s) => (p!.scopes as unknown[]).includes(s)) : [];
  return { scopes, fullTrust: p?.fullTrust === true };
}

function isSharedApp(raw: unknown): raw is SharedApp {
  const a = raw as SharedApp | null;
  return !!a && typeof a === "object" && typeof a.app === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(a.app) && typeof a.title === "string" && a.title.length <= 300 && typeof a.version === "string" && a.version.length <= 100
    && (a.icon === undefined || (typeof a.icon === "string" && a.icon.length <= 16 && !/[\/\\.<>]/.test(a.icon)));
}
