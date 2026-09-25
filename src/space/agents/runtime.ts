import type { ChatTurn, RuntimeAdapter } from "../runtimes/types.ts";

/**
 * Chat over HTTP: one turn of a conversation with an agent, run on the
 * agent's runtime adapter (`../runtimes`) and streamed back as server-sent
 * events. Authentication is the runtime's own login on the machine; the
 * agent identity (system prompt, tool allow-list) is decided by the caller
 * from the manifest, never by the browser.
 */

export { PERMISSION_MODES } from "../runtimes/claude-code.ts";
export type { ChatCallbacks, ChatTurn } from "../runtimes/types.ts";

export { SESSION_ID_RE } from "../runtimes/transcripts.ts";
export const MODEL_RE = /^(?:[a-z0-9][a-z0-9._-]*\/)?[a-z0-9._-]{1,64}$/i;

/**
 * A long tool call emits nothing. Proxies in between (a tunnel's edge) drop a
 * stream idle for ~100 s, and Bun's own server does so after `idleTimeout`
 * (set to 255 s in the entry point; the default is 10 s), so a comment line
 * goes out every 20 s while a turn runs.
 */
export const HEARTBEAT_MS = 20_000;

/**
 * Server-sent events adapter: the response streams every runtime event as a
 * `data:` line, then `{"type":"error"}` on failure and `{"type":"done"}`.
 * A comment line every `heartbeatMs` keeps the connection alive through a
 * long tool call. Closing the response (client gone) kills the process.
 */
export function chatResponse(runtime: RuntimeAdapter, t: ChatTurn, hooks: { onSession?: (sid: string) => void } = {}, opts: { heartbeatMs?: number } = {}): Response {
  const enc = new TextEncoder();
  let handle: { kill: () => void } | undefined;
  let beat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const send = (line: string) => write(`data: ${line}\n\n`);
      const finish = (error: string | null) => {
        clearInterval(beat);
        if (error) send(JSON.stringify({ type: "error", error }));
        send('{"type":"done"}');
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      beat = setInterval(() => write(": keepalive\n\n"), opts.heartbeatMs ?? HEARTBEAT_MS);
      try {
        handle = runtime.chat(t, { onEvent: send, onSession: hooks.onSession, onFinish: finish });
      } catch (e) {
        finish((e as Error).message);
      }
    },
    cancel() {
      clearInterval(beat);
      handle?.kill();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
