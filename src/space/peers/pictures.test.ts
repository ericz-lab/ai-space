import { describe, expect, test } from "bun:test";
import { createPeerRoutes } from "./api.ts";
import type { PeerHub } from "./hub.ts";
import type { LayoutStore } from "../panel/layout.ts";
import type { AppRegistry } from "../panel/registry.ts";

const PNG = new Uint8Array(4096).map((_, i) => i % 251);

/** A body that sends half of the picture, then fails, as a link dropping mid-transfer does. */
function cutShort(): Response {
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (!sent) { sent = true; c.enqueue(PNG.slice(0, 2048)); return; }
      c.error(new Error("connection reset"));
    },
  });
  return new Response(body, { headers: { "content-type": "image/png" } });
}

function routesAnswering(answer: (path: string) => Response) {
  const seen: string[] = [];
  const hub = { get: (name: string) => (name === "box" ? { name: "box", forward: async (_req: Request, path: string) => (seen.push(path), answer(path)) } : undefined) } as unknown as PeerHub;
  return { seen, routes: createPeerRoutes({ hub, layout: {} as LayoutStore, registry: {} as AppRegistry }) };
}

async function get(routes: ReturnType<typeof createPeerRoutes>, key: string, params: Record<string, string>, path: string) {
  const handler = (routes[key] as Record<string, (req: unknown, server: unknown) => Promise<Response>>).GET!;
  return handler(Object.assign(new Request(`http://hub${path}`), { params }), undefined);
}

const ICON = "/api/peers/:peer/apps/:app/icon";
const AVATAR = "/api/peers/:peer/agents/:app/:agent/avatar";

describe("a peer's icons and avatars arrive whole or not at all", () => {
  test("a whole picture is relayed with its length", async () => {
    const { routes, seen } = routesAnswering(() => new Response(PNG, { headers: { "content-type": "image/png" } }));
    const res = await get(routes, ICON, { peer: "box", app: "ai-draw" }, "/api/peers/box/apps/ai-draw/icon?v=2");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-length")).toBe(String(PNG.byteLength));
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    expect(seen).toEqual(["/api/peer/apps/ai-draw/icon?v=2"]);
  });

  test("a picture the link cuts short is a 502, not a shorter 200", async () => {
    const { routes } = routesAnswering(cutShort);
    for (const [key, params, path] of [
      [ICON, { peer: "box", app: "ai-draw" }, "/api/peers/box/apps/ai-draw/icon"],
      [AVATAR, { peer: "box", app: "ai-draw", agent: "painter" }, "/api/peers/box/agents/ai-draw/painter/avatar"],
    ] as const) {
      const res = await get(routes, key, params, path);
      expect(res.status).toBe(502);
      expect((await res.json()).error).toContain("connection reset");
    }
  });

  test("fewer bytes than the peer declared is a 502", async () => {
    const { routes } = routesAnswering(() => new Response(PNG.slice(0, 100), { headers: { "content-type": "image/png", "content-length": "4096" } }));
    const res = await get(routes, ICON, { peer: "box", app: "ai-draw" }, "/api/peers/box/apps/ai-draw/icon");
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("cut short");
  });

  test("the peer's own errors and an unknown peer keep their status", async () => {
    const { routes } = routesAnswering(() => Response.json({ ok: false, error: "no icon" }, { status: 404 }));
    expect((await get(routes, ICON, { peer: "box", app: "x" }, "/api/peers/box/apps/x/icon")).status).toBe(404);
    expect((await get(routes, ICON, { peer: "nobody", app: "x" }, "/api/peers/nobody/apps/x/icon")).status).toBe(404);
  });
});
