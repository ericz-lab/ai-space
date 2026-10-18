import { bearer, markOwner, tokenEquals } from "../auth.ts";
import type { AuthService } from "./service.ts";

/**
 * Who may reach each route under `SPACE_AUTH=builtin` (docs/auth.md#access-policy).
 * The policy is given per route key when the table is composed, so a route
 * added later gets the strictest one unless its table says otherwise:
 *
 * - `public`: anyone (the sign-in routes, the page shell and its files, `/healthz`).
 * - `self`: the route checks its own credential strictly (a hub's token, a package connection's).
 * - `app`: the owner, the operator token, or an app's token or an external consumer's key;
 *   the route then decides what that caller may do, as before.
 * - `app-read`: as `app` for GET and HEAD, `owner` otherwise.
 * - `owner`: the owner's session or the operator token. The default.
 *
 * `external` (the default mode) leaves every route as it was: the access layer in front
 * (Cloudflare Access) is the sign-in.
 */

export type AuthMode = "external" | "builtin";
export type Policy = "public" | "self" | "app" | "app-read" | "owner";

export const SESSION_COOKIE = "space_session";

export function parseAuthMode(value: string | undefined): AuthMode {
  const v = value?.trim().toLowerCase() || "external";
  if (v !== "external" && v !== "builtin") throw new Error(`SPACE_AUTH must be "external" or "builtin", not "${value}"`);
  return v;
}

/** The value of one cookie, or "". */
export function cookieValue(req: Request, name: string): string {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return "";
      }
    }
  }
  return "";
}

type Table = Record<string, unknown>;

/**
 * Merges route tables in order (a later key wins, as with object spread) and
 * records each key's policy from the table it came from; `overrides` set single keys.
 */
export function composeRoutes(tables: [Policy, Table][], overrides: Record<string, Policy> = {}): { routes: Table; policies: Map<string, Policy> } {
  const routes: Table = {};
  const policies = new Map<string, Policy>();
  for (const [policy, table] of tables) {
    for (const [key, value] of Object.entries(table)) {
      routes[key] = value;
      policies.set(key, policy);
    }
  }
  for (const [key, policy] of Object.entries(overrides)) if (key in routes) policies.set(key, policy);
  return { routes, policies };
}

export type GateOptions = {
  mode: AuthMode;
  auth: AuthService;
  /** The operator token; under `builtin` it is never empty (src/space/auth/operator-token.ts). */
  operatorToken: string;
  /** True for an app's token or an external consumer's key. */
  isAppCredential: (token: string) => Promise<boolean>;
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

const READS = new Set(["GET", "HEAD"]);

/** A page navigation (not a fetch, a stream or a socket), which is sent to the sign-in page instead of a 401. */
function isNavigation(req: Request): boolean {
  if (req.method !== "GET" || req.headers.get("upgrade")) return false;
  const mode = req.headers.get("sec-fetch-mode");
  if (mode) return mode === "navigate";
  return (req.headers.get("accept") ?? "").includes("text/html");
}

/** Undefined when the request may go on; otherwise the refusal. */
export async function check(req: Request, policy: Policy, opts: GateOptions): Promise<Response | undefined> {
  if (policy === "public" || policy === "self") return undefined;
  const presented = bearer(req);
  if (presented) {
    if (tokenEquals(presented, opts.operatorToken)) return undefined;
    const appAllowed = policy === "app" || (policy === "app-read" && READS.has(req.method));
    if (appAllowed && (await opts.isAppCredential(presented))) return undefined;
    // A bearer token that is none of the above is refused, never treated as "no token".
    return json(401, { ok: false, error: "unauthorized" });
  }
  const session = opts.auth.verify(cookieValue(req, SESSION_COOKIE));
  if (session) {
    markOwner(req);
    return undefined;
  }
  if (isNavigation(req)) {
    const url = new URL(req.url);
    return new Response(null, { status: 302, headers: { location: `/?next=${encodeURIComponent(url.pathname + url.search)}`, "cache-control": "no-store" } });
  }
  return json(401, { ok: false, error: "sign-in required", auth: opts.auth.initialized() ? "signed-out" : "uninitialized" });
}

type AnyHandler = (req: any, server: any) => unknown;

/** Wraps every handler with its key's policy. A static value (a page bundle, a fixed Response) must be `public`. */
export function gateRoutes<T extends Table>(routes: T, policies: Map<string, Policy>, opts: GateOptions): T {
  if (opts.mode === "external") return routes;
  const guard = (policy: Policy, h: AnyHandler): AnyHandler => async (req: Request, server: unknown) => (await check(req, policy, opts)) ?? h(req, server);
  const out: Table = {};
  for (const [path, value] of Object.entries(routes)) {
    const policy = policies.get(path) ?? "owner";
    if (policy === "public" || policy === "self") out[path] = value;
    else if (typeof value === "function") out[path] = guard(policy, value as AnyHandler);
    else if (value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).every((k) => /^[A-Z]+$/.test(k))) {
      out[path] = Object.fromEntries(
        Object.entries(value).map(([m, h]) => {
          if (typeof h !== "function") throw new Error(`route ${m} ${path}: a static response needs the public policy`);
          return [m, guard(policy, h as AnyHandler)];
        }),
      );
    } else throw new Error(`route ${path}: a static response needs the public policy`);
  }
  return out as T;
}
