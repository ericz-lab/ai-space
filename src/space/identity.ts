import { isOperator } from "./auth.ts";

/**
 * What this service is (docs/editions.md#service-identity): a client checks it before it says
 * Connected, so a port that answers is not taken for an ai-space; the Local edition will use the
 * id to recognise the installation it owns.
 *
 *   GET /api/space   { product, api, version, edition }, plus { id, name } for the operator token
 *                    or the owner's session
 *
 * A public route (docs/auth.md#access-policy): a client asks before anyone has signed in.
 */

export const PRODUCT = "ai-space";

/**
 * The Space API's compatibility level. Raise it when a change breaks clients built for the
 * previous level; adding a route or a field does not.
 */
export const API_LEVEL = 1;

/** The editions that run this service. The Client edition never does, so it has no value here. */
export const EDITIONS = ["server", "local"] as const;
export type Edition = (typeof EDITIONS)[number];

/** SPACE_EDITION: `server` when unset; the Local edition's launcher sets `local`. */
export function parseEdition(raw: string | undefined): Edition {
  const value = raw?.trim().toLowerCase() || "server";
  if (!(EDITIONS as readonly string[]).includes(value)) throw new Error(`SPACE_EDITION must be one of ${EDITIONS.join(", ")}, got "${raw}"`);
  return value as Edition;
}

export type SpaceIdentity = {
  product: typeof PRODUCT;
  version: string;
  edition: Edition;
  api: number;
  /** The Space's stable id (the same one packages and connections use); the operator's only. */
  id?: string;
  /** SPACE_NAME, default the hostname; the operator's only. */
  name?: string;
};

export function createIdentityRoutes(opts: { version: string; edition: Edition; id: string; name: string; token: string }) {
  const open: SpaceIdentity = { product: PRODUCT, api: API_LEVEL, version: opts.version, edition: opts.edition };
  return {
    "/api/space": {
      GET: (req: Request) => Response.json(isOperator(req, opts.token) ? { ...open, id: opts.id, name: opts.name } : open, { headers: { "cache-control": "no-store" } }),
    },
  };
}
