import { afterAll, describe, expect, test } from "bun:test";
import { GATEWAY_PREFIX, createGatewayRoutes } from "../gateway/api.ts";
import { parseGatewayYaml } from "../gateway/config.ts";
import { ModelGateway } from "../gateway/service.ts";
import { createAnthropicApi } from "./anthropic-api.ts";
import { createClaudeCode, SPACE_GATEWAY_ENV } from "./claude-code.ts";
import { parseRuntimesYaml } from "./config.ts";
import { filledTiers } from "./magpie.ts";
import { RuntimeRegistry } from "./registry.ts";
import { fakeModelBin } from "./testing.ts";
import type { CompleteInput } from "./types.ts";

/**
 * Runtimes through the built-in model gateway (docs/model-gateway.md): `gateway: space` on a
 * claude-code or anthropic-api runtime, against the real gateway routes on a loopback port and a
 * provider stand-in. No network, no real key.
 */

const stops: (() => void)[] = [];
afterAll(() => {
  for (const s of stops) s();
});

function provider() {
  const seen: { body: Record<string, unknown>; auth: string | null }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = (await req.json()) as Record<string, unknown>;
      seen.push({ body, auth: req.headers.get("authorization") });
      return Response.json({ type: "message", role: "assistant", content: [{ type: "text", text: `vendor answer (${String(body.model)})` }], usage: { input_tokens: 4, output_tokens: 2 } });
    },
  });
  stops.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, seen };
}

function gatewayOver(vendorUrl: string) {
  const { config } = parseGatewayYaml(`providers:\n  ds: { messages: '${vendorUrl}', apiKeyEnv: K }\ngroups:\n  fast: [ds/deepseek-chat]\n`, { K: "sk-vendor" });
  const gateway = new ModelGateway({ config, log: () => {} });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", routes: createGatewayRoutes(gateway), fetch: () => new Response("", { status: 404 }) });
  stops.push(() => server.stop(true));
  gateway.listen(`http://127.0.0.1:${server.port}${GATEWAY_PREFIX}`);
  return gateway;
}

const input = (over: Partial<CompleteInput> = {}): CompleteInput => ({ prompt: "hello", system: "", model: "haiku", tag: "t", tools: [], timeoutMs: 20_000, maxTokens: 100, ...over });

describe("runtimes.yaml: gateway:", () => {
  test("space, magpie or an address on claude-code; magpie: keeps working; never with ssh", () => {
    const { config } = parseRuntimesYaml(
      "runtimes:\n  a:\n    kind: claude-code\n    gateway: space\n    models: { basic: fast, intermediate: ds/deepseek-v4-pro }\n  b:\n    kind: claude-code\n    gateway: magpie\n  c:\n    kind: claude-code\n    gateway: http://127.0.0.1:4000/\n  d:\n    kind: claude-code\n    magpie: http://127.0.0.1:3425\n",
      { MAGPIE_ADDR: "127.0.0.1:3999" },
    );
    expect(config.runtimes).toEqual([
      { name: "a", kind: "claude-code", bin: [], chatArgs: [], gateway: "space", models: { basic: "fast", intermediate: "ds/deepseek-v4-pro" } },
      { name: "b", kind: "claude-code", bin: [], chatArgs: [], magpie: "http://127.0.0.1:3999" },
      { name: "c", kind: "claude-code", bin: [], chatArgs: [], magpie: "http://127.0.0.1:4000" },
      { name: "d", kind: "claude-code", bin: [], chatArgs: [], magpie: "http://127.0.0.1:3425" },
    ]);
    expect(() => parseRuntimesYaml("runtimes:\n  a: { kind: claude-code, gateway: space, ssh: box }\n")).toThrow(/runs on this machine; drop ssh/);
    expect(() => parseRuntimesYaml("runtimes:\n  a: { kind: claude-code, gateway: space, magpie: 'http://127.0.0.1:3425' }\n")).toThrow(/name the model gateway once/);
    expect(() => parseRuntimesYaml("runtimes:\n  a: { kind: claude-code, gateway: 'http://x/v1/messages' }\n")).toThrow(/gateway must be space, magpie or a gateway's address/);
    expect(() => parseRuntimesYaml("runtimes:\n  a: { kind: claude-code, gateway: space }\nmachines:\n  box: { ssh: box }\nfallback:\n  a/basic: [box:a/basic]\n")).toThrow(/answers through a model gateway on this machine/);
  });

  test("anthropic-api with gateway: space needs no key variable and takes no url", () => {
    const { config, warnings } = parseRuntimesYaml("runtimes:\n  gw:\n    kind: anthropic-api\n    gateway: space\n    models: { basic: ds/deepseek-chat }\n", {});
    expect(warnings).toEqual([]);
    expect(config.runtimes[0]).toEqual({ name: "gw", kind: "anthropic-api", apiKey: "", apiUrl: "", gateway: "space", models: { basic: "ds/deepseek-chat" } });
    expect(() => parseRuntimesYaml("runtimes:\n  gw: { kind: anthropic-api, gateway: space, apiKeyEnv: K }\n", {})).toThrow(/takes no apiKeyEnv or url/);
    expect(() => parseRuntimesYaml("runtimes:\n  gw: { kind: anthropic-api, gateway: magpie }\n", {})).toThrow(/gateway must be space/);
  });

  test("a gateway runtime cannot run on another machine", () => {
    const reg = new RuntimeRegistry({ default: "a", runtimes: [{ name: "a", kind: "claude-code", bin: [], chatArgs: [], gateway: "space" }], machines: [{ name: "box", ssh: "box" }] });
    expect(() => reg.resolve("box:a/basic")).toThrow(/through a model gateway\) cannot run on another machine/);
  });
});

describe("unpinned tiers through the built-in gateway", () => {
  test("take the nearest pin, a lower one first", () => {
    expect(filledTiers({ junior: "j", advanced: "x" })).toEqual({ basic: "j", junior: "j", intermediate: "j", advanced: "x" });
    expect(filledTiers({})).toEqual({});
  });
});

describe("Claude Code with gateway: space", () => {
  test("each process gets the loopback address and a token of its own; served comes from the trace; nothing else changes", async () => {
    const vendor = provider();
    const gateway = gatewayOver(vendor.url);
    const rt = createClaudeCode({ name: "gw", kind: "claude-code", bin: fakeModelBin(), chatArgs: [], gateway: "space", models: { basic: "fast" } }, { gateway: gateway.link });
    const before = { ...process.env };
    process.env.ANTHROPIC_API_KEY = "sk-from-dotenv";
    let r;
    try {
      r = await rt.complete(input({ model: "haiku" }));
    } finally {
      if (before.ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = before.ANTHROPIC_API_KEY;
    }
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The fake CLI made its one call through the gateway with the alias's pin, without the .env key, betas off.
    expect(r.text).toContain("[space-gateway: model=fast betas=1 apikey=unset said=200 ");
    expect(r.text).toContain("vendor answer (deepseek-chat)");
    // The pins also go as --settings, carrying the same token.
    const settings = /--settings (\{.*?\}) -p/.exec(r.text)?.[1];
    expect(settings && JSON.parse(settings).env).toMatchObject({ ANTHROPIC_BASE_URL: gateway.link.base(), ANTHROPIC_DEFAULT_HAIKU_MODEL: "fast", ANTHROPIC_DEFAULT_FABLE_MODEL: "fast", ...SPACE_GATEWAY_ENV });
    expect(JSON.parse(settings!).env.ANTHROPIC_AUTH_TOKEN).toMatch(/^sgw-/);
    expect(r.served).toBe("ds/deepseek-chat");
    // The CLI's cost is Claude's price for another vendor's model: dropped. Its token counts stay.
    expect(r.costUsd).toBeUndefined();
    expect(r.usage).toBeDefined();
    expect(vendor.seen[0]!.auth).toBe("Bearer sk-vendor");
  });

  test("with the gateway off the call fails and says why", async () => {
    const gateway = new ModelGateway({ log: () => {} });
    const rt = createClaudeCode({ name: "gw", kind: "claude-code", bin: fakeModelBin(), chatArgs: [], gateway: "space" }, { gateway: gateway.link });
    expect(await rt.complete(input())).toMatchObject({ ok: false, error: expect.stringMatching(/built-in model gateway, which is off: no gateway.yaml/) });
  });
});

describe("anthropic-api with gateway: space", () => {
  test("a token per call instead of a key; what answered from the trace", async () => {
    const vendor = provider();
    const gateway = gatewayOver(vendor.url);
    const rt = createAnthropicApi({ name: "gw", kind: "anthropic-api", apiKey: "", apiUrl: "", gateway: "space" }, { gateway: gateway.link });
    const r = await rt.complete(input({ model: "fast" }));
    expect(r).toMatchObject({ ok: true, text: "vendor answer (deepseek-chat)", served: "ds/deepseek-chat", usage: { inputTokens: 4, outputTokens: 2 } });
    expect(vendor.seen[0]!.body.model).toBe("deepseek-chat");
  });
});

describe("pictures through the built-in gateway (anthropic-api with gateway: space)", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  function imageVendor(answer?: () => Response) {
    const seen: { path: string; auth: string | null; json?: Record<string, unknown>; form?: Record<string, string[]> }[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (req.headers.get("content-type")?.startsWith("multipart/")) {
          const form: Record<string, string[]> = {};
          for (const [k, v] of await req.formData()) (form[k] ??= []).push(typeof v === "string" ? v : `<file ${(v as File).name} ${(v as File).size} ${(v as File).type}>`);
          seen.push({ path, auth: req.headers.get("authorization"), form });
        } else seen.push({ path, auth: req.headers.get("authorization"), json: (await req.json()) as Record<string, unknown> });
        return answer?.() ?? Response.json({ created: 1, data: [{ b64_json: Buffer.from(png).toString("base64") }], usage: { input_tokens: 50, output_tokens: 4000 } });
      },
    });
    stops.push(() => server.stop(true));
    return { url: `http://127.0.0.1:${server.port}/v1`, seen };
  }
  function gatewayWith(openaiBase: string, messages?: string) {
    const { config } = parseGatewayYaml(`providers:\n  openai: { openai: '${openaiBase}', apiKeyEnv: OA }\n${messages ? `  ds: { messages: '${messages}' }\n` : ""}`, { OA: "sk-openai" });
    const gateway = new ModelGateway({ config, log: () => {} });
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", routes: createGatewayRoutes(gateway), fetch: () => new Response("", { status: 404 }) });
    stops.push(() => server.stop(true));
    gateway.listen(`http://127.0.0.1:${server.port}${GATEWAY_PREFIX}`);
    return gateway;
  }
  const image = (over: Partial<import("./types.ts").ImageInput> = {}) => ({ prompt: "a red square", system: "", model: "openai/gpt-image-1", tag: "image", files: [], timeoutMs: 20_000, ...over });

  test("offered only when a provider has an openai base", () => {
    const withOpenai = createAnthropicApi({ name: "gw", kind: "anthropic-api", apiKey: "", apiUrl: "", gateway: "space" }, { gateway: gatewayWith("http://127.0.0.1:9/v1").link });
    expect(withOpenai.capabilities).toEqual({ complete: true, agent: false, chat: false, image: true });
    const { config } = parseGatewayYaml("providers:\n  ds: { messages: 'http://127.0.0.1:9' }\n", {});
    const textOnly = createAnthropicApi({ name: "gw", kind: "anthropic-api", apiKey: "", apiUrl: "", gateway: "space" }, { gateway: new ModelGateway({ config }).link });
    expect(textOnly.capabilities.image).toBeUndefined();
    expect(textOnly.image).toBeUndefined();
  });

  test("generations: the picture as b64_json, no response_format for a GPT image model, usage kept", async () => {
    const v = imageVendor();
    const rt = createAnthropicApi({ name: "gw", kind: "anthropic-api", apiKey: "", apiUrl: "", gateway: "space" }, { gateway: gatewayWith(v.url).link });
    const r = await rt.image!(image());
    expect(r).toMatchObject({ ok: true, text: "1 image by openai/gpt-image-1", usage: { inputTokens: 50, outputTokens: 4000 } });
    if (r.ok) expect(r.images).toEqual([{ type: "image/png", bytes: png }]);
    expect(v.seen[0]).toEqual({ path: "/v1/images/generations", auth: "Bearer sk-openai", json: { model: "gpt-image-1", prompt: "a red square", n: 1 } });
    // Another model is asked for b64_json.
    await rt.image!(image({ model: "openai/dall-e-3" }));
    expect(v.seen[1]!.json).toMatchObject({ model: "dall-e-3", response_format: "b64_json" });
  });

  test("edits: one image[] per input file, multipart, the model rewritten by the gateway", async () => {
    const v = imageVendor();
    const dir = `${process.env.TMPDIR ?? "/tmp"}/gw-img-${crypto.randomUUID()}`;
    await Bun.write(`${dir}/img1.png`, png);
    try {
      const rt = createAnthropicApi({ name: "gw", kind: "anthropic-api", apiKey: "", apiUrl: "", gateway: "space" }, { gateway: gatewayWith(v.url).link });
      const r = await rt.image!(image({ prompt: "make it blue", system: "Keep the size.", files: [{ name: "img1.png", path: `${dir}/img1.png` }] }));
      expect(r.ok).toBe(true);
      expect(v.seen[0]).toEqual({ path: "/v1/images/edits", auth: "Bearer sk-openai", form: { model: ["gpt-image-1"], prompt: ["Keep the size.\n\nmake it blue"], "image[]": ["<file img1.png 12 image/png>"] } });
    } finally {
      await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true }));
    }
  });

  test("/api/model/image's service resolves a tier of such a runtime and records the call, as for codex-cli", async () => {
    const v = imageVendor();
    const gateway = gatewayWith(v.url);
    const registry = new RuntimeRegistry({ runtimes: [{ name: "gw", kind: "anthropic-api", apiKey: "", apiUrl: "", gateway: "space", models: { basic: "openai/gpt-image-1" } }] }, { gateway: gateway.link });
    const { ModelService } = await import("../model/service.ts");
    const { ModelStore } = await import("../model/store.ts");
    const service = new ModelService({ store: new ModelStore(":memory:"), runtimes: registry, log: () => {} });
    const { outcome, call } = await service.image("app", { prompt: "p", system: "", model: "gw/basic", tag: "image", files: [], timeoutMs: 20_000 });
    expect(outcome.ok).toBe(true);
    expect(call).toMatchObject({ runtime: "gw", model: "openai/gpt-image-1", status: "ok", backend: "api" });
  });

  test("an answer with URLs only is refused: ai-space does not fetch what an answer names", async () => {
    const v = imageVendor(() => Response.json({ data: [{ url: "https://cdn.example.com/x.png" }] }));
    const rt = createAnthropicApi({ name: "gw", kind: "anthropic-api", apiKey: "", apiUrl: "", gateway: "space" }, { gateway: gatewayWith(v.url).link });
    expect(await rt.image!(image({ model: "openai/cogview-4" }))).toMatchObject({ ok: false, error: expect.stringMatching(/b64_json only/) });
  });

  test("a provider without an openai base: the gateway's own error", async () => {
    const v = imageVendor();
    const rt = createAnthropicApi({ name: "gw", kind: "anthropic-api", apiKey: "", apiUrl: "", gateway: "space" }, { gateway: gatewayWith(v.url, "http://127.0.0.1:9").link });
    expect(await rt.image!(image({ model: "ds/some-model" }))).toMatchObject({ ok: false, error: expect.stringMatching(/API 400: no provider can take ds\/some-model: .*has no openai base/) });
  });
});

describe("the built-in gateway's tiers (docs/model-gateway.md#tiers)", () => {
  const yaml = (vendorUrl: string) =>
    `providers:\n  ds: { messages: '${vendorUrl}', apiKeyEnv: K }\n  glm: { messages: '${vendorUrl}', apiKeyEnv: K }\n  openai: { openai: '${vendorUrl}/v1', apiKeyEnv: K }\ngroups:\n  fast: [ds/deepseek-chat, glm/glm-4.5-air]\ntiers:\n  basic: fast\n  advanced: glm/glm-4.6\n  image: openai/gpt-image-1\n`;
  function gatewayTiered(vendorUrl: string) {
    const { config } = parseGatewayYaml(yaml(vendorUrl), { K: "sk-vendor" });
    const gateway = new ModelGateway({ config, log: () => {} });
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", routes: createGatewayRoutes(gateway), fetch: () => new Response("", { status: 404 }) });
    stops.push(() => server.stop(true));
    gateway.listen(`http://127.0.0.1:${server.port}${GATEWAY_PREFIX}`);
    return gateway;
  }

  test("an API runtime: its own pin, else the gateway's tier; an image call goes to the picture tier", () => {
    const gateway = gatewayTiered("http://127.0.0.1:9");
    const reg = new RuntimeRegistry(
      { default: "api", runtimes: [{ name: "api", kind: "anthropic-api", apiKey: "", apiUrl: "", gateway: "space", models: { advanced: "ds/deepseek-v4-pro" } }, { name: "plain", kind: "anthropic-api", apiKey: "k", apiUrl: "", models: { basic: "claude-haiku" } }] },
      { gateway: gateway.link },
    );
    expect(reg.resolve("api/advanced").model).toBe("ds/deepseek-v4-pro");
    expect(reg.resolve("api/basic").model).toBe("fast");
    expect(() => reg.resolve("api/junior")).toThrow(/no model for tier junior/);
    expect(reg.resolve("api/advanced", "image").model).toBe("openai/gpt-image-1");
    expect(reg.resolve("api/ds/deepseek-chat", "image").model).toBe("ds/deepseek-chat");
    // A runtime not through the gateway keeps its own tiers.
    expect(reg.resolve("plain/basic").model).toBe("claude-haiku");
    expect(reg.resolve("plain/basic", "image").model).toBe("claude-haiku");
    // The choices pickers list follow the gateway too.
    expect(reg.tierOptions({ all: true }).filter((o) => o.runtime === "api").map((o) => [o.tier, o.model])).toEqual([["basic", "fast"], ["advanced", "ds/deepseek-v4-pro"]]);
    // Saved in Settings: the next call resolves the new tiers, no restart.
    gateway.setTiers({ junior: "glm/glm-4.6" });
    expect(reg.resolve("api/junior").model).toBe("glm/glm-4.6");
    expect(() => reg.resolve("api/basic")).toThrow(/no model for tier basic/);
    expect(reg.resolve("api/advanced", "image").model).toBe("ds/deepseek-v4-pro");
  });

  test("Claude Code: its own pin, else the gateway's tier, else the nearest of those; read per process", async () => {
    const vendor = provider();
    const gateway = gatewayTiered(vendor.url);
    const rt = createClaudeCode({ name: "gw", kind: "claude-code", bin: fakeModelBin(), chatArgs: [], gateway: "space", models: { advanced: "ds/deepseek-v4-pro" } }, { gateway: gateway.link });
    const envOf = async () => {
      const r = await rt.complete(input({ model: "haiku" }));
      if (!r.ok) throw new Error(r.error);
      return JSON.parse(/--settings (\{.*?\}) -p/.exec(r.text)![1]!).env as Record<string, string>;
    };
    expect(await envOf()).toMatchObject({ ANTHROPIC_DEFAULT_HAIKU_MODEL: "fast", ANTHROPIC_DEFAULT_SONNET_MODEL: "fast", ANTHROPIC_DEFAULT_OPUS_MODEL: "fast", ANTHROPIC_DEFAULT_FABLE_MODEL: "ds/deepseek-v4-pro", ANTHROPIC_SMALL_FAST_MODEL: "fast" });
    gateway.setTiers({ junior: "glm/glm-4.6" });
    expect(await envOf()).toMatchObject({ ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm/glm-4.6", ANTHROPIC_DEFAULT_SONNET_MODEL: "glm/glm-4.6", ANTHROPIC_DEFAULT_OPUS_MODEL: "glm/glm-4.6", ANTHROPIC_DEFAULT_FABLE_MODEL: "ds/deepseek-v4-pro" });
  });
});
