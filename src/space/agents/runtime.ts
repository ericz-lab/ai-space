import type { RunRegistry } from "./runs.ts";

/**
 * Chat over HTTP: one turn of a conversation with an agent, run on the
 * agent's runtime adapter (`../runtimes`) as a background run (`./runs.ts`)
 * and streamed back as server-sent events. Authentication is the runtime's own
 * login on the machine; the agent identity (system prompt, tool allow-list) is
 * decided by the caller from the manifest, never by the browser.
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
 * Server-sent events over a background run: the response replays the run's events after
 * `after` and follows it live, each as an `id: <seq>` and a `data:` line, then
 * `{"type":"error","error","status"}` when the run did not end well and `{"type":"done"}`.
 * A comment line every `heartbeatMs` keeps the connection alive through a long tool call.
 * Closing the response (client gone) only unsubscribes: the run goes on, and `runs.stop` is
 * what ends it. Null for an unknown run.
 */
export function runResponse(runs: RunRegistry, id: string, after = 0, opts: { heartbeatMs?: number } = {}): Response | null {
  if (!runs.get(id)) return null;
  const enc = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
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
      beat = setInterval(() => write(": keepalive\n\n"), opts.heartbeatMs ?? HEARTBEAT_MS);
      unsubscribe = runs.subscribe(id, after, {
        onEvent: (ev) => write(`id: ${ev.seq}\ndata: ${ev.line}\n\n`),
        onEnd: (run) => {
          clearInterval(beat);
          if (run.status !== "done") send(JSON.stringify({ type: "error", error: run.error ?? run.status, status: run.status }));
          send('{"type":"done"}');
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        },
      });
    },
    cancel() {
      clearInterval(beat);
      unsubscribe?.();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-run-id": id,
    },
  });
}

/**
 * Server-sent events about an agent's runs, or every agent's when `agent` is null
 * (docs/runtimes.md#background-work), so an open chat finds the turns an agent starts by itself:
 * first the runs going now and every conversation's background jobs, then each run's start and end
 * (`{"type":"run","run"}`) and each change of a conversation's jobs
 * (`{"type":"jobs","agent","sessionId","jobs"}`, the whole list) as they happen.
 */
export function watchResponse(runs: RunRegistry, agent: string | null, opts: { heartbeatMs?: number } = {}): Response {
  const mine = (a: string) => agent === null || a === agent;
  const enc = new TextEncoder();
  let unwatch: (() => void) | null = null;
  let beat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (chunk: string) => {
        try {
          controller.enqueue(enc.encode(chunk));
        } catch {
          clearInterval(beat);
          unwatch?.();
        }
      };
      const send = (news: unknown) => write(`data: ${JSON.stringify(news)}\n\n`);
      beat = setInterval(() => write(": keepalive\n\n"), opts.heartbeatMs ?? HEARTBEAT_MS);
      write(": watching\n\n"); // the headers go out with the first bytes
      for (const run of runs.running()) if (mine(run.agent)) send({ type: "run", run });
      for (const jobs of runs.jobsOf(agent)) send({ type: "jobs", ...jobs });
      unwatch = runs.watch((news) => {
        if (mine(news.type === "run" ? news.run.agent : news.agent)) send(news);
      });
    },
    cancel() {
      clearInterval(beat);
      unwatch?.();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" },
  });
}
