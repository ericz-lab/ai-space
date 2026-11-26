import { describe, expect, test } from "bun:test";
import { API_LEVEL, PRODUCT, createIdentityRoutes } from "./identity.ts";

describe("GET /api/space", () => {
  const id = "6f1c1b7e-3c39-4d55-9d1e-0c5c2a6b8f10";
  const routes = createIdentityRoutes({ version: "1.2.3", id, name: "mac", token: "op" });
  const get = (headers: Record<string, string> = {}) => routes["/api/space"].GET(new Request("http://x/api/space", { headers }));

  test("anyone learns what the service is, uncached", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ product: PRODUCT, api: API_LEVEL, version: "1.2.3", edition: "server", installation: "external" });
  });

  test("the operator also gets the Space's id and name; a wrong token does not", async () => {
    expect(await (await get({ authorization: "Bearer op" })).json()).toEqual({ product: PRODUCT, api: API_LEVEL, version: "1.2.3", edition: "server", installation: "external", id, name: "mac" });
    expect(await (await get({ authorization: "Bearer nope" })).json()).not.toHaveProperty("id");
  });

  test("the operator also gets this run's start and the whole running time; nobody else does", async () => {
    const withUptime = createIdentityRoutes({ version: "1.2.3", id, name: "mac", token: "op", uptime: () => ({ startedAt: "2026-10-01T00:00:00.000Z", totalMs: 5000, currentMs: 1000, firstStartedAt: "2026-09-01T00:00:00.000Z", restarts: 3 }) as { startedAt: string; totalMs: number } });
    const get = (headers: Record<string, string> = {}) => withUptime["/api/space"].GET(new Request("http://x/api/space", { headers }));
    expect((await (await get({ authorization: "Bearer op" })).json()).uptime).toEqual({ startedAt: "2026-10-01T00:00:00.000Z", totalMs: 5000 });
    expect(await (await get()).json()).not.toHaveProperty("uptime");
    // Before the run has started there is nothing to show, and no empty field.
    const early = createIdentityRoutes({ version: "1.2.3", id, name: "mac", token: "op", uptime: () => undefined });
    expect(await (await early["/api/space"].GET(new Request("http://x/api/space", { headers: { authorization: "Bearer op" } }))).json()).not.toHaveProperty("uptime");
  });
});
