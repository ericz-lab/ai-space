import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRuntimesYaml } from "../runtimes/config.ts";
import { RuntimeRegistry, splitMachine } from "../runtimes/registry.ts";
import type { RuntimeSpec } from "../runtimes/types.ts";
import { PeerHub } from "../peers/hub.ts";
import { createPeerRuntime, peerRuntimes } from "../peers/model.ts";
import { createPeerServeRoutes } from "../peers/serve.ts";
import { createModelRoutes, createPeerModelRoutes } from "./api.ts";
import { RuntimeHealth, probeRuntime, readStatus } from "./health.ts";
import { cellOf, probeTargets, statusTable } from "./machines.ts";
import { ModelService, needsLocal } from "./service.ts";
import { ModelStore } from "./store.ts";
import { MODEL_PATTERN } from "./types.ts";

/** Model calls by machine: docs/model-machines.md. */

const input = (model: string) => ({ model, prompt: "hi", system: "be brief", tag: "notes", tools: [], timeoutMs: 10_000, maxTokens: 100 });

/** The Messages API as a stand-in runtime: answers with a fixed text, or fails with `error`. */
function fakeApi(opts: { text?: string; error?: { status: number; message: string } } = {}): typeof fetch {
  return (async () => {
    if (opts.error) return new Response(JSON.stringify({ error: { message: opts.error.message } }), { status: opts.error.status });
    return Response.json({ content: [{ type: "text", text: opts.text ?? "pong" }], usage: { input_tokens: 10, output_tokens: 5 } });
  }) as unknown as typeof fetch;
}

/** Panel and agent tables with a stub for every path: the serve routes look their mirrored handlers up at creation. */
const stub = () => new Response("stub");
const anyRoutes = new Proxy({}, { get: () => ({ GET: stub, POST: stub, DELETE: stub }) }) as Parameters<typeof createPeerServeRoutes>[0]["panel"];

describe("model strings name a machine", () => {
  test("the pattern takes machine:runtime/model; a colon after the slash stays the runtime's", () => {
    for (const ok of ["haiku", "codex/basic", "box:codex/basic", "box:dsh/deepseek-official:deepseek-flash", "gpu-box.2:claude/opus"]) expect(MODEL_PATTERN.test(ok)).toBe(true);
    for (const bad of ["box:/basic", ":codex/basic", "box:codex/", "a b:codex/basic"]) expect(MODEL_PATTERN.test(bad)).toBe(false);
    expect(splitMachine("box:codex/basic")).toEqual({ machine: "box", runtime: "codex", model: "basic" });
    expect(splitMachine("dsh/deepseek-official:deepseek-flash")).toBeUndefined();
    expect(splitMachine("haiku")).toBeUndefined();
  });
});

describe("machines: in runtimes.yaml", () => {
  const yaml = `default: codex
runtimes:
  codex: { kind: codex-cli }
  claude: { kind: claude-code }
  api: { kind: anthropic-api, apiKeyEnv: K }
machines:
  bare: { ssh: bare-alias }
`;

  test("are parsed and resolve to this space's adapter over ssh, with the tier resolved here", () => {
    const { config, warnings } = parseRuntimesYaml(yaml, { K: "sk" });
    expect(warnings).toEqual([]);
    expect(config.machines).toEqual([{ name: "bare", ssh: "bare-alias" }]);
    const reg = new RuntimeRegistry(config);
    const r = reg.resolve("bare:codex/basic");
    expect(r.runtime.machine).toBe("bare");
    expect(r.runtime.backend).toBe("ssh:bare-alias");
    expect(r.runtime.name).toBe("codex");
    expect(r.model).toBe("gpt-6-luna");
    // The same adapter each time, and the local runtime is untouched.
    expect(reg.resolve("bare:codex/junior").runtime).toBe(r.runtime);
    expect(reg.resolve("codex/basic").runtime.backend).toBe("local");
    expect(reg.describe()).toContain("machines bare (ssh:bare-alias)");
    expect(reg.machineTierOptions().map((o) => o.value)).toContain("bare:claude/advanced");
  });

  test("an API runtime, an unknown machine or runtime is an error", () => {
    const reg = new RuntimeRegistry(parseRuntimesYaml(yaml, { K: "sk" }).config);
    expect(() => reg.resolve("bare:api/haiku")).toThrow("cannot run on another machine");
    expect(() => reg.resolve("nowhere:codex/basic")).toThrow("unknown machine: nowhere");
    expect(() => reg.resolve("bare:nope/basic")).toThrow("unknown runtime: nope");
  });

  test("bad entries are refused at load", () => {
    expect(() => parseRuntimesYaml(`${yaml}  Bad_Name: { ssh: x }\n`, { K: "sk" })).toThrow("invalid machine name");
    expect(() => parseRuntimesYaml(`${yaml}  two: { ssh: "x; rm" }\n`, { K: "sk" })).toThrow("ssh must be a host name");
    expect(() => parseRuntimesYaml(`${yaml}  three: { ssh: x, user: y }\n`, { K: "sk" })).toThrow('unknown key "user"');
  });

  test("a peer named like a machine is refused: a machine is a space or an ssh login", () => {
    const reg = new RuntimeRegistry(parseRuntimesYaml(yaml, { K: "sk" }).config);
    expect(() => reg.attachRemote({ names: () => ["bare"], adapter: () => ({ error: "x" }), offered: () => [] })).toThrow("both a peer and an entry under machines:");
  });

  test("a runtime's own ssh still answers there, and its calls carry that machine", () => {
    const reg = new RuntimeRegistry(parseRuntimesYaml(`runtimes:\n  codex: { kind: codex-cli, ssh: other }\n`).config);
    expect(reg.get("codex")!.machine).toBe("other");
    expect(probeTargets(reg).map((t) => [t.machine, t.ssh ?? null])).toEqual([["", null], ["other", "other"]]);
  });
});

describe("answers through a peer", () => {
  let dir: string;
  let hubStore: ModelStore;
  let peerStore: ModelStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "space-model-machines-"));
    hubStore = new ModelStore(join(dir, "hub.db"));
    peerStore = new ModelStore(join(dir, "peer.db"));
  });

  afterEach(async () => {
    hubStore.close();
    peerStore.close();
    await rm(dir, { recursive: true, force: true });
  });

  /** Space "box" offering `allow`, and space "hub" with box as its peer; the link is an in-process call. */
  function link(opts: { allow?: string[]; api?: typeof fetch; token?: string; hubToken?: string; proxy?: (r: Response) => Response } = {}) {
    const peerRuntimesReg = new RuntimeRegistry({ default: "api", runtimes: [{ name: "api", kind: "anthropic-api", apiKey: "sk", apiUrl: "" }] }, { fetch: opts.api ?? fakeApi() });
    const peerHealth = new RuntimeHealth();
    const peerService = new ModelService({ store: peerStore, runtimes: peerRuntimesReg, log: () => {}, health: peerHealth });
    const allow = opts.allow ?? ["api"];
    const served = createPeerServeRoutes({
      token: opts.token ?? "t",
      name: "box",
      panel: anyRoutes,
      agents: anyRoutes,
      model: createPeerModelRoutes({ service: peerService, allow }),
      modelInfo: () => ({ serves: allow.map((name) => ({ name, kind: "anthropic-api", image: false, tiers: {} })), cells: peerHealth.list() }),
    }) as Record<string, Record<string, (req: Request & { params: Record<string, string> }, s: unknown) => Promise<Response>>>;
    const wire = (async (url: string | URL | Request, init?: RequestInit) => {
      const req = new Request(url, init);
      const route = served[new URL(req.url).pathname];
      if (!route?.[req.method]) return new Response("not found", { status: 404 });
      const r = await route[req.method]!(Object.assign(req, { params: {} }), undefined);
      return opts.proxy ? opts.proxy(r) : r;
    }) as unknown as typeof fetch;
    const peers = new PeerHub([{ name: "box", url: "http://box", token: opts.hubToken ?? "t", headers: {}, refreshMs: 30_000 }], { fetch: wire });
    peers.get("box")!.snapshot = { name: "box", apps: [], services: [], widgets: [], agents: [], terminal: false, capabilities: [], model: { serves: allow.map((name) => ({ name, kind: "anthropic-api", image: false, tiers: {} })), cells: [] }, asOf: new Date().toISOString() };
    const hubRuntimes = new RuntimeRegistry({ runtimes: [{ name: "codex", kind: "codex-cli", bin: ["true"] }] });
    hubRuntimes.attachRemote(peerRuntimes(peers, "hub"));
    const hubHealth = new RuntimeHealth();
    const hub = new ModelService({ store: hubStore, runtimes: hubRuntimes, log: () => {}, health: hubHealth });
    return { hub, hubHealth, peerService, peers, hubRuntimes };
  }

  test("run on the peer, recorded on both sides: the app here, the caller there", async () => {
    const { hub } = link();
    const { outcome, call } = await hub.run("news", input("box:api/haiku"));
    expect(outcome).toMatchObject({ ok: true, text: "pong", backend: "peer:box" });
    expect(call).toMatchObject({ app: "news", runtime: "api", machine: "box", backend: "peer:box", model: "haiku", origin: "run", status: "ok" });
    expect(call.usage).toEqual({ inputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 5 });
    const there = peerStore.list();
    expect(there).toHaveLength(1);
    expect(there[0]).toMatchObject({ app: "hub/news", runtime: "api", origin: "peer", backend: "api", model: "haiku" });
    expect(there[0]!.machine).toBeUndefined();
    expect(hubStore.groupBy(["machine", "runtime"], 0)).toMatchObject([{ machine: "box", runtime: "api", calls: 1 }]);
  });

  test("a streaming caller gets the peer's answer through its event stream", async () => {
    const { hub } = link();
    const deltas: string[] = [];
    const { outcome } = await hub.run("news", input("box:api/haiku"), undefined, (t) => deltas.push(t));
    expect(outcome).toMatchObject({ ok: true, text: "pong" });
  });

  test("the peer's account error comes back as it is and marks both sides limited", async () => {
    const { hub, hubHealth } = link({ api: fakeApi({ error: { status: 429, message: "You've hit your usage limit" } }) });
    const { outcome, call } = await hub.run("news", input("box:api/haiku"));
    expect(outcome.ok).toBe(false);
    expect(call.error).toContain("usage limit");
    expect(hubHealth.list().find((c) => c.machine === "box")?.limitedUntil).toBeDefined();
  });

  test("a proxy on the link that swaps a 502's body still lets the peer's error and model through", async () => {
    // A CDN in front of the peer answers a 502 with its own page; the call travels as an event stream, so a failure is an event.
    const proxy = (r: Response) => (r.status === 502 ? new Response("error code: 502", { status: 502 }) : r);
    const { hub, hubHealth } = link({ proxy, api: fakeApi({ error: { status: 429, message: "429 Too Many Requests" } }) });
    const { outcome, call } = await hub.run("news", input("box:api/haiku"));
    expect(outcome.ok).toBe(false);
    expect(call.error).toContain("429 Too Many Requests");
    expect(call.model).toBe("haiku");
    expect(hubHealth.list().find((c) => c.machine === "box")?.limitedUntil).toBeDefined();
  });

  test("a runtime the peer does not offer, a rejected token, a machine in a forwarded call", async () => {
    const offered = link({ allow: ["api"] });
    expect(() => offered.hubRuntimes.resolve("box:other/haiku")).toThrow("does not offer runtime other; it offers api");

    const wrong = link({ hubToken: "nope" });
    const { outcome } = await wrong.hub.run("news", input("box:api/haiku"));
    expect(outcome).toMatchObject({ ok: false, error: "peer box rejected the token" });

    // Straight at the peer route: no machine prefix, no runtime outside the list.
    const routes = createPeerModelRoutes({ service: offered.peerService, allow: ["api"] }) as Record<string, Record<string, (req: Request & { params: Record<string, string> }) => Promise<Response>>>;
    const post = (body: unknown, caller = "hub/news") => routes["/api/peer/model/run"]!.POST!(Object.assign(new Request("http://box/api/peer/model/run", { method: "POST", headers: { "x-space-caller": caller }, body: JSON.stringify(body) }), { params: {} }));
    expect(((await (await post({ prompt: "hi", model: "far:api/haiku" })).json()) as { error: string }).error).toContain("names no machine");
    expect((await post({ prompt: "hi", model: "api/haiku" }, "no-slash")).status).toBe(400);
    expect((await post({ prompt: "hi" })).status).toBe(400);
  });

  test("a runtime outside SPACE_PEER_MODEL is refused by the peer even when asked directly", async () => {
    const { peerService } = link();
    const routes = createPeerModelRoutes({ service: peerService, allow: [] }) as Record<string, Record<string, (req: Request & { params: Record<string, string> }) => Promise<Response>>>;
    const r = await routes["/api/peer/model/run"]!.POST!(Object.assign(new Request("http://box/x", { method: "POST", headers: { "x-space-caller": "hub/news" }, body: JSON.stringify({ prompt: "hi", model: "api/haiku" }) }), { params: {} }));
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toContain("SPACE_PEER_MODEL");
  });

  test("both directions: each space may be the other's peer", async () => {
    // Space A offers its runtime to B and B offers its own to A; each call stays on the machine it was sent to.
    const ab = link();
    const ba = link();
    expect((await ab.hub.run("a-app", input("box:api/haiku"))).outcome.ok).toBe(true);
    expect((await ba.hub.run("b-app", input("box:api/haiku"))).outcome.ok).toBe(true);
  });

  test("a call that needs this machine's environment is refused on another, here and at the peer", async () => {
    const { hub, hubRuntimes, peerService } = link();
    for (const extra of [{ mode: "full" as const }, { tools: ["Bash"] }, { tools: ["WebSearch", "Read(/etc/*)"] }]) {
      const { outcome, call } = await hub.run("news", { ...input("box:api/haiku"), ...extra });
      expect(outcome.ok).toBe(false);
      expect(call).toMatchObject({ status: "error", machine: "box" });
      expect(call.error).toContain("needs this machine's environment, so it cannot run on box");
    }
    // Plain reasoning and the web tools travel; files do too, since they ride along with the request.
    expect(needsLocal({ mode: "slim", tools: ["WebSearch", "WebFetch(example.com)"] })).toBeUndefined();
    expect(() => hub.place({ ...input("box:api/haiku"), tools: ["WebSearch"] })).not.toThrow();
    // On this machine nothing is refused.
    expect(() => hub.place({ ...input("codex/basic"), mode: "full" })).not.toThrow();
    expect(hubRuntimes.resolve("codex/basic").runtime.machine).toBeUndefined();

    const routes = createPeerModelRoutes({ service: peerService, allow: ["api"] }) as Record<string, Record<string, (req: Request & { params: Record<string, string> }) => Promise<Response>>>;
    const r = await routes["/api/peer/model/run"]!.POST!(Object.assign(new Request("http://box/x", { method: "POST", headers: { "x-space-caller": "hub/news" }, body: JSON.stringify({ prompt: "hi", model: "api/haiku", tools: ["Bash"] }) }), { params: {} }));
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toContain("plain reasoning only");
  });

  test("a machines: login or a runtime's own ssh refuses full mode too", () => {
    const reg = new RuntimeRegistry(parseRuntimesYaml(`machines:\n  bare: { ssh: me@bare }\nruntimes:\n  codex: { kind: codex-cli }\n  old: { kind: codex-cli, ssh: other }\n`).config);
    const svc = new ModelService({ store: hubStore, runtimes: reg, log: () => {} });
    expect(() => svc.place({ ...input("bare:codex/basic"), mode: "full" })).toThrow("cannot run on bare");
    expect(() => svc.place({ ...input("old/basic"), tools: ["Bash"] })).toThrow("cannot run on other");
    expect(() => svc.place({ ...input("codex/basic"), mode: "full" })).not.toThrow();
  });

  test("the model status lists the machines; usage sums by machine", async () => {
    const { hub } = link();
    await hub.run("news", input("box:api/haiku"));
    const routes = createModelRoutes({ service: hub, machines: () => [{ machine: "box", runtime: "api", kind: "anthropic-api", used: true }], servesPeers: [], space: "hub" }) as Record<string, Record<string, (req: Request & { params: Record<string, string> }) => Promise<Response>>>;
    const status = (await (await routes["/api/model/status"]!.GET!(Object.assign(new Request("http://x/api/model/status"), { params: {} }))).json()) as { machines: unknown[] };
    expect(status.machines).toHaveLength(1);
    const usage = (await (await routes["/api/model/usage"]!.GET!(Object.assign(new Request("http://x/api/model/usage"), { params: {} }))).json()) as { space: string; byMachine: { machine: string; calls: number }[] };
    expect(usage.space).toBe("hub");
    expect(usage.byMachine).toMatchObject([{ machine: "box", calls: 1 }]);
  });
});

describe("pictures through a peer", () => {
  test("the input images travel under their own names; the pictures come back as bytes", async () => {
    let sent: { model?: string; images?: { name: string }[] } = {};
    const client = {
      name: "box",
      request: async (_path: string, init: RequestInit) => {
        sent = JSON.parse(String(init.body));
        return Response.json({ ok: true, text: "a cat", images: [{ type: "image/png", data: Buffer.from([1, 2, 3]).toString("base64") }], call: { model: "gpt-image", costUsd: 0.01 } });
      },
    } as unknown as Parameters<typeof createPeerRuntime>[0];
    const dir = await mkdtemp(join(tmpdir(), "space-peer-image-"));
    try {
      await Bun.write(join(dir, "a17.png"), new Uint8Array([9]));
      const rt = createPeerRuntime(client, "hub", { name: "codex", kind: "codex-cli", image: true });
      const out = await rt.image!({ prompt: "draw", system: "s", model: "basic", tag: "image", files: [{ name: "a17.png", path: join(dir, "a17.png") }], timeoutMs: 1000, caller: "notes" });
      expect(sent.model).toBe("codex/basic");
      expect(sent.images?.[0]?.name).toBe("a17.png");
      expect(out).toMatchObject({ ok: true, text: "a cat", model: "gpt-image", costUsd: 0.01, backend: "peer:box" });
      if (out.ok) expect([...out.images[0]!.bytes]).toEqual([1, 2, 3]);
      expect(rt.capabilities).toEqual({ complete: true, agent: false, chat: false, image: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("status table", () => {
  test("a success clears a limit; an account error sets one; other errors do not", () => {
    let now = 1_000_000;
    const h = new RuntimeHealth({ now: () => now, prober: async () => ({ installed: true }) });
    h.note("", "codex", "exceeded retry limit, last status: 429 Too Many Requests");
    expect(h.list()[0]!.limitedUntil).toBe(new Date(now + 3_600_000).toISOString());
    h.note("", "codex");
    expect(h.list()[0]!.limitedUntil).toBeUndefined();
    h.note("", "codex", "verification failed (exit 1)");
    expect(h.list()[0]!.limitedUntil).toBeUndefined();
    h.note("", "codex", "You've hit your usage limit");
    now += 3_600_001;
    expect(h.list()[0]!.limitedUntil).toBeUndefined();
  });

  test("the CLIs' own status commands decide signed in", () => {
    expect(readStatus("claude-code", 0, '{"loggedIn": true}', "")).toEqual({ signedIn: true });
    expect(readStatus("claude-code", 1, '{"loggedIn": false}', "")).toMatchObject({ signedIn: false });
    expect(readStatus("codex-cli", 0, "Logged in using ChatGPT", "")).toEqual({ signedIn: true });
    expect(readStatus("codex-cli", 1, "", "Not logged in")).toEqual({ signedIn: false, detail: "Not logged in" });
  });

  test("installed means on the service's own PATH, not the login shell's", async () => {
    const calls: string[][] = [];
    const spawn = (async (cmd: string[]) => {
      calls.push(cmd);
      return { code: 0, stdout: '{"loggedIn": true}', stderr: "", timedOut: false, aborted: false };
    }) as unknown as Parameters<typeof probeRuntime>[0];
    const claude: RuntimeSpec = { name: "claude", kind: "claude-code", bin: ["claude-not-installed-here"], chatArgs: [] };
    expect(await probeRuntime(spawn, { PATH: "/nonexistent" })({ machine: "", spec: claude })).toMatchObject({ installed: false });
    expect(calls).toEqual([]);
    expect(await probeRuntime(spawn, { PATH: "/usr/bin:/bin" })({ machine: "", spec: { ...claude, bin: ["true"] } })).toEqual({ installed: true, signedIn: true });
    expect(calls).toEqual([["true", "--version"], ["true", "auth", "status"]]);
    // Over ssh through the login shell; 127 is a missing CLI there.
    const missing = (async () => ({ code: 127, stdout: "", stderr: "", timedOut: false, aborted: false })) as unknown as Parameters<typeof probeRuntime>[0];
    expect(await probeRuntime(missing)({ machine: "bare", spec: claude, ssh: "bare-alias" })).toMatchObject({ installed: false });
    // 255 is ssh itself failing: the machine is unreachable, not missing the CLI.
    const down = (async () => ({ code: 255, stdout: "", stderr: "ssh: Could not resolve hostname", timedOut: false, aborted: false })) as unknown as Parameters<typeof probeRuntime>[0];
    const r = await probeRuntime(down)({ machine: "bare", spec: claude, ssh: "bare-alias" });
    expect(r).toMatchObject({ reachable: false });
    expect(r.installed).toBeUndefined();
  });

  test("used cells that cannot answer are flagged; a peer's own report is merged under its name", () => {
    const reg = new RuntimeRegistry({ default: "codex", runtimes: [{ name: "codex", kind: "codex-cli", bin: [] }, { name: "claude", kind: "claude-code", bin: [], chatArgs: [] }] });
    const health = new RuntimeHealth({ prober: async () => ({ installed: true }) });
    health.note("box", "codex", "usage limit");
    const now = Date.now();
    const table = statusTable({
      health,
      runtimes: reg,
      used: ["codex/basic", "box:codex/basic", "far:dsh/basic"],
      peers: [{ machine: "box", serves: [{ name: "codex", kind: "codex-cli" }], cells: [{ machine: "", runtime: "codex", kind: "codex-cli", installed: true, signedIn: true }] }],
      now,
    });
    const box = table.find((c) => c.machine === "box")!;
    expect(box).toMatchObject({ kind: "codex-cli", installed: true, signedIn: true, used: true, problem: "limited" });
    expect(table.find((c) => c.machine === "far")).toMatchObject({ used: true, problem: "not installed" });
    expect(cellOf("haiku", reg)).toBe("|codex");
    expect(cellOf("box:codex/basic", reg)).toBe("box|codex");
  });

  test("the ledger seeds the last success per machine and runtime", async () => {
    const dir = await mkdtemp(join(tmpdir(), "space-model-lastok-"));
    const store = new ModelStore(join(dir, "x.db"));
    try {
      const base = { app: "a", tag: "t", model: "m", origin: "run" as const, durationMs: 1, promptChars: 1 };
      store.add({ ...base, runtime: "codex", backend: "local", status: "ok", startedAt: 100 });
      store.add({ ...base, runtime: "codex", machine: "box", backend: "peer:box", status: "ok", startedAt: 200 });
      store.add({ ...base, runtime: "codex", machine: "box", backend: "peer:box", status: "error", startedAt: 300 });
      expect([...store.lastOk()].sort()).toEqual([["box|codex", 200], ["|codex", 100]]);
      const h = new RuntimeHealth();
      h.seed(store.lastOk());
      expect(h.list().map((c) => [c.machine, c.lastOkAt])).toEqual([["", new Date(100).toISOString()], ["box", new Date(200).toISOString()]]);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
