import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeRegistry } from "../runtimes/registry.ts";
import { PeerHub } from "../peers/hub.ts";
import { peerRuntimes } from "../peers/model.ts";
import { createPeerServeRoutes } from "../peers/serve.ts";
import { createPeerModelRoutes } from "./api.ts";
import { PeerRuns } from "./peer-runs.ts";
import { ModelService } from "./service.ts";
import { ModelStore } from "./store.ts";

/** A forwarded call that outlives a dropped link: docs/model-machines.md#resuming. */

const input = (model: string, timeoutMs = 10_000) => ({ model, prompt: "hi", system: "be brief", tag: "notes", tools: [], timeoutMs, maxTokens: 100 });

let dir: string;
let hubStore: ModelStore;
let peerStore: ModelStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "space-peer-resume-"));
  hubStore = new ModelStore(join(dir, "hub.db"));
  peerStore = new ModelStore(join(dir, "peer.db"));
});

afterEach(async () => {
  hubStore.close();
  peerStore.close();
  await rm(dir, { recursive: true, force: true });
});

const stub = () => new Response("stub");
const anyRoutes = new Proxy({}, { get: () => ({ GET: stub, POST: stub, DELETE: stub }) }) as Parameters<typeof createPeerServeRoutes>[0]["panel"];

/** A response whose stream breaks before the answer, as when a tunnel drops; the peer sees its side closed. */
function cut(r: Response): Response {
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await r.body!.cancel();
      controller.error(new Error("The socket connection was closed unexpectedly."));
    },
  });
  return new Response(body, { status: r.status, headers: r.headers });
}

type Link = {
  /** What happens to the n-th request to /api/peer/model/run (0-based): through, cut mid-stream, a proxy's 524 after the peer got it, or lost before it. */
  run?: (n: number) => "through" | "cut" | "524" | "unreachable";
  resume?: boolean;
  /** How long the stand-in model takes to answer. */
  answerMs?: number;
};

function link(opts: Link = {}) {
  let apiCalls = 0;
  const api = (async (_url: unknown, init?: RequestInit) => {
    apiCalls++;
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, opts.answerMs ?? 80);
      init?.signal?.addEventListener("abort", () => (clearTimeout(t), reject(new DOMException("aborted", "AbortError"))), { once: true });
    });
    return Response.json({ content: [{ type: "text", text: "pong" }], usage: { input_tokens: 10, output_tokens: 5 } });
  }) as unknown as typeof fetch;
  const peerService = new ModelService({ store: peerStore, runtimes: new RuntimeRegistry({ default: "api", runtimes: [{ name: "api", kind: "anthropic-api", apiKey: "sk", apiUrl: "" }] }, { fetch: api }), log: () => {} });
  const runs = new PeerRuns();
  const served = createPeerServeRoutes({ token: "t", name: "box", panel: anyRoutes, agents: anyRoutes, model: createPeerModelRoutes({ service: peerService, allow: ["api"], runs }) }) as Record<string, Record<string, (req: Request & { params: Record<string, string> }, s: unknown) => Promise<Response>>>;
  let runRequests = 0;
  const cancels: string[] = [];
  const wire = (async (url: string | URL | Request, init?: RequestInit) => {
    const req = new Request(url, init);
    const path = new URL(req.url).pathname;
    const cancel = path.match(/^\/api\/peer\/model\/runs\/([^/]+)\/cancel$/);
    if (cancel) {
      cancels.push(cancel[1]!);
      return served["/api/peer/model/runs/:ref/cancel"]!.POST!(Object.assign(req, { params: { ref: cancel[1]! } }), undefined);
    }
    if (path !== "/api/peer/model/run") return new Response("not found", { status: 404 });
    const fate = opts.run?.(runRequests++) ?? "through";
    if (fate === "unreachable") throw new Error("Unable to connect");
    const r = await served[path]!.POST!(Object.assign(req, { params: {} }), undefined);
    if (fate === "524") {
      await r.body?.cancel();
      return new Response("error code: 524", { status: 524 });
    }
    return fate === "cut" ? cut(r) : r;
  }) as unknown as typeof fetch;
  const peers = new PeerHub([{ name: "box", url: "http://box", token: "t", headers: {}, refreshMs: 30_000 }], { fetch: wire });
  const model = { serves: [{ name: "api", kind: "anthropic-api", image: false, tiers: {} }], cells: [], ...(opts.resume === false ? {} : { resume: true }) };
  peers.get("box")!.snapshot = { name: "box", apps: [], services: [], widgets: [], agents: [], terminal: false, capabilities: [], model, asOf: new Date().toISOString() };
  const hubRuntimes = new RuntimeRegistry({ runtimes: [{ name: "codex", kind: "codex-cli", bin: ["true"] }] });
  const logs: string[] = [];
  hubRuntimes.attachRemote(peerRuntimes(peers, "hub", { backoffMs: 5, linkMs: 300, log: (l) => logs.push(l) }));
  const hub = new ModelService({ store: hubStore, runtimes: hubRuntimes, log: () => {} });
  return { hub, runs, logs, cancels, apiCalls: () => apiCalls, runRequests: () => runRequests };
}

describe("a forwarded call through a dropped link", () => {
  test("the stream breaks mid-call: the hub asks again, gets the answer, and the model ran once", async () => {
    const l = link({ run: (n) => (n === 0 ? "cut" : "through") });
    const { outcome, call } = await l.hub.run("news", input("box:api/haiku"));
    expect(outcome).toMatchObject({ ok: true, text: "pong", backend: "peer:box" });
    expect(call).toMatchObject({ status: "ok", machine: "box" });
    expect(l.apiCalls()).toBe(1);
    expect(l.runRequests()).toBe(2);
    expect(peerStore.list()).toHaveLength(1);
    expect(peerStore.list()[0]).toMatchObject({ app: "hub/news", origin: "peer", status: "ok" });
    expect(l.logs[0]).toContain("link dropped");
  });

  test("a proxy's 524 after the peer got the call, then a request that never arrives: still one run", async () => {
    const l = link({ run: (n) => (n === 0 ? "524" : n === 1 ? "unreachable" : "through") });
    const { outcome } = await l.hub.run("news", input("box:api/haiku"));
    expect(outcome).toMatchObject({ ok: true, text: "pong" });
    expect(l.apiCalls()).toBe(1);
    expect(l.runRequests()).toBe(3);
  });

  test("asking again after the call finished returns the kept answer", async () => {
    const l = link({ answerMs: 1, run: (n) => (n === 0 ? "cut" : "through") });
    const { outcome } = await l.hub.run("news", input("box:api/haiku"));
    expect(outcome).toMatchObject({ ok: true, text: "pong" });
    expect(l.apiCalls()).toBe(1);
  });

  test("a peer without resume gets no ref: the drop is a failure, and nothing is asked twice", async () => {
    const l = link({ resume: false, run: (n) => (n === 0 ? "cut" : "through") });
    const { outcome } = await l.hub.run("news", input("box:api/haiku"));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toContain("peer stream:");
    expect(l.runRequests()).toBe(1);
    // The peer's run goes on without a listener; let it finish before the stores close.
    await Bun.sleep(150);
  });

  test("a link that stays down fails at the call's deadline", async () => {
    const l = link({ run: () => "unreachable" });
    const started = Date.now();
    const { outcome } = await l.hub.run("news", input("box:api/haiku", 1));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toContain("did not come back");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(l.apiCalls()).toBe(0);
  });

  test("a caller that gives up cancels the call on the peer", async () => {
    const l = link({ answerMs: 5_000, run: () => "cut" });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const { outcome } = await l.hub.run("news", input("box:api/haiku"), ac.signal);
    expect(outcome.ok).toBe(false);
    await Bun.sleep(50);
    expect(l.cancels).toHaveLength(1);
    expect(peerStore.list()[0]).toMatchObject({ status: "error" });
  });
});

describe("PeerRuns", () => {
  const done = () => Promise.resolve({ event: "done" as const, data: { ok: true, text: "x" } });

  test("the same caller and ref attach; another caller or ref starts its own", async () => {
    const runs = new PeerRuns();
    let started = 0;
    const start = () => (started++, done());
    expect(runs.open("hub/a", "ref-00001", start).fresh).toBe(true);
    expect(runs.open("hub/a", "ref-00001", start).fresh).toBe(false);
    expect(runs.open("other/a", "ref-00001", start).fresh).toBe(true);
    expect(runs.open("hub/a", "ref-00002", start).fresh).toBe(true);
    expect(started).toBe(3);
  });

  test("finished calls are kept for a while, then forgotten; at most maxKept of them", async () => {
    let now = 0;
    const runs = new PeerRuns({ keepMs: 1_000, maxKept: 2, now: () => now });
    for (const ref of ["ref-0000a", "ref-0000b", "ref-0000c"]) await runs.open("hub/a", ref, done).run.settled;
    now = 10;
    runs.open("hub/a", "ref-0000d", () => new Promise(() => {}));
    expect(runs.size).toBe(3);
    now = 5_000;
    expect(runs.open("hub/a", "ref-0000b", done).fresh).toBe(true);
  });

  test("cancel stops a running call only", async () => {
    const runs = new PeerRuns();
    let aborted = false;
    runs.open("hub/a", "ref-00001", (signal) => new Promise((resolve) => signal.addEventListener("abort", () => ((aborted = true), resolve({ event: "error", data: { ok: false, error: "aborted" } })))));
    expect(runs.cancel("hub/b", "ref-00001")).toBe(false);
    expect(runs.cancel("hub/a", "ref-00001")).toBe(true);
    expect(aborted).toBe(true);
  });
});
