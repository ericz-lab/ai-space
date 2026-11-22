import type { AppCapabilities } from "../bus/bus.ts";
import type { HealthCell } from "../model/health.ts";
import type { MachineInventory } from "../model/inventory.ts";
import type { AgentView, AppView, ServiceView } from "../panel/view.ts";
import type { EventInput } from "../scheduler/types.ts";
import type { WidgetView } from "../panel/widgets.ts";
import { FramedSocket } from "../packages/socket.ts";
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
  /** The peer's stable id (its `/api/space` id); absent from an older peer. Survives renames on both sides. */
  id?: string;
  apps: AppView[];
  services: ServiceView[];
  widgets: WidgetView[];
  agents: AgentView[];
  /** Whether the peer offers a terminal to the hub (docs/terminal.md). */
  terminal: boolean;
  /** What the peer's apps provide, publish and consume (docs/events.md); empty for a peer without the bus. */
  capabilities: AppCapabilities[];
  /** The runtimes the peer answers for other spaces and its status cells (docs/model-machines.md); absent when it offers none. */
  model?: PeerModelInfo;
  /** The agent CLIs on the peer (docs/model-machines.md#inventory); absent from an older peer. */
  inventory?: MachineInventory;
  asOf: string;
};

/** What a peer's snapshot says about its model service. */
export type PeerModelInfo = {
  /** `tiers`: the peer's concrete model per tier, for the hub's model choices. */
  serves: { name: string; kind: string; image: boolean; tiers: Partial<Record<string, string>> }[];
  /** The peer's own cells (machine ""), as its status table shows them. */
  cells: HealthCell[];
  /** The peer keeps a call asked for under a `ref` through a dropped link, and asking again attaches to it (docs/model-machines.md#resuming). */
  resume?: boolean;
};

/** What a peer answers on `/api/peer/events`. */
export type PeerEvent = { id: number; name: string; app: string; at: string; data: Record<string, unknown> };

/**
 * One request over a package connection's channel (packages/links.ts `request`): what a peer whose config
 * names a `connection` sends instead of HTTPS. The other Space answers it as a `peer` operation.
 */
export type PeerChannel = (connection: string, meta: unknown, body: ReadableStream<Uint8Array> | null, signal?: AbortSignal, opts?: { responseTimeoutMs?: number }) => Promise<Response>;

export type PeerClientOptions = {
  store?: PeerStore;
  fetch?: typeof fetch;
  /** The channel a connection peer's requests travel on; a config with a `connection` and no channel cannot reach its peer. */
  channel?: PeerChannel;
  now?: () => number;
  /** Called with the events pulled from the peer after each refresh, oldest first, as inputs ready to publish here. */
  onEvents?: (peer: string, events: EventInput[]) => void;
};

export type PeerHealth = "ok" | "down";

export type PeerStatus = {
  name: string;
  /** The peer's stable id from its snapshot, when it sent one (docs/peers.md#renaming-a-peer). */
  id?: string;
  /** The peer's address (`SPACE_PEER_<NAME>`), or `connection:<id>` for a peer reached over a package connection. */
  url: string;
  /** How the hub reaches it: `http` (`SPACE_PEER_<NAME>` and the peer's `SPACE_HUB_TOKEN`) or a package `connection`. */
  via: "http" | "connection";
  /** The package connection, for a peer reached over one. */
  connection?: string;
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
/**
 * How long a request over a connection may wait for its answer to start: the callers bound their own waits
 * (a forwarded model call, an uninstall, a bus call) as they do over HTTPS; this only catches a lost answer.
 */
const CHANNEL_ANSWER_MS = 15 * 60_000;
/** How long a socket over a connection may take to open. */
const SOCKET_OPEN_MS = 15_000;
/** Events pulled per refresh; a peer that published more is caught up over the next refreshes. */
const EVENTS_PAGE = 200;
/** A snapshot older than this many refresh periods counts as stale. */
const STALE_PERIODS = 2;
/** Failed refreshes in a row before a bus call to the peer is refused without trying. */
const KNOWN_DOWN_FAILURES = 2;
/**
 * What the hub asks a peer for. Its `/api/peer/...` routes answer JSON anyway; the header is for Cloudflare in front of a
 * tunnel, which shapes its own 530 by `Accept`: JSON with the code for this one, an HTML page for Bun's default `*\/*`.
 */
const ACCEPT_JSON = { accept: "application/json" };

export class PeerClient {
  snapshot: PeerSnapshot | undefined;
  error: string | undefined;
  private lastOkAt: number | undefined;
  /** Refreshes that failed in a row. */
  private failures = 0;
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

  /** `connection` when the config names a package connection: every request then travels on its channel, with no credential of the hub's. */
  get via(): "http" | "connection" {
    return this.config.connection ? "connection" : "http";
  }

  /** `ok` while the last successful refresh is recent; a restored snapshot alone is not. */
  health(): PeerHealth {
    return this.lastOkAt !== undefined && this.now() - this.lastOkAt < this.config.refreshMs * STALE_PERIODS ? "ok" : "down";
  }

  /**
   * `down` and the last two refreshes failed: a call to the peer is then refused at once
   * (docs/peers.md#failure-and-staleness). One lost snapshot on a poor link is not enough, and neither is the time
   * just after boot, before any refresh has ended; a call is then forwarded as before.
   */
  knownDown(): boolean {
    return this.failures >= KNOWN_DOWN_FAILURES && this.health() === "down";
  }

  status(): PeerStatus {
    const s = this.snapshot;
    return {
      name: this.name,
      ...(s?.id ? { id: s.id } : {}),
      url: this.config.url,
      via: this.via,
      ...(this.config.connection ? { connection: this.config.connection } : {}),
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

  /** Stop, then wait for a refresh under way, so nothing is written under this name afterwards. */
  async settle(): Promise<void> {
    this.stop();
    await this.inFlight?.catch(() => {});
  }

  /** Fetch the snapshot once; a failure keeps the previous snapshot and records the reason. */
  refresh(): Promise<void> {
    if (!this.inFlight) this.inFlight = this.refreshOnce().finally(() => (this.inFlight = undefined));
    return this.inFlight;
  }

  private async refreshOnce(): Promise<void> {
    try {
      const r = await this.send(SNAPSHOT_PATH, { headers: { ...ACCEPT_JSON, ...this.authHeaders() }, signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS) });
      // Over a connection a refusal is the other Space's own words (a scope it does not grant), not a token.
      if (this.config.connection && !r.ok) throw new Error(await errorOf(r));
      if (r.status === 401 || r.status === 403) throw new Error("token rejected");
      if (!r.ok) throw new Error(await httpError(r));
      const snap = parseSnapshot(await r.json());
      // A connection is bound to one Space: its id is the peer's identity (docs/peers.md#renaming-a-peer).
      if (this.config.spaceId) snap.id = this.config.spaceId;
      this.snapshot = snap;
      this.error = undefined;
      this.failures = 0;
      this.lastOkAt = this.now();
      this.opts.store?.set(this.name, snap);
      if (this.opts.onEvents) await this.pullEvents();
    } catch (e) {
      this.error = String((e as Error).message ?? e).slice(0, 200);
      this.failures++;
    }
  }

  /**
   * Mirror the peer's new events: everything after the cursor, oldest first, handed to `onEvents`
   * as inputs that carry the peer's name and the original time. A peer whose ids went backwards
   * (a reset database) restarts the cursor at its newest id, so nothing old is mirrored twice.
   * A peer without the route (older version) is left alone.
   */
  async pullEvents(): Promise<number> {
    const r = await this.send(`${EVENTS_PATH}?since=${this.cursor}&limit=${EVENTS_PAGE}`, { headers: { ...ACCEPT_JSON, ...this.authHeaders() }, signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS) });
    // An older peer without the route, or a connection that grants the panel but not the events scope: nothing to mirror.
    if (r.status === 404 || (this.config.connection && r.status === 403)) {
      await r.body?.cancel().catch(() => {});
      return 0;
    }
    if (!r.ok) throw new Error(`events: HTTP ${r.status}`);
    const body = (await r.json()) as { ok?: boolean; events?: PeerEvent[]; latestId?: number; next?: number };
    if (body.ok !== true || !Array.isArray(body.events)) throw new Error("events: not an event list");
    const latest = typeof body.latestId === "number" ? body.latestId : undefined;
    // The last id the peer's page covered, hidden apps included (absent on older peers).
    const next = typeof body.next === "number" && Number.isFinite(body.next) ? body.next : undefined;
    const events = body.events.filter((e) => typeof e.id === "number" && typeof e.app === "string" && typeof e.name === "string");
    const before = this.cursor;
    if (events.length) {
      const inputs: EventInput[] = events.map((e) => ({ app: e.app, name: e.name.slice(e.app.length + 1), data: e.data && typeof e.data === "object" ? e.data : {}, peer: this.name, at: Date.parse(e.at) || this.now() }));
      this.opts.onEvents?.(this.name, inputs);
      this.cursor = events[events.length - 1]!.id;
    }
    if (next !== undefined && next > this.cursor && (latest === undefined || next <= latest)) {
      this.cursor = next;
    } else if (this.cursor === before && latest !== undefined && latest < this.cursor) {
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
    // Bytes, not text: a forwarded call may carry a recording or an image, and decoding one as UTF-8 destroys it.
    if (req.method !== "GET" && req.method !== "HEAD") init.body = await req.arrayBuffer();
    const up = await this.send(path, init);
    // A chat turn's run id rides along, so the browser can reattach to it or stop it on the peer.
    const runId = up.headers.get("x-run-id");
    return new Response(up.body, { status: up.status, headers: { "content-type": up.headers.get("content-type") ?? "application/octet-stream", "cache-control": "no-store", ...(runId ? { "x-run-id": runId } : {}) } });
  }

  /** A request of this space's own to the peer's `/api/peer/...` path (forwarded model calls); JSON unless the caller asks for something else (a stream). */
  request(path: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<Response> {
    const own = init.headers ?? {};
    const accept = Object.keys(own).some((k) => k.toLowerCase() === "accept") ? {} : ACCEPT_JSON;
    return this.send(path, { ...init, headers: { ...accept, ...this.authHeaders(), ...own } });
  }

  /**
   * A socket to the peer's `/api/peer/...` path (the terminal's, an app's through the proxy): a WebSocket with the
   * token over HTTPS, a `FramedSocket` on the connection's channel. Either behaves as a client WebSocket.
   */
  socket(path: string): WebSocket {
    const connection = this.config.connection;
    if (!connection) return new WebSocket(this.config.url.replace(/^http/, "ws") + path, { headers: this.authHeaders() } as unknown as string[]);
    const meta = { operation: "peer", method: "GET", path, headers: [], socket: true };
    return new FramedSocket((input, signal) => this.channel(connection, meta, input, signal, { responseTimeoutMs: SOCKET_OPEN_MS })) as unknown as WebSocket;
  }

  /** The headers every request to the peer carries: the access layer's extras and the bearer token. None over a connection. */
  authHeaders(): Record<string, string> {
    if (this.config.connection) return {};
    return { ...this.config.headers, ...(this.config.token ? { authorization: `Bearer ${this.config.token}` } : {}) };
  }

  /**
   * Where every request to the peer goes: HTTPS to `url + path`, or the connection's channel as a `peer`
   * operation that carries the method, the path, the headers given here (no credential is added) and the body.
   */
  private async send(path: string, init: RequestInit): Promise<Response> {
    const connection = this.config.connection;
    if (!connection) return this.fetch(this.config.url + path, init);
    const headers = [...new Headers(init.headers)];
    const method = (init.method ?? "GET").toUpperCase();
    const body = method === "GET" || method === "HEAD" || init.body == null ? null : new Response(init.body).body;
    return this.channel(connection, { operation: "peer", method, path, headers }, body, init.signal ?? undefined, { responseTimeoutMs: CHANNEL_ANSWER_MS });
  }

  private get channel(): PeerChannel {
    if (!this.opts.channel) throw new Error(`peer ${this.name} is reached over a connection, and none is available`);
    return this.opts.channel;
  }

  private get fetch(): typeof fetch {
    return this.opts.fetch ?? fetch;
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }
}

/** The `error` of a JSON refusal, else the status. */
async function errorOf(r: Response): Promise<string> {
  const j = (await r.json().catch(() => null)) as { error?: unknown } | null;
  return typeof j?.error === "string" ? j.error.slice(0, 200) : `HTTP ${r.status}`;
}

/** Cloudflare's own 1xxx codes that mean the peer's tunnel, not the peer, is what failed. */
const CLOUDFLARE_CODES: Record<string, string> = {
  "1033": "tunnel not connected",
  "1016": "origin DNS error",
};

/** How far into a 530's body to look for the code: Cloudflare's HTML page puts it after kilobytes of inline CSS. */
const ERROR_BODY_LIMIT = 64 * 1024;

/**
 * Why a refresh got an error status. Cloudflare answers 530 itself when the peer's tunnel has no
 * connector (the machine asleep, offline, or its `cloudflared` stopped), with its own code in the
 * body; that says more than the status alone (docs/peers.md#failure-and-staleness).
 */
export async function httpError(r: Response): Promise<string> {
  if (r.status !== 530) return `HTTP ${r.status}`;
  const body = (await r.text().catch(() => "")).slice(0, ERROR_BODY_LIMIT);
  const code = cloudflareCode(r.headers.get("content-type") ?? "", body);
  if (!code) return "HTTP 530";
  const meaning = CLOUDFLARE_CODES[code];
  return meaning ? `${meaning} (Cloudflare ${code})` : `HTTP 530 (Cloudflare ${code})`;
}

/**
 * Cloudflare's 1xxx code in the shape its `Accept` rules pick: JSON (`"error_code": 1033`) for `application/json`, Markdown
 * frontmatter (`error_code: 1033`) for `text/markdown`, an HTML page (`<span class="cf-error-code">1033</span>`) for `*\/*`,
 * which a zone's custom error page also sends whatever was asked, and plain `error code: 1033`, which curl gets.
 */
function cloudflareCode(contentType: string, body: string): string | undefined {
  if (/\bjson\b/i.test(contentType)) {
    try {
      const c = (JSON.parse(body) as { error_code?: unknown } | null)?.error_code;
      if ((typeof c === "number" || typeof c === "string") && /^1\d{3}$/.test(String(c))) return String(c);
    } catch {
      // Not JSON after all: look for the text forms below.
    }
  }
  return /(?:error[ _]code"?\s*:?\s*|cf-error-code["']?\s*>\s*)(1\d{3})\b/i.exec(body)?.[1];
}

/** Accept only the shape the hub relies on; anything else is a peer of another version. */
export function parseSnapshot(j: unknown): PeerSnapshot {
  const o = j as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || o.ok !== true) throw new Error(typeof o?.error === "string" ? o.error : "not a snapshot");
  for (const k of ["apps", "services", "widgets", "agents"]) if (!Array.isArray(o[k])) throw new Error(`snapshot has no ${k} list`);
  return {
    name: typeof o.name === "string" ? o.name : "",
    ...(typeof o.id === "string" && o.id ? { id: o.id.slice(0, 200) } : {}),
    apps: o.apps as AppView[],
    services: o.services as ServiceView[],
    widgets: o.widgets as WidgetView[],
    agents: o.agents as AgentView[],
    terminal: o.terminal === true,
    capabilities: Array.isArray(o.capabilities) ? (o.capabilities as AppCapabilities[]) : [],
    ...(parseModelInfo(o.model) ? { model: parseModelInfo(o.model)! } : {}),
    ...(parseInventory(o.inventory) ? { inventory: parseInventory(o.inventory)! } : {}),
    asOf: typeof o.asOf === "string" ? o.asOf : new Date().toISOString(),
  };
}

function parseModelInfo(v: unknown): PeerModelInfo | undefined {
  const o = v as { serves?: unknown; cells?: unknown } | null;
  if (!o || typeof o !== "object" || !Array.isArray(o.serves)) return undefined;
  const serves = o.serves.filter((r): r is PeerModelInfo["serves"][number] => typeof r?.name === "string" && typeof r?.kind === "string").map((r) => ({ name: r.name, kind: r.kind, image: r.image === true, tiers: tiersOf(r.tiers) }));
  const cells = Array.isArray(o.cells) ? (o.cells as HealthCell[]).filter((c) => typeof c?.runtime === "string") : [];
  return { serves, cells, ...((o as { resume?: unknown }).resume === true ? { resume: true } : {}) };
}

/** A peer's CLI row: only the fields the panel shows, of the expected types. */
function parseInventory(v: unknown): MachineInventory | undefined {
  const o = v as { clis?: unknown; reachable?: unknown } | null;
  if (!o || typeof o !== "object" || !Array.isArray(o.clis)) return undefined;
  const str = (x: unknown) => (typeof x === "string" ? x.slice(0, 200) : undefined);
  const bool = (x: unknown) => (typeof x === "boolean" ? x : undefined);
  const clis = (o.clis as Record<string, unknown>[])
    .filter((c) => c && typeof c.cli === "string" && typeof c.kind === "string")
    .slice(0, 16)
    .map((c) => {
      const out: MachineInventory["clis"][number] = { cli: str(c.cli)!, kind: str(c.kind)!, configured: c.configured === true, runtimes: Array.isArray(c.runtimes) ? (c.runtimes as unknown[]).filter((r): r is string => typeof r === "string").slice(0, 16) : [] };
      for (const k of ["installed", "signedIn"] as const) if (bool(c[k]) !== undefined) out[k] = bool(c[k]);
      for (const k of ["version", "detail", "checkedAt"] as const) if (str(c[k]) !== undefined) out[k] = str(c[k]);
      return out;
    });
  return { machine: "", via: "local", ...(o.reachable === false ? { reachable: false } : {}), clis };
}

function tiersOf(v: unknown): Partial<Record<string, string>> {
  if (!v || typeof v !== "object") return {};
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"));
}
