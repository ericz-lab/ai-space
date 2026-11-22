/** Bounded, bidirectional request/response streams over an authenticated WebSocket (docs/app-packages.md#connected-space-api). */

/**
 * The frame protocol both ends must speak; the dialer sends it on the upgrade and the acceptor in its
 * `hello` (links.ts). Version 2 added the separate budgets, the `503` refusal of one stream and the `peer`
 * operation; a version-1 end would read a refusal as a broken channel, so the two refuse each other.
 */
export const CHANNEL_PROTOCOL = 2;
const CHUNK = 32 * 1024;
const MAX_MESSAGE = 64 * 1024;

/**
 * How many streams a channel carries at once. A stream holds at most one 32 KiB chunk in flight (one
 * credit), so 128 per direction bound a channel's buffered body bytes to about 4 MiB each way, the same
 * as the socket's backpressure limit (links.ts). That leaves room for what stays open for hours (a chat
 * turn's SSE, an agent's watch stream, each open terminal and app socket: a panel on three devices keeps
 * a few dozen) next to bursts of short requests (a catalogue round, icons, a model call).
 * `perKind` caps the streams of one consumer (one app, or one peer scope such as `agents`) in each
 * direction, so a runaway app or a dozen forgotten chat tabs cannot take the channel: at a quarter of
 * the budget, four consumers at their cap still leave room for everyone else.
 * `creditIdleMs` releases a reply nobody reads: a chunk ready on the answering side whose reader gives
 * no credit for that long. A quiet stream (an SSE between events, an idle terminal) is waiting for data,
 * not for credit, and never meets it; a reader that stops for two minutes with data waiting is gone.
 */
export const STREAM_LIMITS = { opened: 128, accepted: 128, perKind: 32, creditIdleMs: 120_000 };
export type StreamLimits = typeof STREAM_LIMITS;
/** Set on a refusal the channel itself answers (a full budget); its value says why. */
export const REFUSED_HEADER = "x-space-channel-refused";

type Wire = { kind: string; id: string; [key: string]: unknown };
type Body = { stream: ReadableStream<Uint8Array>; data: (bytes: Uint8Array) => void; end: () => void; fail: (error: Error) => void };
type State = {
  abort: AbortController;
  body?: Body;
  resolve?: (response: Response) => void;
  reject?: (error: Error) => void;
  credit?: () => void;
  granted: boolean;
  timer?: ReturnType<typeof setTimeout>;
  /** Whether the other side opened it (counted against `accepted`, not `opened`). */
  accepted: boolean;
  /**
   * The consumer the stream belongs to (`classify`: `app:<name>`, `scope:<name>`), for the per-kind cap and so
   * a revoked grant or scope ends its streams alone.
   */
  kind?: string;
};
/** How long a request waits for its answer to start; a caller whose work takes longer (a forwarded model call) says so. */
const RESPONSE_TIMEOUT_MS = 30_000;
export type RequestOptions = { responseTimeoutMs?: number };
export type ChannelOptions = {
  /** Who a request belongs to, from its metadata; undefined = no consumer (a catalogue round), counted in the totals only. */
  classify?: (meta: unknown) => string | undefined;
  limits?: Partial<StreamLimits>;
};

export class PackageChannel {
  private readonly states = new Map<string, State>();
  private closed = false;
  private readonly limits: StreamLimits;
  constructor(private readonly sendWire: (text: string) => void, private readonly handler: (meta: unknown, body: ReadableStream<Uint8Array>, signal: AbortSignal) => Promise<Response>, private readonly prefix: "a" | "b", private readonly onClose?: () => void, private readonly options: ChannelOptions = {}) {
    this.limits = { ...STREAM_LIMITS, ...options.limits };
  }

  /**
   * Send one request. A full budget on either side answers `503` with `REFUSED_HEADER` (this side's at
   * once, the other side's when its refusal arrives) and the channel stays up; a closed channel throws.
   */
  async request(meta: unknown, body: ReadableStream<Uint8Array> | null = null, signal?: AbortSignal, opts: RequestOptions = {}): Promise<Response> {
    if (this.closed) throw new Error("connection unavailable");
    if (signal?.aborted) throw new Error("request aborted");
    const kind = this.options.classify?.(meta);
    const full = this.full(false, kind);
    if (full) { await body?.cancel().catch(() => {}); return refused(full); }
    const id = `${this.prefix}-${crypto.randomUUID()}`;
    const s: State = { abort: new AbortController(), granted: false, accepted: false, ...(kind ? { kind } : {}) };
    this.states.set(id, s);
    const response = new Promise<Response>((resolve, reject) => { s.resolve = resolve; s.reject = reject; });
    s.body = this.body(id);
    s.timer = setTimeout(() => this.cancel(id, new Error("remote response timed out")), opts.responseTimeoutMs ?? RESPONSE_TIMEOUT_MS);
    const onAbort = () => this.cancel(id, new Error("request aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
    s.abort.signal.addEventListener("abort", () => signal?.removeEventListener("abort", onAbort), { once: true });
    try { this.send({ kind: "open", id, meta }); }
    catch (e) { this.cancel(id, e as Error); }
    void this.pump(id, s, body);
    return response;
  }

  receive(text: string): void {
    try {
      if (this.closed || text.length > MAX_MESSAGE) throw new Error("oversized channel frame");
      const m = JSON.parse(text) as Wire;
      if (!m || typeof m.kind !== "string" || typeof m.id !== "string" || !/^[ab]-[a-f0-9-]{36}$/.test(m.id)) throw new Error("invalid channel frame");
      if (m.kind === "open") {
        if (m.id.startsWith(this.prefix) || this.states.has(m.id)) throw new Error("invalid stream open");
        const kind = this.options.classify?.(m.meta);
        const full = this.full(true, kind);
        // A full budget refuses this one request and keeps no state for it: later frames for the id are dropped.
        if (full) { this.send({ kind: "response", id: m.id, status: 503, headers: [["content-type", "application/json"], [REFUSED_HEADER, full]] }); this.send({ kind: "end", id: m.id }); return; }
        const s: State = { abort: new AbortController(), granted: false, accepted: true, ...(kind ? { kind } : {}) };
        this.states.set(m.id, s); s.body = this.body(m.id);
        void this.respond(m.id, s, m.meta);
        return;
      }
      const s = this.states.get(m.id);
      if (!s) return; // Late credit/cancel after a stream completed, or frames of a refused one.
      switch (m.kind) {
        case "response": {
          if (!s.resolve || typeof m.status !== "number" || !Number.isInteger(m.status) || m.status < 200 || m.status > 599 || !Array.isArray(m.headers)) throw new Error("invalid response frame");
          clearTimeout(s.timer);
          const headers = m.headers as [string, string][];
          const why = m.status === 503 ? headers.find(([name]) => name === REFUSED_HEADER)?.[1] : undefined;
          // The other side's refusal: its `end` follows and finishes the stream.
          if (why !== undefined) { s.resolve(refused(String(why).slice(0, 200))); s.resolve = undefined; s.reject = undefined; break; }
          const noBody = [204, 205, 304].includes(m.status);
          s.resolve(new Response(noBody ? null : s.body!.stream, { status: m.status, headers }));
          s.resolve = undefined; s.reject = undefined;
          if (noBody) void s.body!.stream.cancel();
          break;
        }
        case "data": {
          if (typeof m.data !== "string" || m.data.length > Math.ceil(CHUNK / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(m.data)) throw new Error("invalid body frame");
          s.body!.data(Buffer.from(m.data, "base64")); break;
        }
        case "end": s.body!.end(); if (!m.id.startsWith(this.prefix)) break; this.finish(m.id); break;
        case "credit": {
          if (s.granted) throw new Error("duplicate stream credit");
          s.granted = true; s.credit?.(); s.credit = undefined; break;
        }
        case "cancel": this.cancel(m.id, new Error("remote cancelled request"), false); break;
        default: throw new Error("unknown channel frame");
      }
    } catch (e) { this.close((e as Error).message); }
  }

  /**
   * End every stream the other side opened for one of `kinds` (`app:<name>`, `scope:<name>`: a revoked grant
   * or scope): its handler is aborted, the other side is told, and frames arriving for it later are dropped.
   * The channel and other streams stay.
   */
  cancelKinds(kinds: readonly string[], reason = "access revoked"): number {
    let n = 0;
    for (const [id, s] of [...this.states]) {
      if (!s.accepted || s.kind === undefined || !kinds.includes(s.kind)) continue;
      this.cancel(id, new Error(reason)); n++;
    }
    return n;
  }

  cancelApps(apps: readonly string[], reason = "application access revoked"): number { return this.cancelKinds(apps.map((a) => `app:${a}`), reason); }

  /** Streams open now, by who opened them; for tests and the status of a connection. */
  counts(): { opened: number; accepted: number } {
    let accepted = 0;
    for (const s of this.states.values()) if (s.accepted) accepted++;
    return { opened: this.states.size - accepted, accepted };
  }

  close(reason = "connection closed"): void {
    if (this.closed) return;
    this.closed = true;
    for (const id of [...this.states.keys()]) this.cancel(id, new Error(reason), false);
    this.onClose?.();
  }

  /** Why one more stream in this direction (and of this kind) does not fit, or undefined when it does. */
  private full(accepted: boolean, kind: string | undefined): string | undefined {
    let total = 0, same = 0;
    for (const s of this.states.values()) {
      if (s.accepted !== accepted) continue;
      total++;
      if (kind !== undefined && s.kind === kind) same++;
    }
    const limit = accepted ? this.limits.accepted : this.limits.opened;
    if (total >= limit) return `stream limit reached (${limit} ${accepted ? "accepted" : "opened"})`;
    if (kind !== undefined && same >= this.limits.perKind) return `stream limit reached for ${kind} (${this.limits.perKind})`;
    return undefined;
  }

  private async respond(id: string, s: State, meta: unknown): Promise<void> {
    try {
      const response = await this.handler(meta, s.body!.stream, s.abort.signal);
      if (s.abort.signal.aborted) { await response.body?.cancel().catch(() => {}); return; }
      const headers = [...response.headers].filter(([name]) => name !== "set-cookie" && name !== REFUSED_HEADER);
      for (const cookie of response.headers.getSetCookie()) headers.push(["set-cookie", cookie]);
      this.send({ kind: "response", id, status: response.status, headers });
      await this.pump(id, s, response.body, this.limits.creditIdleMs);
      this.finish(id);
    } catch (e) { this.cancel(id, e as Error); }
  }

  private body(id: string): Body {
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let waiting: (() => void) | undefined;
    let done = false;
    const stream = new ReadableStream<Uint8Array>({
      start: (c) => { controller = c; },
      pull: () => {
        if (done) return;
        return new Promise<void>((resolve) => { waiting = resolve; this.send({ kind: "credit", id }); });
      },
      cancel: () => { done = true; waiting?.(); waiting = undefined; this.cancel(id, new Error("body cancelled")); },
    }, { highWaterMark: 0 });
    return {
      stream,
      data: (bytes) => {
        if (done || !waiting) throw new Error("body arrived without credit");
        controller.enqueue(bytes); const resolve = waiting; waiting = undefined; resolve();
      },
      end: () => { if (!done) { done = true; controller.close(); waiting?.(); waiting = undefined; } },
      fail: (e) => { if (!done) { done = true; controller.error(e); waiting?.(); waiting = undefined; } },
    };
  }

  /** Send `stream` as data frames, one per credit; with `idleMs`, a chunk left waiting that long for credit cancels the stream. */
  private async pump(id: string, s: State, stream: ReadableStream<Uint8Array> | null, idleMs?: number): Promise<void> {
    const reader = stream?.getReader();
    const abort = () => { void reader?.cancel().catch(() => {}); s.credit?.(); s.credit = undefined; };
    s.abort.signal.addEventListener("abort", abort, { once: true });
    try {
      if (reader) for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (let at = 0; at < value.length; at += CHUNK) {
          if (!s.granted && !s.abort.signal.aborted) {
            const stalled = idleMs ? setTimeout(() => this.cancel(id, new Error("remote reader stalled")), idleMs) : undefined;
            await new Promise<void>((resolve) => { s.credit = resolve; });
            clearTimeout(stalled);
          }
          if (s.abort.signal.aborted) return;
          s.granted = false;
          this.send({ kind: "data", id, data: Buffer.from(value.subarray(at, at + CHUNK)).toString("base64") });
        }
      }
      if (!s.abort.signal.aborted) this.send({ kind: "end", id });
    } catch (e) { this.cancel(id, e as Error); }
    finally { s.abort.signal.removeEventListener("abort", abort); reader?.releaseLock(); }
  }

  private send(m: Wire): void {
    if (this.closed) throw new Error("connection closed");
    const text = JSON.stringify(m);
    if (text.length > MAX_MESSAGE) throw new Error("oversized channel frame");
    this.sendWire(text);
  }
  private finish(id: string): void {
    const s = this.states.get(id);
    if (!s) return;
    this.states.delete(id); clearTimeout(s.timer); s.abort.abort(); s.credit?.();
  }
  private cancel(id: string, error: Error, notify = true): void {
    const s = this.states.get(id);
    if (!s) return;
    if (notify && !this.closed) { try { this.send({ kind: "cancel", id }); } catch { /* transport gone */ } }
    s.reject?.(error); s.body?.fail(error); this.finish(id);
  }
}

/** The answer to a request that did not fit: JSON like every other refusal, with the reason in `REFUSED_HEADER` too. */
function refused(reason: string): Response {
  return Response.json({ ok: false, error: reason }, { status: 503, headers: { [REFUSED_HEADER]: reason, "cache-control": "no-store" } });
}
