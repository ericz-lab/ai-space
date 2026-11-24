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
