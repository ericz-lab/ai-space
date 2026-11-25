import { afterEach, describe, expect, test } from "bun:test";
import { terminalWebSocket } from "../terminal/api.ts";
import { createSpeechRoutes } from "./api.ts";
import { parseProvidersYaml } from "./config.ts";
import { SpeechService, buildAdapters } from "./service.ts";
import { SpeechStore } from "./store.ts";
import { wav } from "./testing.ts";
import type { SpeechAdapter } from "./types.ts";
import { RECHECK_MS, VoiceStudioDirectAdapter, identityProof } from "./voice-studio-direct.ts";

/**
 * A voice-studio server reached at its own addresses (docs/speech.md#direct): stand-in servers on
 * loopback that answer the identity probe (or fail it in each way an impostor or an access layer
 * would), the token kept from every address that has not passed, the order of preference, a choice
 * made again after a dead address and the move back to the preferred one, and the routes end to end.
 */

const TOKEN = "test-token";
const NO_STUDIO = { hasLocal: () => false, servicePort: () => undefined, callLocal: async () => new Response(null, { status: 500 }), callRemote: async () => new Response(null, { status: 500 }) };

type Mode = "ok" | "wrong" | "404" | "redirect" | "html" | "hang" | "not-studio";
type Seen = { path: string; auth: string | null; access: string | null };

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

/** A stand-in voice-studio: its identity answer by `mode`, the API behind the bearer token. */
function studio(name: string, mode: Mode = "ok") {
  const seen: Seen[] = [];
  const state: { mode: Mode; fail?: number } = { mode };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req, srv) {
      const u = new URL(req.url);
      seen.push({ path: u.pathname, auth: req.headers.get("authorization"), access: req.headers.get("cf-access-client-id") });
      if (u.pathname === "/api/identity") {
        const nonce = u.searchParams.get("nonce") ?? "";
        if (!/^[0-9a-f]{32,128}$/.test(nonce)) return new Response("bad nonce", { status: 400 });
        switch (state.mode) {
          case "ok": return Response.json({ ok: true, app: "voice-studio", proof: identityProof(TOKEN, nonce) });
          case "wrong": return Response.json({ ok: true, app: "voice-studio", proof: identityProof("another-token", nonce) });
          case "not-studio": return Response.json({ ok: true, app: "something-else", proof: identityProof(TOKEN, nonce) });
          case "404": return new Response("not found", { status: 404 });
          case "redirect": return new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${srv.port}/trap` } });
          case "html": return new Response("<!doctype html><title>Sign in</title>", { headers: { "content-type": "text/html" } });
          case "hang": return new Promise<Response>(() => {});
        }
      }
      if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });
      if (state.fail) return new Response("busy", { status: state.fail });
      if (u.pathname === "/api/asr" && req.method === "POST") {
        const form = await req.formData();
        return Response.json({ text: `${name} heard ${await (form.get("file") as File).text()}`, language: String(form.get("language") || "zh"), segments: [{ start: 0, end: 1.25, text: "heard" }] });
      }
      if (u.pathname === "/api/tts" && req.method === "POST") {
        const body = (await req.json()) as { text: string; voices: string[] };
        return new Response(wav(0.25), { headers: { "content-type": "audio/wav", "x-said": encodeURIComponent(`${body.text}|${body.voices.join(",")}`) } });
      }
      if (u.pathname === "/api/voices") return Response.json({ voices: [`${name}-voice`], ready: true });
      if (u.pathname === "/api/asr/realtime" && srv.upgrade(req, { data: undefined })) return;
      return new Response("not found", { status: 404 });
    },
    websocket: {
      message(ws, m) {
        if (typeof m !== "string") return void ws.send(JSON.stringify({ type: "partial", segment_id: 0, text: `${name} got ${m.byteLength}` }));
        const msg = JSON.parse(m) as { type: string };
        if (msg.type === "start") ws.send(JSON.stringify({ type: "ready", sample_rate: 16000, max_seconds: 60, max_frame_bytes: 3200 }));
        else if (msg.type === "stop") {
          ws.send(JSON.stringify({ type: "final", segment_id: 0, text: "你好", language: "zh" }));
          ws.send(JSON.stringify({ type: "done" }));
          ws.close(1000, "done");
        }
      },
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  let stopped = false;
  const stop = () => {
    if (!stopped) server.stop(true);
    stopped = true;
  };
  stops.push(stop);
  return { url, host: `127.0.0.1:${server.port}`, seen, state, stop, sawToken: () => seen.some((s) => s.auth !== null), paths: () => seen.map((s) => s.path) };
}

/** An address nothing listens on. */
function deadUrl(): string {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const url = `http://127.0.0.1:${s.port}`;
  s.stop(true);
  return url;
}

function yamlFor(urls: string[], extra = "") {
  return `speech:\n  providers:\n    gpu:\n      kind: voice-studio\n      urls: [${urls.join(", ")}]\n      apiKeyEnv: STUDIO_TOKEN\n${extra}`;
}

function direct(urls: string[], opts: { now?: () => number; timeout?: number } = {}) {
  const { config } = parseProvidersYaml(yamlFor(urls), { STUDIO_TOKEN: TOKEN });
  const [adapter] = buildAdapters(config, { voiceStudio: NO_STUDIO, direct: { probeTimeoutMs: { local: opts.timeout ?? 300, remote: opts.timeout ?? 300 }, ...(opts.now ? { now: opts.now } : {}) } });
  return adapter as VoiceStudioDirectAdapter;
}

const FILE = { file: new Blob(["hello"]), filename: "a.wav", language: "zh", context: "" };
const SPACE = { app: "space", tag: "other" };

describe("the identity probe", () => {
  test("the proof is HMAC-SHA256 keyed by the token over voice-studio-identity:<nonce>, lowercase hex", () => {
    expect(identityProof("test-token", "ab".repeat(32))).toBe("9049ac1554066be5b4837b5656acec363b4868fdfe2d2147b241997bdfdb69ec");
  });

  test.each(["wrong", "404", "redirect", "html", "hang", "not-studio"] as const)("an address that answers %s never gets the token or the audio", async (mode) => {
    const bad = studio("bad", mode);
    const good = studio("good");
    const a = direct([bad.url, good.url]);
    const r = await a.transcribe(FILE);
    expect(r.text).toBe("good heard hello");
    expect(bad.sawToken()).toBe(false);
    expect(bad.paths()).toEqual(["/api/identity"]);
    expect(good.seen.filter((s) => s.path === "/api/asr")).toEqual([{ path: "/api/asr", auth: `Bearer ${TOKEN}`, access: null }]);
    expect(a.state()).toMatchObject({ where: good.host, machine: good.host, reachable: true });
  });

  test("each probe carries a fresh random nonce and no token", async () => {
    const nonces: string[] = [];
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input));
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      const nonce = u.searchParams.get("nonce")!;
      nonces.push(nonce);
      return Response.json({ ok: true, app: "voice-studio", proof: identityProof(TOKEN, nonce) });
    }) as typeof fetch;
    const { config } = parseProvidersYaml(yamlFor(["http://192.168.3.48:8920"]), { STUDIO_TOKEN: TOKEN });
    for (let i = 0; i < 3; i++) {
      const [a] = buildAdapters(config, { voiceStudio: NO_STUDIO, fetch: fetcher });
      await (a as VoiceStudioDirectAdapter).live();
    }
    expect(nonces).toHaveLength(3);
    expect(new Set(nonces).size).toBe(3);
    for (const n of nonces) expect(n).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("choosing the address", () => {
  test("the first in list order that passes, without waiting for a later one", async () => {
    const lan = studio("lan");
    const slow = studio("slow", "hang");
    const a = direct([lan.url, slow.url], { timeout: 3000 });
    const started = Date.now();
    expect((await a.transcribe(FILE)).text).toBe("lan heard hello");
    expect(Date.now() - started).toBeLessThan(1500);
    // Both pass: the earlier one still wins.
    const one = studio("one");
    const two = studio("two");
    expect((await direct([two.url, one.url]).transcribe(FILE)).text).toBe("two heard hello");
    expect((await direct([one.url, two.url]).transcribe(FILE)).text).toBe("one heard hello");
  });

  test("before any call the cell names the first address and claims nothing; the choice is remembered", async () => {
    const lan = studio("lan");
    const a = direct([lan.url]);
    expect(a.state()).toEqual({ where: lan.host, machine: lan.host, located: true });
    await a.transcribe(FILE);
    await a.speak({ text: "hi", voices: [] });
    expect(lan.paths().filter((p) => p === "/api/identity")).toHaveLength(1);
  });

  test("a dead remembered address: choose again and send the call once more on the new one", async () => {
    const lan = studio("lan");
    const tunnel = studio("tunnel");
    const a = direct([lan.url, tunnel.url]);
    expect((await a.transcribe(FILE)).text).toBe("lan heard hello");
    lan.stop();
    expect((await a.transcribe(FILE)).text).toBe("tunnel heard hello");
    expect(a.state()).toMatchObject({ where: tunnel.host, reachable: true });
    // A server that answers with an error is the real server failing, not a dead address: no move.
    const busy = studio("busy");
    const other = studio("other");
    const b = direct([busy.url, other.url]);
    await b.voices();
    busy.state.fail = 503;
    const e = await b.transcribe(FILE).catch((x) => x);
    expect(e.message).toBe("gpu: HTTP 503: busy");
    expect(other.paths()).not.toContain("/api/asr");
    expect(b.state().where).toBe(busy.host);
  });

  test("a later address in use: after the re-check interval the preferred one is probed again, in the background, and taken", async () => {
    let now = 1_000_000;
    const lan = studio("lan", "404");
    const tunnel = studio("tunnel");
    const a = direct([lan.url, tunnel.url], { now: () => now });
    expect((await a.transcribe(FILE)).text).toBe("tunnel heard hello");
    lan.state.mode = "ok";
    // Inside the interval nothing is probed again.
    now += RECHECK_MS - 1;
    expect((await a.transcribe(FILE)).text).toBe("tunnel heard hello");
    expect(lan.paths().filter((p) => p === "/api/identity")).toHaveLength(1);
    // Past it, the call that notices still goes where it is; the next one moves home.
    now += 2;
    expect((await a.transcribe(FILE)).text).toBe("tunnel heard hello");
    await a.settled();
    expect((await a.transcribe(FILE)).text).toBe("lan heard hello");
    expect(lan.sawToken()).toBe(true);
    expect(a.state().where).toBe(lan.host);
  });

  test("no address passes: a link failure the cell remembers", async () => {
    const impostor = studio("impostor", "wrong");
    const a = direct([deadUrl(), impostor.url]);
    const e = await a.transcribe(FILE).catch((x) => x);
    expect(e).toMatchObject({ status: 503, kind: "transport" });
    expect(e.message).toMatch(/^gpu: unreachable: no address answered as voice-studio \(127\.0\.0\.1:\d+: unreachable: .*; 127\.0\.0\.1:\d+: the proof is wrong/);
    expect(a.state()).toMatchObject({ located: true, reachable: false, detail: expect.stringContaining("no address answered") });
    expect(impostor.sawToken()).toBe(false);
  });
});

describe("calls", () => {
  test("transcribe, speak, voices and their bearer; voices are kept a minute", async () => {
    let now = 5_000_000;
    const lan = studio("lan");
    const a = direct([lan.url], { now: () => now });
    expect(a.limits.transcribeBytes).toBe(25 * 1024 * 1024);
    expect(await a.transcribe({ ...FILE, language: "en", context: "AI Space" })).toEqual({ text: "lan heard hello", language: "en", segments: [{ start: 0, end: 1.25, text: "heard" }], audioSeconds: 1.25 });
    const spoken = await a.speak({ text: "你好", voices: ["lan-voice"] });
    expect(spoken.contentType).toBe("audio/wav");
    expect(spoken.audio.byteLength).toBe(44 + 8000);
    expect(await a.voices()).toEqual(["lan-voice"]);
    expect(await a.voices()).toEqual(["lan-voice"]);
    now += 61_000;
    await a.voices();
    expect(lan.seen.filter((s) => s.path !== "/api/identity").map((s) => [s.path, s.auth])).toEqual([
      ["/api/asr", `Bearer ${TOKEN}`], ["/api/tts", `Bearer ${TOKEN}`], ["/api/voices", `Bearer ${TOKEN}`], ["/api/voices", `Bearer ${TOKEN}`],
    ]);
  });

  test("a refused token is the server's answer, not a link failure", async () => {
    const lan = studio("lan");
    const { config } = parseProvidersYaml(yamlFor([lan.url]), { STUDIO_TOKEN: TOKEN });
    const a = buildAdapters(config, { voiceStudio: NO_STUDIO })[0] as VoiceStudioDirectAdapter;
    await a.voices();
    // The token changed on the server: its identity answer no longer matches, and a call is a 401.
    (a.spec.direct as { token?: string }).token = "stale";
    const e = await a.transcribe(FILE).catch((x) => x);
    expect(e.message).toBe("gpu: HTTP 401: unauthorized");
  });

  test("an access layer's headers go to the https address only, the token only after the probe", async () => {
    const seen: { url: string; auth: string | null; access: string | null }[] = [];
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input));
      const h = new Headers(init?.headers);
      seen.push({ url: `${u.origin}${u.pathname}`, auth: h.get("authorization"), access: h.get("cf-access-client-id") });
      expect(init?.redirect).toBe("manual");
      if (u.hostname === "192.168.3.48") throw new TypeError("Unable to connect. Is the computer able to access the url?");
      if (u.pathname === "/api/identity") {
        if (h.get("cf-access-client-secret") !== "s3cret") return new Response(null, { status: 302, headers: { location: "https://team.cloudflareaccess.com/login" } });
        return Response.json({ ok: true, app: "voice-studio", proof: identityProof(TOKEN, u.searchParams.get("nonce")!) });
      }
      return Response.json({ text: "far", language: "zh", segments: [] });
    }) as typeof fetch;
    const yaml = "speech:\n  providers:\n    gpu:\n      kind: voice-studio\n      urls:\n        - http://192.168.3.48:8920\n        - { url: https://voice.example.com, headersEnv: VOICE_ACCESS }\n      apiKeyEnv: STUDIO_TOKEN\n";
    const { config } = parseProvidersYaml(yaml, { STUDIO_TOKEN: TOKEN, VOICE_ACCESS: "CF-Access-Client-Id: id.access; CF-Access-Client-Secret: s3cret" });
    const a = buildAdapters(config, { voiceStudio: NO_STUDIO, fetch: fetcher })[0] as VoiceStudioDirectAdapter;
    expect((await a.transcribe(FILE)).text).toBe("far");
    expect(seen).toEqual([
      { url: "http://192.168.3.48:8920/api/identity", auth: null, access: null },
      { url: "https://voice.example.com/api/identity", auth: null, access: "id.access" },
      { url: "https://voice.example.com/api/asr", auth: `Bearer ${TOKEN}`, access: "id.access" },
    ]);
    expect(a.state()).toMatchObject({ where: "voice.example.com", machine: "voice.example.com" });
    // Without the service token, Access answers its login redirect: that address is not it.
    const bare = parseProvidersYaml(yaml, { STUDIO_TOKEN: TOKEN, VOICE_ACCESS: "CF-Access-Client-Id: id.access; CF-Access-Client-Secret: wrong" }).config;
    const b = buildAdapters(bare, { voiceStudio: NO_STUDIO, fetch: fetcher })[0]!;
    const e = await b.transcribe!(FILE, SPACE).catch((x) => x);
    expect(e.message).toContain("voice.example.com: HTTP 302: redirected (an access layer's login?)");
    expect(seen.filter((s) => s.auth !== null)).toHaveLength(1);
  });
});

describe("through the speech service and its routes", () => {
  function routes(yaml: string, env: Record<string, string>, extra: SpeechAdapter[] = []) {
    const { config } = parseProvidersYaml(yaml, env);
    const built = buildAdapters(config, { voiceStudio: NO_STUDIO, direct: { probeTimeoutMs: { local: 300, remote: 300 } } });
    const adapters = built.map((a) => extra.find((x) => x.name === a.name) ?? a);
    const store = new SpeechStore(":memory:");
    const service = new SpeechService({ config, adapters, store, log: () => {} });
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", routes: createSpeechRoutes({ service, token: "op", appForToken: async () => undefined }) as never, websocket: terminalWebSocket });
    stops.push(() => server.stop(true));
    return { url: `http://127.0.0.1:${server.port}`, ws: `ws://127.0.0.1:${server.port}`, service, store, adapters };
  }

  test("status names the address, the ledger its host; nothing is probed for status", async () => {
    const lan = studio("lan");
    const s = routes(yamlFor([lan.url]), { STUDIO_TOKEN: TOKEN });
    const before = await fetch(`${s.url}/api/speech`).then((r) => r.json());
    expect(before.providers[0]).toMatchObject({ provider: "gpu", kind: "voice-studio", selfHosted: true, where: lan.host, located: true });
    expect(before.providers[0]).not.toHaveProperty("reachable");
    expect(lan.seen).toEqual([]);
    const form = new FormData();
    form.append("file", new File(["hi"], "a.webm"));
    const r = await fetch(`${s.url}/api/speech/transcribe`, { method: "POST", body: form });
    expect(await r.json()).toMatchObject({ ok: true, text: "lan heard hi", provider: "gpu" });
    expect(s.store.recent()[0]).toMatchObject({ provider: "gpu", kind: "voice-studio", machine: lan.host, status: "ok" });
    expect((await fetch(`${s.url}/api/speech`).then((x) => x.json())).providers[0]).toMatchObject({ reachable: true, where: lan.host });
  });

  test("no address passes: the fallback provider answers, and the row says why", async () => {
    const impostor = studio("impostor", "html");
    const cloud: SpeechAdapter = {
      name: "cloud", kind: "openai-compatible", capabilities: new Set(["transcribe", "speak"]), selfHosted: false, limits: {},
      state: () => ({ where: "api.example.com", machine: "", located: true }),
      transcribe: async () => ({ text: "from the cloud", language: "zh", segments: [] }),
    };
    const yaml = `${yamlFor([impostor.url, deadUrl()])}    cloud: { kind: openai-compatible, apiKeyEnv: KEY }\n  default: { asr: gpu }\n  fallback: { asr: [cloud] }\n`;
    const s = routes(yaml, { STUDIO_TOKEN: TOKEN, KEY: "k" }, [cloud]);
    const { result, call } = await s.service.transcribe(SPACE, FILE);
    expect(result.text).toBe("from the cloud");
    expect(call).toMatchObject({ provider: "cloud", fallbackFrom: "gpu", tries: 2 });
    expect(call.trace?.tries[0]).toMatchObject({ provider: "gpu", ok: false, kind: "transport", error: expect.stringContaining("no address answered as voice-studio") });
    expect(impostor.sawToken()).toBe(false);
    expect(s.service.cells().find((c) => c.provider === "gpu")).toMatchObject({ reachable: false, problem: "unreachable" });
  });

  test("live dictation end to end, with the bearer on the socket; a dead address is rerouted before the client sees anything", async () => {
    const lan = studio("lan");
    const tunnel = studio("tunnel");
    const s = routes(yamlFor([lan.url, tunnel.url]), { STUDIO_TOKEN: TOKEN });
    const run = () => session(`${s.ws}/api/speech/live`);
    const first = await run();
    expect(first.events.map((e) => e.type)).toEqual(["ready", "partial", "final", "done"]);
    expect(first.events[0]).toMatchObject({ provider: "gpu" });
    expect(first.events[1]).toMatchObject({ text: "lan got 3200" });
    expect(lan.seen.find((x) => x.path === "/api/asr/realtime")?.auth).toBe(`Bearer ${TOKEN}`);
    lan.stop();
    const second = await run();
    expect(second.events.map((e) => e.type)).toEqual(["ready", "partial", "final", "done"]);
    expect(second.events[1]).toMatchObject({ text: "tunnel got 3200" });
    await Bun.sleep(20);
    expect(s.store.recent()[0]).toMatchObject({ capability: "live", provider: "gpu", status: "ok", machine: tunnel.host, tries: 1 });
  });
});

/** start, one frame after ready, stop; the events until the close. */
async function session(url: string): Promise<{ events: Record<string, unknown>[]; code: number }> {
  const events: Record<string, unknown>[] = [];
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => ws.send(JSON.stringify({ type: "start", format: "pcm_s16le", sample_rate: 16000, channels: 1, language: "zh" }));
    ws.onmessage = (e) => {
      const ev = JSON.parse(e.data as string) as Record<string, unknown>;
      events.push(ev);
      if (ev.type === "ready") ws.send(new Uint8Array(3200));
      else if (ev.type === "partial") ws.send(JSON.stringify({ type: "stop" }));
    };
    ws.onclose = (e) => resolve({ events, code: e.code });
    ws.onerror = () => reject(new Error("socket error"));
    setTimeout(() => reject(new Error(`timed out: ${JSON.stringify(events)}`)), 5000);
  });
}
