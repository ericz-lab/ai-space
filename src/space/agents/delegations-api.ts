import { bearer } from "../auth.ts";
import { DelegationError, type DelegationService, type RunCaller, type RunTokens } from "./delegations.ts";

/**
 * The delegation routes (docs/orders.md#routes-and-commands). A delegating agent's run reaches them
 * with its `SPACE_RUN_TOKEN` (the `space delegate` command sends it), and only for the delegations
 * of its own session; the owner (the panel) may read every delegation and stop one.
 *
 *   POST /api/delegations              run token   { to, brief, continue?, images?: [order id] } → { ok, delegation }
 *   POST /api/delegations/:id/steer    run token   { message } → { ok: true } or { ok: false, reason: ended | unsupported | unreachable, error }
 *   POST /api/delegations/:id/stop     token/owner → { ok, stopped, last }
 *   GET  /api/delegations/:id          token/owner → { ok, delegation, notes, tail }
 *   GET  /api/delegations?session=     token/owner → { ok, delegations } (a token: its own session's, whatever is asked)
 *
 * The routes check their callers themselves (the gate's `self` policy): a run token is not one of
 * the credentials the gate knows, and an app's token is refused here.
 */

type Handler = (req: Request & { params: Record<string, string> }) => Response | Promise<Response>;

export type DelegationApiOptions = {
  service: DelegationService;
  tokens: RunTokens;
  /** Undefined when the request is the owner's (a session, a device, the operator, or no gate at all); else the refusal. */
  owner: (req: Request) => Promise<Response | undefined>;
};

export function createDelegationRoutes(opts: DelegationApiOptions): Record<string, Partial<Record<"GET" | "POST", Handler>>> {
  /** The caller: a run (its token), the owner (null), or a refusal. */
  const who = async (req: Request, runOnly: boolean): Promise<RunCaller | null | Response> => {
    const t = bearer(req);
    const run = t ? opts.tokens.resolve(t) : undefined;
    if (run) return run;
    if (t && t.startsWith("srt_")) return error(401, "this run token is not valid any more: it works only while its turn runs");
    if (runOnly) return error(403, "only a delegating agent's turn may do this, with its SPACE_RUN_TOKEN; the person adds to a delegate in the delegate's own chat");
    return (await opts.owner(req)) ?? null;
  };
  const route =
    (runOnly: boolean, h: (req: Request & { params: Record<string, string> }, caller: RunCaller | null) => Response | Promise<Response>): Handler =>
    async (req) => {
      const caller = await who(req, runOnly);
      if (caller instanceof Response) return caller;
      try {
        return await h(req, caller);
      } catch (e) {
        if (e instanceof DelegationError) return json({ ok: false, error: e.message, ...(e.reason ? { reason: e.reason } : {}) }, e.status);
        return error(400, (e as Error).message ?? String(e));
      }
    };
  const idOf = (req: { params: Record<string, string> }) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new DelegationError(400, "the id must be a delegation's number");
    return id;
  };
  return {
    "/api/delegations": {
      GET: route(false, (req, caller) => json({ ok: true, delegations: opts.service.list(caller, new URL(req.url).searchParams.get("session")) })),
      POST: route(true, async (req, caller) => {
        const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
        if (!body || typeof body !== "object" || Array.isArray(body)) return error(400, "the body must be JSON { to, brief, continue?, images? }");
        const cont = body.continue === undefined || body.continue === null ? undefined : Number(body.continue);
        if (cont !== undefined && !Number.isInteger(cont)) return error(400, "continue must be a delegation's number");
        const delegation = await opts.service.begin(caller!, {
          to: typeof body.to === "string" ? body.to : "",
          brief: typeof body.brief === "string" ? body.brief : "",
          ...(cont !== undefined ? { continue: cont } : {}),
          ...(body.images !== undefined ? { images: body.images as number[] } : {}),
        });
        return json({ ok: true, delegation }, 201);
      }),
    },
    "/api/delegations/:id": {
      GET: route(false, async (req, caller) => {
        const delegation = opts.service.read(caller, idOf(req));
        return json({ ok: true, delegation, notes: delegation.notes, tail: (await opts.service.show(delegation.id)).tail });
      }),
    },
    "/api/delegations/:id/steer": {
      POST: route(true, async (req, caller) => {
        const body = (await req.json().catch(() => null)) as { message?: unknown } | null;
        const r = await opts.service.say(caller!, idOf(req), typeof body?.message === "string" ? body.message : "");
        return json(r);
      }),
    },
    "/api/delegations/:id/stop": {
      POST: route(false, async (req, caller) => json({ ok: true, ...(await opts.service.halt(caller, idOf(req))) })),
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function error(status: number, message: string): Response {
  return json({ ok: false, error: message }, status);
}
