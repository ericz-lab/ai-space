import { isOperator } from "./auth.ts";

/**
 * What this service is (docs/editions.md#service-identity): a client checks it before it says
 * Connected, so a port that answers is not taken for an ai-space.
 *
 *   GET /api/space   { product, api, version, edition, installation }, plus { id, name } for the
 *                    operator token or the owner's session. `edition` is always "server" and
 *                    `installation` always "external": the retired Local edition answered other
 *                    values, and clients built then still decode both fields.
 *                    The operator also gets `uptime: { startedAt, totalMs }`, this run's start and
 *                    every recorded run added up (docs/usage.md#uptime).
 *
 * A public route (docs/auth.md#access-policy): a client asks before anyone has signed in.
 */

export const PRODUCT = "ai-space";

/**
 * The Space API's compatibility level. Raise it when a change breaks clients built for the
 * previous level; adding a route or a field does not.
 */
export const API_LEVEL = 1;

/** The edition that runs this service: the Server. The Client edition never does. */
export const EDITION = "server";

export type SpaceIdentity = {
  product: typeof PRODUCT;
  version: string;
  edition: typeof EDITION;
  api: number;
  installation: "external";
  /** The Space's stable id (the same one packages and connections use); the operator's only. */
  id?: string;
  /** SPACE_NAME, default the hostname; the operator's only. */
  name?: string;
  /** This run's start and the Space's whole recorded running time (docs/usage.md#uptime); the operator's only. */
  uptime?: { startedAt: string; totalMs: number };
};

export function createIdentityRoutes(opts: { version: string; id: string; name: string; token: string; uptime?: () => { startedAt: string; totalMs: number } | undefined }) {
  const open: SpaceIdentity = { product: PRODUCT, api: API_LEVEL, version: opts.version, edition: EDITION, installation: "external" };
  return {
    "/api/space": {
      GET: (req: Request) => {
        if (!isOperator(req, opts.token)) return Response.json(open, { headers: { "cache-control": "no-store" } });
        const up = opts.uptime?.();
        const body: SpaceIdentity = { ...open, id: opts.id, name: opts.name, ...(up ? { uptime: { startedAt: up.startedAt, totalMs: up.totalMs } } : {}) };
        return Response.json(body, { headers: { "cache-control": "no-store" } });
      },
    },
  };
}
