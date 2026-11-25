import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRuntimesYaml } from "../runtimes/config.ts";
import { RuntimeRegistry } from "../runtimes/registry.ts";
import { builtinSpeech, checkGatewayProviders, loadSpeech, parseProvidersYaml } from "../speech/config.ts";
import { SpeechService, buildAdapters } from "../speech/service.ts";
import { SpeechStore } from "../speech/store.ts";
import { SpeechError } from "../speech/types.ts";
import { GATEWAY_PREFIX, createGatewayRoutes } from "./api.ts";
import { parseGatewayYaml } from "./config.ts";
import { forwardsOf, kindOf, servesOf } from "./kinds.ts";
import { ModelGateway } from "./service.ts";
import { createGatewaySettingsRoutes } from "./settings.ts";
import { chainOf, setSpeechText, speechEditProblem } from "./speech-edit.ts";

/**
 * Settings → Gateway's model kinds, Speech and Image groups (docs/model-gateway.md#kinds,
 * #speech-group, #image-group): temp files, fake vendors on loopback, fake keys.
 */

const KEY = "sk-fake-media-key-0000-abcd";
const WAV = new Uint8Array([82, 73, 70, 70, 36, 0, 0, 0, 87, 65, 86, 69, 1, 2, 3, 4]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const stops: (() => void)[] = [];
afterAll(() => {
  for (const s of stops) s();
});

/** A vendor with an OpenAI-style base: audio, images, and model lists with OpenRouter's lists by kind. */
function vendor() {
  const seen: { path: string; auth: string | null; json?: Record<string, unknown>; form?: Record<string, string> }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get("authorization");
      const s: (typeof seen)[number] = { path: url.pathname + url.search, auth };
      if (req.method === "POST") {
        if (req.headers.get("content-type")?.startsWith("multipart/")) {
          const f = await req.formData();
          s.form = Object.fromEntries([...f.entries()].map(([k, v]) => [k, typeof v === "string" ? v : `<file ${(v as File).size}>`]));
        } else s.json = (await req.json()) as Record<string, unknown>;
      }
      seen.push(s);
      if (auth !== `Bearer ${KEY}`) return Response.json({ error: { message: `bad key ${auth}` } }, { status: 401 });
      if (url.pathname.endsWith("/audio/speech")) return new Response(WAV, { headers: { "content-type": "audio/wav" } });
      if (url.pathname.endsWith("/audio/transcriptions")) return Response.json({ text: " hello from ai-space " });
      if (url.pathname.endsWith("/images/generations")) return Response.json({ data: [{ b64_json: Buffer.from(PNG).toString("base64") }] });
      if (url.pathname.endsWith("/models")) {
        const by = url.searchParams.get("output_modalities");
        if (by === "speech") return Response.json({ data: [{ id: "vendor/voice-1", architecture: { output_modalities: ["speech"] } }] });
        if (by === "transcription") return Response.json({ data: [{ id: "vendor/scribe-1" }] });
        if (by === "image") return Response.json({ data: [{ id: "vendor/painter-1", architecture: { output_modalities: ["image"] } }] });
        return Response.json({ data: [{ id: "chat-a" }, { id: "draw-and-talk", architecture: { output_modalities: ["image", "text"] } }, { id: "whisper-1" }] });
      }
      return new Response("not here", { status: 404 });
    },
  });
  stops.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, seen };
}

/**
 * MiniMax's speech API as its docs show it (speech-t2a-http.md, speech-to-text.md): hex audio in JSON,
 * errors inside HTTP 200 for t2a_v2, the real status for speech_to_text.
 */
function minimaxVendor(key = KEY) {
  const seen: { path: string; auth: string | null; language: string | null; json?: Record<string, unknown>; form?: Record<string, string> }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get("authorization");
      const s: (typeof seen)[number] = { path: url.pathname, auth, language: req.headers.get("language") };
      if (req.headers.get("content-type")?.startsWith("multipart/")) {
        const f = await req.formData();
        s.form = Object.fromEntries([...f.entries()].map(([k, v]) => [k, typeof v === "string" ? v : `<file ${(v as File).size}>`]));
      } else s.json = (await req.json()) as Record<string, unknown>;
      seen.push(s);
      const good = auth === `Bearer ${key}`;
      if (url.pathname === "/v1/t2a_v2") {
        if (!good) return Response.json({ base_resp: { status_code: 1004, status_msg: "login fail: Please carry the API secret key in the 'Authorization' field of the request header" } });
        return Response.json({ data: { audio: Buffer.from(WAV).toString("hex"), status: 2 }, extra_info: { audio_format: "wav", usage_characters: 20 }, trace_id: "t", base_resp: { status_code: 0, status_msg: "success" } });
      }
      if (url.pathname === "/v1/speech_to_text") {
        if (!good) return Response.json({ type: "error", error: { type: "authorized_error", message: "login fail (1004)", http_code: "401" } }, { status: 401 });
        return Response.json({ text: "hello from ai-space", duration: 1.2, n_speakers: 1, segments: [{ id: 0, start: 0, end: 1.2, speaker: "S1", text: "hello from ai-space" }], trace_id: "t" });
      }
      return new Response("404 page not found", { status: 404 });
    },
  });
  stops.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, seen };
}

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "space-gw-media-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** The voice-studio app's place, as the bus reports it: here (`studio`) or nowhere. */
const voiceStudioDeps = (studio: boolean) => ({ hasLocal: () => studio, servicePort: () => (studio ? 9 : undefined), callLocal: async () => new Response("", { status: 503 }), callRemote: async () => new Response("", { status: 503 }), peers: { get: () => undefined, names: () => [], providerOf: () => undefined } }) as never;

async function setup(gatewayYaml?: string, o: { studio?: boolean } = {}) {
  const voiceStudio = voiceStudioDeps(o.studio ?? false);
  const env: Record<string, string | undefined> = { OA: KEY };
  const lines: string[] = [];
  const gateway = new ModelGateway({ log: (l) => lines.push(l) });
  const gwServer = Bun.serve({ port: 0, hostname: "127.0.0.1", routes: createGatewayRoutes(gateway), fetch: () => new Response("", { status: 404 }) });
  stops.push(() => gwServer.stop(true));
  gateway.listen(`http://127.0.0.1:${gwServer.port}${GATEWAY_PREFIX}`);
  if (gatewayYaml) {
    await writeFile(join(home, "gateway.yaml"), gatewayYaml);
    gateway.reload({ config: parseGatewayYaml(gatewayYaml, env).config });
  }
  const load = async () => {
    const l = await loadSpeech(home, env);
    l.warnings.push(...checkGatewayProviders(l.config, (n) => {
      const p = gateway.link.provider(n);
      const off = gateway.providerOff(n);
      return p ? { openai: Boolean(p.openai), messages: Boolean(p.messages), ...(off ? { off } : {}) } : undefined;
    }, gateway.enabled));
    return { config: l.config, source: l.source, warnings: l.warnings, adapters: buildAdapters(l.config, { voiceStudio, gateway: gateway.link }) };
  };
  const speech = new SpeechService({ ...(await load()), store: new SpeechStore(":memory:"), localOnly: (app) => app === "diary", log: () => {} });
  let reloads = 0;
  const routes = createGatewaySettingsRoutes({
    gateway,
    runtimes: new RuntimeRegistry(parseRuntimesYaml("runtimes:\n  claude:\n    kind: claude-code\n", env).config, { gateway: gateway.link }),
    home,
    envFile: join(home, ".env"),
    env,
    token: "op",
    isAppCredential: async (t) => t === "app-token",
    claude: () => undefined,
    log: (l) => lines.push(l),
    speech: {
      config: () => speech.config,
      source: () => speech.status().source,
      configError: () => speech.status().configError,
      cells: () => speech.cells(),
      speak: (provider, text) => speech.speak({ app: "settings", tag: "t" }, { text, voices: [], provider }),
      transcribe: async (provider, file) => (await speech.transcribe({ app: "settings", tag: "t" }, { file, filename: "t.wav", language: "", context: "", provider })).result,
    },
    reloadSpeech: async () => {
      reloads++;
      speech.reload(await load());
    },
  });
  type Handler = (r: Request) => Promise<Response>;
  const call = async (method: string, path: string, body?: unknown, token: string | null = "op") => {
    const route = Object.entries(routes).find(([k]) => new RegExp(`^${k.replace(/:name/g, "[^/]+")}$`).test(path.split("?")[0]!));
    if (!route) throw new Error(`no route ${path}`);
    const req = new Request(`http://127.0.0.1${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const name = /providers\/([^/?]+)/.exec(path)?.[1];
    Object.assign(req, { params: name ? { name } : {} });
    const res = await (route[1] as Record<string, Handler>)[method]!(req);
    const text = await res.text();
    return { status: res.status, text, json: JSON.parse(text) as Record<string, any> };
  };
  return { call, env, gateway, speech, lines, reloads: () => reloads };
}

describe("model kinds (docs/model-gateway.md#kinds)", () => {
  test("a file with only models: loads as before, every model text unless a documented rule says otherwise", () => {
    const { config } = parseGatewayYaml("providers:\n  oa: { preset: openai, apiKeyEnv: OA, models: [gpt-5, whisper-1, gpt-image-1] }\n  mine: { openai: 'http://x.test/v1', models: [whisper-1] }\n", {});
    const [oa, mine] = config.providers as [any, any];
    expect(oa.kinds).toBeUndefined();
    expect([kindOf(oa, "gpt-5"), kindOf(oa, "whisper-1"), kindOf(oa, "gpt-image-1")]).toEqual(["text", "asr", "image"]);
    // No preset, no rule: a name that looks like speech is still text until the owner says so.
    expect(kindOf(mine, "whisper-1")).toBe("text");
  });

  test("kinds: names listed models only, with a known kind", () => {
    const ok = parseGatewayYaml("providers:\n  mine:\n    openai: 'http://x.test/v1'\n    models: [w, t, p, c]\n    kinds: { w: asr, t: tts, p: image, c: text }\n", {}).config.providers[0]!;
    expect(ok.kinds).toEqual({ w: "asr", t: "tts", p: "image", c: "text" });
    expect(() => parseGatewayYaml("providers:\n  mine:\n    openai: 'http://x.test/v1'\n    models: [w]\n    kinds: { other: asr }\n", {})).toThrow(/not in its models/);
    expect(() => parseGatewayYaml("providers:\n  mine:\n    openai: 'http://x.test/v1'\n    models: [w]\n    kinds: { w: video }\n", {})).toThrow(/must be one of/);
  });

  test("what a provider serves, and why not", () => {
    expect(servesOf({ preset: "deepseek", messages: "x" })).toEqual({ text: true, asr: expect.stringMatching(/tools\/asr/), tts: expect.stringMatching(/tools\/tts/), image: "the vendor documents none" });
    expect(servesOf({ preset: "openrouter", messages: "x", openai: "y" })).toMatchObject({ asr: true, tts: expect.stringMatching(/wav/), image: expect.stringMatching(/api\/v1\/images/) });
    expect(servesOf({ openai: "y" })).toEqual({ text: "no messages base", asr: true, tts: true, image: true });
    expect(servesOf({ preset: "zhipu", messages: "x" }).image).toMatch(/no openai base/);
    // MiniMax's speech is the speech layer's own kind: either base gives the host; the gateway forwards none of it.
    expect(servesOf({ preset: "minimax", messages: "x" })).toEqual({ text: true, asr: true, tts: true, image: expect.stringMatching(/no openai base/) });
    expect(forwardsOf({ preset: "minimax", messages: "x", openai: "y" })).toMatchObject({ asr: expect.stringMatching(/speech layer/), tts: expect.stringMatching(/speech layer/), image: true });
  });

  test("/v1/models carries each model's kind; magpie's reader still tells groups apart", async () => {
    const v = vendor();
    const { gateway } = await setup(`providers:\n  oa:\n    preset: openai\n    messages: '${v.url}'\n    openai: '${v.url}/v1'\n    apiKeyEnv: OA\n    models: [gpt-5, tts-1, mine-tts]\n    kinds: { mine-tts: tts }\ngroups:\n  fast: [oa/gpt-5]\n`);
    const data = gateway.models().data;
    expect(data.map((m) => [m.id, m.kind])).toEqual([["fast", "group"], ["oa/gpt-5", "text"], ["oa/tts-1", "tts"], ["oa/mine-tts", "tts"]]);
    const { readCatalog } = await import("../runtimes/magpie.ts");
    const catalog = readCatalog({ data })!;
    expect(catalog.groups).toEqual(["fast"]);
    expect(catalog.models).toEqual(expect.arrayContaining(["oa/gpt-5", "oa/tts-1", "oa/mine-tts"]));
    const view = gateway.view();
    expect(view.ttsModels).toEqual(["oa/tts-1", "oa/mine-tts"]);
    expect(view.textModels).toEqual(["fast", "oa/gpt-5"]);
  });

  test("the vendor's list says what its models are for; the rest is text for the owner to change; saved kinds go to the file", async () => {
    const v = vendor();
    const { call } = await setup();
    // An OpenRouter preset at the stand-in: its lists by kind, and its entries' output modalities.
    const or = await call("POST", "/api/model/gateway/models", { preset: "openrouter", openai: `${v.url}/v1`, messages: v.url, key: KEY });
    expect(or.json.source).toBe("vendor");
    expect(or.json.kinds).toEqual({ "vendor/scribe-1": "asr", "vendor/voice-1": "tts", "vendor/painter-1": "image" });
    expect(or.json.models).toContain("draw-and-talk");
    expect(or.json.kinds["draw-and-talk"]).toBeUndefined();
    // OpenAI: its documented ids.
    const oa = await call("POST", "/api/model/gateway/models", { preset: "openai", openai: `${v.url}/v1`, key: KEY });
    expect(oa.json.kinds).toEqual({ "whisper-1": "asr" });
    // Added with a kind the owner set; one equal to the rule is not written.
    const add = await call("POST", "/api/model/gateway/providers", { name: "oa", preset: "openai", openai: `${v.url}/v1`, key: KEY, models: ["chat-a", "whisper-1", "draw-and-talk"], kinds: { "draw-and-talk": "image", "whisper-1": "asr" } });
    expect(add.status).toBe(200);
    const text = await readFile(join(home, "gateway.yaml"), "utf8");
    expect(text).toContain("    kinds: { draw-and-talk: image }\n");
    // Correct one in one call: back to text drops it from the file.
    await call("PUT", "/api/model/gateway/providers/oa", { kinds: { "draw-and-talk": "text", "chat-a": "tts" } });
    const after = await readFile(join(home, "gateway.yaml"), "utf8");
    expect(after).toContain("    kinds: { chat-a: tts }\n");
    const view = (await call("GET", "/api/model/gateway")).json;
    expect(view.providers[0].kinds).toEqual({ "chat-a": "tts", "whisper-1": "asr", "draw-and-talk": "text" });
    expect(view.providers[0].kindSet).toEqual(["chat-a"]);
    expect(view.providers[0].serves).toEqual({ text: "no messages base", asr: true, tts: true, image: true });
  });
});

describe("the speech orders in providers.yaml (docs/speech.md#from-settings)", () => {
  const gw = (_role: "asr" | "tts", model: string, voice?: string) => ({ gateway: "oa", model, ...(voice ? { voice } : {}) });
  const vs = { provider: "voice-studio" };

  test("no file, voice-studio there: the built-in default is written out and stays first; the gateway after it", () => {
    const { text, after } = setSpeechText(undefined, { asr: [vs, gw("asr", "whisper-1")], tts: [vs, gw("tts", "tts-1", "nova")] }, {}, "present");
    expect(text).toContain("    voice-studio:\n      kind: voice-studio\n      app: voice-studio\n");
    const b = builtinSpeech();
    for (const role of ["asr", "tts", "live"] as const) expect(after.default[role]).toBe(b.default[role]);
    expect(chainOf(after, "asr")).toEqual(["voice-studio", "gateway-oa"]);
    expect(chainOf(after, "tts")).toEqual(["voice-studio", "gateway-oa"]);
    expect(chainOf(after, "live")).toEqual(["voice-studio"]);
    // The gateway first for TTS: it answers, voice-studio after it; ASR and live stay.
    const moved = setSpeechText(text, { asr: [vs, gw("asr", "whisper-1")], tts: [gw("tts", "tts-1", "nova"), vs] }, {}, "present");
    expect(chainOf(moved.after, "tts")).toEqual(["gateway-oa", "voice-studio"]);
    expect(chainOf(moved.after, "asr")).toEqual(["voice-studio", "gateway-oa"]);
    expect(chainOf(moved.after, "live")).toEqual(["voice-studio"]);
  });

  test("a minimax entry: its kind and the vendor's ids; an old entry of another kind for that provider is started again", () => {
    const old = "speech:\n  providers:\n    gateway-minimax:   # mine\n      kind: openai-compatible\n      gateway: space\n      provider: minimax\n      asrModel: whisper-1\n";
    const mm = (_role: "asr" | "tts", model: string, voice?: string) => ({ gateway: "minimax", model, kind: "minimax" as const, ...(voice ? { voice } : {}) });
    const { text, after, changed } = setSpeechText(old, { asr: [mm("asr", "asr-1.0")], tts: [mm("tts", "speech-2.8-hd", "Cantonese_GentleLady")] }, {}, "absent");
    expect(changed).toBe(true);
    expect(text).toContain("    gateway-minimax:   # mine\n      kind: minimax\n      gateway: space\n      provider: minimax\n      asrModel: asr-1.0\n      ttsModel: speech-2.8-hd\n      voice: Cantonese_GentleLady\n");
    expect(after.providers).toEqual([{ name: "gateway-minimax", kind: "minimax", url: "", asrModel: "asr-1.0", ttsModel: "speech-2.8-hd", voice: "Cantonese_GentleLady", gateway: { via: "space", provider: "minimax" } }]);
    // The same again writes nothing; taking it out of TTS keeps its TTS model, out of both removes it.
    expect(setSpeechText(text, { asr: [mm("asr", "asr-1.0")], tts: [mm("tts", "speech-2.8-hd", "Cantonese_GentleLady")] }, {}, "absent").changed).toBe(false);
    expect(setSpeechText(text, { asr: [mm("asr", "asr-1.0")], tts: [] }, {}, "absent").after.providers[0]).toMatchObject({ kind: "minimax", ttsModel: "speech-2.8-hd" });
  });

  test("no file, voice-studio not there: nothing of it is written", () => {
    const { text, after } = setSpeechText(undefined, { asr: [gw("asr", "whisper-1")], tts: [] }, {}, "absent");
    expect(text).not.toContain("voice-studio");
    expect(after.providers.map((p) => p.name)).toEqual(["gateway-oa"]);
    expect(chainOf(after, "asr")).toEqual(["gateway-oa"]);
    expect(chainOf(after, "tts")).toEqual([]);
    expect(() => setSpeechText(undefined, { asr: [], tts: [] }, {}, "absent")).toThrow(/add a provider/);
    expect(() => setSpeechText(undefined, { asr: [vs], tts: [] }, {}, "absent")).toThrow(/voice-studio is not a speech provider here/);
  });

  test("a hand-written file: reorder and remove custom providers, never rewrite them; comments and untouched lines stay", () => {
    const hand = "# my speech\nspeech:\n  default: { asr: gpu, tts: gpu }   # both on the GPU\n  providers:\n    gpu: { kind: voice-studio, machine: box }  # the GPU box\n    openai:\n      kind: openai-compatible\n      apiKeyEnv: OPENAI_API_KEY   # mine\n  fallback:\n    asr: [openai]   # cloud second\n  voices:\n    narrator: { gpu: en-Frank, openai: onyx }\n";
    const env = { OPENAI_API_KEY: "sk-x" };
    const before = parseProvidersYaml(hand, env).config;
    // Saving the orders as they are writes nothing.
    const same = setSpeechText(hand, { asr: [{ provider: "gpu" }, { provider: "openai" }], tts: [{ provider: "gpu" }] }, env, "present");
    expect(same.changed).toBe(false);
    expect(same.text).toBe(hand);
    // openai first for ASR, gpu taken out of TTS in favour of openai: only default: and fallback: change.
    const { text, after } = setSpeechText(hand, { asr: [{ provider: "openai" }, { provider: "gpu" }], tts: [{ provider: "openai" }] }, env, "present");
    expect(text).toContain("# my speech\n");
    expect(text).toContain("    gpu: { kind: voice-studio, machine: box }  # the GPU box\n");
    expect(text).toContain("      apiKeyEnv: OPENAI_API_KEY   # mine\n");
    expect(text).toContain("  default:   # both on the GPU\n");
    expect(after.voices).toEqual(before.voices);
    expect(text).toContain("    asr: [gpu]   # cloud second\n");
    expect(chainOf(after, "asr")).toEqual(["openai", "gpu"]);
    expect(chainOf(after, "tts")).toEqual(["openai"]);
    expect(chainOf(after, "live")).toEqual(chainOf(before, "live"));
    expect(after.providers.filter((p) => p.name !== "gateway-oa")).toEqual(before.providers);
    // A gateway provider added for TTS only: one new entry, ASR's lines untouched.
    const added = setSpeechText(hand, { asr: [{ provider: "gpu" }, { provider: "openai" }], tts: [{ provider: "gpu" }, gw("tts", "tts-1")] }, env, "present");
    expect(added.text).toContain("  default: { asr: gpu, tts: gpu }   # both on the GPU\n");
    expect(added.text).toContain("    asr: [openai]   # cloud second\n");
    expect(chainOf(added.after, "tts")).toEqual(["gpu", "gateway-oa"]);
  });

  test("a page provider keeps what the owner did not touch; one no order uses goes", () => {
    const first = setSpeechText(undefined, { asr: [vs, gw("asr", "gpt-4o-transcribe")], tts: [vs, gw("tts", "tts-1-hd", "onyx")] }, {}, "present");
    // Out of ASR only: its TTS model and voice stay.
    const asrOut = setSpeechText(first.text, { asr: [vs], tts: [vs, { provider: "gateway-oa" }] }, {}, "present");
    const p = asrOut.after.providers.find((x) => x.name === "gateway-oa") as { ttsModel: string; voice?: string };
    expect([p.ttsModel, p.voice]).toEqual(["oa/tts-1-hd", "onyx"]);
    const gone = setSpeechText(asrOut.text, { asr: [vs], tts: [vs] }, {}, "present");
    expect(gone.after.providers.map((x) => x.name)).toEqual(["voice-studio"]);
    expect(() => setSpeechText(first.text, { asr: [vs, vs], tts: [] }, {}, "present")).toThrow(/twice/);
  });

  test("a file the page cannot edit is refused with the reason", () => {
    expect(speechEditProblem("speech: { providers: { gpu: { kind: voice-studio } } }\n", {})).toMatch(/one line/);
    expect(speechEditProblem("speech:\n  providers: { gpu: { kind: voice-studio } }\n", {})).toMatch(/one line/);
    expect(speechEditProblem("speech:\n  providers:\n    gpu:\n      kind: voice-studio\n", {})).toBeUndefined();
  });

  test("the gateway's speech provider is a cloud provider: a local-only app never reaches it", async () => {
    const v = vendor();
    const { speech, call } = await setup(`providers:\n  oa:\n    preset: openai\n    openai: '${v.url}/v1'\n    apiKeyEnv: OA\n    models: [whisper-1, tts-1]\n`);
    expect((await call("PUT", "/api/model/gateway/speech", { asr: [], tts: [{ gateway: "oa", model: "tts-1", voice: "alloy" }] })).status).toBe(200);
    expect(speech.cells().find((c) => c.provider === "gateway-oa")?.selfHosted).toBe(false);
    const seen = v.seen.length;
    const refused = await speech.speak({ app: "diary", tag: "t" }, { text: "secret", voices: [] }).catch((e) => e);
    expect(refused).toBeInstanceOf(SpeechError);
    expect(refused).toMatchObject({ status: 403, code: "local_only" });
    expect(v.seen.length).toBe(seen);
    const ok = await speech.speak({ app: "notes", tag: "t" }, { text: "hello", voices: [] });
    expect(new Uint8Array(ok.audio)).toEqual(WAV);
  });
});

describe("the Speech group's routes", () => {
  const gwYaml = (url: string) => `providers:\n  oa:\n    preset: openai\n    openai: '${url}/v1'\n    apiKeyEnv: OA\n    models: [gpt-5, whisper-1, tts-1]\n  ds:\n    preset: deepseek\n    messages: '${url}'\n    apiKeyEnv: OA\n`;

  test("no file and no voice-studio: the view names none of it; a save writes a file without it", async () => {
    const v = vendor();
    const { call, speech } = await setup(gwYaml(v.url));
    const view = (await call("GET", "/api/model/gateway/speech")).json;
    expect(view.source).toBe("builtin");
    expect(view.custom).toEqual([]);
    expect(view.order).toEqual({ asr: [], tts: [] });
    expect(view.live).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain("voice-studio");
    const oa = view.providers.find((p: { name: string }) => p.name === "oa");
    expect(oa.voices["tts-1"]).toContain("alloy");
    expect(view.providers.find((p: { name: string }) => p.name === "ds").serves.tts).toMatch(/tools\/tts/);
    const saved = await call("PUT", "/api/model/gateway/speech", { asr: [{ gateway: "oa", model: "whisper-1" }], tts: [] });
    expect(saved.json).toMatchObject({ ok: true, applied: true, created: true, after: { asr: ["gateway-oa"], tts: [] } });
    const text = await readFile(join(home, "providers.yaml"), "utf8");
    expect(text).not.toContain("voice-studio");
    expect(speech.status().default).toEqual({ asr: "gateway-oa" });
  });

  test("no file, voice-studio here: listed as custom and first; the gateway after it keeps it default, the gateway first takes over at once", async () => {
    const v = vendor();
    const { call, speech, reloads } = await setup(gwYaml(v.url), { studio: true });
    const view = (await call("GET", "/api/model/gateway/speech")).json;
    expect(view.custom).toEqual([{ name: "voice-studio", kind: "voice-studio", serves: { asr: true, tts: true, live: true }, machine: "", located: true, testable: true }]);
    expect(view.order).toEqual({ asr: [{ provider: "voice-studio" }], tts: [{ provider: "voice-studio" }] });
    expect(view.live).toEqual(["voice-studio"]);
    // A provider that cannot speak is refused.
    expect((await call("PUT", "/api/model/gateway/speech", { asr: [], tts: [{ gateway: "ds", model: "x" }] })).status).toBe(400);
    const after = { asr: [{ provider: "voice-studio" }, { gateway: "oa", model: "whisper-1" }], tts: [{ provider: "voice-studio" }, { gateway: "oa", model: "tts-1", voice: "nova" }] };
    const preview = await call("PUT", "/api/model/gateway/speech", { ...after, dryRun: true });
    expect(preview.json.after).toEqual({ asr: ["voice-studio", "gateway-oa"], tts: ["voice-studio", "gateway-oa"], live: ["voice-studio"] });
    expect(await Bun.file(join(home, "providers.yaml")).exists()).toBe(false);
    expect((await call("PUT", "/api/model/gateway/speech", after)).json).toMatchObject({ ok: true, applied: true, created: true });
    expect(reloads()).toBe(1);
    expect(speech.status().default).toEqual({ asr: "voice-studio", tts: "voice-studio", live: "voice-studio" });
    expect((await call("GET", "/api/model/gateway/speech")).json.order).toEqual({ asr: after.asr, tts: [{ provider: "voice-studio" }, { gateway: "oa", model: "tts-1", voice: "nova" }] });
    // The file keeps its mode; the gateway first for TTS: the running service moves with no restart.
    if (process.platform !== "win32") await chmod(join(home, "providers.yaml"), 0o640);
    await call("PUT", "/api/model/gateway/speech", { asr: after.asr, tts: [after.tts[1], after.tts[0]] });
    if (process.platform !== "win32") expect((await stat(join(home, "providers.yaml"))).mode & 0o777).toBe(0o640);
    expect(speech.status().default).toEqual({ asr: "voice-studio", tts: "gateway-oa", live: "voice-studio" });
    const spoken = await speech.speak({ app: "notes", tag: "t" }, { text: "hi", voices: [] });
    expect(spoken.call.provider).toBe("gateway-oa");
    expect(v.seen.at(-1)).toMatchObject({ path: "/v1/audio/speech", json: { model: "tts-1", voice: "nova", input: "hi" } });
  });

  test("a hand-written direct voice-studio: shown where its address is, and a save keeps its entry as written", async () => {
    const v = vendor();
    const { call, env } = await setup(gwYaml(v.url));
    env.STUDIO_TOKEN = "tok";
    const entry = "    gpu:   # the GPU box, home and away\n      kind: voice-studio\n      urls:\n        - http://192.168.3.48:8920          # LAN\n        - { url: https://voice.example.com, headersEnv: VOICE_ACCESS }\n      apiKeyEnv: STUDIO_TOKEN\n";
    await writeFile(join(home, "providers.yaml"), `speech:\n  default: { asr: gpu, tts: gpu }\n  providers:\n${entry}`);
    // The running service has not loaded the file in this setup: the view falls back to the first address.
    const view = (await call("GET", "/api/model/gateway/speech")).json;
    expect(view.custom).toEqual([{ name: "gpu", kind: "voice-studio", serves: { asr: true, tts: true, live: true }, machine: "192.168.3.48:8920", testable: false }]);
    expect(view.order).toEqual({ asr: [{ provider: "gpu" }], tts: [{ provider: "gpu" }] });
    const saved = await call("PUT", "/api/model/gateway/speech", { asr: [{ provider: "gpu" }, { gateway: "oa", model: "whisper-1" }], tts: [{ provider: "gpu" }] });
    expect(saved.json).toMatchObject({ ok: true, applied: true });
    const text = await readFile(join(home, "providers.yaml"), "utf8");
    expect(text).toContain(entry);
    const after = parseProvidersYaml(text, env).config;
    expect(chainOf(after, "asr")).toEqual(["gpu", "gateway-oa"]);
    expect(chainOf(after, "live")).toEqual(["gpu"]);
  });

  test("tests: TTS plays and ASR transcribes that clip, through the gateway or a custom provider; errors never carry the key", async () => {
    const v = vendor();
    const { call, lines } = await setup(gwYaml(v.url));
    await writeFile(join(home, "providers.yaml"), `speech:\n  providers:\n    lan:\n      kind: openai-compatible\n      url: '${v.url}/v1'\n      apiKeyEnv: OA\n      selfHosted: true\n      voice: alloy\n`);
    const { call: call2 } = await setup(gwYaml(v.url));
    const view = (await call2("GET", "/api/model/gateway/speech")).json;
    expect(view.custom).toEqual([{ name: "lan", kind: "openai-compatible", serves: { asr: true, tts: true, live: false }, located: true, testable: true }]);
    expect(view.live).toBeUndefined();
    const own = (await call2("POST", "/api/model/gateway/speech/test", { role: "tts", speech: "lan" })).json;
    expect(own).toMatchObject({ ok: true, role: "tts", contentType: "audio/wav", bytes: WAV.length });
    expect((await call2("POST", "/api/model/gateway/speech/test", { role: "asr", speech: "lan", audio: own.audio })).json).toMatchObject({ ok: true, text: "hello from ai-space" });
    const tts = (await call("POST", "/api/model/gateway/speech/test", { role: "tts", provider: "oa", model: "tts-1", voice: "alloy" })).json;
    expect(new Uint8Array(Buffer.from(tts.audio, "base64"))).toEqual(WAV);
    expect((await call("POST", "/api/model/gateway/speech/test", { role: "asr", provider: "oa", model: "whisper-1", audio: tts.audio })).json).toMatchObject({ ok: true, role: "asr", text: "hello from ai-space" });
    const bad = (await call("POST", "/api/model/gateway/speech/test", { role: "tts", provider: "ds", model: "x" })).json;
    expect(bad.failed).toBe(true);
    expect(JSON.stringify(bad)).not.toContain(KEY);
    expect(lines.join("\n")).not.toContain(KEY);
  });

  test("an app's credential is refused on the new routes", async () => {
    const { call } = await setup();
    for (const [m, p] of [["GET", "/api/model/gateway/speech"], ["PUT", "/api/model/gateway/speech"], ["POST", "/api/model/gateway/speech/test"], ["POST", "/api/model/gateway/image/test"]] as const) {
      expect((await call(m, p, {}, "app-token")).status).toBe(403);
      expect((await call(m, p, {}, null)).status).toBe(401);
    }
  });

  test("a gateway change reloads speech: a provider removed turns its speech provider off", async () => {
    const v = vendor();
    const { call, speech } = await setup(`providers:\n  oa:\n    preset: openai\n    openai: '${v.url}/v1'\n    apiKeyEnv: OA\n    models: [tts-1]\n  keep:\n    messages: '${v.url}'\n`);
    await call("PUT", "/api/model/gateway/speech", { asr: [], tts: [{ gateway: "oa", model: "tts-1" }] });
    expect(speech.config!.off["gateway-oa"]).toBeUndefined();
    await call("PUT", "/api/model/gateway/providers/oa", { disabled: true });
    expect(speech.config!.off["gateway-oa"]).toMatch(/off/);
  });
});

describe("a MiniMax provider in the Speech group (its own speech kind)", () => {
  const gwYaml = (url: string) => `providers:\n  minimax:\n    preset: minimax\n    messages: '${url}/anthropic'\n    apiKeyEnv: OA\n    models: [MiniMax-M3]\n`;

  test("it serves ASR and TTS with its documented models and voices, which may be typed; the gateway itself does not list them", async () => {
    const m = minimaxVendor();
    const { call } = await setup(gwYaml(m.url).replace("models: [MiniMax-M3]", "models: [MiniMax-M3, asr-1.0, speech-2.8-hd]"));
    const p = (await call("GET", "/api/model/gateway/speech")).json.providers.find((x: { name: string }) => x.name === "minimax");
    expect(p.serves).toEqual({ asr: true, tts: true, image: expect.stringMatching(/no openai base/) });
    expect(p.asrModels).toEqual(["asr-1.0"]);
    expect(p.ttsModels).toContain("speech-2.8-hd");
    expect(p.voices["speech-2.8-hd"]).toContain("Chinese (Mandarin)_News_Anchor");
    expect(p.voicesOpen).toBe(true);
    const info = (await call("GET", "/api/model/gateway")).json;
    const row = info.providers.find((x: { name: string }) => x.name === "minimax");
    expect(row.serves).toMatchObject({ asr: true, tts: true });
    expect(row.kinds).toMatchObject({ "asr-1.0": "asr", "speech-2.8-hd": "tts" });
    // Nothing for the gateway to forward: its own speech lists stay without these.
    expect([info.asrModels, info.ttsModels]).toEqual([[], []]);
  });

  test("saved as kind minimax with the vendor's ids; it answers with the gateway provider's key and host; no voices list is written", async () => {
    const m = minimaxVendor();
    const { call, speech } = await setup(gwYaml(m.url));
    const order = { asr: [{ gateway: "minimax", model: "asr-1.0" }], tts: [{ gateway: "minimax", model: "speech-2.8-hd", voice: "Chinese (Mandarin)_News_Anchor" }] };
    expect((await call("PUT", "/api/model/gateway/speech", order)).json).toMatchObject({ ok: true, applied: true, after: { asr: ["gateway-minimax"], tts: ["gateway-minimax"] } });
    const text = await readFile(join(home, "providers.yaml"), "utf8");
    expect(text).toContain("    gateway-minimax:\n      kind: minimax\n      gateway: space\n      provider: minimax\n      asrModel: asr-1.0\n      ttsModel: speech-2.8-hd\n      voice: \"Chinese (Mandarin)_News_Anchor\"\n");
    expect(text).not.toContain("voices:");
    expect(text).not.toContain(KEY);
    expect((await call("GET", "/api/model/gateway/speech")).json.order).toEqual(order);
    // Saving the same again writes nothing.
    expect((await call("PUT", "/api/model/gateway/speech", order)).json.unchanged).toBe(true);
    const spoken = await speech.speak({ app: "notes", tag: "t" }, { text: "hi", voices: [] });
    expect([spoken.call.provider, spoken.call.kind, spoken.contentType]).toEqual(["gateway-minimax", "minimax", "audio/wav"]);
    expect(m.seen.at(-1)).toMatchObject({ path: "/v1/t2a_v2", auth: `Bearer ${KEY}`, json: { model: "speech-2.8-hd", voice_setting: { voice_id: "Chinese (Mandarin)_News_Anchor" } } });
    const heard = await speech.transcribe({ app: "notes", tag: "t" }, { file: new Blob([WAV]), filename: "a.wav", language: "zh", context: "" });
    expect(heard.result.segments).toEqual([{ start: 0, end: 1.2, text: "hello from ai-space" }]);
    expect(m.seen.at(-1)).toMatchObject({ path: "/v1/speech_to_text", language: "zh", form: { model: "asr-1.0", response_format: "verbose_json" } });
    // A cloud provider: a local-only app is refused.
    expect((await speech.speak({ app: "diary", tag: "t" }, { text: "hi", voices: [] }).catch((e) => e)).code).toBe("local_only");
  });

  test("the row's tests: TTS then ASR on that clip; a refused key is a failure without the key", async () => {
    const m = minimaxVendor();
    const { call } = await setup(gwYaml(m.url));
    const tts = (await call("POST", "/api/model/gateway/speech/test", { role: "tts", provider: "minimax", model: "speech-2.8-turbo" })).json;
    expect(tts).toMatchObject({ ok: true, role: "tts", contentType: "audio/wav", bytes: WAV.length });
    // No voice sent: the first documented one.
    expect(m.seen[0]!.json).toMatchObject({ model: "speech-2.8-turbo", voice_setting: { voice_id: "English_Graceful_Lady" }, audio_setting: { format: "wav" } });
    expect((await call("POST", "/api/model/gateway/speech/test", { role: "asr", provider: "minimax", model: "asr-1.0", audio: tts.audio })).json).toMatchObject({ ok: true, text: "hello from ai-space" });
    // A vendor that takes another key refuses this one: inside HTTP 200, as t2a_v2 does.
    const other = minimaxVendor("sk-another-key");
    const { call: wrong } = await setup(gwYaml(other.url));
    const bad = (await wrong("POST", "/api/model/gateway/speech/test", { role: "tts", provider: "minimax", model: "speech-2.8-turbo" })).json;
    expect(bad).toMatchObject({ ok: true, failed: true, error: expect.stringContaining("(1004)") });
    expect(JSON.stringify(bad)).not.toContain(KEY);
  });
});

describe("the Image group", () => {
  test("which providers can draw, and a test picture through the gateway", async () => {
    const v = vendor();
    const { call } = await setup(`providers:\n  oa:\n    preset: openai\n    openai: '${v.url}/v1'\n    apiKeyEnv: OA\n    models: [gpt-image-1, chat]\n  ds:\n    preset: deepseek\n    messages: '${v.url}'\ntiers:\n  image: oa/gpt-image-1\n`);
    const view = (await call("GET", "/api/model/gateway")).json;
    expect(view.imageModels).toEqual(["oa/gpt-image-1"]);
    expect(view.providers.find((p: { name: string }) => p.name === "ds").serves.image).toBe("the vendor documents none");
    // The test names its picture model: the old tiers.image is not read.
    expect((await call("POST", "/api/model/gateway/image/test", {})).json).toMatchObject({ ok: false, error: "pick the picture model to test" });
    const r = (await call("POST", "/api/model/gateway/image/test", { model: "oa/gpt-image-1" })).json;
    expect(r).toMatchObject({ ok: true, type: "image/png", bytes: PNG.length, served: "oa/gpt-image-1" });
    expect(v.seen.at(-1)).toMatchObject({ path: "/v1/images/generations", json: { model: "gpt-image-1", n: 1 } });
    expect((await call("POST", "/api/model/gateway/image/test", { model: "ds/x" })).json).toMatchObject({ ok: true, failed: true });
  });
});
