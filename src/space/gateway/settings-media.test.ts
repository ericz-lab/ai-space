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
import { kindOf, servesOf } from "./kinds.ts";
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

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "space-gw-media-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const voiceStudio = { hasLocal: () => false, servicePort: () => undefined, callLocal: async () => new Response("", { status: 503 }), callRemote: async () => new Response("", { status: 503 }), peers: { get: () => undefined, names: () => [] } } as never;

async function setup(gatewayYaml?: string) {
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
      return p ? { openai: Boolean(p.openai), ...(off ? { off } : {}) } : undefined;
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
    speech: { config: () => speech.config, source: () => speech.status().source, configError: () => speech.status().configError },
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

describe("the speech choice in providers.yaml (docs/speech.md#through-the-gateway)", () => {
  const both = (asr: string, tts: string) => ({ asr: { place: asr as "off", provider: "oa", model: "whisper-1" }, tts: { place: tts as "off", provider: "oa", model: "tts-1", voice: "alloy" } });

  test("no file: the built-in voice-studio default is written out, and stays the default with the gateway as fallback", () => {
    const { text, after } = setSpeechText(undefined, both("fallback", "fallback"), {});
    expect(text).toContain("    voice-studio:\n      kind: voice-studio\n      app: voice-studio\n");
    const b = builtinSpeech();
    for (const role of ["asr", "tts", "live"] as const) expect(after.default[role]).toBe(b.default[role]);
    expect(chainOf(after, "asr")).toEqual(["voice-studio", "gateway-oa"]);
    expect(chainOf(after, "tts")).toEqual(["voice-studio", "gateway-oa"]);
    expect(chainOf(after, "live")).toEqual(["voice-studio"]);
  });

  test("default for TTS only moves TTS; live stays; back to off restores the old default", () => {
    const first = setSpeechText(undefined, both("fallback", "fallback"), {}).text;
    const moved = setSpeechText(first, both("fallback", "default"), {});
    expect(chainOf(moved.after, "tts")).toEqual(["gateway-oa", "voice-studio"]);
    expect(chainOf(moved.after, "asr")).toEqual(["voice-studio", "gateway-oa"]);
    expect(chainOf(moved.after, "live")).toEqual(["voice-studio"]);
    const back = setSpeechText(moved.text, both("off", "off"), {});
    expect(back.after.default).toEqual({ asr: "voice-studio", tts: "voice-studio", live: "voice-studio" });
    expect(back.after.providers.map((p) => p.name)).toEqual(["voice-studio"]);
  });

  test("a hand-written file: comments, other providers and named voices kept; an ASR default leaves live where it was", () => {
    const hand = "# my speech\nspeech:\n  default: { asr: gpu, tts: gpu }   # both on the GPU\n  providers:\n    gpu: { kind: voice-studio, machine: box }  # the GPU box\n    openai:\n      kind: openai-compatible\n      apiKeyEnv: OPENAI_API_KEY   # mine\n  fallback:\n    asr: [openai]\n  voices:\n    narrator: { gpu: en-Frank, openai: onyx }\n";
    const env = { OPENAI_API_KEY: "sk-x" };
    const before = parseProvidersYaml(hand, env).config;
    const { text, after } = setSpeechText(hand, { asr: { place: "default", provider: "oa", model: "whisper-1" }, tts: { place: "off" } }, env);
    expect(text).toContain("# my speech\n");
    expect(text).toContain("    gpu: { kind: voice-studio, machine: box }  # the GPU box\n");
    expect(text).toContain("      apiKeyEnv: OPENAI_API_KEY   # mine\n");
    expect(text).toContain("  default:   # both on the GPU\n");
    expect(after.voices).toEqual(before.voices);
    expect(chainOf(after, "asr")).toEqual(["gateway-oa", "gpu", "openai"]);
    expect(chainOf(after, "live")).toEqual(chainOf(before, "live"));
    expect(chainOf(after, "tts")).toEqual(["gpu"]);
  });

  test("a file the page cannot edit is refused with the reason", () => {
    expect(speechEditProblem("speech: { providers: { gpu: { kind: voice-studio } } }\n", {})).toMatch(/one line/);
    expect(speechEditProblem("speech:\n  providers: { gpu: { kind: voice-studio } }\n", {})).toMatch(/one line/);
    expect(speechEditProblem("speech:\n  providers:\n    gpu:\n      kind: voice-studio\n", {})).toBeUndefined();
  });

  test("the gateway's speech provider is a cloud provider: a local-only app never reaches it", async () => {
    const v = vendor();
    const { speech, call } = await setup(`providers:\n  oa:\n    preset: openai\n    openai: '${v.url}/v1'\n    apiKeyEnv: OA\n    models: [whisper-1, tts-1]\n`);
    expect((await call("PUT", "/api/model/gateway/speech", both("off", "default"))).status).toBe(200);
    expect(speech.cells().find((c) => c.provider === "gateway-oa")?.selfHosted).toBe(false);
    const seen = v.seen.length;
    const refused = await speech.speak({ app: "diary", tag: "t" }, { text: "secret", voices: [] }).catch((e) => e);
    expect(refused).toBeInstanceOf(SpeechError);
    expect(refused).toMatchObject({ status: 403, code: "local_only" });
    expect(v.seen.length).toBe(seen);
    // Another app is answered by the gateway.
    const ok = await speech.speak({ app: "notes", tag: "t" }, { text: "hello", voices: [] });
    expect(new Uint8Array(ok.audio)).toEqual(WAV);
  });
});

describe("the Speech group's routes", () => {
  test("view, preview, save as fallback (the default does not move), then as TTS default, applied at once; tests of each", async () => {
    const v = vendor();
    const { call, speech, reloads, lines } = await setup(`providers:\n  oa:\n    preset: openai\n    openai: '${v.url}/v1'\n    apiKeyEnv: OA\n    models: [gpt-5, whisper-1, tts-1]\n  ds:\n    preset: deepseek\n    messages: '${v.url}'\n    apiKeyEnv: OA\n`);
    const view = (await call("GET", "/api/model/gateway/speech")).json;
    expect(view.exists).toBe(false);
    expect(view.now).toEqual({ asr: ["voice-studio"], tts: ["voice-studio"], live: ["voice-studio"] });
    expect(view.choice).toEqual({ asr: { place: "off" }, tts: { place: "off" } });
    const oa = view.providers.find((p: { name: string }) => p.name === "oa");
    expect(oa.asrModels).toContain("whisper-1");
    expect(oa.ttsModels).toEqual(expect.arrayContaining(["tts-1", "gpt-4o-mini-tts"]));
    expect(oa.voices["tts-1"]).toContain("alloy");
    expect(view.providers.find((p: { name: string }) => p.name === "ds").serves.tts).toMatch(/tools\/tts/);

    // A provider that cannot speak is refused.
    expect((await call("PUT", "/api/model/gateway/speech", { asr: { place: "off" }, tts: { place: "default", provider: "ds", model: "x" } })).status).toBe(400);
    const choice = { asr: { place: "fallback", provider: "oa", model: "whisper-1" }, tts: { place: "fallback", provider: "oa", model: "tts-1", voice: "nova" } };
    const preview = await call("PUT", "/api/model/gateway/speech", { ...choice, dryRun: true });
    expect(preview.json.after).toEqual({ asr: ["voice-studio", "gateway-oa"], tts: ["voice-studio", "gateway-oa"], live: ["voice-studio"] });
    expect(await Bun.file(join(home, "providers.yaml")).exists()).toBe(false);

    const saved = await call("PUT", "/api/model/gateway/speech", choice);
    expect(saved.json).toMatchObject({ ok: true, applied: true, created: true });
    expect(reloads()).toBe(1);
    expect(speech.status().default).toEqual({ asr: "voice-studio", tts: "voice-studio", live: "voice-studio" });
    expect(speech.status().fallback).toMatchObject({ asr: ["gateway-oa"], tts: ["gateway-oa"] });
    expect((await call("GET", "/api/model/gateway/speech")).json.choice).toEqual({ asr: { place: "fallback", provider: "oa", model: "whisper-1" }, tts: { place: "fallback", provider: "oa", model: "tts-1", voice: "nova" } });

    // The file keeps its mode; TTS default now: the running service moves with no restart.
    if (process.platform !== "win32") await chmod(join(home, "providers.yaml"), 0o640);
    await call("PUT", "/api/model/gateway/speech", { ...choice, tts: { ...choice.tts, place: "default" } });
    if (process.platform !== "win32") expect((await stat(join(home, "providers.yaml"))).mode & 0o777).toBe(0o640);
    expect(speech.status().default).toEqual({ asr: "voice-studio", tts: "gateway-oa", live: "voice-studio" });
    const spoken = await speech.speak({ app: "notes", tag: "t" }, { text: "hi", voices: [] });
    expect(spoken.call.provider).toBe("gateway-oa");
    expect(v.seen.at(-1)).toMatchObject({ path: "/v1/audio/speech", json: { model: "tts-1", voice: "nova", input: "hi" } });

    // Tests: TTS gives audio to play; ASR transcribes that clip; both through the gateway.
    const tts = (await call("POST", "/api/model/gateway/speech/test", { role: "tts", provider: "oa", model: "tts-1", voice: "alloy" })).json;
    expect(tts).toMatchObject({ ok: true, role: "tts", contentType: "audio/wav", bytes: WAV.length });
    expect(new Uint8Array(Buffer.from(tts.audio, "base64"))).toEqual(WAV);
    const asr = (await call("POST", "/api/model/gateway/speech/test", { role: "asr", provider: "oa", model: "whisper-1", audio: tts.audio })).json;
    expect(asr).toMatchObject({ ok: true, role: "asr", text: "hello from ai-space" });
    // A vendor error comes back as text, never with the key.
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
    await call("PUT", "/api/model/gateway/speech", { asr: { place: "off" }, tts: { place: "fallback", provider: "oa", model: "tts-1" } });
    expect(speech.config!.off["gateway-oa"]).toBeUndefined();
    await call("PUT", "/api/model/gateway/providers/oa", { disabled: true });
    expect(speech.config!.off["gateway-oa"]).toMatch(/off/);
  });
});

describe("the Image group", () => {
  test("which providers can draw, and a test picture through the gateway", async () => {
    const v = vendor();
    const { call } = await setup(`providers:\n  oa:\n    preset: openai\n    openai: '${v.url}/v1'\n    apiKeyEnv: OA\n    models: [gpt-image-1, chat]\n  ds:\n    preset: deepseek\n    messages: '${v.url}'\ntiers:\n  image: oa/gpt-image-1\n`);
    const view = (await call("GET", "/api/model/gateway")).json;
    expect(view.imageModels).toEqual(["oa/gpt-image-1"]);
    expect(view.providers.find((p: { name: string }) => p.name === "ds").serves.image).toBe("the vendor documents none");
    const r = (await call("POST", "/api/model/gateway/image/test", {})).json;
    expect(r).toMatchObject({ ok: true, type: "image/png", bytes: PNG.length, served: "oa/gpt-image-1" });
    expect(v.seen.at(-1)).toMatchObject({ path: "/v1/images/generations", json: { model: "gpt-image-1", n: 1 } });
    expect((await call("POST", "/api/model/gateway/image/test", { model: "ds/x" })).json).toMatchObject({ ok: true, failed: true });
  });
});
