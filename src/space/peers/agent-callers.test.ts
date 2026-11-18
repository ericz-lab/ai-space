import { describe, expect, test } from "bun:test";
import { createPeerRoutes } from "./api.ts";
import type { PeerHub } from "./hub.ts";
import type { LayoutStore } from "../panel/layout.ts";
import type { AppRegistry } from "../panel/registry.ts";

// A hub with one peer whose forwarder answers the path it was given.
const hub = { get: (name: string) => (name === "box" ? { name: "box", forward: async (_req: Request, path: string) => new Response(path) } : undefined) } as unknown as PeerHub;
const tokens: Record<string, string | null> = { owner: null, hq: "agent-hq", other: "other-app", stranger: "" };
const routes = createPeerRoutes({
  hub,
  layout: {} as LayoutStore,
  registry: {} as AppRegistry,
  callerApp: async (req) => tokens[(req.headers.get("authorization") ?? "").replace("Bearer ", "")] ?? null,
  agentCallers: ["agent-hq"],
});

async function call(key: string, method: "GET" | "POST", params: Record<string, string>, path: string, token: string) {
  const handler = (routes[key] as Record<string, (req: unknown, server: unknown) => Promise<Response>>)[method]!;
  const req = Object.assign(new Request(`http://hub${path}`, { method, headers: { authorization: `Bearer ${token}` } }), { params });
  return handler(req, undefined);
}

describe("peer agent routes and SPACE_AGENT_CALLERS", () => {
  const chat = "/api/peers/:peer/agents/:app/:agent/chat";
  const params = { peer: "box", app: "ai-design", agent: "designer" };
  const path = "/api/peers/box/agents/ai-design/designer/chat";

  test("the owner and a listed app reach a peer's agent", async () => {
    for (const token of ["owner", "hq"]) {
      const res = await call(chat, "POST", params, path, token);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("/api/peer/agents/ai-design/designer/chat");
    }
  });

  test("an unlisted app or another credential is refused before the peer is called", async () => {
    for (const token of ["other", "stranger"]) expect((await call(chat, "POST", params, path, token)).status).toBe(403);
  });

  test("a listed app never reaches a peer's Space Assistant", async () => {
    const res = await call(chat, "POST", { peer: "box", app: "space", agent: "assistant" }, "/api/peers/box/agents/space/assistant/chat", "hq");
    expect(res.status).toBe(403);
  });

  test("runs and their events follow the same rule", async () => {
    const runParams = { ...params, id: "r1" };
    expect((await call("/api/peers/:peer/agents/:app/:agent/runs/:id/events", "GET", runParams, "/api/peers/box/agents/ai-design/designer/runs/r1/events", "hq")).status).toBe(200);
    expect((await call("/api/peers/:peer/agents/:app/:agent/runs/:id", "GET", runParams, "/api/peers/box/agents/ai-design/designer/runs/r1", "other")).status).toBe(403);
  });
});
