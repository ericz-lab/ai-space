import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { isOperator } from "../auth.ts";
import { createAuthRoutes } from "./api.ts";
import { SESSION_COOKIE, composeRoutes, gateRoutes } from "./gate.ts";
import { AuthService } from "./service.ts";
import { AuthStore } from "./store.ts";

// Device credentials: the Local edition's Mac app holds one instead of the owner's password.

type H = (req: Request) => Response | Promise<Response>;

function setup() {
  let now = 1_000_000;
  const auth = new AuthService(new AuthStore(new Database(":memory:")), { now: () => now });
  const ok: H = (req) => Response.json({ ok: true, operator: isOperator(req, "op") });
  const routes = createAuthRoutes({ mode: "builtin", auth });
  const composed = composeRoutes([["owner", { "/api/panel/layout": { GET: ok } }], ["owner", routes]], { "/api/auth/device/session": "self" });
  const gated = gateRoutes(composed.routes, composed.policies, { mode: "builtin", auth, operatorToken: "op", isAppCredential: async () => false });
  const call = (path: string, method = "GET", headers: Record<string, string> = {}) => {
    const key = path.replace(/\/devices\/\d+$/, "/devices/:id");
    const v = gated[key] as Record<string, (r: Request) => Response | Promise<Response>>;
    const req = Object.assign(new Request(`http://127.0.0.1:8700${path}`, { method, headers }), { params: { id: path.split("/").pop()! } });
    return v[method]!(req);
  };
  return { auth, call, tick: (ms: number) => (now += ms) };
}

test("a device token is the owner, works with no password set, and is stored only as a hash", async () => {
  const { auth, call } = setup();
  expect(auth.initialized()).toBe(false);
  const { device, token } = auth.addDevice("This Mac");
  expect(token.startsWith("spd_")).toBe(true);
  expect(JSON.stringify(auth.store.db.query("SELECT * FROM auth_devices").all())).not.toContain(token);
  const r = await call("/api/panel/layout", "GET", { authorization: `Bearer ${token}` });
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ ok: true, operator: true });
  expect(auth.devices()).toMatchObject([{ id: device.id, name: "This Mac" }]);
  expect(auth.devices()[0]!.lastSeenAt).not.toBeNull();
});

test("a wrong or revoked device token is refused", async () => {
  const { auth, call } = setup();
  const { device, token } = auth.addDevice("mac");
  expect((await call("/api/panel/layout", "GET", { authorization: "Bearer spd_wrong" })).status).toBe(401);
  expect(auth.revokeDevice(device.id)).toBe(true);
  expect((await call("/api/panel/layout", "GET", { authorization: `Bearer ${token}` })).status).toBe(401);
  expect(auth.revokeDevice(device.id)).toBe(false);
});

test("a device opens a browser session for its web view; the session then passes alone", async () => {
  const { auth, call } = setup();
  const { token } = auth.addDevice("mac");
  expect((await call("/api/auth/device/session", "POST")).status).toBe(401);
  const r = await call("/api/auth/device/session", "POST", { authorization: `Bearer ${token}`, "user-agent": "AISpace/0.1" });
  expect(r.status).toBe(200);
  const set = r.headers.get("set-cookie")!;
  expect(set).toContain(`${SESSION_COOKIE}=`);
  expect(set).toContain("HttpOnly");
  const value = set.split(";")[0]!.split("=")[1]!;
  expect((await call("/api/panel/layout", "GET", { cookie: `${SESSION_COOKIE}=${value}` })).status).toBe(200);
  expect(auth.sessions()[0]!.userAgent).toBe("device mac: AISpace/0.1");
});

test("the owner lists and revokes devices over the API", async () => {
  const { auth, call } = setup();
  const a = auth.addDevice("a");
  auth.addDevice("b");
  const list = (await (await call("/api/auth/devices", "GET", { authorization: `Bearer ${a.token}` })).json()) as { devices: { name: string }[] };
  expect(list.devices.map((d) => d.name)).toEqual(["a", "b"]);
  expect((await call(`/api/auth/devices/${a.device.id}`, "DELETE", { authorization: "Bearer op" })).status).toBe(200);
  expect(auth.devices().map((d) => d.name)).toEqual(["b"]);
});
