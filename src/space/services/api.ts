import type { Manifest } from "../scheduler/manifest.ts";
import type { Supervisor } from "./supervisor.ts";
import { SupervisorError } from "./supervisor.ts";

/**
 * The supervisor's HTTP surface, shaped as a Bun.serve `routes` table.
 *
 *   GET  /api/apps/:app/service      who supervises it, the unit, its state, the last sync's outcome
 *   POST /api/apps/:app/service      { action: "start" | "stop" | "restart" }: the space's unit, by hand;
 *                                    409 under SPACE_SUPERVISOR=operator (the answer names the command)
 *                                    { action: "supervise", to?: "space" | "operator" }: hand the app from the
 *                                    operator's unit to the space's (default) or back, rolled back unless
 *                                    healthy; 502 with the steps when it was rolled back
 *
 * Panel routes: no bearer token, like uninstall; they are reached through the
 * operator's access layer or loopback (docs/panel.md).
 */

type Handler = (req: Request & { params: Record<string, string> }) => Response | Promise<Response>;

const ACTIONS = ["start", "stop", "restart"] as const;

export function createServiceRoutes(opts: { supervisor: Supervisor; hasService: (app: string) => boolean | undefined; manifest?: (app: string) => Manifest | undefined }): Record<string, Partial<Record<"GET" | "POST", Handler>>> {
  const { supervisor } = opts;
  const known = (app: string | undefined): string => {
    const has = opts.hasService(app ?? "");
    if (has === undefined) throw new SupervisorError(404, `unknown app: ${app}`);
    if (!has) throw new SupervisorError(404, `"${app}" declares no service`);
    return app!;
  };
  const wrap =
    (h: Handler): Handler =>
    async (req) => {
      try {
        return await h(req);
      } catch (e) {
        return json({ ok: false, error: (e as Error).message }, e instanceof SupervisorError ? e.status : 502);
      }
    };
  return {
    "/api/apps/:app/service": {
      GET: wrap(async (req) => json({ ok: true, service: await supervisor.status(known(req.params.app)) })),
      POST: wrap(async (req) => {
        const app = known(req.params.app);
        const body = (await req.json().catch(() => ({}))) as { action?: unknown; to?: unknown };
        if (body.action === "supervise") {
          const to = body.to ?? "space";
          if (to !== "space" && to !== "operator") return json({ ok: false, error: "to must be space or operator" }, 400);
          const manifest = opts.manifest?.(app);
          if (!manifest) return json({ ok: false, error: `unknown app: ${app}` }, 404);
          const handover = await supervisor.handover(manifest, to);
          return json({ ok: handover.ok, handover, service: await supervisor.status(app) }, handover.ok ? 200 : 502);
        }
        const action = ACTIONS.find((a) => a === body.action);
        if (!action) return json({ ok: false, error: `action must be one of ${ACTIONS.join(", ")}, supervise` }, 400);
        await supervisor.control(app, action);
        return json({ ok: true, service: await supervisor.status(app) });
      }),
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
