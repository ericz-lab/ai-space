import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markOwner } from "../auth.ts";
import { composeRoutes, gateRoutes } from "../auth/gate.ts";
import { AuthService } from "../auth/service.ts";
import { AuthStore } from "../auth/store.ts";
import { parseRuntimesYaml } from "../runtimes/config.ts";
import { RuntimeRegistry } from "../runtimes/registry.ts";
import { GATEWAY_PREFIX, createGatewayRoutes } from "./api.ts";
import { parseGatewayYaml } from "./config.ts";
import { setProviderText } from "./edit.ts";
import { ModelGateway } from "./service.ts";
import { createGatewaySettingsRoutes } from "./settings.ts";

/** Settings → Gateway (docs/model-gateway.md#settings): every route against temp files, fake vendors on loopback, no real key. */

const KEY = "sk-fake-test-key-0000-abcd";
const KEY2 = "sk-fake-second-key-9999-wxyz";

const stops: (() => void)[] = [];
afterAll(() => {
  for (const s of stops) s();
});

/** A vendor stand-in: Messages, an OpenAI-style list at /models and /v1/models; it echoes the key it got in its errors, as some vendors do. */
function vendor(opts: { lists?: boolean } = {}) {
  const seen: { path: string; auth: string | null; xkey: string | null; body?: Record<string, unknown> }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const auth = req.headers.get("authorization");
      const xkey = req.headers.get("x-api-key");
      const body = req.method === "POST" ? ((await req.json()) as Record<string, unknown>) : undefined;
      seen.push({ path, auth, xkey, ...(body ? { body } : {}) });
      const presented = auth?.replace(/^Bearer /, "") ?? xkey ?? "";
      if (presented !== KEY && presented !== KEY2) return Response.json({ error: { message: `Incorrect API key provided: ${presented}` } }, { status: 401 });
      if (path.endsWith("/v1/messages")) return Response.json({ type: "message", role: "assistant", content: [{ type: "text", text: `ok from ${String(body?.model)}` }], usage: { input_tokens: 1, output_tokens: 1 } });
      if (opts.lists !== false && (path.endsWith("/models"))) return Response.json({ object: "list", data: [{ id: "chat-b" }, { id: "chat-a" }, { id: "gpt-image-1" }] });
      return new Response("not here", { status: 404 });
    },
  });
  stops.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, seen };
}

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "space-gw-settings-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function setup(o: { token?: string; env?: Record<string, string | undefined>; runtimes?: string; claude?: string; unavailable?: string } = {}) {
  const env: Record<string, string | undefined> = { ...o.env };
  const lines: string[] = [];
  const gateway = new ModelGateway({ log: (l) => lines.push(l) });
  const gwServer = Bun.serve({ port: 0, hostname: "127.0.0.1", routes: createGatewayRoutes(gateway), fetch: () => new Response("", { status: 404 }) });
  stops.push(() => gwServer.stop(true));
  gateway.listen(`http://127.0.0.1:${gwServer.port}${GATEWAY_PREFIX}`);
  const runtimesYaml = o.runtimes ?? "# my runtimes\nruntimes:\n  claude:\n    kind: claude-code\n";
  await writeFile(join(home, "runtimes.yaml"), runtimesYaml);
  const runtimes = new RuntimeRegistry(parseRuntimesYaml(runtimesYaml, env).config, { gateway: gateway.link });
  const added: string[] = [];
  const routes = createGatewaySettingsRoutes({
    gateway,
    runtimes,
    home,
    envFile: join(home, ".env"),
    env,
    token: o.token ?? "op",
    isAppCredential: async (t) => t === "app-token" || t === "consumer-key",
    claude: () => o.claude,
    ...(o.unavailable ? { unavailable: o.unavailable } : {}),
    log: (l) => lines.push(l),
    onRuntimeAdded: (n) => added.push(n),
  });
  type Handler = (r: Request) => Promise<Response>;
  const call = async (method: string, path: string, body?: unknown, token: string | null = "op", params?: Record<string, string>) => {
    const route = Object.entries(routes).find(([k]) => {
      const re = new RegExp(`^${k.replace(/:name/g, "[^/]+")}$`);
      return re.test(path.split("?")[0]!);
    });
    if (!route) throw new Error(`no route ${path}`);
    const req = new Request(`http://127.0.0.1${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const name = /providers\/([^/?]+)/.exec(path)?.[1];
    Object.assign(req, { params: { ...(name ? { name } : {}), ...params } });
    const res = await ((route[1] as Record<string, Handler>)[method]!)(req);
    const text = await res.text();
    return { status: res.status, text, json: JSON.parse(text) as Record<string, any> };
  };
  return { routes, call, env, gateway, runtimes, lines, added };
}

describe("who may use it", () => {
  test("SPACE_AUTH=external with an operator token: the token or the owner's session; an app's or a consumer's credential is refused", async () => {
    const { routes, call } = await setup();
    expect((await call("GET", "/api/model/gateway", undefined, null)).status).toBe(401);
    expect((await call("GET", "/api/model/gateway", undefined, "wrong")).status).toBe(401);
    expect((await call("GET", "/api/model/gateway", undefined, "app-token")).status).toBe(403);
    expect((await call("POST", "/api/model/gateway/providers", { name: "x", messages: "http://127.0.0.1:9" }, "consumer-key")).status).toBe(403);
    expect((await call("GET", "/api/model/gateway")).status).toBe(200);
    const req = new Request("http://127.0.0.1/api/model/gateway");
    markOwner(req);
    expect((await (routes["/api/model/gateway"].GET as (r: Request) => Promise<Response>)(req)).status).toBe(200);
  });

  test("SPACE_AUTH=external with no operator token (every request is the operator): an app is still refused", async () => {
    const { call } = await setup({ token: "" });
    expect((await call("GET", "/api/model/gateway", undefined, null)).status).toBe(200);
    expect((await call("GET", "/api/model/gateway", undefined, "app-token")).status).toBe(403);
    expect((await call("PUT", "/api/model/gateway/tiers", { tiers: {} }, "app-token")).status).toBe(403);
  });

  test("SPACE_AUTH=builtin: the gate lets only the owner through; from loopback without a credential is refused", async () => {
    const { routes } = await setup();
    const auth = new AuthService(new AuthStore(new Database(":memory:")), { hashCost: { memoryCost: 1024, timeCost: 1 } });
    const { routes: all, policies } = composeRoutes([["owner", routes]]);
    const gated = gateRoutes(all, policies, { mode: "builtin", auth, operatorToken: "op", isAppCredential: async (t) => t === "app-token" });
    const get = (headers: Record<string, string>) => ((gated["/api/model/gateway"] as Record<string, (r: Request) => Promise<Response>>).GET!)(new Request("http://127.0.0.1/api/model/gateway", { headers }));
    expect((await get({})).status).toBe(401);
    expect((await get({ authorization: "Bearer app-token" })).status).toBe(401);
    expect((await get({ authorization: "Bearer op" })).status).toBe(200);
  });
});

describe("providers from the page", () => {
  test("the first provider creates gateway.yaml; its key goes to .env (other lines and the mode kept) and applies at once; no answer or log line carries it", async () => {
    const v = vendor();
    const { call, env, gateway, lines } = await setup();
    await writeFile(join(home, ".env"), "# my env\nSPACE_NAME=box\n");
    await chmod(join(home, ".env"), 0o600);
    expect((await call("GET", "/api/model/gateway")).json).toMatchObject({ exists: false, providers: [] });
    const added = await call("POST", "/api/model/gateway/providers", { name: "ds", preset: "deepseek", messages: v.url, key: KEY, models: ["chat-a"] });
    expect(added.json).toEqual({ ok: true, provider: "ds", created: true });
    const yaml = await Bun.file(join(home, "gateway.yaml")).text();
    expect(yaml).toContain("apiKeyEnv: SPACE_GATEWAY_DS_KEY");
    expect(yaml).not.toContain(KEY);
    const dotenv = await Bun.file(join(home, ".env")).text();
    expect(dotenv).toStartWith("# my env\nSPACE_NAME=box\n");
    expect(dotenv).toContain(`SPACE_GATEWAY_DS_KEY=${KEY}`);
    expect((await stat(join(home, ".env"))).mode & 0o777).toBe(0o600);
    expect(env.SPACE_GATEWAY_DS_KEY).toBe(KEY);
    // Hot: the gateway answers through the new provider at once.
    expect(gateway.problem()).toBeUndefined();
    const grant = gateway.tokens.issue();
    const r = await fetch(`${gateway.link.base()}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${grant.token}`, "content-type": "application/json" }, body: JSON.stringify({ model: "ds/chat-a", max_tokens: 5, messages: [] }) });
    expect(((await r.json()) as { content: { text: string }[] }).content[0]!.text).toBe("ok from chat-a");
    const shown = await call("GET", "/api/model/gateway");
    expect(shown.json.providers[0]).toMatchObject({ name: "ds", preset: "deepseek", messages: v.url, key: { state: "workspace", last4: "abcd", page: true, variable: "SPACE_GATEWAY_DS_KEY" }, models: ["chat-a"] });
    for (const text of [added.text, shown.text, ...lines]) expect(text).not.toContain(KEY);
    expect((await call("POST", "/api/model/gateway/providers", { name: "ds", preset: "deepseek", key: KEY })).status).toBe(409);
    expect((await call("POST", "/api/model/gateway/providers", { name: "x", preset: "deepseek" })).json.error).toContain("API key");
  });

  test("a key the environment sets is shown so and never overwritten; replacing a workspace key applies at once", async () => {
    const v = vendor();
    const { call, env } = await setup({ env: { SPACE_GATEWAY_KM_KEY: KEY } });
    expect((await call("POST", "/api/model/gateway/providers", { name: "km", preset: "kimi", messages: v.url, key: KEY2 })).status).toBe(409);
    await call("POST", "/api/model/gateway/providers", { name: "ds", preset: "deepseek", messages: v.url, key: KEY });
    // A provider naming the environment's variable.
    await call("POST", "/api/model/gateway/providers", { name: "km", preset: "kimi", messages: v.url, apiKeyEnv: "SPACE_GATEWAY_KM_KEY" });
    const shown = (await call("GET", "/api/model/gateway")).json;
    expect(shown.providers.find((p: { name: string }) => p.name === "km").key).toMatchObject({ state: "environment", last4: "abcd" });
    expect((await call("PUT", "/api/model/gateway/providers/km/key", { key: KEY2 })).status).toBe(409);
    expect(env.SPACE_GATEWAY_KM_KEY).toBe(KEY);
    const replaced = await call("PUT", "/api/model/gateway/providers/ds/key", { key: KEY2 });
    expect(replaced.json.key).toMatchObject({ state: "workspace", last4: "wxyz" });
    expect(replaced.text).not.toContain(KEY2);
    expect(env.SPACE_GATEWAY_DS_KEY).toBe(KEY2);
    expect(await Bun.file(join(home, ".env")).text()).not.toContain(KEY);
  });

  test("edit, turn off, groups, tiers and remove: the hand-written comments stay; removing clears what named it and deletes only the page's key", async () => {
    const v = vendor();
    const { call, env, gateway } = await setup({ env: { MINE_KEY: KEY2 } });
    await writeFile(join(home, "gateway.yaml"), `# written by hand\nproviders:\n  mine:                 # my own server\n    messages: ${v.url}\n    apiKeyEnv: MINE_KEY\n    models: [chat-a]    # the one I use\n`);
    await writeFile(join(home, ".env"), "OTHER=1\n");
    await call("POST", "/api/model/gateway/providers", { name: "ds", preset: "deepseek", messages: v.url, key: KEY, models: ["chat-a", "chat-b"] });
    expect((await call("PUT", "/api/model/gateway/groups", { groups: { fast: ["ds/chat-a", "mine/chat-a"] } })).status).toBe(200);
    expect((await call("PUT", "/api/model/gateway/groups", { groups: { fast: ["nope/x"] } })).status).toBe(400);
    expect((await call("PUT", "/api/model/gateway/tiers", { tiers: { basic: "fast", advanced: "ds/chat-b", intermediate: "mine/chat-a" } })).status).toBe(200);
    expect(gateway.link.tiers()).toEqual({ basic: "fast", intermediate: "mine/chat-a", advanced: "ds/chat-b" });
    // Turn mine off: kept in the file, off in the gateway, comments still there.
    expect((await call("PUT", "/api/model/gateway/providers/mine", { disabled: true })).status).toBe(200);
    let yaml = await Bun.file(join(home, "gateway.yaml")).text();
    expect(yaml).toStartWith("# written by hand\n");
    expect(yaml).toContain("mine:   # my own server");
    expect(yaml).toContain("disabled: true");
    expect(parseGatewayYaml(yaml, env).config.off).toEqual({ mine: "turned off" });
    expect((await call("PUT", "/api/model/gateway/providers/mine", { disabled: false, models: ["chat-a", "chat-c"] })).status).toBe(200);
    yaml = await Bun.file(join(home, "gateway.yaml")).text();
    expect(yaml).not.toContain("disabled");
    // A group a tier uses cannot just go.
    expect((await call("PUT", "/api/model/gateway/groups", { groups: {} })).status).toBe(409);
    // Where ds is used, before removing it.
    const ds = (await call("GET", "/api/model/gateway")).json.providers.find((p: { name: string }) => p.name === "ds");
    expect(ds.usedBy).toEqual({ groups: ["fast"], tiers: ["advanced"], emptied: [] });
    const removed = await call("DELETE", "/api/model/gateway/providers/ds");
    expect(removed.json).toEqual({ ok: true, provider: "ds", cleared: { groups: ["fast"], emptied: [], tiers: ["advanced"] }, keyDeleted: true });
    yaml = await Bun.file(join(home, "gateway.yaml")).text();
    const after = parseGatewayYaml(yaml, env).config;
    expect(after.providers.map((p) => p.name)).toEqual(["mine"]);
    expect(after.groups).toEqual({ fast: ["mine/chat-a"] });
    expect(after.tiers).toEqual({ basic: "fast", intermediate: "mine/chat-a" });
    expect(await Bun.file(join(home, ".env")).text()).toBe("OTHER=1\n");
    expect(env.SPACE_GATEWAY_DS_KEY).toBeUndefined();
    // A hand-made key is kept unless asked.
    const kept = await call("DELETE", "/api/model/gateway/providers/mine");
    expect(kept.json.keyDeleted).toBe(false);
    expect(env.MINE_KEY).toBe(KEY2);
    expect(gateway.problem()).toBe("gateway.yaml has no provider yet");
  });

  test("a file the page cannot edit is shown read-only with the reason, and no write touches it", async () => {
    const { call } = await setup();
    const text = "providers: { a: { messages: 'http://127.0.0.1:9' } }\n";
    await writeFile(join(home, "gateway.yaml"), text);
    const shown = (await call("GET", "/api/model/gateway")).json;
    expect(shown.readOnly).toContain("on one line");
    expect(shown.text).toBe(text);
    expect((await call("POST", "/api/model/gateway/providers", { name: "b", messages: "http://127.0.0.1:9" })).status).toBe(409);
    expect((await call("PUT", "/api/model/gateway/tiers", { tiers: { basic: "a/x" } })).status).toBe(409);
    expect(await Bun.file(join(home, "gateway.yaml")).text()).toBe(text);
  });

  test("the editor writes a provider as asked and refuses what it cannot write safely", () => {
    const created = setProviderText(undefined, "oa", { preset: "openai", apiKeyEnv: "K", models: ["gpt-image-1"] }, {});
    expect(parseGatewayYaml(created, {}).config.providers[0]).toMatchObject({ name: "oa", preset: "openai", openai: "https://api.openai.com/v1", apiKeyEnv: "K", models: ["gpt-image-1"] });
    expect(() => setProviderText(created, "nope", null, {})).toThrow(/has no provider nope/);
  });
});

describe("models and the test", () => {
  test("the vendor's list at the configured base; a vendor without one gets its documented ids; a failed list falls back, its error without the key", async () => {
    const v = vendor();
    const { call } = await setup();
    const listed = await call("POST", "/api/model/gateway/models", { preset: "deepseek", messages: `${v.url}/anthropic`, key: KEY });
    expect(listed.json).toMatchObject({ ok: true, source: "vendor", models: ["chat-a", "chat-b", "gpt-image-1"] });
    expect(v.seen.at(-1)).toMatchObject({ path: "/models", auth: `Bearer ${KEY}` });
    await call("POST", "/api/model/gateway/models", { preset: "minimax", messages: v.url, key: KEY });
    expect(v.seen.at(-1)).toMatchObject({ path: "/v1/models", xkey: KEY });
    const none = await call("POST", "/api/model/gateway/models", { preset: "zai", key: KEY });
    expect(none.json).toMatchObject({ source: "defaults", models: ["glm-5.4", "glm-5.3", "glm-5.3-flash"] });
    const bad = await call("POST", "/api/model/gateway/models", { preset: "kimi", messages: v.url, key: "sk-wrong-key-123456" });
    expect(bad.json).toMatchObject({ ok: true, source: "defaults", models: ["kimi-k3", "kimi-k3.1-pro"] });
    expect(bad.json.error).toContain("HTTP 401");
    expect(bad.text).not.toContain("sk-wrong-key-123456");
    // A saved provider: its own key from the environment.
    await call("POST", "/api/model/gateway/providers", { name: "c", openai: `${v.url}/v1`, key: KEY });
    expect((await call("POST", "/api/model/gateway/models", { provider: "c" })).json.models).toEqual(["chat-a", "chat-b", "gpt-image-1"]);
  });

  test("Test: one token on messages, the free list on openai, with latency; a refusal shows the vendor's error without the key", async () => {
    const v = vendor();
    const { call, env } = await setup();
    await call("POST", "/api/model/gateway/providers", { name: "both", messages: v.url, openai: `${v.url}/v1`, key: KEY, models: ["chat-a"] });
    const seenBefore = v.seen.length;
    const ok = await call("POST", "/api/model/gateway/providers/both/test", {});
    expect(ok.json.results).toMatchObject([{ base: "messages", ok: true, detail: "chat-a" }, { base: "openai", ok: true, detail: "3 models" }]);
    for (const r of ok.json.results) expect(typeof r.ms).toBe("number");
    const calls = v.seen.slice(seenBefore);
    expect(calls.map((c) => c.path)).toEqual(["/v1/messages", "/v1/models"]);
    expect(calls[0]!.body).toEqual({ model: "chat-a", max_tokens: 1, messages: [{ role: "user", content: "Hi" }] });
    env.SPACE_GATEWAY_BOTH_KEY = "sk-revoked-key-000011112222";
    const refused = await call("POST", "/api/model/gateway/providers/both/test", {});
    expect(refused.json.results[0]).toMatchObject({ base: "messages", ok: false, status: 401 });
    expect(refused.json.results[0].error).toContain("Incorrect API key provided: [key]");
    expect(refused.text).not.toContain("sk-revoked-key-000011112222");
  });
});

describe("a runtime through it", () => {
  test("the Messages API runtime is written to runtimes.yaml (comments kept) and answers at once, through the gateway's tiers", async () => {
    const v = vendor();
    const { call, runtimes, added } = await setup();
    await call("POST", "/api/model/gateway/providers", { name: "ds", preset: "deepseek", messages: v.url, key: KEY, models: ["chat-a"] });
    await call("PUT", "/api/model/gateway/tiers", { tiers: { basic: "ds/chat-a" } });
    const r = await call("POST", "/api/model/gateway/runtimes", { kind: "anthropic-api" });
    expect(r.json).toEqual({ ok: true, runtime: "gateway-api", kind: "anthropic-api", applied: true });
    expect(added).toEqual(["gateway-api"]);
    const text = await Bun.file(join(home, "runtimes.yaml")).text();
    expect(text).toStartWith("# my runtimes\nruntimes:\n");
    expect(parseRuntimesYaml(text, {}).config.runtimes.find((x) => x.name === "gateway-api")).toMatchObject({ kind: "anthropic-api", gateway: "space" });
    const target = runtimes.resolve("gateway-api/basic");
    expect(target.model).toBe("ds/chat-a");
    const out = await target.runtime.complete({ prompt: "hi", system: "", model: target.model, tag: "t", tools: [], timeoutMs: 10_000, maxTokens: 5 });
    expect(out).toMatchObject({ ok: true, text: "ok from chat-a", served: "ds/chat-a" });
    expect((await call("POST", "/api/model/gateway/runtimes", { kind: "anthropic-api" })).json.runtime).toBe("gateway-api-2");
    expect((await call("GET", "/api/model/gateway")).json.runtimes.map((x: { runtime: string }) => x.runtime)).toEqual(["gateway-api-2", "gateway-api"]);
  });

  test("Claude Code needs the CLI found here; the path never comes from the request; refused when the gateway cannot exist", async () => {
    const none = await setup();
    expect((await none.call("POST", "/api/model/gateway/runtimes", { kind: "claude-code", bin: "/tmp/evil" })).status).toBe(409);
    const found = await setup({ claude: "/opt/bin/claude" });
    const r = await found.call("POST", "/api/model/gateway/runtimes", { kind: "claude-code" });
    expect(r.json).toMatchObject({ ok: true, runtime: "gateway", applied: true });
    expect(await Bun.file(join(home, "runtimes.yaml")).text()).toContain('bin: ["/opt/bin/claude"]');
    const off = await setup({ unavailable: "ai-space listens on 10.0.0.2 only" });
    expect((await off.call("GET", "/api/model/gateway")).json.unavailable).toContain("10.0.0.2");
    expect((await off.call("POST", "/api/model/gateway/runtimes", { kind: "anthropic-api" })).status).toBe(409);
  });
});
