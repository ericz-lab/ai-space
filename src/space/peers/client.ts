import type { AppCapabilities } from "../bus/bus.ts";
import type { AgentView, AppView, ServiceView } from "../panel/view.ts";
import type { EventInput } from "../scheduler/types.ts";
import type { WidgetView } from "../panel/widgets.ts";
import type { PeerConfig } from "./config.ts";
import type { PeerStore } from "./store.ts";

/**
 * One peer as the hub sees it: a snapshot of its panel refreshed on a timer,
 * the last good copy kept when a refresh fails, and a forwarder for the
 * requests that must run on the peer (chat, sessions, embed pages, icons).
 * A browser request never waits for a peer: lists read the cached snapshot.
 */

export type PeerSnapshot = {
  /** What the peer calls itself (`SPACE_NAME`); informative only. */
  name: string;
  apps: AppView[];
  services: ServiceView[];
  widgets: WidgetView[];
  agents: AgentView[];
  /** Whether the peer offers a terminal to the hub (docs/terminal.md). */
  terminal: boolean;
  /** What the peer's apps provide, publish and consume (docs/events.md); empty for a peer without the bus. */
  capabilities: AppCapabilities[];
  asOf: string;
};

/** What a peer answers on `/api/peer/events`. */
export type PeerEvent = { id: number; name: string; app: string; at: string; data: Record<string, unknown> };

export type PeerClientOptions = {
  store?: PeerStore;
  fetch?: typeof fetch;
  now?: () => number;
  /** Called with the events pulled from the peer after each refresh, oldest first, as inputs ready to publish here. */
  onEvents?: (peer: string, events: EventInput[]) => void;
};

export type PeerHealth = "ok" | "down";

export type PeerStatus = {
  name: string;
  url: string;
  health: PeerHealth;
  /** Time of the snapshot on show, when there is one. */
  asOf?: string;
  /** Why the last refresh failed, when it did. */
  error?: string;
  /** True when the snapshot on show is older than the health window (the peer is down). */
  stale: boolean;
  apps: number;
  agents: number;
  widgets: number;
  services: number;
};

export const SNAPSHOT_PATH = "/api/peer/snapshot";
export const EVENTS_PATH = "/api/peer/events";
const SNAPSHOT_TIMEOUT_MS = 8_000;
/** Events pulled per refresh; a peer that published more is caught up over the next refreshes. */
const EVENTS_PAGE = 200;
/** A snapshot older than this many refresh periods counts as stale. */
const STALE_PERIODS = 2;

export class PeerClient {
  snapshot: PeerSnapshot | undefined;
  error: string | undefined;
  private lastOkAt: number | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> | undefined;

  /** Id of the last event mirrored from the peer. */
  private cursor: number;

  constructor(
    readonly config: PeerConfig,
    private readonly opts: PeerClientOptions = {},
  ) {
    this.snapshot = opts.store?.get(config.name);
    this.cursor = opts.store?.cursor(config.name) ?? 0;
  }

  get name(): string {
    return this.config.name;
  }

  /** `ok` while the last successful refresh is recent; a restored snapshot alone is not. */
  health(): PeerHealth {
    return this.lastOkAt !== undefined && this.now() - this.lastOkAt < this.config.refreshMs * STALE_PERIODS ? "ok" : "down";
  }

  status(): PeerStatus {
    const s = this.snapshot;
    return {
      name: this.name,
      url: this.config.url,
      health: this.health(),
      ...(s ? { asOf: s.asOf } : {}),
      ...(this.error ? { error: this.error } : {}),
      stale: this.health() !== "ok",
      apps: s?.apps.length ?? 0,
      agents: s?.agents.length ?? 0,
      widgets: s?.widgets.length ?? 0,
      services: s?.services.length ?? 0,
    };
  }

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.config.refreshMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Fetch the snapshot once; a failure keeps the previous snapshot and records the reason. */
  refresh(): Promise<void> {
    if (!this.inFlight) this.inFlight = this.refreshOnce().finally(() => (this.inFlight = undefined));
    return this.inFlight;
  }

  private async refreshOnce(): Promise<void> {
    try {
      const r = await this.fetch(this.config.url + SNAPSHOT_PATH, { headers: this.authHeaders(), signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS) });
      if (r.status === 401 || r.status === 403) throw new Error("token rejected");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const snap = parseSnapshot(await r.json());
      this.snapshot = snap;
      this.error = undefined;
      this.lastOkAt = this.now();
      this.opts.store?.set(this.name, snap);
      if (this.opts.onEvents) await this.pullEvents();
    } catch (e) {
      this.error = String((e as Error).message ?? e).slice(0, 200);
    }
  }

  /**
   * Mirror the peer's new events: everything after the cursor, oldest first, handed to `onEvents`
   * as inputs that carry the peer's name and the original time. A peer whose ids went backwards
   * (a reset database) restarts the cursor at its newest id, so nothing old is mirrored twice.
   * A peer without the route (older version) is left alone.
   */
  async pullEvents(): Promise<number> {
    const r = await this.fetch(`${this.config.url}${EVENTS_PATH}?since=${this.cursor}&limit=${EVENTS_PAGE}`, { headers: this.authHeaders(), signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS) });
    if (r.status === 404) return 0;
    if (!r.ok) throw new Error(`events: HTTP ${r.status}`);
    const body = (await r.json()) as { ok?: boolean; events?: PeerEvent[]; latestId?: number };
    if (body.ok !== true || !Array.isArray(body.events)) throw new Error("events: not an event list");
    const latest = typeof body.latestId === "number" ? body.latestId : undefined;
    const events = body.events.filter((e) => typeof e.id === "number" && typeof e.app === "string" && typeof e.name === "string");
    if (events.length) {
      const inputs: EventInput[] = events.map((e) => ({ app: e.app, name: e.name.slice(e.app.length + 1), data: e.data && typeof e.data === "object" ? e.data : {}, peer: this.name, at: Date.parse(e.at) || this.now() }));
      this.opts.onEvents?.(this.name, inputs);
      this.cursor = events[events.length - 1]!.id;
    } else if (latest !== undefined && latest < this.cursor) {
      this.cursor = latest;
    }
    this.opts.store?.setCursor(this.name, this.cursor);
    return events.length;
  }

  /** Whether the peer's snapshot says one of its apps provides the capability. */
  provides(app: string, capability?: string): boolean {
    const a = this.snapshot?.capabilities.find((c) => c.app === app);
    return Boolean(a && (capability === undefined || a.provides.some((c) => c.name === capability)));
  }

  /**
   * Forward a browser request to the peer's `/api/peer/...` path and stream the
   * answer back. Bodies are small JSON, so they are read whole; the response
   * body (a file, a page, an SSE stream) is passed through as it arrives.
   */
  async forward(req: Request, path: string, opts: { timeoutMs?: number; headers?: Record<string, string> } = {}): Promise<Response> {
    const headers = { ...this.authHeaders(), ...(opts.headers ?? {}) };
    const ct = req.headers.get("content-type");
    if (ct) headers["content-type"] = ct;
    const init: RequestInit = { method: req.method, headers, signal: opts.timeoutMs ? AbortSignal.any([req.signal, AbortSignal.timeout(opts.timeoutMs)]) : req.signal };
    if (req.method !== "GET" && req.method !== "HEAD") init.body = await req.text();
    const up = await this.fetch(this.config.url + path, init);
    return new Response(up.body, { status: up.status, headers: { "content-type": up.headers.get("content-type") ?? "application/octet-stream", "cache-control": "no-store" } });
  }

  /** The headers every request to the peer carries: the access layer's extras and the bearer token. */
  authHeaders(): Record<string, string> {
    return { ...this.config.headers, ...(this.config.token ? { authorization: `Bearer ${this.config.token}` } : {}) };
  }

  private get fetch(): typeof fetch {
    return this.opts.fetch ?? fetch;
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }
}

/** Accept only the shape the hub relies on; anything else is a peer of another version. */
export function parseSnapshot(j: unknown): PeerSnapshot {
  const o = j as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || o.ok !== true) throw new Error(typeof o?.error === "string" ? o.error : "not a snapshot");
  for (const k of ["apps", "services", "widgets", "agents"]) if (!Array.isArray(o[k])) throw new Error(`snapshot has no ${k} list`);
  return {
    name: typeof o.name === "string" ? o.name : "",
    apps: o.apps as AppView[],
    services: o.services as ServiceView[],
    widgets: o.widgets as WidgetView[],
    agents: o.agents as AgentView[],
    terminal: o.terminal === true,
    capabilities: Array.isArray(o.capabilities) ? (o.capabilities as AppCapabilities[]) : [],
    asOf: typeof o.asOf === "string" ? o.asOf : new Date().toISOString(),
  };
}
