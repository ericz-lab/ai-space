import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeOnly } from "../runtimes/registry.ts";
import { fakeModelBin } from "../runtimes/testing.ts";
import { createModelRoutes } from "./api.ts";
import { ModelService } from "./service.ts";
import { ModelStore } from "./store.ts";
import { DEFAULT_SYSTEM } from "./types.ts";

let dir: string;
let store: ModelStore;
let service: ModelService;
let server: ReturnType<typeof Bun.serve>;
let base: string;

const TOKENS: Record<string, string> = { "sat_my-app": "my-app", sat_other: "other" };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "space-model-api-"));
  store = new ModelStore(join(dir, "space.db"));
  service = new ModelService({ store, runtimes: claudeOnly(fakeModelBin()), maxConcurrency: 2, log: () => {} });
  server = Bun.serve({
    port: 0,
    routes: createModelRoutes({ service, token: "op-token", appForToken: async (t) => TOKENS[t], defaultModel: "haiku" }),
    fetch: () => new Response("nf", { status: 404 }),
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  server.stop(true);
  store.close();
  delete process.env.FAKE_MODEL_MODE;
  await rm(dir, { recursive: true, force: true });
});

const post = (path: string, body: unknown, token?: string) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

type RunBody = { ok: boolean; text?: string; error?: string; call: { id: number; app: string; tag: string; model: string; status: string; usage?: { inputTokens: number }; costUsd?: number } };

describe("POST /api/model/run", () => {
  test("an app token identifies the app; the answer and the ledger row come back", async () => {
    const res = await post("/api/model/run", { app: "someone-else", prompt: "hello", tag: "translate" }, "sat_my-app");
    expect(res.status).toBe(200);
    const body = (await res.json()) as RunBody;
    expect(body.text).toBe(`answer to: hello [args: -p --output-format json --model haiku --strict-mcp-config --tools  --system-prompt ${DEFAULT_SYSTEM}]`);
    expect(body.call).toMatchObject({ app: "my-app", tag: "translate", model: "haiku", runtime: "claude", backend: "local", status: "ok", usage: { inputTokens: 10 }, costUsd: 0.0123 });
    expect(store.get(body.call.id)).toMatchObject({ app: "my-app", promptChars: 5, runtime: "claude" });
  });

  test("a runtime prefix picks the runtime and is stripped from the model; an unknown one is 400 and leaves no row", async () => {
    const res = await post("/api/model/run", { prompt: "hello", model: "claude/sonnet" }, "sat_my-app");
    expect(res.status).toBe(200);
    const body = (await res.json()) as RunBody;
    expect(body.text).toContain("--model sonnet ");
    expect(body.call).toMatchObject({ model: "sonnet", runtime: "claude" });
    const before = store.totals(0).calls;
    const bad = await post("/api/model/run", { prompt: "hello", model: "dsh/deepseek-v4-flash" }, "sat_my-app");
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("unknown runtime: dsh");
    expect(store.totals(0).calls).toBe(before);
  });

  test("the operator token needs an explicit app; wrong or missing tokens are 401", async () => {
    expect((await post("/api/model/run", { prompt: "x" }, "op-token")).status).toBe(400);
    const ok = await post("/api/model/run", { app: "my-app", prompt: "x", model: "sonnet" }, "op-token");
    expect(((await ok.json()) as RunBody).call).toMatchObject({ app: "my-app", model: "sonnet" });
    expect((await post("/api/model/run", { prompt: "x" }, "nope")).status).toBe(401);
    expect((await post("/api/model/run", { app: "my-app", prompt: "x" })).status).toBe(401);
  });

  test("validation errors are 400 with the reason and leave no row", async () => {
    const bad = await post("/api/model/run", { model: "so nnet", prompt: "x" }, "sat_my-app");
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/model/);
    const notJson = await fetch(`${base}/api/model/run`, { method: "POST", headers: { authorization: "Bearer sat_my-app" }, body: "nope" });
    expect(notJson.status).toBe(400);
    expect(store.list()).toEqual([]);
  });

  test("a model failure is 502 and still recorded", async () => {
    process.env.FAKE_MODEL_MODE = "error";
    const res = await post("/api/model/run", { prompt: "x" }, "sat_my-app");
    expect(res.status).toBe(502);
    const body = (await res.json()) as RunBody;
    expect(body).toMatchObject({ ok: false, error: "simulated runtime failure", call: { status: "error" } });
    expect(store.get(body.call.id)).toMatchObject({ status: "error", error: "simulated runtime failure" });
  });

  test("calls beyond the concurrency cap wait their turn", async () => {
    const started = Date.now();
    const runs = await Promise.all([1, 2, 3, 4].map((i) => post("/api/model/run", { prompt: `p${i}` }, "sat_my-app")));
    expect(runs.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(store.list()).toHaveLength(4);
    expect(Date.now() - started).toBeLessThan(20_000);
  });
});

describe("reads", () => {
  test("status, usage and calls", async () => {
    await post("/api/model/run", { prompt: "a", tag: "translate" }, "sat_my-app");
    await post("/api/model/run", { prompt: "b", tag: "digest", model: "sonnet" }, "sat_other");
    const status = (await (await fetch(`${base}/api/model/status`)).json()) as { backend: string; maxConcurrency: number; running: number };
    expect(status).toMatchObject({ ok: true, backend: "local", maxConcurrency: 2, running: 0, runtimes: [{ name: "claude", kind: "claude-code", backend: "local", default: true }] });

    const usage = (await (await fetch(`${base}/api/model/usage?window=5h`)).json()) as {
      window: string;
      totals: { calls: number; tokens: number; costUsd: number };
      byApp: { app: string; calls: number }[];
      byTag: { app: string; tag: string; model: string }[];
      byModel: { model: string }[];
      history: { firstAt?: string; totals: { calls: number }; days: { day: string; calls: number }[] };
    };
    expect(usage.window).toBe("5h");
    expect(usage.totals).toMatchObject({ calls: 2, tokens: 200, costUsd: 0.0246 });
    expect(usage.byApp.map((a) => a.app).sort()).toEqual(["my-app", "other"]);
    expect(usage.byTag).toHaveLength(2);
    expect(usage.byModel.map((m) => m.model).sort()).toEqual(["haiku", "sonnet"]);
    expect(usage.history.days).toHaveLength(1);
    expect(usage.history.totals.calls).toBe(2);
    expect(usage.history.firstAt).toMatch(/^\d{4}-/);
    const mine = (await (await fetch(`${base}/api/model/usage?app=my-app`)).json()) as { totals: { calls: number } };
    expect(mine.totals.calls).toBe(1);
    expect((await fetch(`${base}/api/model/usage?window=1y`)).status).toBe(400);

    const calls = (await (await fetch(`${base}/api/model/calls?app=other`)).json()) as { calls: { app: string; tag: string; startedAt: string }[] };
    expect(calls.calls).toEqual([expect.objectContaining({ app: "other", tag: "digest" })]);
    expect(calls.calls[0]!.startedAt).toMatch(/^\d{4}-/);
    expect((await fetch(`${base}/api/model/calls?tag=Bad Tag`)).status).toBe(400);
  });
});
