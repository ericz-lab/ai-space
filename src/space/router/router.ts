import { mkdir } from "node:fs/promises";
import type { Manifest } from "../scheduler/manifest.ts";
import { CaddyBackend } from "./caddy.ts";
import { renderCaddyfile } from "./caddyfile.ts";
import { routeTable } from "./table.ts";
import type { Route, RouterConfig, RouterStatus, SyncResult } from "./types.ts";

/**
 * Keeps the proxy's configuration in step with the registry. `sync()` is
 * called after every change (boot, provision, removal) and is coalesced: a
 * boot that registers thirty apps writes and reloads once. A failed write or
 * reload is logged and kept for `/api/router`; it never reaches the caller,
 * so a broken router cannot stop an app from registering.
 *
 * With the backend `none` nothing is written; the table is still computed so
 * the API can show what would be routed.
 */

export type RouterOptions = {
  config: RouterConfig;
  /** The registry's manifests, read at each sync. */
  apps: () => Manifest[];
  /** The panel's port, for `SPACE_PANEL_HOST`. */
  panelPort: number;
  /** `<workspace>/run/Caddyfile`. */
  file: string;
  /** `<workspace>/run/caddy.sock`. */
  socket: string;
  /** `<workspace>/logs/router`. */
  logDir: string;
  backend?: CaddyBackend;
  log?: (line: string) => void;
  /** How long to wait for more changes before writing; default 200 ms. */
  debounceMs?: number;
};

export class Router {
  private readonly backend: CaddyBackend;
  private readonly debounceMs: number;
  private readonly log: (line: string) => void;
  private lastSync?: SyncResult;
  private pending?: { promise: Promise<SyncResult>; resolve: (r: SyncResult) => void };
  private timer?: ReturnType<typeof setTimeout>;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: RouterOptions) {
    this.backend = opts.backend ?? new CaddyBackend({ bin: opts.config.caddyBin, file: opts.file, socket: opts.socket });
    this.debounceMs = opts.debounceMs ?? 200;
    this.log = opts.log ?? (() => {});
  }

  get enabled(): boolean {
    return this.opts.config.backend !== "none";
  }

  table(): Route[] {
    const { domain, panelHost } = this.opts.config;
    return routeTable(this.opts.apps(), { domain, panelHost, panelPort: this.opts.panelPort });
  }

  status(): RouterStatus {
    const { backend, domain, port } = this.opts.config;
    return { router: backend, domain, port, file: this.opts.file, routes: this.table(), ...(this.lastSync ? { lastSync: this.lastSync } : {}) };
  }

  /** Schedule a write; every call within the window shares one run. Never rejects. */
  sync(): Promise<SyncResult> {
    if (!this.pending) {
      let resolve!: (r: SyncResult) => void;
      const promise = new Promise<SyncResult>((r) => (resolve = r));
      this.pending = { promise, resolve };
    }
    const p = this.pending;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pending = undefined;
      this.chain = this.chain.then(() => this.run()).then(p.resolve);
    }, this.debounceMs);
    return p.promise;
  }

  /** Write now, without the window; runs after any sync already in flight. */
  syncNow(): Promise<SyncResult> {
    const p = this.chain.then(() => this.run());
    this.chain = p;
    return p;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending?.resolve({ at: new Date().toISOString(), ok: true, changed: false });
    this.pending = undefined;
  }

  private async run(): Promise<SyncResult> {
    const at = new Date().toISOString();
    if (!this.enabled) return (this.lastSync = { at, ok: true, changed: false });
    try {
      const routes = this.table();
      for (const r of routes) if (r.status === "conflict") this.log(`${r.app}: ${r.host} is already routed to another app; not rendered`);
      await mkdir(this.opts.logDir, { recursive: true });
      const changed = await this.backend.write(renderCaddyfile(routes, { port: this.opts.config.port, socket: this.opts.socket, logDir: this.opts.logDir }));
      // Reload on a change, and again after a failure even when nothing changed (Caddy may be up now).
      if (changed || !this.lastSync?.ok) {
        await this.backend.reload();
        this.log(`${changed ? "wrote" : "kept"} ${this.opts.file} (${routes.filter((r) => r.status !== "conflict").length} routes) and reloaded caddy`);
      }
      return (this.lastSync = { at, ok: true, changed });
    } catch (e) {
      const error = (e as Error).message;
      this.log(`sync failed: ${error}`);
      return (this.lastSync = { at, ok: false, changed: false, error });
    }
  }
}
