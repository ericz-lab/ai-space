import { sameOrigin } from "../auth.ts";
import { bridge, wantsWebSocket } from "../terminal/api.ts";
import type { Bus } from "./bus.ts";
import type { PeerHub } from "../peers/hub.ts";

/** Keep credentials on the server and use the same provider precedence as file transcription. */
export function voiceTarget(bus: Pick<Bus, "capability">, remote: Pick<PeerHub, "providerOf"> | undefined, servicePort: (app: string) => number | undefined) {
  if (bus.capability("voice-studio", "transcribe")) {
    const port = servicePort("voice-studio");
    return port ? { url: `ws://127.0.0.1:${port}/api/asr/realtime`, headers: {} } : undefined;
  }
  const at = remote?.providerOf("voice-studio", "transcribe");
  if (!at || !("peer" in at)) return;
  return { url: `${at.peer.config.url.replace(/^http/, "ws")}/api/peer/apps/voice-studio/proxy/api/asr/realtime`, headers: at.peer.authHeaders() };
}

export function createVoiceRoutes(resolve: () => ReturnType<typeof voiceTarget>) {
  return {
    "/api/voice/realtime": {
      GET: (req: Request, server: Bun.Server<unknown>) => {
        if (!sameOrigin(req)) return Response.json({ error: "cross-origin request refused" }, { status: 403 });
        if (!wantsWebSocket(req)) return Response.json({ error: "websocket required" }, { status: 426 });
        const target = resolve();
        if (!target) return Response.json({ error: "no voice-studio transcriber available" }, { status: 503 });
        if (server.upgrade(req, { data: { attachment: bridge(target.url, target.headers, "voice-studio") } })) return;
        return Response.json({ error: "websocket upgrade failed" }, { status: 400 });
      },
    },
  };
}
