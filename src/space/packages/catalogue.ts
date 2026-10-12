import type { AppView } from "../panel/view.ts";
import type { PackageLinks, SharedApp } from "./links.ts";

type Entry = { name?: string; spaceId: string; apps: SharedApp[]; ok: boolean };

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
    // A changed grant closes the channel; ask again once it had time to reconnect.
    this.unsubscribe = links.connections.onChange(() => {
      this.prune();
      clearTimeout(this.soon);
      this.soon = setTimeout(() => void this.refresh(), 6000); this.soon.unref();
    });
  }
  private readonly timeoutMs: number;

  refresh(): Promise<void> {
    return this.running ??= this.load().finally(() => { this.running = undefined; });
  }

  /** One tile per shared app that has a page; ids are `<space name>/<app>`, like a peer's. */
  views(hidden: Set<string>): AppView[] {
    const out: AppView[] = [];
    for (const [connection, e] of this.entries) {
      const label = e.name ?? e.spaceId.slice(0, 8);
      for (const a of e.apps) {
        const id = `${label}/${a.app}`;
        out.push({
          id, name: a.app, peer: label, connection, stale: !e.ok, title: a.title, icon: "",
          ...(a.page === false ? {} : { url: `/_space/connections/${connection}/apps/${encodeURIComponent(a.app)}` }),
          status: "active", manifestOnly: false, hidden: hidden.has(id), agents: [], widgets: [],
        });
      }
    }
    return out;
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
        if (!response.ok) throw new Error("catalogue unavailable");
        const data = await response.json() as { spaceId?: unknown; name?: unknown; apps?: unknown };
        // The connection is bound to one Space identity; an answer from another is not its catalogue.
        if (data.spaceId !== c.remoteSpaceId || !Array.isArray(data.apps)) throw new Error("catalogue does not match the connection");
        const apps = data.apps.filter(isSharedApp).slice(0, 1000);
        const name = typeof data.name === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(data.name) ? data.name : undefined;
        if (this.links.connections.get(c.id)?.enabled) this.entries.set(c.id, { spaceId: c.remoteSpaceId, apps, ok: true, ...(name ? { name } : {}) });
      } catch {
        const last = this.entries.get(c.id);
        if (last) last.ok = false;
      }
    }));
  }
}

function isSharedApp(raw: unknown): raw is SharedApp {
  const a = raw as SharedApp | null;
  return !!a && typeof a === "object" && typeof a.app === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(a.app) && typeof a.title === "string" && a.title.length <= 300 && typeof a.version === "string";
}
