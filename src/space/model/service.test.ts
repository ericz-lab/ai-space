import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeOnly } from "../runtimes/registry.ts";
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
