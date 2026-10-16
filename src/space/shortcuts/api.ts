import { type RunInput, ShortcutError, type Shortcuts } from "./service.ts";
import type { Run } from "./types.ts";

/**
 * HTTP surface of shortcuts (docs/shortcuts.md#api), the panel's like `/api/voice`: no token, and a
 * browser write is held to the panel's own origin by `guardBrowserWrites`. Runs execute as the
 * operator (`space` in the bus's call history).
 *
 *   GET  /api/shortcuts/actions            the catalogue: built-ins, app actions here and on peers, unfilled slots
 *   POST /api/shortcuts/runs               { action, peer?, args, timezone, requestId } start a run; answers it when
 *                                          it ends or after a few seconds (status running), 201, or 200 with
 *                                          `duplicate: true` for a request id seen before
 *   GET  /api/shortcuts/runs?limit         recent runs, newest first
 *   GET  /api/shortcuts/runs/:id           one run (a task run's status is read from the scheduler)
 *   POST /api/shortcuts/runs/:id/retry     run a failed one again; an unknown write only when the provider is idempotent
 *   POST /api/shortcuts/preview            { action, args, timezone } a read action's result, not recorded (live conversion)
 */

type Handler = (req: Request & { params: Record<string, string> }) => Response | Promise<Response>;
type Routes = Record<string, Partial<Record<"GET" | "POST", Handler>>>;

export function createShortcutRoutes(opts: { shortcuts: Shortcuts }): Routes {
  const { shortcuts } = opts;
  const safe =
    (h: Handler): Handler =>
    async (req) => {
      try {
        return await h(req);
      } catch (e) {
        if (e instanceof ShortcutError) return error(e.status, e.message);
        return error(500, (e as Error).message ?? String(e));
      }
    };
  const body = async (req: Request): Promise<RunInput> => {
    const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!b || typeof b !== "object" || typeof b.action !== "string") throw new ShortcutError(400, "body must be { action, args?, timezone?, requestId? }");
    if (b.peer !== undefined && typeof b.peer !== "string") throw new ShortcutError(400, "peer must be a peer name");
    if (b.args !== undefined && (typeof b.args !== "object" || b.args === null || Array.isArray(b.args))) throw new ShortcutError(400, "args must be an object");
    if (b.timezone !== undefined && typeof b.timezone !== "string") throw new ShortcutError(400, "timezone must be an IANA zone");
    return { action: b.action, ...(b.peer ? { peer: b.peer as string } : {}), ...(b.args ? { args: b.args as Record<string, unknown> } : {}), ...(b.timezone ? { timezone: b.timezone as string } : {}), ...(b.requestId !== undefined ? { requestId: b.requestId as string } : {}) };
  };
  const runId = (req: { params: Record<string, string> }) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new ShortcutError(400, "run id must be a positive integer");
    return id;
  };

  return {
    "/api/shortcuts/actions": {
      GET: safe(() => json({ ok: true, actions: shortcuts.catalogue() })),
    },
    "/api/shortcuts/runs": {
      GET: safe((req) => {
        const limit = Number(new URL(req.url).searchParams.get("limit") ?? 30);
        return json({ ok: true, runs: shortcuts.listRuns(Number.isFinite(limit) ? limit : 30).map(runView) });
      }),
      POST: safe(async (req) => {
        const { run, duplicate } = await shortcuts.start(await body(req));
        return json({ ok: true, run: runView(run), duplicate }, duplicate ? 200 : 201);
      }),
    },
    "/api/shortcuts/runs/:id": {
      GET: safe((req) => {
        const run = shortcuts.getRun(runId(req));
        return run ? json({ ok: true, run: runView(run) }) : error(404, `unknown run: ${req.params.id}`);
      }),
    },
    "/api/shortcuts/runs/:id/retry": {
      POST: safe(async (req) => json({ ok: true, run: runView(await shortcuts.retry(runId(req))) })),
    },
    "/api/shortcuts/preview": {
      POST: safe(async (req) => json({ ok: true, result: await shortcuts.preview(await body(req)) })),
    },
  };
}

/** A run as the page reads it: instants as ISO strings; the idempotency key stays on the server. */
export function runView(r: Run) {
  const { idempotencyKey: _key, createdAt, endedAt, taskStartedAt: _started, ...rest } = r;
  return { ...rest, createdAt: new Date(createdAt).toISOString(), ...(endedAt !== undefined ? { endedAt: new Date(endedAt).toISOString() } : {}) };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function error(status: number, message: string): Response {
  return json({ ok: false, error: message }, status);
}
