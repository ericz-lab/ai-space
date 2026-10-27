import { APP_HEADER } from "../usage/api.ts";
import { APP_PATTERN } from "../usage/types.ts";
import { PeerError, type PeerFeedbackSync } from "./peers.ts";
import { FeedbackError, type FeedbackService } from "./service.ts";
import { LIMITS } from "./types.ts";

/**
 * HTTP surface of feedback (docs/feedback.md), a Bun.serve `routes` table.
 *
 *   GET  /_space/feedback.js                 the button's script (public)
 *   GET  /_space/feedback/config             { enabled, ... } for the app the router names (public)
 *   POST /_space/feedback                    { text, mode?, context, images? } → { id, status, todoId, todoUrl } (public, same origin)
 *   GET  /_space/feedback/recent             the app's last five, without context (public)
 *   GET  /api/panel/feedback/settings        settings, apps, machines, models, and each peer's apps (owner)
 *   PUT  /api/panel/feedback/settings        a settings patch, sent on to the peers (owner)
 *   GET  /api/panel/feedback                 recent feedback of every app, the peers' too (owner)
 *   POST /api/panel/feedback/fix             { peer?, app? | ids? } start waiting feedback now (owner)
 *
 * `/_space/*` arrives through the router, which names the app in `X-Space-App`; a page cannot pick
 * another app. The writes are same-origin only (guardBrowserWrites in the entry point).
 *
 * A space with peers keeps their switches in line with its own (peers.ts): reading or saving the
 * settings sends each peer this space's choices for the apps it runs. What a peer serves for that is
 * `createFeedbackPeerServeRoutes`: its own settings and rows, never its peers'.
 */

export type FeedbackApiOptions = {
  service: FeedbackService;
  script: () => Promise<{ js: string; etag: string }>;
  /** The Settings view's lists: apps with a page, the machines the engineer may run on, the models it may use. */
  apps: () => { app: string; title: string; zh?: string; status: string }[];
  machines: () => { value: string; label: string }[];
  models: () => { value: string; runtime: string; tier: string; model: string }[];
  /** On a space with peers: their apps' switches follow this space's settings. */
  peers?: PeerFeedbackSync;
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
  const settingsView = async () => {
    const local = localSettingsView(opts);
    if (!opts.peers) return { ...local, peers: [] };
    const peers = await opts.peers.views(local.settings);
    // A copy left paused here when its app moved to a peer is that peer's app now: list it once.
    const moved = new Set(peers.flatMap((p) => p.apps.map((a) => a.app)));
    return { ...local, apps: local.apps.filter((a) => !(a.status === "paused" && moved.has(a.app))), peers };
  };

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
      GET: guarded(async () => json(await settingsView())),
      PUT: guarded(async (req) => {
        service.saveSettings(await req.json().catch(() => null));
        return json(await settingsView());
      }),
    },
    "/api/panel/feedback": {
      GET: guarded(async (req) => {
        const limit = limitOf(req);
        const local: Record<string, unknown>[] = service.list(limit).map((r) => ({ ...rowView(r), peer: "" }));
        const remote = opts.peers ? await opts.peers.recent(limit) : [];
        const items = [...local, ...remote].sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0)).slice(0, limit);
        return json({ ok: true, items, counts: service.counts() });
      }),
    },
    "/api/panel/feedback/fix": {
      POST: guarded(async (req) => {
        const b = ((await req.json().catch(() => null)) ?? {}) as { peer?: unknown; app?: unknown; ids?: unknown };
        const what = fixBody(b);
        if (typeof b.peer === "string" && b.peer) {
          if (!opts.peers) return error(404, `unknown peer: ${b.peer}`);
          return json({ ok: true, ...(await opts.peers.fix(b.peer, what)) });
        }
        return json({ ok: true, ...service.fix(what) });
      }),
    },
  };
}

/**
 * What a hub reads and changes on this space (`/api/peer/feedback*`, behind the peer token in
 * peers/serve.ts): this space's own settings view and rows, without its peers, so two spaces that
 * are peers of each other never ask each other in a circle.
 */
export function createFeedbackPeerServeRoutes(opts: Omit<FeedbackApiOptions, "peers" | "script">): Routes {
  const { service } = opts;
  return {
    "/api/peer/feedback/settings": {
      GET: guarded(() => json(localSettingsView(opts))),
      PUT: guarded(async (req) => {
        service.saveSettings(await req.json().catch(() => null));
        return json(localSettingsView(opts));
      }),
    },
    "/api/peer/feedback": {
      GET: guarded((req) => json({ ok: true, items: service.list(limitOf(req)).map(rowView), counts: service.counts() })),
    },
    "/api/peer/feedback/fix": {
      POST: guarded(async (req) => json({ ok: true, ...service.fix(fixBody(((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>)) })),
    },
  };
}

function localSettingsView(opts: Omit<FeedbackApiOptions, "peers" | "script">) {
  const { service } = opts;
  return {
    ok: true,
    settings: service.settings(),
    apps: opts.apps().map((a) => ({ ...a, enabled: service.enabledFor(a.app) })),
    machines: opts.machines(),
    models: opts.models(),
    counts: service.counts(),
    shortcut: "Alt+Shift+F",
  };
}

function rowView(r: ReturnType<FeedbackService["list"]>[number]) {
  return {
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
  };
}

function fixBody(b: { app?: unknown; ids?: unknown }): { app?: string; ids?: number[] } {
  const app = typeof b.app === "string" && APP_PATTERN.test(b.app) ? b.app : undefined;
  const ids = Array.isArray(b.ids) ? b.ids.filter((x): x is number => Number.isInteger(x)).slice(0, 100) : undefined;
  return { ...(app ? { app } : {}), ...(ids ? { ids } : {}) };
}

function limitOf(req: Request): number {
  const n = Number(new URL(req.url).searchParams.get("limit") ?? 50);
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), 500) : 50;
}

function guarded(h: (req: Request) => Response | Promise<Response>): Handler {
  return async (req) => {
    try {
      return await h(req);
    } catch (e) {
      if (e instanceof FeedbackError || e instanceof PeerError) return error(e.status, e.message);
      return error(500, (e as Error).message);
    }
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function error(status: number, message: string): Response {
  return json({ ok: false, error: message }, status);
}
