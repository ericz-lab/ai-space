/**
 * What this service is (docs/editions.md#service-identity): a client checks it before it says
 * Connected, so a port that answers is not taken for an ai-space; the Local edition will use the
 * id to recognise the installation it owns.
 *
 *   GET /api/space   { product, version, edition, api, id, name }
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
  /** The Space's stable id (the same one packages and connections use). */
  id: string;
  /** SPACE_NAME, default the hostname. */
  name: string;
};

export function createIdentityRoutes(identity: Omit<SpaceIdentity, "product" | "api">) {
  const body: SpaceIdentity = { product: PRODUCT, api: API_LEVEL, ...identity };
  return {
    "/api/space": {
      GET: () => Response.json(body, { headers: { "cache-control": "no-store" } }),
    },
  };
}
