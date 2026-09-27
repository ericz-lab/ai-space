import { APP_RE, type LogsProcess, type LogsRequest, spawnLogs } from "./logs.ts";

/**
 * HTTP surface of the logs, shaped as a Bun.serve `routes` table.
 *
 *   GET /api/apps/:app/logs?lines=100     the last N lines, text/plain
 *   GET /api/apps/:app/logs?follow=1      the same, then every new line as it comes: server-sent
 *                                         events, one `line` event per line, a comment every 15 s
 *                                         to keep the connection open, `end` {code} when the
 *                                         command exits; the command is killed when the reader leaves
 *   GET /api/apps/space/logs              ai-space's own log
 *
 * Operator token required when one is configured: a log is not panel data.
 * The app must be one the space knows (or `space`), so the route never runs
 * the template for a name that was never registered.
 */

export type LogsApiOptions = {
  /** SPACE_SERVICE_LOGS. */
  template: string;
  token?: string;
  knownApp: (app: string) => boolean;
  /** The unit of an app when it is not named after the app (the supervisor's `space-<app>.service`). */
  unitOf?: (app: string) => string | undefined;
  spawn?: (req: LogsRequest) => LogsProcess;
  /** Keepalive period for the stream, ms. */
  keepaliveMs?: number;
};

type Handler = (req: Request & { params: Record<string, string> }) => Response | Promise<Response>;

export function createLogsRoutes(opts: LogsApiOptions): Record<string, { GET: Handler }> {
  const token = opts.token?.trim() ?? "";
  const spawn = opts.spawn ?? ((req: LogsRequest) => spawnLogs(opts.template, req));

  return {
    "/api/apps/:app/logs": {
      GET: async (req) => {
        if (token && req.headers.get("authorization") !== `Bearer ${token}`) return error(401, "unauthorized");
        const app = req.params.app ?? "";
        if (!APP_RE.test(app)) return error(400, "invalid app name");
        if (app !== "space" && !opts.knownApp(app)) return error(404, `unknown app: ${app}`);
        const q = new URL(req.url).searchParams;
        const lines = Number(q.get("lines") ?? 100);
        if (!Number.isFinite(lines) || lines < 1) return error(400, "lines must be a positive number");
        const follow = q.get("follow") === "1";
        const unit = app === "space" ? undefined : opts.unitOf?.(app);
        const proc = spawn({ app, lines, follow, ...(unit ? { unit } : {}) });
        if (!follow) {
          const out: string[] = [];
          for await (const line of proc.lines) out.push(line);
          const code = await proc.exited;
          if (code !== 0 && out.length === 0) return error(502, `log command exited with ${code}`);
          return new Response(out.length ? out.join("\n") + "\n" : "", { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-exit-code": String(code) } });
        }
        return stream(proc, req.signal, opts.keepaliveMs ?? 15_000);
      },
    },
  };
}

function stream(proc: LogsProcess, signal: AbortSignal, keepaliveMs: number): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (s: string) => {
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          /* the reader is gone */
        }
      };
      const keepalive = setInterval(() => send(": keepalive\n\n"), keepaliveMs);
      const stop = () => proc.kill();
      signal.addEventListener("abort", stop, { once: true });
      try {
        for await (const line of proc.lines) send(`event: line\ndata: ${JSON.stringify(line)}\n\n`);
        const code = await proc.exited;
        send(`event: end\ndata: ${JSON.stringify({ code })}\n\n`);
      } finally {
        clearInterval(keepalive);
        signal.removeEventListener("abort", stop);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      proc.kill();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" } });
}

function error(status: number, message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: message }), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
