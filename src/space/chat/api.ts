import { view as callView, STREAM_KEEPALIVE_MS } from "../model/api.ts";
import { APP_PATTERN } from "../model/types.ts";
import { type ChatService, Locked, Refused, type TurnResult } from "./service.ts";
import { parseScope, parseTitle, parseTurnInput } from "./spec.ts";
import { MAX_ATTACHMENT_BYTES, type Attachment, type Message, type Thread, type TurnRecord } from "./types.ts";
import { OPERATOR, Unauthorized, identify } from "../auth.ts";

/**
 * HTTP surface of the chat service, a Bun.serve `routes` table merged with the
 * other Space routes by the entry point.
 *
 *   GET    /api/chat/threads?scope=&limit=      threads of the app in a scope, newest first
 *   POST   /api/chat/threads                    { scope, title? } → 201 thread
 *   DELETE /api/chat/threads?scope=             every thread of a scope
 *   GET    /api/chat/threads/:id                thread, messages with their attachments, `running` and, while it answers, `turn` with the text so far
 *   PATCH  /api/chat/threads/:id                { title }
 *   DELETE /api/chat/threads/:id                rows and files
 *   POST   /api/chat/threads/:id/attachments    multipart field `file`, one image → 201 attachment
 *   GET    /api/chat/attachments/:id            the image bytes
 *   POST   /api/chat/threads/:id/turn           one turn; server-sent events by default (`start`, `delta`, then `done` or `error`), `?stream=0` for one JSON answer;
 *                                               with `requestId` it outlives the connection and a repeat of the id is the same turn
 *   GET    /api/chat/threads/:id/turn           the turn in flight as the same event stream, from its first character (404 when the thread is not answering)
 *   POST   /api/chat/threads/:id/stop           the person's stop → { stopped }
 *   GET    /api/chat/models?model=              the picker: options, the person's choice, the effective model (`model` = what the app asks for)
 *   PUT    /api/chat/model                      { model: "runtime/tier" | null } the person's choice for this app's chat → the same view
 *   GET    /api/chat/widget.js | widget.css     the embeddable widget (no token)
 *
 * The caller is identified like the model service's: an app's own token maps
 * to that app; the operator token needs `app` in the body or query. An app
 * only ever sees its own threads.
 */

export type ChatApiOptions = {
  service: ChatService;
  token?: string;
  appForToken?: (token: string) => Promise<string | undefined>;
  /** The widget bundle; absent = the widget routes answer 404. */
  widget?: () => Promise<{ js: string; css: string; etag: string }>;
};

type Req = Request & { params: Record<string, string> };
type Handler = (req: Req) => Response | Promise<Response>;
type Routes = Record<string, Handler | Partial<Record<"GET" | "POST" | "PUT" | "PATCH" | "DELETE", Handler>>>;

class NotFound extends Error {}

export function createChatRoutes(opts: ChatApiOptions): Routes {
  const { service } = opts;
  const token = opts.token?.trim() ?? "";

  /** Who is calling: the app behind an app token, or the operator naming the app. */
  const resolveApp = async (req: Request, named?: unknown): Promise<string> => {
    const fromCaller = (): string => {
      const app = named ?? new URL(req.url).searchParams.get("app");
      if (typeof app !== "string" || !APP_PATTERN.test(app)) throw new Error("app is required when calling with the operator token");
      return app;
    };
    const caller = await identify(req, { token, appForToken: opts.appForToken });
    if (!caller) throw new Unauthorized();
    return caller === OPERATOR ? fromCaller() : caller.app;
  };

  const threadOf = (app: string, req: Req): Thread => {
    const id = Number(req.params.id);
    const t = Number.isInteger(id) ? service.store.getThread(app, id) : undefined;
    if (!t) throw new NotFound("unknown thread");
    return t;
  };

  /** Run a handler, turning the known failures into their status codes. */
  const guard = async (fn: () => Promise<Response>): Promise<Response> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof Unauthorized) return error(401, "unauthorized");
      if (e instanceof NotFound) return error(404, e.message);
      if (e instanceof Locked) return error(409, e.message);
      if (e instanceof Refused) return error(e.status, e.message);
      return error(400, (e as Error).message ?? String(e));
    }
  };

  const body = async (req: Request): Promise<Record<string, unknown>> => {
    const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error("body must be a JSON object");
    return b;
  };

  const threadView = (t: Thread) => {
    const attachments = new Map<number, Attachment[]>();
    for (const a of service.store.listAttachments(t.id)) if (a.messageId !== undefined) attachments.set(a.messageId, [...(attachments.get(a.messageId) ?? []), a]);
    const messages = service.store.listMessages(t.id).map((m) => messageView(m, attachments.get(m.id) ?? [], service));
    const live = service.liveTurn(t.id);
    return { thread: view(t), messages, running: live !== undefined, ...(live ? { turn: turnInfo(live.record, live.text) } : {}) };
  };

  /** The picker's view for an app; `requested` is the model the app itself asks for, when the widget knows it. */
  const modelsView = (app: string, requested?: string) => {
    const choice = service.store.getModelChoice(app);
    const effective = service.effectiveModel(app, requested);
    return {
      ok: true,
      options: service.modelOptions(),
      choice: choice ?? null,
      ...(choice !== undefined && effective.source !== "choice" ? { choiceUnavailable: true } : {}),
      appModel: requested ?? null,
      defaultModel: service.spaceDefaultModel(app).model,
      effective,
      /** What "default" in the picker means right now: the app's model, else the space's. */
      fallback: service.effectiveModel(app, requested, { ignoreChoice: true }),
    };
  };

  return {
    "/api/chat/models": {
      GET: (req) =>
        guard(async () => {
          const app = await resolveApp(req);
          const raw = new URL(req.url).searchParams.get("model");
          return json(modelsView(app, raw ? service.checkModelShape(raw) : undefined));
        }),
    },

    "/api/chat/model": {
      PUT: (req) =>
        guard(async () => {
          const b = await body(req);
          const app = await resolveApp(req, b.app);
          if (!("model" in b)) throw new Error("model is required (a model, runtime/tier, or null for the default)");
          service.setModelChoice(app, b.model);
          return json(modelsView(app, typeof b.appModel === "string" && b.appModel ? service.checkModelShape(b.appModel) : undefined));
        }),
    },

    "/api/chat/threads": {
      GET: (req) =>
        guard(async () => {
          const app = await resolveApp(req);
          const q = new URL(req.url).searchParams;
          const scope = parseScope(q.get("scope"));
          const limit = Math.min(Math.max(1, Number(q.get("limit") ?? 50) || 50), 100);
          return json({ ok: true, threads: service.store.listThreads(app, scope, limit).map(view) });
        }),
      POST: (req) =>
        guard(async () => {
          const b = await body(req);
          const app = await resolveApp(req, b.app);
          const t = service.store.createThread(app, parseScope(b.scope), b.title === undefined ? "" : parseTitle(b.title));
          return json({ ok: true, thread: view(t) }, 201);
        }),
      DELETE: (req) =>
        guard(async () => {
          const app = await resolveApp(req);
          const scope = parseScope(new URL(req.url).searchParams.get("scope"));
          const files = await service.deleteScope(app, scope);
          return json({ ok: true, files });
        }),
    },

    "/api/chat/threads/:id": {
      GET: (req) =>
        guard(async () => {
          const app = await resolveApp(req);
          return json({ ok: true, ...threadView(threadOf(app, req)) });
        }),
      PATCH: (req) =>
        guard(async () => {
          const b = await body(req);
          const app = await resolveApp(req, b.app);
          const t = threadOf(app, req);
          service.store.renameThread(app, t.id, parseTitle(b.title));
          return json({ ok: true, thread: view(service.store.getThread(app, t.id)!) });
        }),
      DELETE: (req) =>
        guard(async () => {
          const app = await resolveApp(req);
          const t = threadOf(app, req);
          await service.deleteThread(app, t.id);
          return json({ ok: true });
        }),
    },

    "/api/chat/threads/:id/attachments": {
      POST: (req) =>
        guard(async () => {
          const app = await resolveApp(req);
          const t = threadOf(app, req);
          const length = Number(req.headers.get("content-length") ?? 0);
          if (length > MAX_ATTACHMENT_BYTES + 4096) return error(413, `image larger than ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB`);
          const form = await req.formData().catch(() => null);
          const file = form?.get("file");
          if (!(file instanceof Blob)) return error(400, "multipart field `file` is required");
          const name = file instanceof File ? file.name : "image";
          const a = await service.addAttachment(app, t, name, new Uint8Array(await file.arrayBuffer()));
          return json({ ok: true, attachment: attachmentView(a) }, 201);
        }),
    },

    "/api/chat/attachments/:id": {
      GET: (req) =>
        guard(async () => {
          const app = await resolveApp(req);
          const id = Number(req.params.id);
          const a = Number.isInteger(id) ? service.store.getAttachment(app, id) : undefined;
          if (!a?.path) throw new NotFound("unknown attachment");
          const f = Bun.file(a.path);
          if (!(await f.exists())) throw new NotFound("attachment file is gone");
          return new Response(f, { headers: { "content-type": a.type, "content-length": String(a.size), "cache-control": "private, max-age=31536000, immutable" } });
        }),
    },

    "/api/chat/threads/:id/turn": {
      POST: (req) =>
        guard(async () => {
          const b = await body(req);
          const app = await resolveApp(req, b.app);
          const t = threadOf(app, req);
          const input = parseTurnInput(b);
          // A request id the thread has seen is the same turn again: its uploads are already bound and nothing new starts.
          const repeat = input.requestId !== undefined && service.store.findTurn(t.id, input.requestId) !== undefined;
          if (!repeat) {
            service.assertAttachments(app, t, input.attachments);
            if (service.isRunning(t.id)) throw new Locked();
          }
          // Without a request id the turn lives as long as its connection, as it always did; with one it is the stop route that ends it.
          const signal = input.requestId === undefined ? req.signal : undefined;
          if (new URL(req.url).searchParams.get("stream") === "0") {
            const r = await service.turn(app, t, input, signal);
            return json(turnView(r, service), r.ok ? 200 : 502);
          }
          const h = service.begin(app, t, input);
          const gone = () => service.abort(t.id, h.record.id);
          if (h.started && signal) signal.addEventListener("abort", gone, { once: true });
          return followTurn(service, app, h.record, h.user, h.started && signal ? gone : undefined);
        }),
      GET: (req) =>
        guard(async () => {
          const app = await resolveApp(req);
          const t = threadOf(app, req);
          const live = service.liveTurn(t.id);
          if (!live) throw new NotFound("this thread is not answering");
          return followTurn(service, app, live.record, service.store.getMessage(live.record.userMessageId)!);
        }),
    },

    "/api/chat/threads/:id/stop": {
      POST: (req) =>
        guard(async () => {
          const app = await resolveApp(req, (await req.json().catch(() => null) as { app?: unknown } | null)?.app);
          const t = threadOf(app, req);
          return json({ ok: true, stopped: service.stop(t.id) });
        }),
    },

    "/api/chat/widget.js": {
      GET: async (req) => {
        if (!opts.widget) return error(404, "the widget is not built");
        const w = await opts.widget();
        if (req.headers.get("if-none-match") === w.etag) return new Response(null, { status: 304, headers: { etag: w.etag } });
        return new Response(w.js, { headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-cache", etag: w.etag } });
      },
    },
    "/api/chat/widget.css": {
      GET: async (req) => {
        if (!opts.widget) return error(404, "the widget is not built");
        const w = await opts.widget();
        if (req.headers.get("if-none-match") === w.etag) return new Response(null, { status: 304, headers: { etag: w.etag } });
        return new Response(w.css, { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-cache", etag: w.etag } });
      },
    },
  };
}

/**
 * A turn as an event stream, for the request that started it and for anyone
 * who comes back to it: `start` (the turn and the person's stored message),
 * the text so far as one `delta`, every later `delta`, then `done` or
 * `error`. The response starts at once; a model failure is the `error` event,
 * not a status code. The reader going away only ends the stream, and calls
 * `onGone` for the one case where the turn is tied to its reader.
 */
function followTurn(service: ChatService, app: string, record: TurnRecord, user: Message, onGone?: () => void): Response {
  const enc = new TextEncoder();
  let release = () => {};
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
      const close = () => {
        release();
        if (!open) return;
        open = false;
        try {
          controller.close();
        } catch {
          /* closed by the client */
        }
      };
      const finish = (r: TurnResult) => {
        event(r.ok ? "done" : "error", turnView(r, service));
        close();
      };
      const attachments = service.store.listAttachments(record.threadId).filter((a) => a.messageId === user.id);
      event("start", { turn: turnInfo(record), user: messageView(user, attachments, service) });
      const sub = service.subscribe(record.threadId, record.id, (e) => {
        if (e.type === "delta") event("delta", { text: e.text });
        else if (e.type === "end") finish(e.result);
        else {
          event("error", { ok: false, error: e.error });
          close();
        }
      });
      release = () => {
        clearInterval(keepalive);
        sub?.off();
      };
      if (!sub) {
        // Already over: the stored result is the whole stream.
        try {
          finish(service.resultOf(app, record));
        } catch (e) {
          event("error", { ok: false, error: (e as Error).message ?? String(e) });
          close();
        }
      } else if (sub.text) event("delta", { text: sub.text });
    },
    cancel() {
      release();
      onGone?.();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" } });
}

/** A turn for the page: its id, the request id that names it, how it stands and, while it runs, the answer so far. */
function turnInfo(r: TurnRecord, text?: string) {
  return { id: r.id, status: r.status, userMessageId: r.userMessageId, ...(r.requestId ? { requestId: r.requestId } : {}), ...(text === undefined ? {} : { text }) };
}

export function view(t: Thread) {
  return { id: t.id, scope: t.scope, title: t.title, createdAt: new Date(t.createdAt).toISOString(), updatedAt: new Date(t.updatedAt).toISOString() };
}

export function attachmentView(a: Attachment) {
  return { id: a.id, name: a.name, type: a.type, size: a.size, url: `/api/chat/attachments/${a.id}` };
}

export function messageView(m: Message, attachments: Attachment[], service: ChatService) {
  const call = m.callId === undefined ? undefined : service.callOf(m.callId);
  return {
    id: m.id, role: m.role, content: m.content, createdAt: new Date(m.createdAt).toISOString(),
    ...(m.error === undefined ? {} : { error: m.error }),
    ...(m.state === undefined ? {} : { state: m.state }),
    ...(m.omitted ? { omitted: m.omitted } : {}),
    attachments: attachments.map(attachmentView),
    ...(call ? { backend: call.backend, costUsd: call.costUsd ?? null, model: call.model } : {}),
  };
}

function turnView(r: TurnResult, service: ChatService) {
  const attachments = service.store.listAttachments(r.thread.id).filter((a) => a.messageId === r.user.id);
  return {
    ok: r.ok,
    ...(r.error === undefined ? {} : { error: r.error }),
    user: messageView(r.user, attachments, service),
    assistant: messageView(r.assistant, [], service),
    thread: view(r.thread),
    ...(r.call ? { call: callView(r.call) } : {}),
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function error(status: number, message: string): Response {
  return json({ ok: false, error: message }, status);
}
