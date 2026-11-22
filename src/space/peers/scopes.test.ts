import { expect, test } from "bun:test";
import { PEER_ROUTES, PEER_SCOPES, parseScopes, peerRouteOf } from "./scopes.ts";
import { createPeerServeHandlers } from "./serve.ts";

/** Every optional part of the peer routes present, with handlers that are never called. */
function allRoutes() {
  const any = new Proxy({}, { get: (_t, path) => (typeof path === "string" ? { GET: () => new Response(), POST: () => new Response(), PATCH: () => new Response(), PUT: () => new Response(), DELETE: () => new Response() } : undefined) });
  return createPeerServeHandlers({
    name: "x", panel: any as never, agents: any as never, terminal: any as never, bus: { capabilities: () => [] } as never, events: {} as never,
    model: any as never, modelInfo: () => undefined, ledger: any as never, appModels: any as never, tasks: any as never, feedback: any as never,
  });
}

test("every /api/peer/* route the peer serves has exactly one scope, and the table names no route that does not exist", () => {
  const served = Object.entries(allRoutes()).flatMap(([path, entry]) => Object.keys(typeof entry === "function" ? { GET: entry } : entry).map((method) => `${method} ${path}`)).sort();
  const mapped = PEER_ROUTES.map((r) => `${r.method} ${r.path}`);
  expect(new Set(mapped).size).toBe(mapped.length);
  // A route added to serve.ts without a scope fails here (and is refused over a connection until it has one).
  expect(served).toEqual([...mapped].sort());
  for (const r of PEER_ROUTES) expect(PEER_SCOPES).toContain(r.scope);
});

test("a request path finds its route as Bun's router would, with its parameters", () => {
  expect(peerRouteOf("GET", "/api/peer/agents/runs")).toMatchObject({ path: "/api/peer/agents/runs", scope: "agents" });
  expect(peerRouteOf("GET", "/api/peer/agents/media/helper/runs")).toMatchObject({ path: "/api/peer/agents/:app/:agent/runs", params: { app: "media", agent: "helper" } });
  expect(peerRouteOf("GET", "/api/peer/tasks/models")).toMatchObject({ path: "/api/peer/tasks/models" });
  expect(peerRouteOf("GET", "/api/peer/apps/media/proxy/api/a/b")).toMatchObject({ path: "/api/peer/apps/:app/proxy/*", scope: "apps", params: { app: "media" } });
  expect(peerRouteOf("GET", "/api/peer/apps/media/proxy")).toBeUndefined();
  expect(peerRouteOf("DELETE", "/api/peer/apps/my%20app")).toMatchObject({ scope: "manage", params: { app: "my app" } });
  expect(peerRouteOf("GET", "/api/peer/apps/a%2Fb/icon")).toBeUndefined();
  expect(peerRouteOf("POST", "/api/peer/snapshot")).toBeUndefined();
  expect(peerRouteOf("GET", "/api/peers/x/snapshot")).toBeUndefined();
  expect(peerRouteOf("GET", "/api/peer//snapshot")).toBeUndefined();
});

test("scope lists are checked strictly and kept in the table's order", () => {
  expect(parseScopes(["terminal", "panel"])).toEqual(["panel", "terminal"]);
  expect(() => parseScopes(["panel", "panel"])).toThrow(/duplicate/);
  expect(() => parseScopes(["admin"])).toThrow(/unknown scope/);
  expect(() => parseScopes("panel")).toThrow(/list/);
});
