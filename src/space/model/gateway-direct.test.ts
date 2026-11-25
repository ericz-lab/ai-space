import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GATEWAY_PREFIX, createGatewayRoutes } from "../gateway/api.ts";
import { parseGatewayYaml } from "../gateway/config.ts";
import { ModelGateway } from "../gateway/service.ts";
import { RuntimeRegistry, claudeOnly } from "../runtimes/registry.ts";
import { fakeModelBin } from "../runtimes/testing.ts";
import { createModelRoutes } from "./api.ts";
import { gatewayModelOptions } from "./app-models.ts";
import { ModelService } from "./service.ts";
import { ModelStore } from "./store.ts";

/**
 * An app's call that names a gateway model (docs/model.md#models): it goes to the built-in model
 * gateway directly, with no runtime, against the real gateway routes on a loopback port and vendor
 * stand-ins. No network, no real key.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const stops: (() => void)[] = [];
afterAll(() => {
  for (const s of stops) s();
});

function vendor() {
  const seen: { path: string; auth: string | null; body: Record<string, unknown> }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const body = (await req.json()) as Record<string, unknown>;
      seen.push({ path, auth: req.headers.get("authorization") ?? req.headers.get("x-api-key"), body });
      if (path.endsWith("/images/generations")) return Response.json({ created: 1, data: [{ b64_json: Buffer.from(PNG).toString("base64") }] });
      if (body.model === "down") return Response.json({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }, { status: 429 });
      return Response.json({ type: "message", role: "assistant", content: [{ type: "text", text: `vendor answer (${String(body.model)})` }], usage: { input_tokens: 4, output_tokens: 2 } });
    },
  });
  stops.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, seen };
}

function gatewayOver(vendorUrl: string) {
  const yaml =
    `providers:\n  ds: { messages: '${vendorUrl}', apiKeyEnv: K, models: [deepseek-chat, down] }\n  oa: { openai: '${vendorUrl}/v1', apiKeyEnv: K, models: [gpt-image-1, tts-1], kinds: { gpt-image-1: image, tts-1: tts } }\n` +
    `groups:\n  fast: [ds/down, ds/deepseek-chat]\n  draw: [oa/gpt-image-1]\n`;
  const { config } = parseGatewayYaml(yaml, { K: "sk-vendor" });
  const gateway = new ModelGateway({ config, log: () => {} });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", routes: createGatewayRoutes(gateway), fetch: () => new Response("", { status: 404 }) });
  stops.push(() => server.stop(true));
  gateway.listen(`http://127.0.0.1:${server.port}${GATEWAY_PREFIX}`);
  return gateway;
}

let dir: string;
let store: ModelStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "space-gateway-direct-"));
  store = new ModelStore(join(dir, "space.db"));
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

const text = (model: string, over: Record<string, unknown> = {}) => ({ model, prompt: "hi", system: "", tag: "notes", tools: [], timeoutMs: 10_000, maxTokens: 100, ...over });
const picture = (model: string) => ({ model, prompt: "a red circle", system: "", tag: "image", files: [], timeoutMs: 10_000 });

describe("a gateway model, called directly", () => {
  test("text: Anthropic Messages through the loopback route with a token of its own; the row says gateway, no runtime", async () => {
    const v = vendor();
    const gateway = gatewayOver(v.url);
    // Only a Claude Code runtime here: nothing in runtimes.yaml answers through the gateway.
    const service = new ModelService({ store, runtimes: claudeOnly(fakeModelBin()), log: () => {}, gateway: { link: gateway.link } });
    const { outcome, call } = await service.run("notes", text("ds/deepseek-chat"));
    expect(outcome).toMatchObject({ ok: true, text: "vendor answer (deepseek-chat)", backend: "gateway", served: "ds/deepseek-chat" });
    expect(v.seen[0]).toMatchObject({ path: "/v1/messages", auth: "Bearer sk-vendor", body: { model: "deepseek-chat" } });
    expect(call).toMatchObject({ app: "notes", model: "ds/deepseek-chat", backend: "gateway", status: "ok", usage: { inputTokens: 4, outputTokens: 2 } });
    expect(call.runtime).toBeUndefined();
    // What answered is in the trace, under no runtime.
    expect(call.trace?.tries).toEqual([expect.objectContaining({ model: "ds/deepseek-chat", ok: true, served: "ds/deepseek-chat" })]);
    expect(call.trace!.tries[0]!.runtime).toBeUndefined();
  });

  test("a group: the gateway's own failover answers, and the row keeps the group asked for and what served it", async () => {
    const v = vendor();
    const service = new ModelService({ store, runtimes: claudeOnly(fakeModelBin()), log: () => {}, gateway: { link: gatewayOver(v.url).link } });
    const { outcome, call } = await service.run("notes", text("fast"));
    expect(outcome).toMatchObject({ ok: true, text: "vendor answer (deepseek-chat)", served: "ds/deepseek-chat" });
    expect(v.seen.map((s) => s.body.model)).toEqual(["down", "deepseek-chat"]);
    expect(call).toMatchObject({ model: "fast", backend: "gateway", tries: 1 });
  });

  test("a runtime name still goes to the runtime; a bare tier and the machine syntax are unchanged", async () => {
    const v = vendor();
    const gateway = gatewayOver(v.url);
    const service = new ModelService({ store, runtimes: claudeOnly(fakeModelBin()), log: () => {}, gateway: { link: gateway.link } });
    const { outcome, call } = await service.run("notes", text("claude/haiku"));
    expect(outcome.ok).toBe(true);
    expect(call).toMatchObject({ runtime: "claude", backend: "local" });
    expect(v.seen).toEqual([]);
    expect(service.resolve("haiku").runtime.name).toBe("claude");
    expect(() => service.resolve("box:ds/deepseek-chat")).toThrow(/unknown machine: box/);
    // A first segment that is neither: as before.
    expect(() => service.resolve("nope/x")).toThrow(/unknown runtime: nope/);
  });

  test("pictures: OpenAI Images through the gateway with no anthropic-api runtime; the cost and what served it on the row", async () => {
    const v = vendor();
    const service = new ModelService({ store, runtimes: claudeOnly(fakeModelBin()), log: () => {}, gateway: { link: gatewayOver(v.url).link } });
    const { outcome, call } = await service.image("cards", picture("oa/gpt-image-1"));
    expect(outcome).toMatchObject({ ok: true, text: "1 image by oa/gpt-image-1", backend: "gateway" });
    if (outcome.ok) expect(outcome.images[0]!.bytes).toEqual(PNG);
    expect(v.seen[0]).toMatchObject({ path: "/v1/images/generations", body: { model: "gpt-image-1" } });
    expect(call).toMatchObject({ app: "cards", tag: "image", model: "oa/gpt-image-1", backend: "gateway", status: "ok" });
    expect(call.runtime).toBeUndefined();
    expect((await service.image("cards", picture("draw"))).outcome.ok).toBe(true);
  });

  test("a model of another kind is refused with the route it belongs to; tools and full mode are refused", async () => {
    const v = vendor();
    const service = new ModelService({ store, runtimes: claudeOnly(fakeModelBin()), log: () => {}, gateway: { link: gatewayOver(v.url).link } });
    expect(() => service.resolve("oa/gpt-image-1")).toThrow(/is a picture model \(send it to \/api\/model\/image\)/);
    expect(() => service.resolveImage("ds/deepseek-chat")).toThrow(/is a text model \(send it to \/api\/model\/run\)/);
    expect(() => service.resolve("oa/tts-1")).toThrow(/speech service/);
    expect((await service.run("notes", text("ds/deepseek-chat", { tools: ["Read"] }))).outcome).toMatchObject({ ok: false, error: expect.stringContaining("takes no tools") });
    expect((await service.run("notes", text("ds/deepseek-chat", { mode: "full" }))).outcome).toMatchObject({ ok: false, error: expect.stringContaining("no full completion mode") });
    expect(v.seen).toEqual([]);
  });

  test("without the gateway, or with no gateway.yaml, a provider name is an unknown runtime as before", () => {
    const plain = new ModelService({ store, runtimes: claudeOnly(fakeModelBin()), log: () => {} });
    expect(() => plain.resolve("ds/deepseek-chat")).toThrow(/unknown runtime: ds/);
    const off = new ModelService({ store, runtimes: claudeOnly(fakeModelBin()), log: () => {}, gateway: { link: new ModelGateway({ log: () => {} }).link } });
    expect(() => off.resolve("ds/deepseek-chat")).toThrow(/unknown runtime: ds/);
    expect(off.gatewayChoices()).toEqual({ text: [], image: [] });
  });

  test("a runtime named like a provider wins (the loader refuses that pair; this is the fallback)", () => {
    const v = vendor();
    const runtimes = new RuntimeRegistry({ default: "ds", runtimes: [{ name: "ds", kind: "claude-code", bin: fakeModelBin(), chatArgs: [] }] });
    const service = new ModelService({ store, runtimes, log: () => {}, gateway: { link: gatewayOver(v.url).link } });
    expect(service.resolve("ds/deepseek-chat").runtime.name).toBe("ds");
  });

  test("the choices an app's override may take: text models and groups, picture models, no speech", () => {
    const v = vendor();
    const service = new ModelService({ store, runtimes: claudeOnly(fakeModelBin()), log: () => {}, gateway: { link: gatewayOver(v.url).link } });
    expect(gatewayModelOptions(service.gatewayChoices())).toEqual([
      { value: "fast", gateway: "text", model: "fast" },
      { value: "ds/deepseek-chat", gateway: "text", model: "ds/deepseek-chat" },
      { value: "ds/down", gateway: "text", model: "ds/down" },
      { value: "draw", gateway: "image", model: "draw" },
      { value: "oa/gpt-image-1", gateway: "image", model: "oa/gpt-image-1" },
    ]);
  });
});

describe("/api/model/run and /api/model/image with a gateway model", () => {
  test("an app names ds/... or a runtime per call; a picture with no model goes where it went before", async () => {
    const v = vendor();
    const service = new ModelService({ store, runtimes: claudeOnly(fakeModelBin()), log: () => {}, gateway: { link: gatewayOver(v.url).link } });
    const routes = createModelRoutes({ service, token: "op", appForToken: async (t) => (t === "app-token" ? "notes" : undefined), defaultModel: "haiku" });
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", routes, fetch: () => new Response("nf", { status: 404 }) });
    stops.push(() => server.stop(true));
    const post = async (path: string, body: unknown) => {
      const r = await fetch(`http://127.0.0.1:${server.port}${path}`, { method: "POST", headers: { authorization: "Bearer app-token", "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: r.status, json: (await r.json()) as Record<string, unknown> };
    };
    const viaGateway = await post("/api/model/run", { model: "ds/deepseek-chat", prompt: "hi" });
    expect(viaGateway).toMatchObject({ status: 200, json: { ok: true, text: "vendor answer (deepseek-chat)", call: { backend: "gateway", model: "ds/deepseek-chat" } } });
    const viaRuntime = await post("/api/model/run", { model: "claude/haiku", prompt: "hi" });
    expect(viaRuntime).toMatchObject({ status: 200, json: { ok: true, call: { backend: "local", runtime: "claude" } } });
    const drawn = await post("/api/model/image", { model: "oa/gpt-image-1", prompt: "a circle" });
    expect(drawn).toMatchObject({ status: 200, json: { ok: true, images: [{ type: "image/png" }], call: { backend: "gateway" } } });
    // No model: the default, a runtime that does not draw, refused exactly as before.
    const none = await post("/api/model/image", { prompt: "a circle" });
    expect(none).toMatchObject({ status: 400, json: { ok: false, error: "runtime claude does not make images" } });
    expect((await post("/api/model/run", { model: "oa/gpt-image-1", prompt: "hi" })).status).toBe(400);
  });
});
