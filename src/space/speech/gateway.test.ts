import { afterAll, describe, expect, test } from "bun:test";
import { GATEWAY_PREFIX, createGatewayRoutes } from "../gateway/api.ts";
import { parseGatewayYaml } from "../gateway/config.ts";
import { ModelGateway } from "../gateway/service.ts";
import { checkGatewayProviders, parseProvidersYaml } from "./config.ts";
import { OpenAiAdapter } from "./openai.ts";
import type { OpenAiSpec } from "./types.ts";

/**
 * Speech through a model gateway (docs/model-gateway.md#speech): the `gateway:` shorthand on an
 * openai-compatible provider, and the built-in gateway's `/v1/audio/*` passthrough against a
 * provider stand-in on a loopback port. No request leaves the machine.
 */

const stops: (() => void)[] = [];
afterAll(() => {
  for (const s of stops) s();
});

type Seen = { path: string; auth: string | null; form?: Record<string, string>; json?: Record<string, unknown> };

function audioVendor() {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const s: Seen = { path: url.pathname, auth: req.headers.get("authorization") };
      if (req.headers.get("content-type")?.startsWith("multipart/")) {
        const form = await req.formData();
        s.form = Object.fromEntries([...form.entries()].map(([k, v]) => [k, typeof v === "string" ? v : `<file ${(v as File).name} ${(v as File).size}>`]));
      } else s.json = (await req.json()) as Record<string, unknown>;
      seen.push(s);
      if (url.pathname.endsWith("/audio/speech")) return new Response(new Uint8Array([82, 73, 70, 70, 1, 2, 3]), { headers: { "content-type": "audio/wav" } });
      return Response.json({ text: " hello ", usage: { type: "tokens", input_tokens: 12, output_tokens: 3 } });
    },
  });
  stops.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}/v1`, seen };
}

function gatewayOver(openaiBase: string) {
  const { config } = parseGatewayYaml(`providers:\n  openai: { openai: '${openaiBase}', apiKeyEnv: OA }\n  ds: { messages: 'http://127.0.0.1:9' }\n`, { OA: "sk-openai" });
  const gateway = new ModelGateway({ config, log: () => {} });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", routes: createGatewayRoutes(gateway), fetch: () => new Response("", { status: 404 }) });
  stops.push(() => server.stop(true));
  gateway.listen(`http://127.0.0.1:${server.port}${GATEWAY_PREFIX}`);
  return gateway;
}

describe("providers.yaml: gateway: on an openai-compatible provider", () => {
  test("space: no url or key of its own, the models as the gateway names them", () => {
    const { config } = parseProvidersYaml("speech:\n  providers:\n    gw: { kind: openai-compatible, gateway: space, provider: openai, asrModel: gpt-4o-transcribe, voice: alloy }\n", {});
    expect(config.providers[0]).toEqual({ name: "gw", kind: "openai-compatible", url: "", asrModel: "openai/gpt-4o-transcribe", ttsModel: "openai/tts-1", selfHosted: false, voice: "alloy", gateway: { via: "space", provider: "openai" } });
    expect(config.off).toEqual({});
  });

  test("magpie: its address and caller key, as the runtimes reach it", () => {
    const { config } = parseProvidersYaml("speech:\n  providers:\n    mp: { kind: openai-compatible, gateway: magpie, provider: openai }\n", { MAGPIE_ADDR: "127.0.0.1:3999" });
    expect(config.providers[0]).toMatchObject({ url: "http://127.0.0.1:3999/v1", apiKey: "magpie-ai-space", asrModel: "openai/whisper-1", gateway: { via: "magpie", provider: "openai" } });
  });

  test("strict", () => {
    const bad = (p: string, msg: RegExp) => expect(() => parseProvidersYaml(`speech:\n  providers:\n    gw: { kind: openai-compatible, ${p} }\n`, {})).toThrow(msg);
    bad("gateway: space", /needs provider/);
    bad("provider: openai", /add gateway: space or gateway: magpie/);
    bad("gateway: other, provider: openai", /gateway must be space or magpie/);
    bad("gateway: space, provider: openai, url: 'https://x'", /drop url and apiKeyEnv/);
    bad("gateway: space, provider: openai, apiKeyEnv: K", /drop url and apiKeyEnv/);
  });

  test("a provider the built-in gateway cannot serve is off, with the reason", () => {
    const yaml = "speech:\n  default: { asr: a, tts: a }\n  providers:\n    a: { kind: openai-compatible, gateway: space, provider: openai, voice: alloy }\n    b: { kind: openai-compatible, gateway: space, provider: ds, voice: alloy }\n    c: { kind: openai-compatible, gateway: space, provider: nope, voice: alloy }\n";
    const { config } = parseProvidersYaml(yaml, {});
    const has = (name: string) => (name === "openai" ? { openai: true } : name === "ds" ? { openai: false } : undefined);
    expect(checkGatewayProviders(config, has, true)).toEqual([
      "speech provider b is off: the model gateway's provider ds has no openai base",
      "speech provider c is off: nope is not a provider of gateway.yaml",
    ]);
    expect(Object.keys(config.off)).toEqual(["b", "c"]);
    const again = parseProvidersYaml(yaml, {}).config;
    expect(checkGatewayProviders(again, has, false)[0]).toMatch(/built-in model gateway is off/);
  });
});

describe("speech through the built-in gateway", () => {
  const spec: OpenAiSpec = { name: "gw", kind: "openai-compatible", url: "", asrModel: "openai/whisper-1", ttsModel: "openai/tts-1", selfHosted: false, voice: "alloy", gateway: { via: "space", provider: "openai" } };
  const file = { file: new File(["abc"], "voice.m4a"), filename: "voice.m4a", language: "en", context: "" };

  test("transcribe: the multipart form as sent, only the model rewritten, the provider's key in place of the token", async () => {
    const v = audioVendor();
    const gateway = gatewayOver(v.url);
    const a = new OpenAiAdapter(spec, { gateway: gateway.link });
    expect(await a.transcribe(file)).toMatchObject({ text: "hello", language: "en" });
    expect(v.seen[0]).toEqual({ path: "/v1/audio/transcriptions", auth: "Bearer sk-openai", form: { file: "<file voice.m4a 3>", model: "whisper-1", response_format: "verbose_json", language: "en" } });
    expect(a.state()).toMatchObject({ where: "model gateway → openai", signedIn: true });
  });

  test("speak: the provider's audio back unchanged", async () => {
    const v = audioVendor();
    const gateway = gatewayOver(v.url);
    const a = new OpenAiAdapter(spec, { gateway: gateway.link });
    const r = await a.speak({ text: "hi", voices: [], language: "en" } as never);
    expect(new Uint8Array(r.audio)).toEqual(new Uint8Array([82, 73, 70, 70, 1, 2, 3]));
    expect(v.seen[0]!.json).toEqual({ model: "tts-1", input: "hi", voice: "alloy", response_format: "wav" });
  });

  test("with the gateway off a call fails with 503 and the reason", async () => {
    const a = new OpenAiAdapter(spec, { gateway: new ModelGateway({ log: () => {} }).link });
    await expect(a.transcribe(file)).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/built-in model gateway is off/) });
    expect(a.state()).toMatchObject({ signedIn: false });
  });
});
