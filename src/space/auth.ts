import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Who may call the Space API. Two kinds of caller present a bearer token: the
 * operator (`SPACE_API_TOKEN`) and an app (its own `SPACE_APP_TOKEN`). Routes
 * without a token (the panel's) are browser routes: `guardBrowserWrites` holds
 * their writes to the panel's own origin.
 */

/** The token after `Bearer ` (any case), or "" when none was presented. */
export function bearer(req: Request): string {
  return req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "";
}

/** Constant-time comparison; the hashes make the lengths equal. */
export function tokenEquals(presented: string, expected: string): boolean {
  if (!presented || !expected) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** An operator route: allowed when no token is configured (loopback only) or the operator's token is presented. */
export function isOperator(req: Request, token: string): boolean {
  return !token || tokenEquals(bearer(req), token);
}

export const OPERATOR = Symbol("operator");
export type Caller = typeof OPERATOR | { app: string };

/**
 * The operator or the app behind the presented token; undefined = not authorized.
 * With no token configured, a request that presents none is the operator.
 */
export async function identify(req: Request, opts: { token: string; appForToken?: (token: string) => Promise<string | undefined> }): Promise<Caller | undefined> {
  const presented = bearer(req);
  if (opts.token && tokenEquals(presented, opts.token)) return OPERATOR;
  if (presented && opts.appForToken) {
    const app = await opts.appForToken(presented);
    if (app) return { app };
  }
  if (!opts.token && !presented) return OPERATOR;
  return undefined;
}

export class Unauthorized extends Error {}

/**
 * True when the request comes from the panel's own origin: `Origin` (sent on
 * every POST and socket upgrade) or, failing that, `Sec-Fetch-Site` matches
 * the host the request arrived at. A request with neither header (a script
 * on the machine, the hub's forward) passes: those are not browsers.
 */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin === null) {
    const site = req.headers.get("sec-fetch-site");
    return site === null || site === "same-origin" || site === "none";
  }
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const forwarded = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  return host === req.headers.get("host") || (!!forwarded && host === forwarded);
}

const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * A write without a bearer token must come from the panel's own origin. Any page
 * the operator opens can send a simple cross-site POST to loopback, and the panel
 * routes carry no token; a request with an `Authorization` header cannot be sent
 * cross-site without a preflight, which this server never answers.
 */
export function crossSiteWrite(req: Request): boolean {
  return WRITES.has(req.method) && !req.headers.has("authorization") && !sameOrigin(req);
}

type AnyHandler = (req: any, server: any) => unknown;

/** Wraps every handler of a `Bun.serve` route table with the `crossSiteWrite` refusal; static routes pass through. */
export function guardBrowserWrites<T extends Record<string, unknown>>(routes: T): T {
  const guard = (h: AnyHandler): AnyHandler => (req: Request, server: unknown) =>
    crossSiteWrite(req) ? new Response(JSON.stringify({ ok: false, error: "cross-origin request refused" }), { status: 403, headers: { "content-type": "application/json" } }) : h(req, server);
  const out: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(routes)) {
    if (typeof value === "function") out[path] = guard(value as AnyHandler);
    // A method table is a plain object; an HTML bundle or a Response is served as it is.
    else if (value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).every((k) => /^[A-Z]+$/.test(k))) {
      out[path] = Object.fromEntries(Object.entries(value).map(([m, h]) => [m, typeof h === "function" && WRITES.has(m) ? guard(h as AnyHandler) : h]));
    } else out[path] = value;
  }
  return out as T;
}
