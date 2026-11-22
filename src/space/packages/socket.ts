const LIMIT = 1024 * 1024;
export type SocketFrame = { kind: "message"; binary: boolean; data: string } | { kind: "close"; code: number; reason: string };

export function socketQueue(onCancel?: () => void) {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let ended = false;
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, cancel() { ended = true; onCancel?.(); } }, { highWaterMark: 2 * LIMIT, size: (chunk) => chunk?.byteLength ?? 0 });
  return {
    stream,
    push(frame: SocketFrame) {
      if (ended) return;
      const bytes = new TextEncoder().encode(JSON.stringify(frame) + "\n");
      if (bytes.length > 2 * LIMIT || (controller.desiredSize ?? 0) < bytes.length) throw new Error("application socket backpressure limit");
      controller.enqueue(bytes);
    },
    end() { if (!ended) { ended = true; controller.close(); } },
    fail(e: unknown) { if (!ended) { ended = true; controller.error(e); } },
    /** Bytes queued and not yet read, as a WebSocket's buffered amount. */
    buffered(): number { return ended ? 0 : Math.max(0, 2 * LIMIT - (controller.desiredSize ?? 0)); },
  };
}

export function socketMessage(data: string | Uint8Array | ArrayBuffer): SocketFrame {
  const bytes = typeof data === "string" ? Buffer.from(data) : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
  if (bytes.length > LIMIT) throw new Error("application socket message exceeds limit");
  return { kind: "message", binary: typeof data !== "string", data: bytes.toString("base64") };
}

export async function* socketFrames(stream: ReadableStream<Uint8Array>): AsyncGenerator<SocketFrame> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      if (pending.length > 2 * LIMIT) throw new Error("socket frame exceeds limit");
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const f = JSON.parse(pending.slice(0, newline)) as SocketFrame;
        pending = pending.slice(newline + 1);
        if (f.kind === "message") {
          if (typeof f.binary !== "boolean" || typeof f.data !== "string" || f.data.length > Math.ceil(LIMIT / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(f.data)) throw new Error("invalid socket message");
        } else if (f.kind === "close") {
          if (!Number.isInteger(f.code) || typeof f.reason !== "string" || f.reason.length > 123) throw new Error("invalid socket close");
        } else throw new Error("invalid socket frame kind");
        yield f;
      }
    }
    if (pending || decoder.decode()) throw new Error("truncated socket frame");
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function safeCloseCode(code: number): number { return code === 1000 || code >= 3000 && code <= 4999 ? code : 4002; }

/** A WebSocket becomes a framed duplex stream so the same channel works through outbound-only peers. */
export async function processSocket(url: string, headers: Headers, input: ReadableStream<Uint8Array> | null, signal: AbortSignal, release: () => void): Promise<Response> {
  if (!input) { release(); throw new Error("socket input stream is required"); }
  const protocols = (headers.get("sec-websocket-protocol") ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  headers.delete("sec-websocket-protocol");
  let socket: WebSocket;
  const output = socketQueue(() => { socket?.close(1000, "reader left"); release(); });
  try { socket = new WebSocket(url, { headers: Object.fromEntries(headers), protocols } as unknown as string[]); }
  catch (e) { release(); throw e; }
  socket.binaryType = "arraybuffer";
  let rejectOpen: (reason: Error) => void = () => {};
  const abort = () => { rejectOpen(new Error("socket cancelled")); socket.close(4002, "request cancelled"); output.fail(new Error("socket cancelled")); release(); };
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { rejectOpen(new Error("socket startup timed out")); socket.close(4002, "startup timed out"); release(); }, 10_000);
  const opened = new Promise<void>((resolve, reject) => { rejectOpen = reject; socket.onopen = () => { clearTimeout(timer); resolve(); }; });
  socket.onmessage = (event) => {
    try { output.push(socketMessage(event.data as string | ArrayBuffer)); }
    catch (e) { output.fail(e); socket.close(4002, "backpressure limit"); }
  };
  socket.onclose = (event) => {
    clearTimeout(timer); signal.removeEventListener("abort", abort);
    rejectOpen(new Error("application socket closed before ready"));
    try { output.push({ kind: "close", code: safeCloseCode(event.code), reason: event.reason.slice(0, 30) }); output.end(); } catch (e) { output.fail(e); }
    release();
  };
  socket.onerror = () => { rejectOpen(new Error("application socket failed")); };
  if (signal.aborted) abort();
  try { await opened; }
  catch (e) { clearTimeout(timer); signal.removeEventListener("abort", abort); socket.close(); release(); throw e; }
  void (async () => {
    try {
      for await (const frame of socketFrames(input)) {
        if (frame.kind === "close") { socket.close(safeCloseCode(frame.code), frame.reason.slice(0, 30)); break; }
        if (socket.bufferedAmount > LIMIT) throw new Error("socket backpressure limit");
        const bytes = Buffer.from(frame.data, "base64");
        socket.send(frame.binary ? bytes : new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      }
    } catch (e) { output.fail(e); socket.close(4002, "socket stream failed"); }
  })();
  return new Response(output.stream, { headers: { "content-type": "application/x-space-socket", ...(socket.protocol ? { "x-space-socket-protocol": socket.protocol } : {}) } });
}

/** What a WebSocket handler upgraded with (terminal/service.ts `WsAttachment`), without importing the terminal. */
type Attachment = {
  open(ws: never): void;
  message(ws: never, message: string | Buffer): void;
  close(ws: never, code: number, reason: string): void;
};

/**
 * A server-side socket handler driven by a framed duplex stream instead of a WebSocket: `input` brings the
 * other end's frames, the answer's body carries this end's. This is how a route that upgrades (the terminal's
 * socket, an app's socket through the peer proxy) is served over a channel with no socket to upgrade.
 * The handler sees a socket object with what such handlers use: `send`, `close`, `readyState`, `getBufferedAmount`,
 * `ping` and `data`. It is closed once, whichever end closes first; `signal` aborting closes it too.
 */
export function attachmentResponse(attachment: Attachment, input: ReadableStream<Uint8Array>, signal: AbortSignal, data: unknown = {}): Response {
  let state = 1;
  let reported = false;
  const output = socketQueue(() => finish(1001, "reader left", false));
  const finish = (code: number, reason: string, tell: boolean) => {
    if (state === 3) return;
    state = 3;
    if (tell) { try { output.push({ kind: "close", code: safeCloseCode(code), reason: reason.slice(0, 30) }); output.end(); } catch (e) { output.fail(e); } }
    signal.removeEventListener("abort", onAbort);
    if (!reported) { reported = true; try { attachment.close(ws as never, code, reason); } catch { /* the handler's own cleanup failed */ } }
  };
  const onAbort = () => { finish(1001, "request cancelled", false); output.fail(new Error("socket cancelled")); };
  const ws = {
    data,
    get readyState() { return state; },
    send(message: string | Uint8Array | ArrayBuffer) {
      if (state !== 1) return 0;
      try { output.push(socketMessage(message)); } catch { finish(4002, "backpressure limit", true); return -1; }
      return typeof message === "string" ? message.length : message.byteLength;
    },
    close(code = 1000, reason = "") { finish(code, reason, true); },
    getBufferedAmount: () => output.buffered(),
    ping: () => 0,
    cork: (fn: () => void) => fn(),
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try { attachment.open(ws as never); } catch { finish(4002, "socket handler failed", true); }
  void (async () => {
    try {
      for await (const frame of socketFrames(input)) {
        if (state !== 1) break;
        if (frame.kind === "close") { finish(frame.code, frame.reason, true); break; }
        const bytes = Buffer.from(frame.data, "base64");
        attachment.message(ws as never, frame.binary ? bytes : new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      }
      finish(1000, "socket input ended", true);
    } catch { finish(4002, "socket stream failed", true); }
  })();
  return new Response(output.stream, { headers: { "content-type": "application/x-space-socket" } });
}

type SocketEvent = { data?: unknown; code?: number; reason?: string; wasClean?: boolean };

/**
 * The other half of `attachmentResponse` and `processSocket`: an object that behaves as a client WebSocket
 * (`onopen`, `onmessage`, `onclose`, `onerror`, `send`, `close`, `readyState`, `binaryType`, `protocol`) whose
 * frames travel as one framed duplex request. `dispatch` sends that request and returns its answer: a
 * non-stream answer (a refusal) closes the socket before it opened, with the answer's error as the reason.
 */
export class FramedSocket {
  binaryType: "arraybuffer" | "nodebuffer" | "blob" = "arraybuffer";
  readyState = 0;
  protocol = "";
  onopen: ((e: SocketEvent) => void) | null = null;
  onmessage: ((e: SocketEvent) => void) | null = null;
  onclose: ((e: SocketEvent) => void) | null = null;
  onerror: ((e: SocketEvent) => void) | null = null;
  private readonly input = socketQueue();
  private readonly abort = new AbortController();

  constructor(dispatch: (input: ReadableStream<Uint8Array>, signal: AbortSignal) => Promise<Response>) {
    void this.run(dispatch);
  }

  get bufferedAmount(): number { return this.input.buffered(); }

  send(data: string | ArrayBuffer | Uint8Array): void {
    if (this.readyState !== 1) throw new Error("socket is not open");
    this.input.push(socketMessage(data));
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState >= 2) return;
    const opened = this.readyState === 1;
    this.readyState = 2;
    try { this.input.push({ kind: "close", code: safeCloseCode(code), reason: reason.slice(0, 30) }); this.input.end(); } catch { /* the request is gone */ }
    // The far end answers a close with its own; one that does not within a moment is let go.
    setTimeout(() => this.ended(code, reason), opened ? 5000 : 0).unref?.();
  }

  private async run(dispatch: (input: ReadableStream<Uint8Array>, signal: AbortSignal) => Promise<Response>): Promise<void> {
    let response: Response;
    try { response = await dispatch(this.input.stream, this.abort.signal); }
    catch (e) { this.onerror?.({}); return this.ended(4002, String((e as Error).message ?? e).slice(0, 120)); }
    if (!response.ok || !response.body || this.readyState >= 2) {
      const why = await response.json().then((j) => (j as { error?: unknown }).error, () => undefined).catch(() => undefined);
      this.onerror?.({});
      return this.ended(response.ok ? 1000 : 4000 + Math.min(999, response.status), typeof why === "string" ? why.slice(0, 120) : `HTTP ${response.status}`);
    }
    this.protocol = response.headers.get("x-space-socket-protocol") ?? "";
    this.readyState = 1;
    this.onopen?.({});
    try {
      for await (const frame of socketFrames(response.body)) {
        if (frame.kind === "close") return this.ended(frame.code, frame.reason);
        const bytes = Buffer.from(frame.data, "base64");
        const data = !frame.binary ? new TextDecoder("utf-8", { fatal: true }).decode(bytes) : this.binaryType === "nodebuffer" ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        if (this.readyState === 1) this.onmessage?.({ data });
      }
      this.ended(1006, "socket stream ended");
    } catch (e) { this.onerror?.({}); this.ended(1006, String((e as Error).message ?? e).slice(0, 120)); }
  }

  private ended(code: number, reason: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.input.end();
    this.abort.abort();
    this.onclose?.({ code, reason, wasClean: code === 1000 });
  }
}
