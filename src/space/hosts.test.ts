import { describe, expect, test } from "bun:test";
import type { Policy } from "./auth/gate.ts";
import { guardHosts, hostAllowed, hostName, hostRules } from "./hosts.ts";

const rules = hostRules({ panelHost: "space.example.com", domain: "apps.example.net", allowed: "box.tail1234.ts.net, *.lan.example.org" });

describe("hostAllowed", () => {
  test("IPs, localhost and requests without a Host pass", () => {
    for (const h of ["127.0.0.1:8700", "10.0.0.5", "[::1]:8700", "localhost:8700", "ai.space.localhost", null, ""]) expect(hostAllowed(h, rules)).toBe(true);
  });

  test("the panel host, the router's domain and its subdomains, and SPACE_ALLOWED_HOSTS pass", () => {
    for (const h of ["space.example.com", "SPACE.example.com.:443", "apps.example.net", "todo.apps.example.net", "box.tail1234.ts.net", "nas.lan.example.org"]) expect(hostAllowed(h, rules)).toBe(true);
  });

  test("any other name is refused, including look-alikes", () => {
    for (const h of ["evil.test:8700", "example.com", "space.example.com.evil.test", "evilapps.example.net", "lan.example.org", "localhost.evil.test"]) expect(hostAllowed(h, rules)).toBe(false);
  });

  test("hostName drops the port and keeps IPv6 brackets", () => {
    expect(hostName("Evil.Test:8700")).toBe("evil.test");
    expect(hostName("[::1]:8700")).toBe("[::1]");
  });
});

describe("guardHosts", () => {
  const ok = () => new Response("ok");
  const routes = { "/api/owner": { POST: ok }, "/api/fn": ok, "/healthz": ok, "/api/peer/snapshot": { GET: ok } };
  const policies = new Map<string, Policy>([["/healthz", "public"], ["/api/peer/snapshot", "self"]]);
  const guarded = guardHosts(routes, policies, { rules, hasCredential: async (req) => req.headers.get("authorization") === "Bearer good" });
  const call = (h: unknown, host: string, headers: Record<string, string> = {}) =>
    (h as (req: Request, server: unknown) => Promise<Response>)(new Request(`http://${host}/x`, { method: "POST", headers: { host, origin: `http://${host}`, ...headers } }), undefined);

  test("a rebinding page (its own name in Host and Origin, no credential) is refused", async () => {
    const r = await call(guarded["/api/owner"].POST, "evil.test:8700");
    expect(r.status).toBe(421);
    expect((await call(guarded["/api/fn"], "evil.test:8700")).status).toBe(421);
  });

  test("a known name passes", async () => {
    expect((await call(guarded["/api/owner"].POST, "127.0.0.1:8700")).status).toBe(200);
    expect((await call(guarded["/api/owner"].POST, "space.example.com")).status).toBe(200);
  });

  test("an unknown name with a credential this space issued passes (a hub, an app, a device)", async () => {
    expect((await call(guarded["/api/owner"].POST, "space-david.example.com", { authorization: "Bearer good" })).status).toBe(200);
    expect((await call(guarded["/api/owner"].POST, "space-david.example.com", { authorization: "Bearer junk" })).status).toBe(421);
  });

  test("public and self routes are not checked", async () => {
    expect(guarded["/healthz"]).toBe(ok);
    expect(guarded["/api/peer/snapshot"].GET).toBe(ok);
  });
});
