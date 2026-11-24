import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCatalog } from "../runtimes/magpie.ts";
import { GATEWAY_PREFIX, createGatewayRoutes, gatewayBase } from "./api.ts";
import { parseGatewayYaml, setGatewayTiersText } from "./config.ts";
import { PriceBook, PRICES_FILE } from "./prices.ts";
import { ModelGateway } from "./service.ts";
import { GatewayTokens } from "./tokens.ts";
import { TraceStore } from "./trace.ts";

/** A provider stand-in on an ephemeral port: records what reached it and answers as told. */
type Seen = { path: string; search: string; headers: Record<string, string>; body: string; form?: Record<string, string> };
function vendor(answer: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const type = req.headers.get("content-type") ?? "";
      let body = "";
      let form: Record<string, string> | undefined;
      if (type.includes("multipart/form-data")) {
        form = {};
        for (const [k, v] of await req.formData()) form[k] = typeof v === "string" ? v : `file:${(v as File).name}:${(v as File).size}`;
      } else body = await req.text();
      const s: Seen = { path: url.pathname, search: url.search, headers: Object.fromEntries(req.headers), body, ...(form ? { form } : {}) };
      seen.push(s);
      return answer(s);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop(true) };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const message = (text: string) => ({ id: "m", type: "message", role: "assistant", content: [{ type: "text", text }], usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 3 } });

const started: { stop: () => void }[] = [];
afterAll(() => {
  for (const s of started) s.stop();
});

/** The gateway's routes on an ephemeral loopback port, over a gateway.yaml naming the stand-ins. */
function serve(yaml: string, env: Record<string, string> = {}, prices?: PriceBook) {
  const { config } = parseGatewayYaml(yaml, env);
  const gateway = new ModelGateway({ config, log: () => {}, ...(prices ? { prices } : {}) });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", routes: createGatewayRoutes(gateway), fetch: () => new Response("nope", { status: 404 }) });
  started.push({ stop: () => server.stop(true) });
  const base = `http://127.0.0.1:${server.port}${GATEWAY_PREFIX}`;
  gateway.listen(base);
  const grant = gateway.tokens.issue();
  const post = (path: string, body: unknown, headers: Record<string, string> = {}, token = grant.token) =>
    fetch(`${base}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { gateway, base, grant, post };
}

describe("gateway.yaml", () => {
  test("presets give a vendor's checked bases; a written base wins; the key stays in the environment", () => {
    const { config, warnings } = parseGatewayYaml(
      "providers:\n  deepseek: { preset: deepseek, apiKeyEnv: DS_KEY }\n  openai: { preset: openai, apiKeyEnv: OA_KEY }\n  mine: { messages: 'https://llm.example.com/anthropic/', auth: x-api-key }\ngroups:\n  fast: [deepseek/deepseek-chat, mine/m-1]\n",
      { DS_KEY: "sk-ds" },
    );
    expect(config.providers[0]).toEqual({ name: "deepseek", messages: "https://api.deepseek.com/anthropic", auth: "bearer", apiKeyEnv: "DS_KEY", apiKey: "sk-ds", models: [], preset: "deepseek" });
    expect(config.providers[1]).toMatchObject({ name: "openai", openai: "https://api.openai.com/v1", apiKeyEnv: "OA_KEY" });
    expect(config.providers[2]).toEqual({ name: "mine", messages: "https://llm.example.com/anthropic", auth: "x-api-key", models: [] });
    expect(config.groups).toEqual({ fast: ["deepseek/deepseek-chat", "mine/m-1"] });
    // An empty key variable: listed, off, with a warning.
    expect(config.off).toEqual({ openai: "OA_KEY is not set" });
    expect(warnings).toEqual(["model gateway provider openai is off: OA_KEY is not set"]);
  });

  test("strict: unknown keys, missing bases, bad URLs, keys in the file, groups that name nothing", () => {
    const bad = (yaml: string, msg: RegExp) => expect(() => parseGatewayYaml(yaml, {})).toThrow(msg);
    bad("providers: []\n", /providers must be a mapping/);
    expect(parseGatewayYaml("providers: {}\n", {}).config.providers).toEqual([]);
    expect(parseGatewayYaml("# nothing yet\nproviders:\n", {}).config.providers).toEqual([]);
    expect(parseGatewayYaml("providers:\n  a: { messages: 'http://x', disabled: true }\n", {}).config.off).toEqual({ a: "turned off" });
    bad("providers:\n  a: { messages: 'https://x' }\nextra: 1\n", /unknown key "extra"/);
    bad("providers:\n  a: { messages: 'https://x', apiKey: sk }\n", /unknown key "apiKey"/);
    bad("providers:\n  a: { apiKeyEnv: K }\n", /needs a messages or an openai base/);
    bad("providers:\n  a: { messages: 'ftp://x' }\n", /http\(s\) URL/);
    bad("providers:\n  a: { messages: 'https://x/?k=1' }\n", /without a query/);
    bad("providers:\n  a: { preset: nope }\n", /preset must be one of/);
    bad("providers:\n  a: { messages: 'https://x', auth: basic }\n", /auth must be x-api-key or bearer/);
    bad("providers:\n  a: { messages: 'https://x', apiKeyEnv: 'sk-live-123!' }\n", /never hold the key/);
    bad("providers:\n  A: { messages: 'https://x' }\n", /invalid provider name/);
    bad("providers:\n  a: { messages: 'https://x' }\ngroups:\n  g: [b/m]\n", /names provider b, which is not in this file/);
    bad("providers:\n  a: { messages: 'https://x' }\ngroups:\n  g: [a]\n", /must be provider\/model/);
    bad("providers:\n  a: { messages: 'https://x' }\ngroups:\n  a: [a/m]\n", /may not be named like a provider/);
    bad("providers:\n  a: { messages: 'https://x' }\ngroups:\n  g: [a/m, a/m]\n", /lists a\/m twice/);
  });
});

describe("tokens", () => {
  test("only tokens issued in this boot pass; the run comes back", () => {
    const tokens = new GatewayTokens();
    const { run, token } = tokens.issue();
    expect(tokens.verify(token)).toBe(run);
    expect(tokens.verify(token.slice(0, -2) + "xx")).toBeUndefined();
    expect(new GatewayTokens().verify(token)).toBeUndefined();
    expect(tokens.verify("sk-ant-something")).toBeUndefined();
    expect(tokens.verify(`sgw-${"0".repeat(24)}`)).toBeUndefined();
  });
});

describe("trace store", () => {
  test("bounded: the oldest run goes first, and none outlives its time", () => {
    let now = 0;
    const t = new TraceStore({ max: 2, ttlMs: 1000, now: () => now });
    t.note("a", { tried: ["p/m"], served: "p/m" });
    t.note("b", { tried: ["p/m"], served: "p/m" });
    t.note("c", { tried: ["p/m"], served: "p/m" });
    expect(t.get("a")).toBeUndefined();
    expect(t.get("c")?.served).toBe("p/m");
    now = 5000;
    expect(t.get("c")).toBeUndefined();
  });
});

describe("who may call it", () => {
  test("a token ai-space issued, from loopback, with no proxy in between", async () => {
    const v = vendor(() => json(message("hi")));
    started.push(v);
    const { post } = serve(`providers:\n  v: { messages: '${v.url}' }\n`);
    const body = { model: "v/m", max_tokens: 5, messages: [] };
    expect((await post("/v1/messages", body, {}, "")).status).toBe(401);
    expect((await post("/v1/messages", body, {}, "an-app-token")).status).toBe(401);
    expect(await (await post("/v1/messages", body, {}, "an-app-token")).json()).toMatchObject({ type: "error", error: { type: "authentication_error" } });
    // Through the router or a tunnel: refused even with a good token.
    expect((await post("/v1/messages", body, { "x-forwarded-for": "203.0.113.9" })).status).toBe(403);
    expect((await post("/v1/messages", body)).status).toBe(200);
    expect(v.seen).toHaveLength(1);
  });

  test("the base a child process gets: loopback, or 127.0.0.1 when ai-space listens everywhere; off on another address", () => {
    expect(gatewayBase("127.0.0.1", 8711)).toEqual({ base: "http://127.0.0.1:8711/api/model-gateway" });
    expect(gatewayBase("0.0.0.0", 8711)).toEqual({ base: "http://127.0.0.1:8711/api/model-gateway" });
    expect(gatewayBase("::1", 8711)).toEqual({ base: "http://[::1]:8711/api/model-gateway" });
    expect(gatewayBase("192.168.1.5", 8711)).toMatchObject({ reason: expect.stringMatching(/not on loopback/) });
  });
});

describe("Messages passthrough", () => {
  test("only the model and the key change; betas, version and the query go on; usage and what served land in the trace", async () => {
    const v = vendor(() => json(message("hello"), 200, { "request-id": "req_1" }));
    started.push(v);
    const { post, gateway, grant } = serve(`providers:\n  ds: { messages: '${v.url}/anthropic', apiKeyEnv: K }\n`, { K: "sk-vendor" });
    const r = await post("/v1/messages?beta=true", { model: "ds/deepseek-chat", max_tokens: 5, messages: [{ role: "user", content: "hi" }], metadata: { user_id: "x" } }, { "anthropic-beta": "a,b", "anthropic-version": "2023-06-01", "x-api-key": "sgw-ignored" });
    expect(r.status).toBe(200);
    expect(r.headers.get("request-id")).toBe("req_1");
    expect(r.headers.get("x-space-gateway-served")).toBe("ds/deepseek-chat");
    expect(await r.json()).toEqual(message("hello"));
    const seen = v.seen[0]!;
    expect(seen.path).toBe("/anthropic/v1/messages");
    expect(seen.search).toBe("?beta=true");
    expect(seen.headers.authorization).toBe("Bearer sk-vendor");
    expect(seen.headers["x-api-key"]).toBeUndefined();
    expect(seen.headers["anthropic-beta"]).toBe("a,b");
    expect(seen.headers["anthropic-version"]).toBe("2023-06-01");
    expect(JSON.parse(seen.body)).toEqual({ model: "deepseek-chat", max_tokens: 5, messages: [{ role: "user", content: "hi" }], metadata: { user_id: "x" } });
    expect(gateway.traces.get(grant.run)).toMatchObject({ requests: 1, served: "ds/deepseek-chat", tried: ["ds/deepseek-chat"], usage: { inputTokens: 11, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 0 } });
  });

  test("each answer is costed at the answering model's price; a model without one leaves the run unpriced", async () => {
    const v = vendor(() => json(message("hello")));
    started.push(v);
    const home = await mkdtemp(join(tmpdir(), "gw-prices-"));
    await Bun.write(join(home, PRICES_FILE), "ds/deepseek-chat: [2, 8, 0.5]\n");
    const prices = new PriceBook({ home, fetch: (async () => new Response("offline", { status: 503 })) as unknown as typeof fetch, log: () => {} });
    await prices.load();
    const { post, gateway, grant } = serve(`providers:\n  ds: { messages: '${v.url}/anthropic', apiKeyEnv: K }\n`, { K: "sk" }, prices);
    await post("/v1/messages", { model: "ds/deepseek-chat", max_tokens: 5, messages: [] });
    await post("/v1/messages", { model: "ds/deepseek-chat", max_tokens: 5, messages: [] });
    // 11 in at $2, 7 out at $8, 3 cache reads at $0.5, twice.
    expect(gateway.traces.get(grant.run)?.costUsd).toBeCloseTo(2 * (11 * 2 + 7 * 8 + 3 * 0.5) / 1e6, 12);
    await post("/v1/messages", { model: "ds/other", max_tokens: 5, messages: [] });
    const trace = gateway.traces.get(grant.run)!;
    expect(trace.costUsd).toBeUndefined();
    expect(trace.unpriced).toEqual(["ds/other"]);
  });

  test("x-api-key for a provider that wants it", async () => {
    const v = vendor(() => json(message("ok")));
    started.push(v);
    const { post } = serve(`providers:\n  a: { messages: '${v.url}', auth: x-api-key, apiKeyEnv: K }\n`, { K: "sk-a" });
    await post("/v1/messages", { model: "a/claude-x", max_tokens: 1, messages: [] });
    expect(v.seen[0]!.headers["x-api-key"]).toBe("sk-a");
    expect(v.seen[0]!.headers.authorization).toBeUndefined();
  });

  test("an SSE answer goes back byte for byte while its usage is read on the side", async () => {
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","model":"glm-4.6","usage":{"input_tokens":20,"output_tokens":1,"cache_read_input_tokens":4}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const v = vendor(() => new Response(new ReadableStream({
      async start(c) {
        // Split mid-line, as a network does.
        const all = new TextEncoder().encode(sse.join(""));
        for (let i = 0; i < all.length; i += 37) c.enqueue(all.slice(i, i + 37));
        c.close();
      },
    }), { headers: { "content-type": "text/event-stream" } }));
    started.push(v);
    const { post, gateway, grant } = serve(`providers:\n  glm: { messages: '${v.url}' }\n`);
    const r = await post("/v1/messages", { model: "glm/glm-4.6", stream: true, max_tokens: 5, messages: [] });
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    expect(await r.text()).toBe(sse.join(""));
    expect(gateway.traces.get(grant.run)?.usage).toEqual({ inputTokens: 20, cacheWriteTokens: 0, cacheReadTokens: 4, outputTokens: 9 });
  });

  test("count_tokens goes to the same base; a provider without it answers its own error, unchanged", async () => {
    const v = vendor((s) => (s.path.endsWith("/count_tokens") ? json({ error: { message: "Not Found" } }, 404) : json(message("x"))));
    started.push(v);
    const { post, gateway, grant } = serve(`providers:\n  ds: { messages: '${v.url}' }\n`);
    const r = await post("/v1/messages/count_tokens", { model: "ds/deepseek-chat", messages: [] });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: { message: "Not Found" } });
    expect(v.seen[0]!.path).toBe("/v1/messages/count_tokens");
    expect(gateway.traces.get(grant.run)?.served).toBeUndefined();
  });

  test("errors the gateway answers itself are in the Messages shape: an unknown model, a provider that is off", async () => {
    const { post } = serve("providers:\n  ds: { messages: 'http://127.0.0.1:9', apiKeyEnv: EMPTY }\n  o: { openai: 'http://127.0.0.1:9' }\n");
    const unknown = await post("/v1/messages", { model: "claude-haiku-4-5", messages: [] });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ type: "error", error: { type: "invalid_request_error", message: expect.stringMatching(/unknown model claude-haiku-4-5/) } });
    const off = await post("/v1/messages", { model: "ds/x", messages: [] });
    expect(off.status).toBe(503);
    expect((await off.json() as { error: { message: string } }).error.message).toMatch(/provider ds is off \(EMPTY is not set\)/);
    const noBase = await post("/v1/messages", { model: "o/x", messages: [] });
    expect(noBase.status).toBe(400);
    expect((await noBase.json() as { error: { message: string } }).error.message).toMatch(/has no messages base/);
  });
});

describe("failover", () => {
  test("a group moves on for a rate limit before the first byte; the one that failed rests and goes last next time", async () => {
    const a = vendor(() => json({ type: "error", error: { type: "rate_limit_error", message: "Too many requests" } }, 429, { "retry-after": "30" }));
    const b = vendor(() => json(message("from b")));
    started.push(a, b);
    const { post, gateway, grant } = serve(`providers:\n  a: { messages: '${a.url}' }\n  b: { messages: '${b.url}' }\ngroups:\n  fast: [a/m-a, b/m-b]\n`);
    const r = await post("/v1/messages", { model: "fast", max_tokens: 5, messages: [] });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-space-gateway-served")).toBe("b/m-b");
    expect(JSON.parse(b.seen[0]!.body).model).toBe("m-b");
    expect(gateway.traces.get(grant.run)).toMatchObject({ served: "b/m-b", tried: ["a/m-a", "b/m-b"] });
    // a rests: another run's request goes to b first.
    const other = gateway.tokens.issue();
    await post("/v1/messages", { model: "fast", max_tokens: 5, messages: [] }, {}, other.token);
    expect(a.seen).toHaveLength(1);
    expect(gateway.traces.get(other.run)?.tried).toEqual(["b/m-b"]);
    // Settings shows the rest: until when and why.
    const view = gateway.view();
    expect(view.providers.find((p) => p.name === "a")).toMatchObject({ name: "a", messages: a.url, resting: { kind: "rate" } });
    expect(Date.parse(view.providers.find((p) => p.name === "a")!.resting!.until)).toBeGreaterThan(Date.now());
    expect(view.providers.find((p) => p.name === "b")?.resting).toBeUndefined();
  });

  test("a refusal about the request itself is not a reason to switch: it goes back as the provider wrote it", async () => {
    const a = vendor(() => json({ type: "error", error: { type: "invalid_request_error", message: "max_tokens: too large" } }, 400));
    const b = vendor(() => json(message("never")));
    started.push(a, b);
    const { post } = serve(`providers:\n  a: { messages: '${a.url}' }\n  b: { messages: '${b.url}' }\ngroups:\n  g: [a/x, b/y]\n`);
    const r = await post("/v1/messages", { model: "g", messages: [] });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ type: "error", error: { type: "invalid_request_error", message: "max_tokens: too large" } });
    expect(b.seen).toHaveLength(0);
  });

  test("an unreachable provider is a transport failure: the next member answers", async () => {
    const b = vendor(() => json(message("b")));
    started.push(b);
    const dead = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const deadUrl = `http://127.0.0.1:${dead.port}`;
    dead.stop(true);
    const { post } = serve(`providers:\n  a: { messages: '${deadUrl}' }\n  b: { messages: '${b.url}' }\ngroups:\n  g: [a/x, b/y]\n`);
    const r = await post("/v1/messages", { model: "g", messages: [] });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-space-gateway-served")).toBe("b/y");
  });

  test("every member refused: the last refusal goes back; a direct provider/model never moves", async () => {
    const a = vendor(() => json({ error: { message: "insufficient balance" } }, 402));
    started.push(a);
    const { post, gateway, grant } = serve(`providers:\n  a: { messages: '${a.url}' }\n`);
    const r = await post("/v1/messages", { model: "a/x", messages: [] });
    expect(r.status).toBe(402);
    expect(gateway.traces.get(grant.run)).toMatchObject({ tried: ["a/x"], error: "API 402: insufficient balance" });
  });

  test("a run keeps the member that first answered; a request with its thinking blocks goes to no other", async () => {
    let aDown = false;
    const a = vendor(() => (aDown ? json({ error: { message: "overloaded" } }, 529) : json(message("a"))));
    const b = vendor(() => json(message("b")));
    started.push(a, b);
    const { post, gateway, grant } = serve(`providers:\n  a: { messages: '${a.url}' }\n  b: { messages: '${b.url}' }\ngroups:\n  g: [a/x, b/y]\n`);
    expect((await post("/v1/messages", { model: "g", messages: [] })).headers.get("x-space-gateway-served")).toBe("a/x");
    aDown = true;
    const thinking = { model: "g", messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "…", signature: "sig-from-a" }, { type: "text", text: "x" }] }, { role: "user", content: "go on" }] };
    const r = await post("/v1/messages", thinking);
    expect(r.status).toBe(529);
    expect(b.seen).toHaveLength(0);
    // Without thinking blocks the run may move on when its member fails.
    const plain = await post("/v1/messages", { model: "g", messages: [{ role: "user", content: "new" }] });
    expect(plain.headers.get("x-space-gateway-served")).toBe("b/y");
    expect(gateway.traces.get(grant.run)?.tried).toEqual(["a/x", "b/y"]);
  });
});

describe("the model list", () => {
  test("groups and provider/model ids in the OpenAI-style list magpie answers; readCatalog tells the groups apart", async () => {
    const { base, grant } = serve("providers:\n  ds: { messages: 'http://127.0.0.1:9', models: [deepseek-chat, deepseek-reasoner] }\n  off: { messages: 'http://127.0.0.1:9', apiKeyEnv: EMPTY, models: [m] }\ngroups:\n  fast: [ds/deepseek-chat]\n");
    const r = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${grant.token}` } });
    const body = await r.json();
    expect(body.object).toBe("list");
    expect(body.data.map((m: { id: string }) => m.id)).toEqual(["fast", "ds/deepseek-chat", "ds/deepseek-reasoner"]);
    expect(readCatalog(body)).toEqual({ models: ["fast", "ds/deepseek-chat", "ds/deepseek-reasoner"], groups: ["fast"] });
    expect((await fetch(`${base}/v1/models`)).status).toBe(401);
  });
});

describe("tiers: in gateway.yaml", () => {
  const head = "# my gateway\nproviders:\n  ds: { preset: deepseek, apiKeyEnv: DS }   # deepseek\n  glm:\n    preset: zai\n    apiKeyEnv: ZAI\n    models: [glm-4.6]\n  openai: { preset: openai, apiKeyEnv: OA }\ngroups:\n  fast: [ds/deepseek-chat, glm/glm-4.5-air]\n";
  const env = { DS: "k", ZAI: "k" };

  test("each tier any vendor's model or a group; image a provider with an openai base", () => {
    const { config, warnings } = parseGatewayYaml(`${head}tiers:\n  basic: fast\n  intermediate: ds/deepseek-chat\n  advanced: glm/glm-4.6\n  image: openai/gpt-image-1\n`, env);
    expect(config.tiers).toEqual({ basic: "fast", intermediate: "ds/deepseek-chat", advanced: "glm/glm-4.6", image: "openai/gpt-image-1" });
    // openai is off (OA unset): a warning for it, none for the tiers.
    expect(warnings).toEqual(["model gateway provider openai is off: OA is not set"]);
    expect(parseGatewayYaml(head, env).config.tiers).toEqual({});
    expect(() => parseGatewayYaml(`${head}tiers:\n  huge: fast\n`, env)).toThrow(/tiers has unknown key "huge"/);
    expect(() => parseGatewayYaml(`${head}tiers: [fast]\n`, env)).toThrow(/tiers must map/);
    expect(() => parseGatewayYaml(`${head}tiers:\n  basic: 3\n`, env)).toThrow(/tiers.basic must be a model or a group/);
  });

  test("a tier whose provider is gone, or that cannot answer it, stays with a warning", () => {
    const { config, warnings } = parseGatewayYaml(`${head}tiers:\n  basic: kimi/k2\n  junior: openai/gpt-5\n  image: ds/deepseek-chat\n`, env);
    expect(config.tiers).toEqual({ basic: "kimi/k2", junior: "openai/gpt-5", image: "ds/deepseek-chat" });
    expect(warnings).toContain("gateway.yaml: tiers.basic: kimi/k2 names provider kimi, which is not in this file");
    expect(warnings).toContain("gateway.yaml: tiers.junior: openai/gpt-5 has no provider with a messages base (text go there)");
    expect(warnings).toContain("gateway.yaml: tiers.image: ds/deepseek-chat has no provider with a openai base (pictures go there)");
  });

  test("Settings edits the text: comments and order stay, the block is replaced, added at the end, or removed", () => {
    const added = setGatewayTiersText(head, { advanced: "glm/glm-4.6", basic: "fast" }, env);
    expect(added).toBe(`${head}tiers:\n  basic: "fast"\n  advanced: "glm/glm-4.6"\n`);
    const withMore = `${head}tiers:\n  basic: fast   # cheap\n  advanced: glm/glm-4.6\n# after the tiers\nextra: no\n`.replace("extra: no\n", "");
    const replaced = setGatewayTiersText(withMore, { junior: "ds/deepseek-chat", image: "openai/gpt-image-1" }, env);
    expect(replaced).toBe(`${head}tiers:\n  junior: "ds/deepseek-chat"\n  image: "openai/gpt-image-1"\n# after the tiers\n`);
    // A tier that keeps its value keeps its comment.
    expect(setGatewayTiersText(withMore, { basic: "fast", junior: "ds/deepseek-chat" }, env)).toBe(`${head}tiers:\n  basic: "fast"   # cheap\n  junior: "ds/deepseek-chat"\n# after the tiers\n`);
    expect(replaced.startsWith("# my gateway\n")).toBe(true);
    expect(replaced).toContain("# deepseek");
    const cleared = setGatewayTiersText(withMore, {}, env);
    expect(cleared).toBe(`${head}# after the tiers\n`);
    expect(parseGatewayYaml(cleared, env).config.tiers).toEqual({});
    // A one-line tiers: is the operator's to change by hand.
    expect(() => setGatewayTiersText(`${head}tiers: { basic: fast }\n`, { basic: "glm/glm-4.6" }, env)).toThrow(/on one line/);
  });

  test("the view: providers with bases and on/off, models, the ids pictures can go to, the tiers", () => {
    const { config } = parseGatewayYaml(`${head}tiers:\n  advanced: glm/glm-4.6\n`, { ...env, OA: "k" });
    const view = new ModelGateway({ config, log: () => {} }).view();
    expect(view.configured).toBe(true);
    expect(view.providers.map((p) => [p.name, p.preset, Boolean(p.messages), Boolean(p.openai), p.off])).toEqual([["ds", "deepseek", true, false, undefined], ["glm", "zai", true, false, undefined], ["openai", "openai", false, true, undefined]]);
    expect(view.models).toEqual(["fast", "ds/deepseek-chat", "glm/glm-4.6", "glm/glm-4.5-air"]);
    // openai lists no model: nothing to offer for pictures (an id can still be typed).
    expect(view.imageModels).toEqual([]);
    const drawn = parseGatewayYaml(`${head.replace("{ preset: openai, apiKeyEnv: OA }", "{ preset: openai, apiKeyEnv: OA, models: [gpt-image-1] }")}groups:\n  pics: [openai/gpt-image-1]\n`.replace("groups:\n  fast: [ds/deepseek-chat, glm/glm-4.5-air]\ngroups:\n", "groups:\n  fast: [ds/deepseek-chat, glm/glm-4.5-air]\n"), { ...env, OA: "k" });
    expect(new ModelGateway({ config: drawn.config, log: () => {} }).view().imageModels).toEqual(["pics", "openai/gpt-image-1"]);
    expect(view.tiers).toEqual({ advanced: "glm/glm-4.6" });
    const off = new ModelGateway({ config: parseGatewayYaml(head, env).config, log: () => {} }).view();
    expect(off.providers.find((p) => p.name === "openai")?.off).toBe("OA is not set");
    expect(new ModelGateway({ log: () => {} }).view()).toMatchObject({ configured: false, providers: [], problem: expect.stringContaining("no gateway.yaml") });
  });
});
