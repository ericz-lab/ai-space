import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createAuthRoutes } from "./api.ts";
import { SESSION_COOKIE, composeRoutes, gateRoutes } from "./gate.ts";
import { AuthService } from "./service.ts";
import { AuthStore } from "./store.ts";

// The sign-in routes as the gate serves them (docs/auth.md#api).

const PASSWORD = "correct horse battery";

type Handler = (req: Request, server?: unknown) => Response | Promise<Response>;

async function setup(opts: { mode?: "builtin" | "external"; init?: boolean } = {}) {
  const mode = opts.mode ?? "builtin";
  const auth = new AuthService(new AuthStore(new Database(":memory:")), { hashCost: { memoryCost: 8, timeCost: 1 } });
  if (opts.init !== false) await auth.init(PASSWORD);
  const routes = createAuthRoutes({ mode, auth });
  const composed = composeRoutes([["owner", routes]], { "/api/auth/session": "public", "/api/auth/login": "public", "/api/auth/logout": "public", "/api/auth/device/session": "self" });
  const gated = gateRoutes(composed.routes, composed.policies, { mode, auth, operatorToken: "op", isAppCredential: async () => false }) as Record<string, Record<string, Handler>>;
  const call = async (key: string, method: string, init: { body?: unknown; headers?: Record<string, string>; params?: Record<string, string>; url?: string } = {}) => {
    const path = Object.entries(init.params ?? {}).reduce((p, [k, v]) => p.replace(`:${k}`, v), key);
    const req = Object.assign(
      new Request(`${init.url ?? "http://127.0.0.1:8700"}${path}`, { method, headers: { "content-type": "application/json", ...init.headers }, ...(init.body === undefined ? {} : { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) }) }),
      { params: init.params ?? {} },
    );
    return gated[key]![method]!(req, undefined);
  };
  const login = async (password = PASSWORD, headers: Record<string, string> = {}) => {
    const r = await call("/api/auth/login", "POST", { body: { password }, headers });
    const set = r.headers.get("set-cookie") ?? "";
    const token = set.match(new RegExp(`${SESSION_COOKIE}=([^;]*)`))?.[1] ?? "";
    return { r, cookie: `${SESSION_COOKIE}=${token}`, setCookie: set };
  };
  return { auth, call, login };
}

describe("external mode", () => {
  test("the session route says the mode; the others are 404", async () => {
    const { call } = await setup({ mode: "external" });
    expect(await (await call("/api/auth/session", "GET")).json()).toEqual({ ok: true, mode: "external" });
    for (const [key, method] of [["/api/auth/login", "POST"], ["/api/auth/logout", "POST"], ["/api/auth/password", "POST"], ["/api/auth/sessions", "GET"], ["/api/auth/sessions/revoke-others", "POST"], ["/api/auth/device/session", "POST"], ["/api/auth/devices", "GET"]] as const) {
      expect((await call(key, method)).status).toBe(404);
    }
    expect((await call("/api/auth/sessions/:id", "DELETE", { params: { id: "1" } })).status).toBe(404);
    expect((await call("/api/auth/devices/:id", "DELETE", { params: { id: "1" } })).status).toBe(404);
  });
});

describe("login and session", () => {
  test("before init, login is 409 and the session says uninitialized", async () => {
    const { call, login } = await setup({ init: false });
    expect(await (await call("/api/auth/session", "GET")).json()).toMatchObject({ mode: "builtin", initialized: false, signedIn: false });
    const { r } = await login();
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ auth: "uninitialized" });
  });

  test("a right password sets an HttpOnly cookie, Secure only over https", async () => {
    const { call, login } = await setup();
    const plain = await login();
    expect(plain.r.status).toBe(200);
    expect(plain.setCookie).toContain("HttpOnly");
    expect(plain.setCookie).toContain("SameSite=Lax");
    expect(plain.setCookie).not.toContain("Secure");
    const r = await call("/api/auth/session", "GET", { headers: { cookie: plain.cookie } });
    expect(await r.json()).toMatchObject({ signedIn: true, session: { current: true } });
    const forwarded = await login(PASSWORD, { "x-forwarded-proto": "https" });
    expect(forwarded.setCookie).toContain("Secure");
  });

  test("a wrong, missing or malformed password is 401, and repeated failures are 429 with retry-after", async () => {
    const { call, login } = await setup();
    expect((await login("wrong password")).r.status).toBe(401);
    expect((await call("/api/auth/login", "POST", { body: "not json" })).status).toBe(401);
    expect((await call("/api/auth/login", "POST", { body: [1, 2] })).status).toBe(401);
    let r: Response | undefined;
    for (let i = 0; i < 30 && r?.status !== 429; i++) r = (await login("wrong password")).r;
    expect(r!.status).toBe(429);
    expect(Number(r!.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await r!.json()).toMatchObject({ retryAfterMs: expect.any(Number) });
  });

  test("logout ends the session and clears the cookie", async () => {
    const { call, login } = await setup();
    const { cookie } = await login();
    const r = await call("/api/auth/logout", "POST", { headers: { cookie } });
    expect(r.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await (await call("/api/auth/session", "GET", { headers: { cookie } })).json()).toMatchObject({ signedIn: false });
  });
});

describe("owner routes", () => {
  test("need a session or a credential", async () => {
    const { call } = await setup();
    expect((await call("/api/auth/sessions", "GET")).status).toBe(401);
    expect((await call("/api/auth/sessions", "GET", { headers: { authorization: "Bearer op" } })).status).toBe(200);
  });

  test("password: only from a session; wrong current is 401, a short one 400, a change signs out the others", async () => {
    const { call, login } = await setup();
    expect((await call("/api/auth/password", "POST", { headers: { authorization: "Bearer op" }, body: { current: PASSWORD, next: "another long one" } })).status).toBe(403);
    const me = await login();
    const other = await login();
    const as = { cookie: me.cookie };
    expect((await call("/api/auth/password", "POST", { headers: as, body: { current: "nope", next: "another long one" } })).status).toBe(401);
    expect((await call("/api/auth/password", "POST", { headers: as, body: { current: PASSWORD, next: "short" } })).status).toBe(400);
    const r = await call("/api/auth/password", "POST", { headers: as, body: { current: PASSWORD, next: "another long one" } });
    expect(await r.json()).toEqual({ ok: true, revoked: 1 });
    expect(await (await call("/api/auth/session", "GET", { headers: { cookie: other.cookie } })).json()).toMatchObject({ signedIn: false });
    expect(await (await call("/api/auth/session", "GET", { headers: as })).json()).toMatchObject({ signedIn: true });
  });

  test("sessions: list marks the current one; revoke one, a bad id, an unknown id; revoke the others", async () => {
    const { call, login } = await setup();
    const me = await login();
    const other = await login();
    await login();
    const list = (await (await call("/api/auth/sessions", "GET", { headers: { cookie: me.cookie } })).json()) as { sessions: { id: number; current: boolean }[] };
    expect(list.sessions).toHaveLength(3);
    expect(list.sessions.filter((s) => s.current)).toHaveLength(1);
    const otherId = ((await (await call("/api/auth/session", "GET", { headers: { cookie: other.cookie } })).json()) as { session: { id: number } }).session.id;
    const del = (id: string) => call("/api/auth/sessions/:id", "DELETE", { params: { id }, headers: { cookie: me.cookie } });
    expect((await del("x")).status).toBe(400);
    expect((await del("99999")).status).toBe(404);
    expect((await del(String(otherId))).status).toBe(200);
    expect(await (await call("/api/auth/sessions/revoke-others", "POST", { headers: { cookie: me.cookie } })).json()).toEqual({ ok: true, revoked: 1 });
    expect(await (await call("/api/auth/session", "GET", { headers: { cookie: me.cookie } })).json()).toMatchObject({ signedIn: true });
  });

  test("devices: list and revoke; a device session needs a device credential", async () => {
    const { auth, call } = await setup();
    const op = { authorization: "Bearer op" };
    expect((await call("/api/auth/device/session", "POST")).status).toBe(401);
    const { device, token } = auth.addDevice("phone");
    const s = await call("/api/auth/device/session", "POST", { headers: { authorization: `Bearer ${token}` } });
    expect(await s.json()).toMatchObject({ ok: true, device: { id: device.id, name: "phone" } });
    expect(s.headers.get("set-cookie")).toContain(`${SESSION_COOKIE}=`);
    expect(await (await call("/api/auth/devices", "GET", { headers: op })).json()).toMatchObject({ devices: [{ id: device.id, name: "phone" }] });
    const del = (id: string) => call("/api/auth/devices/:id", "DELETE", { params: { id }, headers: op });
    expect((await del("x")).status).toBe(400);
    expect((await del(String(device.id))).status).toBe(200);
    expect((await del(String(device.id))).status).toBe(404);
  });
});
