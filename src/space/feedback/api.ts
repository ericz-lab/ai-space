import { APP_HEADER } from "../usage/api.ts";
import { APP_PATTERN } from "../usage/types.ts";
import { FeedbackError, type FeedbackService } from "./service.ts";
import { LIMITS } from "./types.ts";

/**
 * HTTP surface of feedback (docs/feedback.md), a Bun.serve `routes` table.
 *
 *   GET  /_space/feedback.js                 the button's script (public)
 *   GET  /_space/feedback/config             { enabled, ... } for the app the router names (public)
 *   POST /_space/feedback                    { text, mode?, context, images? } → { id, status, todoId, todoUrl } (public, same origin)
 *   GET  /_space/feedback/recent             the app's last five, without context (public)
 *   GET  /api/panel/feedback/settings        settings, apps, machines, models (owner)
 *   PUT  /api/panel/feedback/settings        a settings patch (owner)
 *   GET  /api/panel/feedback                 recent feedback of every app (owner)
 *   POST /api/panel/feedback/fix             { app? | ids? } start waiting feedback now (owner)
 *
 * `/_space/*` arrives through the router, which names the app in `X-Space-App`; a page cannot pick
 * another app. The writes are same-origin only (guardBrowserWrites in the entry point).
 */

export type FeedbackApiOptions = {
  service: FeedbackService;
  script: () => Promise<{ js: string; etag: string }>;
  /** The Settings view's lists: apps with a page, the machines the engineer may run on, the models it may use. */
  apps: () => { app: string; title: string; zh?: string; status: string }[];
  machines: () => { value: string; label: string }[];
  models: () => { value: string; runtime: string; tier: string; model: string }[];
};

type Handler = (req: Request) => Response | Promise<Response>;
type Routes = Record<string, Partial<Record<"GET" | "POST" | "PUT", Handler>>>;

export function createFeedbackRoutes(opts: FeedbackApiOptions): Routes {
  const { service } = opts;
  /** The router's word for the app, or a response that refuses the request. */
  const appOf = (req: Request): string | Response => {
    const app = req.headers.get(APP_HEADER)?.trim() ?? "";
    if (!app) return error(400, "no X-Space-App header: feedback arrives through the router");
    if (!APP_PATTERN.test(app)) return error(404, "unknown app");
    return app;
  };
  const guarded = (h: (req: Request) => Response | Promise<Response>): Handler => async (req) => {
    try {
      return await h(req);
    } catch (e) {
      return e instanceof FeedbackError ? error(e.status, e.message) : error(500, (e as Error).message);
    }
  };
  const settingsView = () => ({
    ok: true,
    settings: service.settings(),
    apps: opts.apps().map((a) => ({ ...a, enabled: service.enabledFor(a.app) })),
    machines: opts.machines(),
    models: opts.models(),
    counts: service.counts(),
    shortcut: "Alt+Shift+F",
  });
  const rowView = (r: ReturnType<FeedbackService["list"]>[number]) => ({
    id: r.id,
    app: r.app,
    text: r.text.slice(0, 300),
    status: r.status,
    path: r.context.path,
    client: r.client.kind,
    todoId: r.todoId,
    todoPeer: r.todoPeer,
    todoUrl: r.todoUrl,
    runId: r.runId,
    runMachine: r.runMachine,
    note: r.note,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });

  return {
    "/_space/feedback.js": {
      GET: async (req) => {
        const { js, etag } = await opts.script();
        if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } });
        return new Response(js, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", etag, "x-content-type-options": "nosniff" } });
      },
    },
    "/_space/feedback/config": {
      GET: guarded((req) => {
        const app = appOf(req);
        if (app instanceof Response) return app;
        return json(service.config(app, req.headers.get("user-agent") ?? ""));
      }),
    },
    "/_space/feedback/recent": {
      GET: guarded((req) => {
        const app = appOf(req);
        if (app instanceof Response) return app;
        if (!service.enabledFor(app)) return json({ ok: true, items: [] });
        return json({ ok: true, items: service.recent(app) });
      }),
    },
    "/_space/feedback": {
      POST: guarded(async (req) => {
        const app = appOf(req);
        if (app instanceof Response) return app;
        const length = Number(req.headers.get("content-length") ?? 0);
        if (length > LIMITS.body) return error(413, "feedback is too large");
        const raw = await req.text();
        if (raw.length > LIMITS.body) return error(413, "feedback is too large");
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          return error(400, "body must be JSON");
        }
        const r = await service.submit(app, body, req.headers.get("user-agent") ?? "");
        return json({ ok: true, ...r }, r.repeated ? 200 : 201);
      }),
    },
    "/api/panel/feedback/settings": {
      GET: guarded(() => json(settingsView())),
      PUT: guarded(async (req) => {
        const body = await req.json().catch(() => null);
        service.saveSettings(body);
        return json(settingsView());
      }),
    },
    "/api/panel/feedback": {
      GET: guarded((req) => {
        const limit = Number(new URL(req.url).searchParams.get("limit") ?? 50);
        return json({ ok: true, items: service.list(Number.isFinite(limit) ? limit : 50).map(rowView), counts: service.counts() });
      }),
    },
    "/api/panel/feedback/fix": {
      POST: guarded(async (req) => {
        const b = ((await req.json().catch(() => null)) ?? {}) as { app?: unknown; ids?: unknown };
        const app = typeof b.app === "string" && APP_PATTERN.test(b.app) ? b.app : undefined;
        const ids = Array.isArray(b.ids) ? b.ids.filter((x): x is number => Number.isInteger(x)).slice(0, 100) : undefined;
        return json({ ok: true, ...service.fix({ ...(app ? { app } : {}), ...(ids ? { ids } : {}) }) });
      }),
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function error(status: number, message: string): Response {
  return json({ ok: false, error: message }, status);
}
