import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeRegistry } from "../runtimes/registry.ts";
import type { CompleteInput, CompleteOutcome, OnDelta, RuntimeAdapter, RuntimesConfig } from "../runtimes/types.ts";
import { createModelRoutes, view } from "./api.ts";
import { type Prober, RuntimeHealth } from "./health.ts";
import { ModelService } from "./service.ts";
import { ModelStore } from "./store.ts";

/** Fallback lists and the call's trace: docs/model-machines.md#fallback, docs/model.md#trace. */

let dir: string;
let store: ModelStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "space-model-fallback-"));
  store = new ModelStore(join(dir, "space.db"));
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

const input = (over: Partial<CompleteInput> = {}): CompleteInput => ({ model: "a/basic", prompt: "hi", system: "be brief", tag: "notes", tools: [], timeoutMs: 60_000, maxTokens: 100, ...over });

/** What a stand-in runtime does on its next call: answer, fail, or send some text and then fail. */
type Step = { text: string } | { error: string } | { deltas: string[]; error: string };

const CONFIG: RuntimesConfig = {
  default: "a",
  runtimes: [
    { name: "a", kind: "anthropic-api", apiKey: "k", apiUrl: "", models: { basic: "m-a" } },
    { name: "b", kind: "anthropic-api", apiKey: "k", apiUrl: "", models: { basic: "m-b" } },
    { name: "c", kind: "claude-code", bin: ["false"], chatArgs: [] },
  ],
  fallback: { "a/basic": ["b/basic", "c/basic"] },
};

/** A service over CONFIG (or another) whose runtimes follow scripts instead of calling anything. */
function setup(config: RuntimesConfig = CONFIG, opts: { now?: () => number; prober?: Prober } = {}) {
  const runtimes = new RuntimeRegistry(config);
  const health = new RuntimeHealth({ prober: opts.prober ?? (async () => ({})), ...(opts.now ? { now: opts.now } : {}) });
  const service = new ModelService({ store, runtimes, health, log: () => {}, ...(opts.now ? { now: opts.now } : {}) });
  const seen: { runtime: string; model: string; timeoutMs: number }[] = [];
  const script = (adapter: RuntimeAdapter, steps: Step[], before?: () => void) =>
    Object.assign(adapter, {
      complete: async (i: CompleteInput, _s?: AbortSignal, onDelta?: OnDelta): Promise<CompleteOutcome> => {
        seen.push({ runtime: adapter.name, model: i.model, timeoutMs: i.timeoutMs });
        before?.();
        const step = steps.shift() ?? { error: "no step left" };
        if ("text" in step) return { ok: true, text: step.text, backend: adapter.backend };
        if ("deltas" in step) for (const d of step.deltas) onDelta?.(d);
        return { ok: false, error: step.error, backend: adapter.backend };
      },
    });
  const on = (name: string, steps: Step[], before?: () => void) => script(runtimes.get(name)!, steps, before);
  return { service, runtimes, health, seen, on, script };
}

describe("without a fallback list", () => {
  test("a call is as before: one try, no trace, no fallback", async () => {
    const { service, on, seen } = setup({ ...CONFIG, fallback: {} });
    on("a", [{ error: "You've hit your usage limit" }]);
    const { outcome, call } = await service.run("news", input());
    expect(outcome.ok).toBe(false);
    expect(seen.map((s) => s.runtime)).toEqual(["a"]);
    expect(call).toMatchObject({ runtime: "a", model: "m-a", status: "error", tries: 1 });
    expect(call.fallbackFrom).toBeUndefined();
    expect(call.trace).toBeUndefined();
  });

  test("a layer skipped on the way still leaves a trace", async () => {
    const { service, on } = setup({ ...CONFIG, fallback: {} });
    on("a", [{ text: "ok" }]);
    const { call } = await service.run("news", input(), undefined, undefined, { source: "default", skipped: [{ source: "manifest-tag", model: "gemini/basic" }] });
    expect(call.modelSource).toBe("default");
    expect(call.trace).toEqual({ skippedLayers: [{ source: "manifest-tag", model: "gemini/basic" }], tries: [{ runtime: "a", model: "m-a", ok: true, ms: expect.any(Number) }], stop: "answered" });
  });
});

describe("switching", () => {
  test("a quota failure before any output moves on; the row names the first choice and the trace says why", async () => {
    const { service, on, seen, health } = setup();
    on("a", [{ error: "You've hit your usage limit" }]);
    on("b", [{ text: "from b" }]);
    const { outcome, call } = await service.run("news", input());
    expect(outcome).toMatchObject({ ok: true, text: "from b" });
    expect(seen.map((s) => `${s.runtime}:${s.model}`)).toEqual(["a:m-a", "b:m-b"]);
    expect(call).toMatchObject({ runtime: "b", model: "m-b", status: "ok", fallbackFrom: "a/basic", tries: 2 });
    expect(call.trace).toMatchObject({
      candidates: [{ model: "a/basic" }, { model: "b/basic" }, { model: "c/basic" }],
      tries: [{ runtime: "a", ok: false, kind: "quota", error: "You've hit your usage limit" }, { runtime: "b", ok: true }],
      stop: "answered",
    });
    expect(health.resting("", "a")).toMatchObject({ kind: "quota" });
  });

  test("credit, rate and transport move on too, through the whole list", async () => {
    const { service, on } = setup();
    on("a", [{ error: "API 400: Your credit balance is too low" }]);
    on("b", [{ error: "API 429: slow down (retry after 20s)" }]);
    on("c", [{ error: "ssh: connect to host box port 22: Connection refused" }]);
    const { outcome, call } = await service.run("news", input());
    expect(outcome.ok).toBe(false);
    expect(call).toMatchObject({ runtime: "c", status: "error", fallbackFrom: "a/basic", tries: 3 });
    expect(call.trace!.tries.map((t) => t.kind)).toEqual(["credit", "rate", "transport"]);
    expect(call.trace!.stop).toBe("exhausted");
  });

  test("auth and bad requests never switch", async () => {
    for (const error of ["API 401: invalid x-api-key", "API 400: prompt is too long: 250000 tokens > 200000 maximum", "timed out after 60s"]) {
      const { service, on, seen } = setup();
      on("a", [{ error }]);
      on("b", [{ text: "must not answer" }]);
      const { outcome, call } = await service.run("news", input());
      expect(outcome).toMatchObject({ ok: false, error });
      expect(seen.map((s) => s.runtime)).toEqual(["a"]);
      expect(call).toMatchObject({ runtime: "a", tries: 1 });
      expect(call.fallbackFrom).toBeUndefined();
      expect(call.trace!.stop).toBe("not-switched");
    }
  });

  test("once output has reached the caller the call stays where it is", async () => {
    const { service, on, seen } = setup();
    on("a", [{ deltas: ["half an "], error: "429 Too Many Requests" }]);
    on("b", [{ text: "must not answer" }]);
    const got: string[] = [];
    const { outcome, call } = await service.run("news", input(), undefined, (t) => got.push(t));
    expect(outcome).toMatchObject({ ok: false, error: "429 Too Many Requests" });
    expect(got).toEqual(["half an "]);
    expect(seen.map((s) => s.runtime)).toEqual(["a"]);
    expect(call.trace).toMatchObject({ tries: [{ runtime: "a", kind: "rate", streamed: true }], stop: "streamed" });
  });

  test("before the first delta a streaming caller is moved on, and gets only the answering runtime's text", async () => {
    const { service, on } = setup();
    on("a", [{ error: "429 Too Many Requests" }]);
    on("b", [{ deltas: ["whole "], error: "429 Too Many Requests" }]);
    const got: string[] = [];
    // b streamed before failing: the call stops there, with b's text the only text the caller saw.
    const { call } = await service.run("news", input(), undefined, (t) => got.push(t));
    expect(got).toEqual(["whole "]);
    expect(call).toMatchObject({ runtime: "b", fallbackFrom: "a/basic", tries: 2 });
    expect(call.trace!.stop).toBe("streamed");
  });

  test("a runtime that answered without a caller reading deltas leaves nothing half-sent: it may move on", async () => {
    const { service, on } = setup();
    on("a", [{ deltas: ["ignored"], error: "429 Too Many Requests" }]);
    on("b", [{ text: "from b" }]);
    const { outcome, call } = await service.run("news", input());
    expect(outcome).toMatchObject({ ok: true, text: "from b" });
    expect(call.trace!.tries[0]!.streamed).toBeUndefined();
  });
});

describe("order", () => {
  test("a resting first choice goes last but is still tried", async () => {
    const { service, on, seen, health } = setup();
    health.note("", "a", "You've hit your usage limit");
    on("b", [{ error: "429 Too Many Requests" }]);
    on("c", [{ error: "429 Too Many Requests" }]);
    on("a", [{ text: "from a" }]);
    const { outcome, call } = await service.run("news", input());
    expect(outcome).toMatchObject({ ok: true, text: "from a" });
    expect(seen.map((s) => s.runtime)).toEqual(["b", "c", "a"]);
    // The first choice answered after all: no fallback, three tries.
    expect(call).toMatchObject({ runtime: "a", tries: 3 });
    expect(call.fallbackFrom).toBeUndefined();
    expect(call.trace!.candidates![2]).toMatchObject({ model: "a/basic", later: "resting", restKind: "quota" });
  });

  test("with every candidate resting the configured order holds; a signed-out one goes last too", async () => {
    // The probe finds c signed out; a and b rest from rate limits.
    const { service, on, seen, health, runtimes } = setup(CONFIG, { prober: async ({ spec }) => ({ installed: true, signedIn: spec.name !== "c" }) });
    await health.probe(["a", "b", "c"].map((name) => ({ machine: "", spec: runtimes.spec(name)! })));
    for (const r of ["a", "b"]) health.note("", r, "429 Too Many Requests");
    on("a", [{ error: "429 Too Many Requests" }]);
    on("b", [{ error: "429 Too Many Requests" }]);
    on("c", [{ text: "from c" }]);
    const { call } = await service.run("news", input());
    expect(seen.map((s) => s.runtime)).toEqual(["a", "b", "c"]);
    expect(call.trace!.candidates!.map((c) => c.later)).toEqual(["resting", "resting", "signed-out"]);
    expect(call).toMatchObject({ runtime: "c", fallbackFrom: "a/basic" });
  });
});

describe("rules that still hold", () => {
  test("an entry that cannot take the call is skipped with the reason: tools, full mode, another machine", async () => {
    const config: RuntimesConfig = {
      default: "c",
      runtimes: [
        { name: "c", kind: "claude-code", bin: ["false"], chatArgs: [] },
        { name: "a", kind: "anthropic-api", apiKey: "k", apiUrl: "", models: { basic: "m-a" } },
      ],
      machines: [{ name: "bare", ssh: "bare-alias" }],
      fallback: { "c/basic": ["bare:c/basic", "a/basic"] },
    };
    const { service, on, seen, script, runtimes } = setup(config);
    on("c", [{ error: "You've hit your usage limit" }, { error: "You've hit your usage limit" }]);
    on("a", [{ text: "from api" }]);
    script(runtimes.machineAdapter("bare", "c"), [{ text: "from bare" }]);

    // Full mode needs this machine and a CLI: neither entry can take it.
    const full = await service.run("news", input({ model: "c/basic", mode: "full" }));
    expect(full.outcome.ok).toBe(false);
    expect(full.call.trace!.candidates).toMatchObject([{ model: "c/basic" }, { model: "bare:c/basic", skipped: expect.stringContaining("full mode") }, { model: "a/basic", skipped: expect.stringContaining("does not support full") }]);
    expect(full.call.trace!.stop).toBe("exhausted");

    // A tool that acts on the machine: not on another one, and not on the API.
    // c rests from the call above: tried all the same, the skipped entries after it.
    const tools = await service.run("news", input({ model: "c/basic", tools: ["Read"] }));
    expect(tools.call.trace!.candidates).toMatchObject([{ model: "c/basic", later: "resting" }, { model: "bare:c/basic", skipped: expect.stringContaining("needs this machine") }, { model: "a/basic", skipped: expect.stringContaining("no tools") }]);
    expect(seen.map((s) => s.runtime)).toEqual(["c", "c"]);
  });

  test("a call another space forwarded here does not fall back here", async () => {
    const { service, on, seen } = setup();
    on("a", [{ error: "You've hit your usage limit" }]);
    on("b", [{ text: "must not answer" }]);
    const { call } = await service.run("hub/news", input(), undefined, undefined, undefined, "peer");
    expect(seen.map((s) => s.runtime)).toEqual(["a"]);
    expect(call).toMatchObject({ origin: "peer", tries: 1 });
    expect(call.trace).toBeUndefined();
  });

  test("the request's timeout is shared: the next try gets what is left, and too little left stops", async () => {
    let clock = 1_000_000;
    const roomy = setup(CONFIG, { now: () => clock });
    roomy.on("a", [{ error: "429 Too Many Requests" }], () => (clock += 40_000));
    roomy.on("b", [{ text: "from b" }]);
    await roomy.service.run("news", input());
    expect(roomy.seen.map((s) => [s.runtime, s.timeoutMs])).toEqual([["a", 60_000], ["b", 20_000]]);

    const tight = setup(CONFIG, { now: () => clock });
    tight.on("a", [{ error: "429 Too Many Requests" }], () => (clock += 57_000));
    tight.on("b", [{ text: "must not answer" }]);
    const { call } = await tight.service.run("news", input());
    expect(tight.seen.map((s) => s.runtime)).toEqual(["a"]);
    expect(call.trace!.stop).toBe("no-time");
  });
});

describe("the ledger and the API", () => {
  test("the row keeps the fallback, the tries and the trace; the calls and status routes show them", async () => {
    const { service, on } = setup();
    on("a", [{ error: "You've hit your usage limit" }]);
    on("b", [{ text: "from b" }]);
    const { call } = await service.run("news", input());
    const stored = store.get(call.id)!;
    expect(stored).toMatchObject({ fallbackFrom: "a/basic", tries: 2 });
    expect(stored.trace).toEqual(call.trace!);
    expect(view(stored)).toMatchObject({ fallbackFrom: "a/basic", tries: 2, trace: { stop: "answered" } });

    const routes = createModelRoutes({ service }) as Record<string, { GET: (r: Request) => Response | Promise<Response> }>;
    const calls = (await (await routes["/api/model/calls"]!.GET(new Request("http://x/api/model/calls"))).json()) as { calls: { fallbackFrom?: string; tries?: number; trace?: unknown }[] };
    expect(calls.calls[0]).toMatchObject({ fallbackFrom: "a/basic", tries: 2, trace: { tries: [{ kind: "quota" }, { ok: true }] } });
    const status = (await (await routes["/api/model/status"]!.GET(new Request("http://x/api/model/status"))).json()) as { fallback: Record<string, string[]> };
    expect(status.fallback).toEqual({ "a/basic": ["b/basic", "c/basic"] });
  });

  test("what an upstream gateway says served the call goes into the trace", async () => {
    const { service, runtimes } = setup({ ...CONFIG, fallback: {} });
    Object.assign(runtimes.get("a")!, { complete: async (): Promise<CompleteOutcome> => ({ ok: true, text: "hi", backend: "api", served: "anthropic/claude-haiku-4-5" }) });
    const { call } = await service.run("news", input());
    expect(call.trace).toMatchObject({ tries: [{ runtime: "a", ok: true, served: "anthropic/claude-haiku-4-5" }] });
  });
});
