import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { guardBrowserWrites } from "../auth.ts";
import { createUsageRoutes } from "./api.ts";
import { UsageService } from "./service.ts";
import { UsageStore } from "./store.ts";

type Handler = (req: Request, server?: unknown) => Response | Promise<Response>;

function setup() {
  const usage = new UsageService(new UsageStore(new Database(":memory:")));
  // As the entry point serves them: every write behind the same-origin guard.
  const routes = guardBrowserWrites(createUsageRoutes({ service: usage, knownApp: (app) => app === "ai-todo" })) as Record<string, Record<string, Handler>>;
  const call = async (method: string, path: string, init: { body?: string; headers?: Record<string, string> } = {}) => {
    const url = new URL(path, "http://todo.example.com");
    const res = await routes[url.pathname]![method]!(new Request(url, { method, body: init.body, headers: { host: "todo.example.com", ...init.headers } }));
    return { status: res.status, text: await res.text(), type: res.headers.get("content-type") };
  };
  return { usage, call };
}

describe("usage routes", () => {
  test("an open from the panel's own page is recorded; another site's is refused", async () => {
    const { call } = setup();
    const body = JSON.stringify({ kind: "app", key: "ai-todo", source: "panel" });
    expect((await call("POST", "/api/panel/usage/open", { body, headers: { origin: "http://todo.example.com", "content-type": "text/plain" } })).status).toBe(204);
    expect((await call("POST", "/api/panel/usage/open", { body, headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await call("POST", "/api/panel/usage/open", { body: "{", headers: { origin: "http://todo.example.com" } })).status).toBe(400);
    const read = JSON.parse((await call("GET", "/api/usage?window=7d")).text);
    expect(read.usage).toMatchObject([{ kind: "app", key: "ai-todo", opens: 1 }]);
  });

  test("a beat needs the router's X-Space-App for a known app, and the same origin", async () => {
    const { call, usage } = setup();
    const body = JSON.stringify({ tab: "tab-aaaa1" });
    const origin = { origin: "http://todo.example.com" };
    expect((await call("POST", "/_space/usage/beat", { body, headers: origin })).status).toBe(400);
    expect((await call("POST", "/_space/usage/beat", { body, headers: { ...origin, "x-space-app": "nope" } })).status).toBe(404);
    expect((await call("POST", "/_space/usage/beat", { body, headers: { origin: "https://evil.example", "x-space-app": "ai-todo" } })).status).toBe(403);
    expect((await call("POST", "/_space/usage/beat", { body: JSON.stringify({ tab: 1 }), headers: { ...origin, "x-space-app": "ai-todo" } })).status).toBe(400);
    expect((await call("POST", "/_space/usage/beat", { body, headers: { ...origin, "x-space-app": "ai-todo" } })).status).toBe(204);
    expect(usage.report("all")).toMatchObject([{ kind: "app", key: "ai-todo", sessions: 1, activeMs: 0 }]);
  });

  test("the script is served as JavaScript; bad query values are refused", async () => {
    const { call } = setup();
    const js = await call("GET", "/_space/usage.js");
    expect(js.type).toContain("javascript");
    expect(js.text).toContain("/_space/usage/beat");
    expect((await call("GET", "/api/usage?window=1y")).status).toBe(400);
    expect((await call("GET", "/api/usage?kind=widget")).status).toBe(400);
    expect(JSON.parse((await call("GET", "/api/usage")).text)).toEqual({ ok: true, window: "30d", usage: [] });
  });
});
