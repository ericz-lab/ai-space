/**
 * Where a connection stands, and the errors of a native call. A port that answers is not
 * `ready`: the Space must say it is ai-space (`GET /api/space`, public, docs/editions.md#service-identity)
 * and its panel routes must answer this client's session (`GET /api/panel/layout`), as the Mac's
 * `SpaceCheck` classifies it.
 */

/** The highest API level of `GET /api/space` this client speaks (`API_LEVEL` in src/space/identity.ts). */
export const SUPPORTED_API = 1;

export type SpaceState =
  | { kind: "connecting" }
  | { kind: "ready"; version?: string; edition?: string; name?: string }
  | { kind: "signin" }
  | { kind: "unreachable"; detail: string }
  | { kind: "incompatible"; detail: string };

export type Identity = { product: string; api: number; version: string; edition: string; installation?: string; id?: string; name?: string };

/**
 * A native call's failure: `signin` when the access layer or the Space wants a sign-in (a
 * redirect, 401 or 403; a redirect is never followed), `http` with the server's own `error`
 * text, `network` when nothing answered, `invalid` for an answer that is not the expected JSON.
 */
export class SpaceError extends Error {
  constructor(
    readonly kind: "signin" | "http" | "network" | "invalid",
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

/** Maps an answer to an error, as the Mac's `SpaceAPI.check`. */
export function checkResponse(status: number, body: string, reason = ""): void {
  if (status >= 200 && status < 300) return;
  if ((status >= 300 && status < 400) || status === 401 || status === 403) throw new SpaceError("signin", "sign in required", status);
  let message = reason || `HTTP ${status}`;
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error) message = parsed.error;
  } catch {}
  throw new SpaceError("http", message, status);
}

/** `GET /api/space`: an ai-space this client can talk to, or why not. */
export function classifyIdentity(status: number, body: string): { identity: Identity } | { state: SpaceState } {
  if (status === 404) return { state: { kind: "incompatible", detail: "no /api/space: an ai-space older than this client, or not an ai-space" } };
  if (status < 200 || status >= 300) return { state: status === 401 || status === 403 || (status >= 300 && status < 400) ? { kind: "signin" } : { kind: "incompatible", detail: `HTTP ${status}` } };
  let id: Partial<Identity>;
  try {
    id = JSON.parse(body) as Partial<Identity>;
  } catch {
    return { state: { kind: "incompatible", detail: "not an ai-space response" } };
  }
  if (id.product !== "ai-space" || typeof id.api !== "number") return { state: { kind: "incompatible", detail: "not an ai-space response" } };
  if (id.api > SUPPORTED_API) return { state: { kind: "incompatible", detail: `this Space speaks API ${id.api}; update the app` } };
  return { identity: id as Identity };
}

/** `GET /api/panel/layout` with the session's cookies: ready, or a sign-in. */
export function classifyLayout(status: number, contentType: string, body: string): SpaceState {
  if (status === 0 || (status >= 300 && status < 400) || status === 401 || status === 403) return { kind: "signin" };
  if (status !== 200) return { kind: "incompatible", detail: `HTTP ${status}` };
  if (!contentType.toLowerCase().includes("json")) return { kind: "incompatible", detail: "not an ai-space response" };
  try {
    const o = JSON.parse(body) as { ok?: unknown; layout?: unknown };
    if (o.ok === true && typeof o.layout === "object" && o.layout !== null) return { kind: "ready" };
  } catch {}
  return { kind: "incompatible", detail: "not an ai-space response" };
}
