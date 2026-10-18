import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { isOperator } from "../auth.ts";
import { SESSION_COOKIE, composeRoutes, cookieValue, gateRoutes, parseAuthMode } from "./gate.ts";
import { AuthService } from "./service.ts";
import { AuthStore } from "./store.ts";

type H = (req: Request, server?: unknown) => Response | Promise<Response>;

async function setup(mode: "builtin" | "external" = "builtin") {
  const auth = new AuthService(new AuthStore(new Database(":memory:")), { hashCost: { memoryCost: 1024, timeCost: 1 } });
  await auth.init("correct horse");
  const r = await auth.login("correct horse", { client: "t" });
  if (!r.ok) throw new Error("login failed");
  const seen: Request[] = [];
  const ok: H = (req) => (seen.push(req), Response.json({ ok: true, operator: isOperator(req, "op") }));
  const { routes, policies } = composeRoutes(
    [
      ["owner", { "/api/panel/layout": { GET: ok, PUT: ok }, "/api/apps": { GET: ok, POST: ok } }],
      ["app", { "/api/model/run": { POST: ok }, "/healthz": ok }],
      ["self", { "/api/peer/snapshot": { GET: ok } }],
      ["public", { "/favicon.svg": new Response("svg") }],
    ],
    { "/healthz": "public", "/api/apps": "app-read" },
  );
  const gated = gateRoutes(routes, policies, { mode, auth, operatorToken: "op", isAppCredential: async (t) => t === "app-t" || t === "consumer-k" });
  const call = async (path: string, init: RequestInit = {}) => {
    const value = gated[path.split("?")[0]!] as H | Record<string, H>;
    const h = typeof value === "function" ? value : value[init.method ?? "GET"]!;
    return h(new Request(`http://127.0.0.1:8700${path}`, init));
  };
  return { call, token: r.token, seen, gated };
}

const cookie = (token: string) => ({ cookie: `other=1; ${SESSION_COOKIE}=${token}` });

describe("the gate under builtin", () => {
  test("no credential: 401 for a fetch, the sign-in page for a navigation", async () => {
    const { call } = await setup();
    const r = await call("/api/panel/layout");
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ auth: "signed-out" });
    const nav = await call("/api/panel/layout?x=1", { headers: { "sec-fetch-mode": "navigate" } });
    expect(nav.status).toBe(302);
    expect(nav.headers.get("location")).toBe("/?next=%2Fapi%2Fpanel%2Flayout%3Fx%3D1");
  });

  test("the owner's session passes and counts as the operator", async () => {
    const { call, token } = await setup();
    const r = await call("/api/panel/layout", { headers: cookie(token) });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, operator: true });
    expect((await call("/api/panel/layout", { headers: cookie("stale") })).status).toBe(401);
  });

  test("a forged bearer token is refused, even next to a valid session", async () => {
    const { call, token } = await setup();
    expect((await call("/api/panel/layout", { headers: { authorization: "Bearer forged" } })).status).toBe(401);
    expect((await call("/api/panel/layout", { headers: { authorization: "Bearer forged", ...cookie(token) } })).status).toBe(401);
  });

  test("the operator token passes everywhere", async () => {
    const { call } = await setup();
    expect((await call("/api/panel/layout", { method: "PUT", headers: { authorization: "Bearer op" } })).status).toBe(200);
  });

  test("an app token reaches app routes and reads, never an owner route", async () => {
    const { call } = await setup();
    const app = { authorization: "Bearer app-t" };
    expect((await call("/api/model/run", { method: "POST", headers: app })).status).toBe(200);
    expect((await call("/api/apps", { headers: app })).status).toBe(200);
    expect((await call("/api/apps", { method: "POST", headers: app })).status).toBe(401);
    expect((await call("/api/panel/layout", { headers: app })).status).toBe(401);
    const r = await call("/api/model/run", { method: "POST", headers: app });
    expect(await r.json()).toEqual({ ok: true, operator: false });
  });

  test("public and self-checking routes pass untouched", async () => {
    const { call, gated } = await setup();
    expect((await call("/healthz")).status).toBe(200);
    expect((await call("/api/peer/snapshot")).status).toBe(200);
    expect(gated["/favicon.svg"]).toBeInstanceOf(Response);
  });

  test("a static response on a guarded route is refused when the table is built", async () => {
    const auth = new AuthService(new AuthStore(new Database(":memory:")));
    const { routes, policies } = composeRoutes([["owner", { "/secret": new Response("x") }]]);
    expect(() => gateRoutes(routes, policies, { mode: "builtin", auth, operatorToken: "op", isAppCredential: async () => false })).toThrow(/public policy/);
  });

  test("external leaves every route as it was", async () => {
    const { call } = await setup("external");
    expect((await call("/api/panel/layout")).status).toBe(200);
  });
});

describe("composition and parsing", () => {
  test("a later table wins a key, with its policy", () => {
    const a = () => new Response("a");
    const b = () => new Response("b");
    const { routes, policies } = composeRoutes([["app", { "/x": a }], ["owner", { "/x": b }]]);
    expect(routes["/x"]).toBe(b);
    expect(policies.get("/x")).toBe("owner");
  });

  test("SPACE_AUTH and cookies", () => {
    expect(parseAuthMode(undefined)).toBe("external");
    expect(parseAuthMode(" Builtin ")).toBe("builtin");
    expect(() => parseAuthMode("cloudflare")).toThrow(/SPACE_AUTH/);
    const req = new Request("http://x/", { headers: { cookie: "a=1; space_session=abc%3D; b=2" } });
    expect(cookieValue(req, "space_session")).toBe("abc=");
    expect(cookieValue(req, "missing")).toBe("");
  });
});
