import type { ModelService } from "./service.ts";
import { parseRunInput, parseWindow } from "./spec.ts";
import { APP_PATTERN, type ModelCall, TAG_PATTERN, WINDOW_MS } from "./types.ts";

/**
 * HTTP surface for the model service, shaped as a Bun.serve `routes` table
 * and merged with the other Space routes by the entry point.
 *
 *   POST /api/model/run                       run one call; 200 with the answer, 502 when the model failed.
 *                                             With `stream: true` in the body the answer comes as server-sent
 *                                             events instead: `delta` {text} as the text is produced, then one
 *                                             `done` {ok, text, call} or `error` {ok, error, call}; a comment
 *                                             line every 15 s keeps the connection alive while the model thinks
 *   GET  /api/model/status                    the configured runtimes, concurrency, calls in flight
 *   GET  /api/model/usage?window=24h&app      sums by app, tag, model, runtime and backend over a window, plus the whole history by day
 *   GET  /api/model/calls?app&tag&limit       recent calls, newest first (prompts and answers are not stored)
 *
 * The caller of `run` is identified by its bearer token: an app's own
 * `SPACE_APP_TOKEN` maps to that app; the operator's `SPACE_API_TOKEN` (or no
 * token at all when none is configured) requires an explicit `app` in the
 * body. The read routes carry no token, like the scheduler's.
 */

export type ModelApiOptions = {
  service: ModelService;
  /** Operator token; empty disables the check (rely on 127.0.0.1). */
  token?: string;
  /** Resolve an app's own token to its name. */
  appForToken?: (token: string) => Promise<string | undefined>;
  /** Model when the request names none (SPACE_MODEL_DEFAULT). */
  defaultModel?: string;
};

type Handler = (req: Request & { params: Record<string, string> }) => Response | Promise<Response>;
type Routes = Record<string, Handler | Partial<Record<"GET" | "POST", Handler>>>;

export function createModelRoutes(opts: ModelApiOptions): Routes {
  const { service } = opts;
  const token = opts.token?.trim() ?? "";

  const bearer = (req: Request): string => req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "";

  /** Who is calling: the app behind an app token, or the operator (then `app` comes from the body). */
  const resolveApp = async (req: Request, body: Record<string, unknown>): Promise<string> => {
    const presented = bearer(req);
    const fromBody = (): string => {
      if (typeof body.app !== "string" || !APP_PATTERN.test(body.app)) throw new Error("app is required when calling with the operator token");
      return body.app;
    };
    if (token && presented === token) return fromBody();
    if (presented && opts.appForToken) {
      const app = await opts.appForToken(presented);
      if (app) return app;
    }
    if (!token && !presented) return fromBody();
    throw new Unauthorized();
  };

  return {
    "/api/model/run": {
      POST: async (req) => {
        let app: string;
        let input: ReturnType<typeof parseRunInput>;
        let body: Record<string, unknown>;
        try {
          const parsed = (await req.json().catch(() => null)) as Record<string, unknown> | null;
          if (!parsed || typeof parsed !== "object") return error(400, "body must be a JSON object");
          body = parsed;
          if (body.stream !== undefined && typeof body.stream !== "boolean") return error(400, "stream must be a boolean");
          app = await resolveApp(req, body);
          input = parseRunInput(body, { model: opts.defaultModel });
          // An unknown `runtime/` prefix is the request's mistake, not a model failure.
          service.resolve(input.model);
        } catch (e) {
          if (e instanceof Unauthorized) return error(401, "unauthorized");
          return error(400, (e as Error).message ?? String(e));
        }
        if (body.stream === true) return streamRun(service, app, input, req.signal);
        const { outcome, call } = await service.run(app, input, req.signal);
        if (!outcome.ok) return json({ ok: false, error: outcome.error, call: view(call) }, 502);
        return json({ ok: true, text: outcome.text, call: view(call) });
      },
    },

    "/api/model/status": {
      GET: () => json({ ok: true, backend: service.backend, runtimes: service.runtimes.list(), maxConcurrency: service.maxConcurrency, ...service.load }),
    },

    "/api/model/usage": {
      GET: (req) => {
        const q = new URL(req.url).searchParams;
        let window: ReturnType<typeof parseWindow>;
        try {
          window = parseWindow(q.get("window"));
        } catch (e) {
          return error(400, (e as Error).message);
        }
        const app = q.get("app") ?? undefined;
        if (app !== undefined && !APP_PATTERN.test(app)) return error(400, "invalid app");
        const since = Date.now() - WINDOW_MS[window];
        const store = service.store;
        const firstAt = store.firstAt();
        return json({
          ok: true,
          window,
          since: new Date(since).toISOString(),
          backend: service.backend,
          totals: store.totals(since, app),
          byApp: store.groupBy(["app"], since, app),
          byTag: store.groupBy(["app", "tag", "model"], since, app),
          byModel: store.groupBy(["model"], since, app),
          byRuntime: store.groupBy(["runtime", "model"], since, app),
          byBackend: store.groupBy(["backend", "origin"], since, app),
          // The whole history, by UTC day: what the panel's grid, weekly bars and lifetime cards read.
          history: { firstAt: firstAt === undefined ? undefined : new Date(firstAt).toISOString(), totals: store.totals(0, app), days: store.days(0) },
        });
      },
    },

    "/api/model/calls": {
      GET: (req) => {
        const q = new URL(req.url).searchParams;
        const app = q.get("app") ?? undefined;
        if (app !== undefined && !APP_PATTERN.test(app)) return error(400, "invalid app");
        const tag = q.get("tag") ?? undefined;
        if (tag !== undefined && !TAG_PATTERN.test(tag)) return error(400, "invalid tag");
        const limit = Number(q.get("limit") ?? 50);
        return json({ ok: true, calls: service.store.list({ app, tag, limit: Number.isFinite(limit) ? limit : 50 }).map(view) });
      },
    },
  };
}

class Unauthorized extends Error {}

/** How often a comment line goes out on an idle event stream, so no proxy or server closes it while the model thinks. */
export const STREAM_KEEPALIVE_MS = 15_000;

/**
 * The same call as an event stream. The response starts at once (200, since
 * the request was already validated); a model failure is the `error` event,
 * with its ledger row, not a status code.
 */
function streamRun(service: ModelService, app: string, input: ReturnType<typeof parseRunInput>, signal: AbortSignal): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const send = (chunk: string) => {
        if (!open) return;
        try {
          controller.enqueue(enc.encode(chunk));
        } catch {
          open = false;
        }
      };
      const event = (name: string, data: unknown) => send(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      const keepalive = setInterval(() => send(": keepalive\n\n"), STREAM_KEEPALIVE_MS);
      void service
        .run(app, input, signal, (text) => event("delta", { text }))
        .then(({ outcome, call }) => {
          if (outcome.ok) event("done", { ok: true, text: outcome.text, call: view(call) });
          else event("error", { ok: false, error: outcome.error, call: view(call) });
        })
        .finally(() => {
          clearInterval(keepalive);
          open = false;
          try {
            controller.close();
          } catch {
            /* already closed by the client */
          }
        });
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" } });
}

export function view(c: ModelCall) {
  return {
    id: c.id,
    app: c.app,
    tag: c.tag,
    model: c.model,
    runtime: c.runtime,
    mode: c.mode,
    backend: c.backend,
    origin: c.origin,
    status: c.status,
    error: c.error,
    startedAt: new Date(c.startedAt).toISOString(),
    durationMs: c.durationMs,
    promptChars: c.promptChars,
    outputChars: c.outputChars,
    usage: c.usage,
    costUsd: c.costUsd,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function error(status: number, message: string): Response {
  return json({ ok: false, error: message }, status);
}
