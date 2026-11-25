import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Bus, BusStore, capabilityCaller, type RemoteBus } from "../bus/index.ts";
import { Store } from "../scheduler/store.ts";
import { terminalWebSocket } from "../terminal/api.ts";
import { createSpeechRoutes } from "./api.ts";
import { builtinSpeech, parseProvidersYaml } from "./config.ts";
import { SpeechService, buildAdapters } from "./service.ts";
import { wav } from "./testing.ts";
import { SpeechStore } from "./store.ts";
import type { SpeechConfig } from "./types.ts";
import type { StudioPeer } from "./voice-studio.ts";

/**
 * The speech routes over a real bus and a stand-in voice-studio app: the panel's voice input as it was
 * (here, through one peer, nowhere), app tokens, voices, and live dictation end to end.
 */

type Seen = { path: string; caller: string | null; body?: string };
const seen: Seen[] = [];
let gpu: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  gpu = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    routes: {
      "/api/asr": {
        POST: async (req) => {
          const form = await req.formData();
          seen.push({ path: "/api/asr", caller: req.headers.get("x-space-caller"), body: `${form.get("language") ?? ""}|${form.get("context") ?? ""}` });
          return Response.json({ text: `heard ${await (form.get("file") as File).text()}`, language: "zh", segments: [{ start: 0, end: 1.5, text: "heard" }], elapsed: 0.2 });
        },
      },
      "/api/tts": {
        POST: async (req) => {
          seen.push({ path: "/api/tts", caller: req.headers.get("x-space-caller"), body: await req.text() });
          return new Response(wav(0.25), { headers: { "content-type": "audio/wav" } });
        },
      },
      "/api/voices": { GET: () => Response.json({ voices: ["en-Frank_man", "zh-Xinran_woman"], ready: true }) },
    },
    fetch(req, server) {
      if (new URL(req.url).pathname === "/api/asr/realtime" && server.upgrade(req, { data: undefined })) return;
      return new Response("not found", { status: 404 });
    },
    websocket: {
      message(ws, m) {
        if (typeof m !== "string") return void ws.send(JSON.stringify({ type: "partial", segment_id: 0, text: `got ${m.byteLength}`, language: "zh" }));
        const msg = JSON.parse(m) as { type: string; language?: string };
        if (msg.type === "start") {
          seen.push({ path: "/api/asr/realtime", caller: null, body: msg.language ?? "" });
          ws.send(JSON.stringify({ type: "loading" }));
          ws.send(JSON.stringify({ type: "ready", sample_rate: 16000, max_seconds: 2700, max_frame_bytes: 3200 }));
        } else if (msg.type === "stop") {
          ws.send(JSON.stringify({ type: "final", segment_id: 0, text: "你好世界", language: "zh" }));
          ws.send(JSON.stringify({ type: "done" }));
          ws.close(1000, "done");
        }
      },
    },
  });
});
// Not awaited: on Bun 1.3, stop() after a server-closed WebSocket session never settles, and the hook times out.
afterAll(() => {
  gpu.stop(true);
});

/** A peer that provides voice-studio and answers its calls itself. */
function peer(name: string, url = "https://peer.invalid"): StudioPeer & { forwarded: Seen[] } {
  const forwarded: Seen[] = [];
  return {
    name,
    config: { url },
    forwarded,
    knownDown: () => false,
    health: () => "ok",
    provides: (app) => app === "voice-studio",
    authHeaders: () => ({ authorization: "Bearer peer-token" }),
    snapshot: { asOf: new Date().toISOString() },
    async forward(req, path, o) {
      forwarded.push({ path, caller: o?.headers?.["x-space-caller"] ?? null });
      if (path.endsWith("/proxy/api/voices")) return Response.json({ voices: ["far-voice"] });
      await req.arrayBuffer();
      return Response.json({ text: "from the peer", language: "en", segments: [] });
    },
  };
}

function space(opts: { at: "local" | "peer" | "none"; config?: SpeechConfig; peers?: Record<string, StudioPeer>; localOnly?: string[] }) {
  const busStore = new BusStore(":memory:");
  const bus = new Bus({ store: busStore, events: new Store(":memory:"), servicePort: (app) => (app === "voice-studio" && opts.at === "local" ? gpu.port : undefined), log: () => {} });
  if (opts.at === "local") {
    bus.syncApp("voice-studio", {
      events: { publishes: [], consumes: [] },
      provides: [{ name: "transcribe", method: "POST", path: "/api/asr", timeoutMs: 5000 }, { name: "speak", method: "POST", path: "/api/tts", timeoutMs: 5000 }],
    });
  }
  const peers = opts.peers ?? (opts.at === "peer" ? { "gpu-box": peer("gpu-box") } : {});
  const remote: RemoteBus = {
    name: "hub",
    capabilities: () => [],
    providerOf: (app) => {
      const found = Object.values(peers).filter((p) => p.provides(app));
      return found.length === 1 ? { peer: found[0]! as never } : found.length ? { ambiguous: found.map((p) => p.name) } : undefined;
    },
    get: (n) => peers[n] as never,
  };
  const calls = capabilityCaller({ bus, store: busStore, remote });
  const config = opts.config ?? builtinSpeech();
  const store = new SpeechStore(":memory:");
  const service = new SpeechService({
    config,
    store,
    log: () => {},
    localOnly: (app) => (opts.localOnly ?? []).includes(app),
    adapters: buildAdapters(config, {
      voiceStudio: {
        hasLocal: (app, cap) => Boolean(bus.capability(app, cap)),
        servicePort: (app) => (app === "voice-studio" && opts.at === "local" ? gpu.port : undefined),
        callLocal: calls.callLocal,
        callRemote: (req, caller, p, app, cap) => calls.callRemote(req, caller, p as never, app, cap),
        peers: { get: (n) => peers[n], providerOf: (app, cap) => remote.providerOf(app, cap) as never },
      },
    }),
  });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    routes: createSpeechRoutes({ service, token: "op", appForToken: async (t) => (t === "notes-token" ? "notes" : undefined) }) as never,
    websocket: terminalWebSocket,
  });
  return { url: `http://127.0.0.1:${server.port}`, ws: `ws://127.0.0.1:${server.port}`, busStore, store, service, peers, stop: () => server.stop(true) };
}

const audio = (text = "hello", extra: Record<string, string> = {}) => {
  const form = new FormData();
  form.append("file", new File([text], "voice.webm", { type: "audio/webm" }));
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return form;
};

describe("the panel's voice input, through the speech layer", () => {
  test("transcribes without a token through the local voice-studio, as the operator, and keeps both records", async () => {
    const s = space({ at: "local" });
    try {
      expect(await fetch(`${s.url}/api/voice`).then((r) => r.json())).toEqual({ ok: true, transcribe: true });
      const r = await fetch(`${s.url}/api/voice/transcribe`, { method: "POST", body: audio("hello", { language: "zh", context: "AI Space" }) });
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ ok: true, text: "heard hello", language: "zh", segments: [{ start: 0, end: 1.5, text: "heard" }], provider: "voice-studio" });
      expect(seen.at(-1)).toEqual({ path: "/api/asr", caller: "space", body: "zh|AI Space" });
      // The bus keeps its row, as before; the speech ledger adds its own.
      expect(s.busStore.listCalls({}).map((c) => [c.caller, c.app, c.capability, c.status])).toEqual([["space", "voice-studio", "transcribe", 200]]);
      expect(s.store.recent()[0]).toMatchObject({ app: "space", tag: "voice-input", capability: "transcribe", provider: "voice-studio", kind: "voice-studio", status: "ok", audioSeconds: 1.5, chars: 11, inputBytes: 5 });
    } finally {
      s.stop();
    }
  });

  test("a locale tag reaches the provider as its primary language code", async () => {
    const s = space({ at: "local" });
    try {
      const r = await fetch(`${s.url}/api/voice/transcribe`, { method: "POST", body: audio("hello", { language: "zh-Hans" }) });
      expect(r.status).toBe(200);
      expect(seen.at(-1)).toEqual({ path: "/api/asr", caller: "space", body: "zh|" });
      await session(`${s.ws}/api/voice/realtime`, dictate("en-US"));
      expect(seen.filter((x) => x.path === "/api/asr/realtime").at(-1)?.body).toBe("en");
      // Empty stays empty: the provider detects the language.
      await session(`${s.ws}/api/voice/realtime`, dictate(""));
      expect(seen.filter((x) => x.path === "/api/asr/realtime").at(-1)?.body).toBe("");
    } finally {
      s.stop();
    }
  });

  test("a voice-studio on one peer is reached through it; none at all answers 503", async () => {
    const p = space({ at: "peer" });
    const n = space({ at: "none" });
    try {
      expect(await fetch(`${p.url}/api/voice`).then((r) => r.json())).toEqual({ ok: true, transcribe: true });
      const r = await fetch(`${p.url}/api/speech/transcribe`, { method: "POST", body: audio() });
      expect(await r.json()).toMatchObject({ ok: true, text: "from the peer", language: "en", segments: [] });
      expect((p.peers["gpu-box"] as ReturnType<typeof peer>).forwarded).toEqual([{ path: "/api/peer/call/voice-studio/transcribe", caller: "hub/space" }]);
      expect(p.busStore.listCalls({}).map((c) => [c.caller, c.app])).toEqual([["space", "gpu-box/voice-studio"]]);
      expect(p.store.recent()[0]).toMatchObject({ provider: "voice-studio", machine: "gpu-box", tag: "other" });

      expect(await fetch(`${n.url}/api/voice`).then((r) => r.json())).toEqual({ ok: true, transcribe: false });
      const none = await fetch(`${n.url}/api/voice/transcribe`, { method: "POST", body: audio() });
      expect(none.status).toBe(502);
      expect(await none.json()).toMatchObject({ ok: false, error: "voice-studio: no voice-studio/transcribe on this space or its peers" });
    } finally {
      p.stop();
      n.stop();
    }
  });

  test("two peers with voice-studio and no machine named is refused, not guessed", async () => {
    const s = space({ at: "none", peers: { a: peer("a"), b: peer("b") } });
    try {
      const r = await fetch(`${s.url}/api/speech/transcribe`, { method: "POST", body: audio() });
      expect((await r.json()).error).toBe("voice-studio: voice-studio/transcribe is on several peers (a, b); name one with machine: in providers.yaml");
      // machine: picks one.
      const { config } = parseProvidersYaml("speech:\n  providers:\n    gpu: { kind: voice-studio, machine: b }\n", {});
      const named = space({ at: "none", peers: { a: peer("a"), b: peer("b") }, config });
      try {
        expect((await fetch(`${named.url}/api/speech/transcribe`, { method: "POST", body: audio() })).status).toBe(200);
        expect((named.peers.b as ReturnType<typeof peer>).forwarded).toHaveLength(1);
      } finally {
        named.stop();
      }
    } finally {
      s.stop();
    }
  });
});

describe("the speech routes", () => {
  test("an app calls with its own token; a token that names nobody is a 401; bad requests leave no row", async () => {
    const s = space({ at: "local" });
    try {
      const r = await fetch(`${s.url}/api/speech/transcribe`, { method: "POST", headers: { authorization: "Bearer notes-token" }, body: audio("hi", { tag: "dictation" }) });
      expect(r.status).toBe(200);
      expect(seen.at(-1)?.caller).toBe("notes");
      expect(s.store.recent()[0]).toMatchObject({ app: "notes", tag: "dictation" });
      expect((await fetch(`${s.url}/api/speech/transcribe`, { method: "POST", headers: { authorization: "Bearer wrong" }, body: audio() })).status).toBe(401);
      expect((await fetch(`${s.url}/api/speech/transcribe`, { method: "POST", body: new FormData() })).status).toBe(400);
      expect((await fetch(`${s.url}/api/speech/transcribe`, { method: "POST", body: audio("x", { context: "y".repeat(301) }) })).status).toBe(400);
      expect((await fetch(`${s.url}/api/speech/transcribe`, { method: "POST", body: audio("x", { language: "zh; rm" }) })).status).toBe(400);
      expect(s.store.recent()).toHaveLength(1);
    } finally {
      s.stop();
    }
  });

  test("speak checks the voice against voice-studio's list before the GPU is asked", async () => {
    const s = space({ at: "local" });
    try {
      const r = await fetch(`${s.url}/api/speech/speak`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "你好", voice: "zh-Xinran_woman" }) });
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("audio/wav");
      expect(r.headers.get("x-speech-provider")).toBe("voice-studio");
      expect(decodeURIComponent(r.headers.get("x-speech-voice")!)).toBe("zh-Xinran_woman");
      expect((await r.arrayBuffer()).byteLength).toBe(44 + 8000);
      expect(JSON.parse(seen.at(-1)!.body!)).toEqual({ text: "你好", voices: ["zh-Xinran_woman"] });
      expect(s.store.recent()[0]).toMatchObject({ capability: "speak", chars: 2, audioSeconds: 0.25, voice: "zh-Xinran_woman" });

      const before = seen.length;
      const bad = await fetch(`${s.url}/api/speech/speak`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi", voice: "Somebody" }) });
      expect(bad.status).toBe(400);
      expect((await bad.json()).error).toBe("voice-studio has no voice Somebody (voices: en-Frank_man, zh-Xinran_woman)");
      expect(seen.length).toBe(before);

      expect(await fetch(`${s.url}/api/speech/voices`).then((x) => x.json())).toEqual({ ok: true, providers: [{ provider: "voice-studio", voices: ["en-Frank_man", "zh-Xinran_woman"] }], mapped: {} });
      expect((await fetch(`${s.url}/api/speech/speak`, { method: "POST", body: JSON.stringify({ text: "" }) })).status).toBe(400);
      expect((await fetch(`${s.url}/api/speech/speak`, { method: "POST", body: JSON.stringify({ text: "x", voice: "a", voices: ["b"] }) })).status).toBe(400);
    } finally {
      s.stop();
    }
  });

  test("a peer's voices are read through its app proxy", async () => {
    const s = space({ at: "peer" });
    try {
      expect(await fetch(`${s.url}/api/speech/voices`).then((x) => x.json())).toMatchObject({ providers: [{ provider: "voice-studio", voices: ["far-voice"] }] });
      expect((s.peers["gpu-box"] as ReturnType<typeof peer>).forwarded.at(-1)?.path).toBe("/api/peer/apps/voice-studio/proxy/api/voices");
    } finally {
      s.stop();
    }
  });

  test("status, calls and usage read the ledger and the cells", async () => {
    const s = space({ at: "local" });
    try {
      await fetch(`${s.url}/api/speech/transcribe`, { method: "POST", body: audio() });
      const status = await fetch(`${s.url}/api/speech`).then((x) => x.json());
      expect(status).toMatchObject({ ok: true, configured: true, source: "builtin", default: { asr: "voice-studio" }, usage24h: { calls: 1, audioSeconds: 1.5 } });
      expect(status.providers).toEqual([expect.objectContaining({ provider: "voice-studio", kind: "voice-studio", capabilities: ["transcribe", "live", "speak"], selfHosted: true, where: "", reachable: true, used: true, roles: ["asr", "tts", "live"], lastOkAt: expect.any(String) })]);
      expect((await fetch(`${s.url}/api/speech/calls?limit=5`).then((x) => x.json())).calls).toHaveLength(1);
      expect(await fetch(`${s.url}/api/speech/usage?window=7d`).then((x) => x.json())).toMatchObject({ ok: true, window: "7d", totals: { calls: 1 } });
      expect((await fetch(`${s.url}/api/speech/usage?window=1y`)).status).toBe(400);
    } finally {
      s.stop();
    }
  });
});

/** Open a live session and collect its events until the socket closes. */
async function session(url: string, frames: (ws: WebSocket, events: Record<string, unknown>[]) => void): Promise<{ events: Record<string, unknown>[]; code: number }> {
  const events: Record<string, unknown>[] = [];
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    ws.onmessage = (e) => {
      events.push(JSON.parse(e.data as string));
      frames(ws, events);
    };
    ws.onopen = () => frames(ws, events);
    ws.onclose = (e) => resolve({ events, code: e.code });
    ws.onerror = () => reject(new Error("socket error"));
    setTimeout(() => reject(new Error(`timed out: ${JSON.stringify(events)}`)), 5000);
  });
}

/** The client's side of the protocol: start, wait for ready, one frame, stop. */
const dictate = (language = "zh", extra: Record<string, unknown> = {}) => (ws: WebSocket, events: Record<string, unknown>[]) => {
  const last = events.at(-1);
  if (!last) ws.send(JSON.stringify({ type: "start", format: "pcm_s16le", sample_rate: 16000, channels: 1, language, ...extra }));
  else if (last.type === "ready") {
    ws.send(new Uint8Array(3200));
    ws.send(new Uint8Array(1600));
  } else if (last.type === "partial" && last.text === "got 1600") ws.send(JSON.stringify({ type: "stop" }));
};

describe("live dictation", () => {
  test("refuses other origins, plain requests and a space with no provider", async () => {
    const n = space({ at: "none" });
    try {
      expect((await fetch(`${n.url}/api/speech/live`, { headers: { origin: "https://other.example", upgrade: "websocket" } })).status).toBe(403);
      expect((await fetch(`${n.url}/api/voice/realtime`)).status).toBe(426);
      const none = await fetch(`${n.url}/api/voice/realtime`, { headers: { upgrade: "websocket" } });
      expect(none.status).toBe(503);
      expect((await none.json()).error).toContain("no live provider can be reached");
    } finally {
      n.stop();
    }
  });

  test("a session runs end to end through the local voice-studio, and is one ledger row", async () => {
    const s = space({ at: "local" });
    try {
      const { events, code } = await session(`${s.ws}/api/voice/realtime`, dictate());
      expect(events.map((e) => e.type)).toEqual(["loading", "ready", "partial", "partial", "final", "done"]);
      expect(events[1]).toEqual({ type: "ready", sample_rate: 16000, max_seconds: 2700, max_frame_bytes: 3200, provider: "voice-studio" });
      expect(code).toBe(1000);
      await Bun.sleep(20);
      expect(s.store.recent()[0]).toMatchObject({ app: "space", tag: "voice-input", capability: "live", provider: "voice-studio", status: "ok", audioSeconds: 0.15, chars: 4, language: "zh" });
    } finally {
      s.stop();
    }
  });

  test("a provider whose socket cannot be opened is a link failure: the next one answers", async () => {
    const closed = Bun.serve({ port: 0, fetch: () => new Response() });
    const deadPort = closed.port;
    closed.stop(true);
    const { config } = parseProvidersYaml(`
speech:
  default: { asr: far }
  providers:
    far: { kind: voice-studio, machine: gpu-box }
    here: { kind: voice-studio }
  fallback: { asr: [here] }
`, {});
    const s = space({ at: "local", config, peers: { "gpu-box": peer("gpu-box", `http://127.0.0.1:${deadPort}`) } });
    try {
      const { events } = await session(`${s.ws}/api/speech/live`, dictate("", { tag: "dictation" }));
      expect(events.find((e) => e.type === "ready")?.provider).toBe("here");
      expect(events.at(-1)?.type).toBe("done");
      await Bun.sleep(20);
      const row = s.store.recent()[0]!;
      expect(row).toMatchObject({ tag: "dictation", provider: "here", fallbackFrom: "far", status: "ok", tries: 2 });
      expect(row.trace?.tries[0]).toMatchObject({ provider: "far", ok: false, kind: "transport" });
      expect(s.service.cells().find((c) => c.provider === "far")).toMatchObject({ restKind: "transport" });
    } finally {
      s.stop();
    }
  });

  test("a bad start is refused in the protocol, with no row", async () => {
    const s = space({ at: "local" });
    try {
      const { events, code } = await session(`${s.ws}/api/speech/live`, (ws, ev) => {
        if (!ev.length) ws.send(JSON.stringify({ type: "start", format: "opus" }));
      });
      expect(events).toEqual([{ type: "error", code: "invalid_request", message: "format must be pcm_s16le" }]);
      expect(code).toBe(4400);
      const pinned = await session(`${s.ws}/api/speech/live`, (ws, ev) => {
        if (!ev.length) ws.send(JSON.stringify({ type: "start", provider: "nobody" }));
      });
      expect(pinned.events).toEqual([{ type: "error", code: "no_provider", message: "no speech provider named nobody" }]);
      expect(s.store.recent()).toHaveLength(0);
    } finally {
      s.stop();
    }
  });

  test("a local-only app's session never goes to a cloud provider", async () => {
    const { config } = parseProvidersYaml("speech:\n  default: { asr: cloud, live: gpu }\n  providers:\n    gpu: { kind: voice-studio }\n    cloud: { kind: openai-compatible }\n", {});
    const s = space({ at: "local", config, localOnly: ["notes"] });
    try {
      const r = await fetch(`${s.url}/api/speech/transcribe`, { method: "POST", headers: { authorization: "Bearer notes-token" }, body: audio() });
      expect(r.status).toBe(403);
      expect((await r.json()).error).toBe("cloud (openai-compatible): local-only: notes keeps its speech off cloud providers");
    } finally {
      s.stop();
    }
  });
});
