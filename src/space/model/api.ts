import type { ResolvedModel } from "./app-models.ts";
import { parseImages, type RunImage, spoolImages } from "./images.ts";
import { type FinalEvent, type PeerRun, PeerRuns, REF_PATTERN } from "./peer-runs.ts";
import { GPT_PRICING } from "./pricing.ts";
import { type ModelService, needsLocal } from "./service.ts";
import { parseImageInput, parseRunInput, parseWindow } from "./spec.ts";
import { mergeReports, peerReport, type UsageReport, usageReport } from "./report.ts";
import { APP_PATTERN, type ModelCall, type Origin, TAG_PATTERN, type Window } from "./types.ts";
import { splitMachine } from "../runtimes/registry.ts";
import type { HealthCell } from "./health.ts";
import { OPERATOR, Unauthorized, identify } from "../auth.ts";

/**
 * HTTP surface for the model service, shaped as a Bun.serve `routes` table
 * and merged with the other Space routes by the entry point.
 *
 *   POST /api/model/run                       run one call; 200 with the answer, 502 when the model failed.
 *                                             With `stream: true` in the body the answer comes as server-sent
 *                                             events instead: `delta` {text} as the text is produced, then one
 *                                             `done` {ok, text, call} or `error` {ok, error, call}; a comment
 *                                             line every 15 s keeps the connection alive while the model thinks.
 *                                             `images: [{ data: base64 }]` (up to 8) travel as files named img1…
 *   POST /api/model/image                     pictures: { prompt, images?, model?, tag?, system?, timeoutMs? }; 200
 *                                             { ok, text, images: [{ type, data: base64 }], call }, 502 when the model failed.
 *                                             Only a runtime that makes images (codex-cli); the input images as for `run`.
 *   GET  /api/model/status                    the configured runtimes, concurrency, calls in flight
 *   GET  /api/model/usage?window=24h&app      this space's ledger (`space` names it): sums by app, tag, model, runtime and backend
 *                                             over a window, plus the whole history by day; on a hub, without `app`, the peers'
 *                                             ledgers too, under `<peer>/<app>`, and `peers` says which answered (docs/model-machines.md#ledger)
 *   GET  /api/model/calls?app&tag&limit       recent calls, newest first (prompts and answers are not stored); on a hub, without
 *                                             `app` or `tag`, the peers' recent calls too
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
  defaultModel?: string | (() => string);
  /** The app's layers when the request names no model (app-models.ts); takes the place of `defaultModel`. */
  resolveModel?: (app: string, tag: string) => ResolvedModel;
  /** The status table: every machine's runtimes, with the problems of the used ones (docs/model-machines.md#status). */
  machines?: () => MachineCell[];
  /** Runtimes this space answers for other spaces (`SPACE_PEER_MODEL`). */
  servesPeers?: string[];
  /** This space's name (SPACE_NAME): the ledger is this space's own, so the usage answer says whose it is. */
  space?: string;
  /** The peers' ledgers, for a hub that shows them with its own (peers/ledgers.ts). */
  peerLedgers?: PeerLedgerSource;
};

/** A call as the API shows it. */
export type CallView = ReturnType<typeof view>;

/** One peer's answer to a ledger read: `data` is absent when it never answered; `error` says why the last try failed. */
export type PeerLedger<T> = { peer: string; space: string; data?: T; error?: string; asOf?: string };

export type PeerLedgerSource = {
  usage(window: Window): Promise<PeerLedger<UsageReport>[]>;
  calls(limit: number): Promise<PeerLedger<CallView[]>[]>;
};

/** What the usage answer says about each peer: whether its rows are in, and from when. */
const peerStatus = (l: PeerLedger<unknown>) => ({ name: l.peer, ok: l.data !== undefined && !l.error, ...(l.asOf ? { asOf: l.asOf } : {}), ...(l.error ? { error: l.error } : {}) });

/** The spaces whose rows the hub drops from its own ledger: their own rows of the same calls are in the merge. */
const answered = (ls: PeerLedger<unknown>[]) => ls.filter((l) => l.data !== undefined && l.space).map((l) => l.space);

/** A status-table cell as the API shows it. */
export type MachineCell = HealthCell & { used: boolean; problem?: string };

type Handler = (req: Request & { params: Record<string, string> }) => Response | Promise<Response>;
type Routes = Record<string, Handler | Partial<Record<"GET" | "POST", Handler>>>;

export function createModelRoutes(opts: ModelApiOptions): Routes {
  const { service } = opts;
  const token = opts.token?.trim() ?? "";


  /** Who is calling: the app behind an app token, or the operator (then `app` comes from the body). */
  const resolveApp = async (req: Request, body: Record<string, unknown>): Promise<string> => {
    const fromBody = (): string => {
      if (typeof body.app !== "string" || !APP_PATTERN.test(body.app)) throw new Error("app is required when calling with the operator token");
      return body.app;
    };
    const caller = await identify(req, { token, appForToken: opts.appForToken });
    if (!caller) throw new Unauthorized();
    return caller === OPERATOR ? fromBody() : caller.app;
  };

  return {
    "/api/model/pricing": { GET: () => json({ ok: true, ...GPT_PRICING }) },
    "/api/model/run": {
      POST: async (req) => {
        let app: string;
        let input: ReturnType<typeof parseRunInput>;
        let body: Record<string, unknown>;
        let images: RunImage[];
        let fallback: string | undefined;
        let source: ResolvedModel["source"] | undefined;
        try {
          const parsed = (await req.json().catch(() => null)) as Record<string, unknown> | null;
          if (!parsed || typeof parsed !== "object") return error(400, "body must be a JSON object");
          body = parsed;
          if (body.stream !== undefined && typeof body.stream !== "boolean") return error(400, "stream must be a boolean");
          app = await resolveApp(req, body);
          if (body.model !== undefined) source = "request";
          else if (opts.resolveModel) {
            const chosen = opts.resolveModel(app, typeof body.tag === "string" && TAG_PATTERN.test(body.tag) ? body.tag : "other");
            fallback = chosen.model;
            source = chosen.source;
          } else fallback = typeof opts.defaultModel === "function" ? opts.defaultModel() : opts.defaultModel;
          input = parseRunInput(body, { model: fallback });
          images = parseImages(body.images);
          // An unknown `runtime/` prefix, or a call that needs this machine sent to another, is the request's mistake, not a model failure.
          service.place(input);
        } catch (e) {
          if (e instanceof Unauthorized) return error(401, "unauthorized");
          return error(400, (e as Error).message ?? String(e));
        }
        const { files, cleanup } = await spoolImages(images);
        if (files.length) input = { ...input, files };
        if (body.stream === true) return streamRun(service, app, input, req.signal, source, cleanup);
        try {
          const { outcome, call } = await service.run(app, input, req.signal, undefined, source);
          if (!outcome.ok) return json({ ok: false, error: outcome.error, call: view(call) }, 502);
          return json({ ok: true, text: outcome.text, call: view(call) });
        } finally {
          await cleanup();
        }
      },
    },

    "/api/model/image": {
      POST: async (req) => {
        let app: string;
        let input: ReturnType<typeof parseImageInput>;
        let images: RunImage[];
        let source: ResolvedModel["source"] | undefined;
        try {
          const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
          if (!body || typeof body !== "object") return error(400, "body must be a JSON object");
          app = await resolveApp(req, body);
          let fallback: string | undefined;
          const tag = typeof body.tag === "string" && TAG_PATTERN.test(body.tag) ? body.tag : "image";
          if (body.model !== undefined) source = "request";
          else if (opts.resolveModel) {
            const chosen = opts.resolveModel(app, tag);
            fallback = chosen.model;
            source = chosen.source;
          } else fallback = typeof opts.defaultModel === "function" ? opts.defaultModel() : opts.defaultModel;
          input = parseImageInput(body, { model: fallback });
          images = parseImages(body.images);
          service.resolveImage(input.model);
        } catch (e) {
          if (e instanceof Unauthorized) return error(401, "unauthorized");
          return error(400, (e as Error).message ?? String(e));
        }
        const { files, cleanup } = await spoolImages(images);
        try {
          const { outcome, call } = await service.image(app, { ...input, files }, req.signal, source);
          if (!outcome.ok) return json({ ok: false, error: outcome.error, call: view(call) }, 502);
          return json({ ok: true, text: outcome.text, images: outcome.images.map((i) => ({ type: i.type, data: Buffer.from(i.bytes).toString("base64") })), call: view(call) });
        } finally {
          await cleanup();
        }
      },
    },

    "/api/model/status": {
      GET: () => json({ ok: true, backend: service.backend, runtimes: service.runtimes.list(), machines: opts.machines?.() ?? [], servesPeers: opts.servesPeers ?? [], maxConcurrency: service.maxConcurrency, ...service.load }),
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
        if (app !== undefined || !opts.peerLedgers) return json({ ok: true, ...(opts.space ? { space: opts.space } : {}), ...usageReport(service.store, window, service.backend, { app }) });
        return opts.peerLedgers.usage(window).then((peers) => {
          const local = usageReport(service.store, window, service.backend, { skipCallers: answered(peers) });
          const merged = mergeReports(local, peers.flatMap((p) => (p.data ? [peerReport(p.peer, p.data)] : [])));
          return json({ ok: true, ...(opts.space ? { space: opts.space } : {}), ...merged, peers: peers.map(peerStatus) });
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
        const asked = Number(q.get("limit") ?? 50);
        const limit = Math.max(1, Math.min(Number.isFinite(asked) ? asked : 50, 500));
        if (app !== undefined || tag !== undefined || !opts.peerLedgers) return json({ ok: true, calls: service.store.list({ app, tag, limit }).map(view) });
        return opts.peerLedgers.calls(limit).then((peers) => {
          const own = service.store.list({ limit, skipCallers: answered(peers) }).map(view);
          const theirs = peers.flatMap((p, i) => (p.data ?? []).map((c) => peerCall(p.peer, c, i)));
          const calls = [...own, ...theirs].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
          return json({ ok: true, calls, peers: peers.map(peerStatus) });
        });
      },
    },
  };
}

/** Room for each peer's ids in the hub's list: a peer's call `n` is `-((index + 1) * PEER_ID_SPAN + n)`. */
const PEER_ID_SPAN = 1e9;

/**
 * A peer's call as the hub lists it: who started it (`<peer>/<app>`) and where it ran (the peer,
 * unless it sent it on). Its id is negative and unique per peer, since clients key the list by id;
 * `peerId` keeps the peer's own.
 */
export function peerCall(peer: string, c: CallView, index: number): CallView & { peer: string; peerId: number } {
  return { ...c, id: -((index + 1) * PEER_ID_SPAN + c.id), peerId: c.id, app: `${peer}/${c.app}`, machine: c.machine || peer, peer };
}

/**
 * The ledger as another space reads it through `/api/peer/model/*` (peers/serve.ts guards them with the
 * peer token): this machine's own share. `skip` names the reading space, whose calls run here are left
 * out, since its own rows count them. `skipApps` are apps the peer link does not share.
 *
 *   GET /api/peer/model/usage?window=24h&skip=<space>   { ok, name, ...UsageReport }
 *   GET /api/peer/model/calls?limit=30&skip=<space>     { ok, name, calls }
 */
export function createPeerUsageRoutes(opts: { service: ModelService; name: string; skipApps?: () => string[] }): Routes {
  const scope = (q: URLSearchParams) => {
    const skip = q.get("skip") ?? "";
    return { skipCallers: skip && APP_PATTERN.test(skip) ? [skip] : [], skipApps: opts.skipApps?.() ?? [] };
  };
  return {
    "/api/peer/model/usage": {
      GET: (req) => {
        const q = new URL(req.url).searchParams;
        let window: Window;
        try {
          window = parseWindow(q.get("window"));
        } catch (e) {
          return error(400, (e as Error).message);
        }
        return json({ ok: true, name: opts.name, ...usageReport(opts.service.store, window, opts.service.backend, scope(q)) });
      },
    },
    "/api/peer/model/calls": {
      GET: (req) => {
        const q = new URL(req.url).searchParams;
        const asked = Number(q.get("limit") ?? 50);
        const limit = Math.max(1, Math.min(Number.isFinite(asked) ? asked : 50, 500));
        return json({ ok: true, name: opts.name, calls: opts.service.store.list({ limit, ...scope(q) }).map(view) });
      },
    },
  };
}

/** Who a forwarded call is for: `<space>/<app>` from the calling space (the bus uses the same header). */
const CALLER = /^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,63}$/i;

/**
 * The model routes another space reaches through `/api/peer/model/*` (docs/model-machines.md):
 * the same bodies and answers as `/api/model/run` and `/api/model/image`, run here with this
 * space's runtimes, recorded here with `origin: peer` under the caller `<space>/<app>`. The
 * request names its model and no machine (a forwarded call is not forwarded again), and only
 * runtimes in `allow` answer. The peer token check is the caller's (peers/serve.ts).
 */
export function createPeerModelRoutes(opts: { service: ModelService; allow: string[]; runs?: PeerRuns }): Routes {
  const { service } = opts;
  // Calls asked for under a `ref`: they outlive a dropped link, and asking again attaches (peer-runs.ts).
  const runs = opts.runs ?? new PeerRuns();
  const prepare = (req: Request, body: Record<string, unknown> | null): { caller: string } => {
    if (!body || typeof body !== "object") throw new Error("body must be a JSON object");
    const caller = req.headers.get("x-space-caller")?.trim() ?? "";
    if (!CALLER.test(caller)) throw new Error("x-space-caller must be <space>/<app>");
    if (typeof body.model !== "string" || !body.model) throw new Error("a forwarded call names its model");
    if (splitMachine(body.model)) throw new Error("a forwarded call names no machine: it runs here");
    return { caller };
  };
  const allowed = (name: string, machine?: string) => {
    if (!opts.allow.includes(name)) throw new Error(`runtime ${name} is not offered to other spaces here (SPACE_PEER_MODEL)`);
    // Its answers would run on yet another machine: a forwarded call stays on the machine it was sent to.
    if (machine) throw new Error(`runtime ${name} answers on ${machine} here, not on this machine; it cannot serve other spaces`);
  };
  return {
    "/api/peer/model/run": {
      POST: async (req) => {
        let caller: string;
        let input: ReturnType<typeof parseRunInput>;
        let images: RunImage[];
        let body: Record<string, unknown> | null;
        try {
          body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
          ({ caller } = prepare(req, body));
          if (body!.stream !== undefined && typeof body!.stream !== "boolean") throw new Error("stream must be a boolean");
          if (body!.ref !== undefined && (typeof body!.ref !== "string" || !REF_PATTERN.test(body!.ref))) throw new Error("ref must be 8 to 80 letters, digits, - or _");
          input = parseRunInput(body!);
          // Here it would read this machine, not the caller's: only plain reasoning crosses a link.
          const local = needsLocal(input);
          if (local) throw new Error(`a forwarded call is plain reasoning only; this one uses ${local}`);
          images = parseImages(body!.images, { named: true });
          const { runtime } = service.resolve(input.model);
          allowed(runtime.name, runtime.machine);
        } catch (e) {
          return error(400, (e as Error).message ?? String(e));
        }
        if (typeof body!.ref === "string") {
          const ready = input;
          const { run, fresh } = runs.open(caller, body!.ref, async (signal, onDelta) => {
            const { files, cleanup } = await spoolImages(images);
            try {
              const { outcome, call } = await service.run(caller, files.length ? { ...ready, files } : ready, signal, onDelta, undefined, "peer");
              return outcome.ok ? { event: "done", data: { ok: true, text: outcome.text, call: view(call) } } : { event: "error", data: { ok: false, error: outcome.error, call: view(call) } };
            } finally {
              await cleanup();
            }
          });
          return streamPeerRun(run, fresh);
        }
        const { files, cleanup } = await spoolImages(images);
        if (files.length) input = { ...input, files };
        if (body!.stream === true) return streamRun(service, caller, input, req.signal, undefined, cleanup, "peer");
        try {
          const { outcome, call } = await service.run(caller, input, req.signal, undefined, undefined, "peer");
          if (!outcome.ok) return json({ ok: false, error: outcome.error, call: view(call) }, 502);
          return json({ ok: true, text: outcome.text, call: view(call) });
        } finally {
          await cleanup();
        }
      },
    },
    // The caller gave up on a call it asked for under a ref: stop it here too.
    "/api/peer/model/runs/:ref/cancel": {
      POST: (req) => {
        const caller = req.headers.get("x-space-caller")?.trim() ?? "";
        if (!CALLER.test(caller)) return error(400, "x-space-caller must be <space>/<app>");
        return json({ ok: true, cancelled: runs.cancel(caller, req.params.ref ?? "") });
      },
    },
    "/api/peer/model/image": {
      POST: async (req) => {
        let caller: string;
        let input: ReturnType<typeof parseImageInput>;
        let images: RunImage[];
        try {
          const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
          ({ caller } = prepare(req, body));
          input = parseImageInput(body!);
          images = parseImages(body!.images, { named: true });
          const { runtime } = service.resolveImage(input.model);
          allowed(runtime.name, runtime.machine);
        } catch (e) {
          return error(400, (e as Error).message ?? String(e));
        }
        const { files, cleanup } = await spoolImages(images);
        try {
          const { outcome, call } = await service.image(caller, { ...input, files }, req.signal, undefined, "peer");
          if (!outcome.ok) return json({ ok: false, error: outcome.error, call: view(call) }, 502);
          return json({ ok: true, text: outcome.text, images: outcome.images.map((i) => ({ type: i.type, data: Buffer.from(i.bytes).toString("base64") })), call: view(call) });
        } finally {
          await cleanup();
        }
      },
    },
  };
}

/** How often a comment line goes out on an idle event stream, so no proxy or server closes it while the model thinks. */
export const STREAM_KEEPALIVE_MS = 15_000;

/**
 * A forwarded call's event stream (peer-runs.ts). The connection that started it gets its text as it
 * comes; one that attached after a dropped link gets only the end, since its caller already has the
 * text up to the drop and the end carries the whole answer. Either way the connection closing leaves
 * the call running.
 */
function streamPeerRun(run: PeerRun, withDeltas: boolean): Response {
  const enc = new TextEncoder();
  let stop = () => {};
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
      const delta = (text: string) => event("delta", { text });
      if (withDeltas) run.deltas.add(delta);
      const keepalive = setInterval(() => send(": keepalive\n\n"), STREAM_KEEPALIVE_MS);
      stop = () => {
        open = false;
        clearInterval(keepalive);
        run.deltas.delete(delta);
      };
      // An immediate comment: the response starts at once, before the model says anything.
      send(": started\n\n");
      void run.settled.then((final: FinalEvent) => {
        event(final.event, final.data);
        stop();
        try {
          controller.close();
        } catch {
          /* already closed by the client */
        }
      });
    },
    cancel() {
      stop();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" } });
}

/**
 * The same call as an event stream. The response starts at once (200, since
 * the request was already validated); a model failure is the `error` event,
 * with its ledger row, not a status code.
 */
function streamRun(service: ModelService, app: string, input: ReturnType<typeof parseRunInput>, signal: AbortSignal, source?: ResolvedModel["source"], cleanup: () => Promise<void> = async () => {}, origin: Origin = "run"): Response {
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
        .run(app, input, signal, (text) => event("delta", { text }), source, origin)
        .then(({ outcome, call }) => {
          if (outcome.ok) event("done", { ok: true, text: outcome.text, call: view(call) });
          else event("error", { ok: false, error: outcome.error, call: view(call) });
        })
        .finally(() => {
          void cleanup();
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
    machine: c.machine,
    mode: c.mode,
    modelSource: c.modelSource,
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
