/** Bounded, bidirectional request/response streams over an authenticated WebSocket. */
const CHUNK = 32 * 1024;
const MAX_MESSAGE = 64 * 1024;
const MAX_STREAMS = 16;
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
};

export class PackageChannel {
  private readonly states = new Map<string, State>();
  private closed = false;
  constructor(private readonly sendWire: (text: string) => void, private readonly handler: (meta: unknown, body: ReadableStream<Uint8Array>, signal: AbortSignal) => Promise<Response>, private readonly prefix: "a" | "b", private readonly onClose?: () => void) {}

  async request(meta: unknown, body: ReadableStream<Uint8Array> | null = null, signal?: AbortSignal): Promise<Response> {
    if (this.closed || this.states.size >= MAX_STREAMS) throw new Error("connection unavailable or stream limit reached");
    if (signal?.aborted) throw new Error("request aborted");
    const id = `${this.prefix}-${crypto.randomUUID()}`;
    const s: State = { abort: new AbortController(), granted: false };
    this.states.set(id, s);
    const response = new Promise<Response>((resolve, reject) => { s.resolve = resolve; s.reject = reject; });
    s.body = this.body(id);
    s.timer = setTimeout(() => this.cancel(id, new Error("remote response timed out")), 30_000);
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
        if (m.id.startsWith(this.prefix) || this.states.has(m.id) || this.states.size >= MAX_STREAMS) throw new Error("invalid stream open");
        const s: State = { abort: new AbortController(), granted: false };
        this.states.set(m.id, s); s.body = this.body(m.id);
        void this.respond(m.id, s, m.meta);
        return;
      }
      const s = this.states.get(m.id);
      if (!s) return; // Late credit/cancel after a stream completed.
      switch (m.kind) {
        case "response": {
          if (!s.resolve || typeof m.status !== "number" || !Number.isInteger(m.status) || m.status < 200 || m.status > 599 || !Array.isArray(m.headers)) throw new Error("invalid response frame");
          clearTimeout(s.timer);
          const noBody = [204, 205, 304].includes(m.status);
          s.resolve(new Response(noBody ? null : s.body!.stream, { status: m.status, headers: m.headers as [string, string][] }));
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

  close(reason = "connection closed"): void {
    if (this.closed) return;
    this.closed = true;
    for (const id of [...this.states.keys()]) this.cancel(id, new Error(reason), false);
    this.onClose?.();
  }

  private async respond(id: string, s: State, meta: unknown): Promise<void> {
    try {
      const response = await this.handler(meta, s.body!.stream, s.abort.signal);
      if (s.abort.signal.aborted) return;
      const headers = [...response.headers].filter(([name]) => name !== "set-cookie");
      for (const cookie of response.headers.getSetCookie()) headers.push(["set-cookie", cookie]);
      this.send({ kind: "response", id, status: response.status, headers });
      await this.pump(id, s, response.body);
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

  private async pump(id: string, s: State, stream: ReadableStream<Uint8Array> | null): Promise<void> {
    const reader = stream?.getReader();
    const abort = () => { void reader?.cancel().catch(() => {}); s.credit?.(); s.credit = undefined; };
    s.abort.signal.addEventListener("abort", abort, { once: true });
    try {
      if (reader) for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (let at = 0; at < value.length; at += CHUNK) {
          if (!s.granted && !s.abort.signal.aborted) await new Promise<void>((resolve) => { s.credit = resolve; });
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
