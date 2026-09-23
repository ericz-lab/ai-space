import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeRegistry, claudeOnly } from "../runtimes/registry.ts";
import { fakeModelBin } from "../runtimes/testing.ts";
import { ModelService } from "./service.ts";
import { ModelStore } from "./store.ts";

let dir: string;
let store: ModelStore;
let service: ModelService;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "space-model-service-"));
  store = new ModelStore(join(dir, "space.db"));
  service = new ModelService({ store, runtimes: claudeOnly(fakeModelBin()), log: () => {} });
});

afterEach(async () => {
  store.close();
  delete process.env.FAKE_MODEL_MODE;
  await rm(dir, { recursive: true, force: true });
});

const input = () => ({ model: "haiku", prompt: "hi", system: "be brief", tag: "notes", tools: [], timeoutMs: 10_000, maxTokens: 1000 });

describe("drain", () => {
  test("waits for the call in flight and leaves its own ledger entry", async () => {
    const running = service.run("my-app", input());
    expect(await service.drain(5_000)).toEqual({ finished: 1, interrupted: 0 });
    expect((await running).outcome.ok).toBe(true);
    const calls = store.list({ app: "my-app" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.status).toBe("ok");
  });

  test("a call still running when the grace is over is recorded as interrupted", async () => {
    process.env.FAKE_MODEL_MODE = "hang";
    const controller = new AbortController();
    const running = service.run("my-app", input(), controller.signal);
    await Bun.sleep(30);

    expect(await service.drain(10)).toEqual({ finished: 0, interrupted: 1 });
    const calls = store.list({ app: "my-app" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.status).toBe("error");
    expect(calls[0]!.error).toContain("interrupted");
    expect(calls[0]!.tag).toBe("notes");

    controller.abort();
    await running.catch(() => {});
  });

  test("nothing in flight drains at once", async () => {
    expect(await service.drain(60_000)).toEqual({ finished: 0, interrupted: 0 });
  });
});

test("Codex tier calls estimate the concrete model cost only when usage is available", async () => {
  const { RuntimeRegistry } = await import("../runtimes/registry.ts");
  const { fakeCodexBin } = await import("../runtimes/testing-codex.ts");
  for (const mode of ["ok", "error"]) {
    const runtimes = new RuntimeRegistry({ default: "codex", runtimes: [{ name: "codex", kind: "codex-cli", bin: fakeCodexBin(mode) }] });
    const model = new ModelService({ store, runtimes, log: () => {} });
    const r = await model.run("news", { ...input(), model: "codex/basic" });
    expect(r.call).toMatchObject({ model: "gpt-6-luna", runtime: "codex", backend: "local", status: mode === "ok" ? "ok" : "error" });
    if (mode === "ok") expect(r.call.costUsd).toBeCloseTo(0.000009, 10);
    else expect(r.call.costUsd).toBeUndefined();
    expect(r.outcome.ok).toBe(mode === "ok");
  }
});


test("unsupported full mode is recorded without calling a bare API", async () => {
  let fetched = false;
  const runtimes = new RuntimeRegistry({ default: "api", runtimes: [{ name: "api", kind: "anthropic-api", apiKey: "test", apiUrl: "" }] },
    { fetch: (() => { fetched = true; throw new Error("must not call"); }) as unknown as typeof fetch });
  const api = new ModelService({ store, runtimes, log: () => {} });
  const r = await api.run("demo", { ...input(), mode: "full" });
  expect(r.outcome).toMatchObject({ ok: false, error: expect.stringContaining("does not support full") });
  expect(r.call.mode).toBe("full");
  expect(fetched).toBe(false);
});
