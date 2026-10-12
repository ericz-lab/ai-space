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
