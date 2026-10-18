import { bearer, isOwner } from "../auth.ts";
import { type AuthMode, SESSION_COOKIE, cookieValue } from "./gate.ts";
import { type AuthService, PasswordRejected, SESSION_TTL_MS } from "./service.ts";
import type { Session } from "./store.ts";

/**
 * The sign-in routes (docs/auth.md#api):
 *
 *   GET    /api/auth/session                     public: the mode, whether an owner exists, whether this request is signed in
 *   POST   /api/auth/login        {password}     public: opens a session, sets the HttpOnly cookie
 *   POST   /api/auth/logout                      public: ends this session, clears the cookie
 *   POST   /api/auth/password     {current, next}  owner: changes the password, signs out every other session
 *   GET    /api/auth/sessions                    owner: live sessions, the current one marked
 *   DELETE /api/auth/sessions/:id                owner: signs one session out
 *   POST   /api/auth/sessions/revoke-others      owner: signs out every session but this one
 *   POST   /api/auth/device/session              self (a device credential): a session cookie for the device's web view
 *   GET    /api/auth/devices                     owner: live device credentials
 *   DELETE /api/auth/devices/:id                 owner: revokes one device credential
 *
 * Writes go through the same-origin check of the whole table (src/space/auth.ts).
 */

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
const iso = (ms: number) => new Date(ms).toISOString();

type Req = Request & { params: Record<string, string> };
type Server = { requestIP?: (req: Request) => { address: string } | null };

export const AUTH_PUBLIC = ["/api/auth/session", "/api/auth/login", "/api/auth/logout"];
/** Routes that check their own credential (policy `self`). */
export const AUTH_SELF = ["/api/auth/device/session"];

function secure(req: Request): boolean {
  return new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https";
}

function cookie(req: Request, value: string, maxAgeS: number): string {
  return [`${SESSION_COOKIE}=${value}`, "Path=/", `Max-Age=${maxAgeS}`, "HttpOnly", "SameSite=Lax", ...(secure(req) ? ["Secure"] : [])].join("; ");
}

/** Buckets failed sign-ins; the forwarded address can be forged, which the space-wide limit bounds. */
function clientOf(req: Request, server: Server | undefined): string {
  const forwarded = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  return `${server?.requestIP?.(req)?.address ?? ""}|${forwarded}`;
}

const view = (s: Session, current?: number) => ({ id: s.id, createdAt: iso(s.createdAt), expiresAt: iso(s.expiresAt), lastSeenAt: iso(s.lastSeenAt), userAgent: s.userAgent, current: s.id === current });

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function createAuthRoutes(opts: { mode: AuthMode; auth: AuthService }) {
  const { auth } = opts;
  const builtin = opts.mode === "builtin";
  const off = () => json(404, { ok: false, error: "built-in sign-in is off (SPACE_AUTH=external)" });
  const current = (req: Request) => auth.verify(cookieValue(req, SESSION_COOKIE));

  return {
    "/api/auth/session": {
      GET: (req: Request) => {
        if (!builtin) return json(200, { ok: true, mode: opts.mode });
        const s = current(req);
        return json(200, { ok: true, mode: opts.mode, initialized: auth.initialized(), signedIn: Boolean(s), ...(s ? { session: view(s, s.id) } : {}) });
      },
    },
    "/api/auth/login": {
      POST: async (req: Request, server?: Server) => {
        if (!builtin) return off();
        const b = await body(req);
        const result = await auth.login(b.password, { client: clientOf(req, server), userAgent: req.headers.get("user-agent") ?? "" });
        if (result.ok) return json(200, { ok: true, session: view(result.session, result.session.id) }, { "set-cookie": cookie(req, result.token, Math.floor(SESSION_TTL_MS / 1000)) });
        if (result.reason === "uninitialized") return json(409, { ok: false, error: "no owner yet: run `space auth init` on the server", auth: "uninitialized" });
        if (result.reason === "limited") return json(429, { ok: false, error: "too many failed sign-ins; try again later", retryAfterMs: result.retryAfterMs }, { "retry-after": String(Math.ceil(result.retryAfterMs / 1000)) });
        return json(401, { ok: false, error: "wrong password" });
      },
    },
    "/api/auth/logout": {
      POST: (req: Request) => {
        if (!builtin) return off();
        auth.logout(cookieValue(req, SESSION_COOKIE));
        return json(200, { ok: true }, { "set-cookie": cookie(req, "", 0) });
      },
    },
    "/api/auth/password": {
      POST: async (req: Request) => {
        if (!builtin) return off();
        const s = current(req);
        if (!s || !isOwner(req)) return json(403, { ok: false, error: "change the password from a signed-in session, or with `space auth reset-password` on the server" });
        const b = await body(req);
        try {
          const r = await auth.changePassword(String(b.current ?? ""), b.next as string, s.id);
          return r.ok ? json(200, { ok: true, revoked: r.revoked }) : json(401, { ok: false, error: "wrong current password" });
        } catch (e) {
          if (e instanceof PasswordRejected) return json(400, { ok: false, error: e.message });
          throw e;
        }
      },
    },
    "/api/auth/sessions": {
      GET: (req: Request) => {
        if (!builtin) return off();
        const s = current(req);
        return json(200, { ok: true, sessions: auth.sessions().map((x) => view(x, s?.id)) });
      },
    },
    "/api/auth/sessions/revoke-others": {
      POST: (req: Request) => {
        if (!builtin) return off();
        return json(200, { ok: true, revoked: auth.revokeAll(current(req)?.id) });
      },
    },
    "/api/auth/device/session": {
      POST: (req: Request) => {
        if (!builtin) return off();
        const d = auth.verifyDevice(bearer(req));
        if (!d) return json(401, { ok: false, error: "a device credential is required" });
        const { token, session } = auth.deviceSession(d, req.headers.get("user-agent") ?? "");
        return json(200, { ok: true, device: { id: d.id, name: d.name }, session: view(session, session.id) }, { "set-cookie": cookie(req, token, Math.floor(SESSION_TTL_MS / 1000)) });
      },
    },
    "/api/auth/devices": {
      GET: () => {
        if (!builtin) return off();
        return json(200, { ok: true, devices: auth.devices().map((d) => ({ id: d.id, name: d.name, createdAt: iso(d.createdAt), lastSeenAt: d.lastSeenAt === null ? null : iso(d.lastSeenAt) })) });
      },
    },
    "/api/auth/devices/:id": {
      DELETE: (req: Req) => {
        if (!builtin) return off();
        const id = Number(req.params.id);
        if (!Number.isInteger(id)) return json(400, { ok: false, error: "bad device id" });
        return auth.revokeDevice(id) ? json(200, { ok: true }) : json(404, { ok: false, error: "no such live device" });
      },
    },
    "/api/auth/sessions/:id": {
      DELETE: (req: Req) => {
        if (!builtin) return off();
        const id = Number(req.params.id);
        if (!Number.isInteger(id)) return json(400, { ok: false, error: "bad session id" });
        return auth.revoke(id) ? json(200, { ok: true }) : json(404, { ok: false, error: "no such live session" });
      },
    },
  };
}
