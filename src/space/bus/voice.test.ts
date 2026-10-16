import { expect, test } from "bun:test";
import { createVoiceRoutes, voiceTarget } from "./voice.ts";
import { terminalWebSocket } from "../terminal/api.ts";

test("realtime route rejects other origins and missing providers", async () => {
  const server = Bun.serve({ port: 0, routes: createVoiceRoutes(() => undefined), websocket: terminalWebSocket });
  try {
    expect((await fetch(new URL("/api/voice/realtime", server.url), { headers: { origin: "https://other.example", upgrade: "websocket" } })).status).toBe(403);
    expect((await fetch(new URL("/api/voice/realtime", server.url))).status).toBe(426);
    expect((await fetch(new URL("/api/voice/realtime", server.url), { headers: { upgrade: "websocket" } })).status).toBe(503);
  } finally { server.stop(true); }
});

test("realtime bridge carries binary audio and final transcript messages", async () => {
  const upstream = Bun.serve({
    port: 0,
    fetch(req, server) { if (server.upgrade(req)) return; return new Response(null, { status: 400 }); },
    websocket: { message(ws, data) { ws.send(typeof data === "string" ? data : JSON.stringify({ type: "final", segment_id: 0, text: `heard ${data.byteLength} bytes` })); } },
  });
  const server = Bun.serve({ port: 0, routes: createVoiceRoutes(() => ({ url: `ws://127.0.0.1:${upstream.port}/api/asr/realtime`, headers: {} })), websocket: terminalWebSocket });
  let ws: WebSocket | undefined;
  try {
    const result = await new Promise<string>((resolve, reject) => {
      ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/voice/realtime`);
      ws.onopen = () => ws!.send(new Uint8Array([0, 1, 2, 3]));
      ws.onmessage = (event) => resolve(event.data);
      ws.onerror = reject;
    });
    expect(JSON.parse(result)).toEqual({ type: "final", segment_id: 0, text: "heard 4 bytes" });
  } finally { ws?.close(); server.stop(true); upstream.stop(true); }
});

test("provider selection prefers local and declines ambiguous peers", () => {
  const local = { capability: () => ({}) } as unknown as Parameters<typeof voiceTarget>[0];
  const absent = { capability: () => undefined } as Parameters<typeof voiceTarget>[0];
  expect(voiceTarget(local, undefined, () => 1234)?.url).toBe("ws://127.0.0.1:1234/api/asr/realtime");
  expect(voiceTarget(local, undefined, () => undefined)).toBeUndefined();
  expect(voiceTarget(absent, { providerOf: () => ({ ambiguous: ["a", "b"] }) }, () => 1234)).toBeUndefined();
  const remote = { providerOf: () => ({ peer: { config: { url: "https://peer.example" }, authHeaders: () => ({ authorization: "Bearer test" }) } }) } as unknown as Parameters<typeof voiceTarget>[1];
  expect(voiceTarget(absent, remote, () => undefined)).toEqual({ url: "wss://peer.example/api/peer/apps/voice-studio/proxy/api/asr/realtime", headers: { authorization: "Bearer test" } });
});
