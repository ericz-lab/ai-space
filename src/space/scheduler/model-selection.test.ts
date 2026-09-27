import { expect, test } from "bun:test";
import { RuntimeRegistry } from "../runtimes/registry.ts";
import { fakeCodexBin } from "../runtimes/testing-codex.ts";
import { createRoutes } from "./api.ts";
import { Scheduler } from "./scheduler.ts";
import { Store } from "./store.ts";

const registry = () => new RuntimeRegistry({ default: "claude", runtimes: [
  { name: "claude", kind: "claude-code", bin: [], chatArgs: [] },
  { name: "codex", kind: "codex-cli", bin: fakeCodexBin() },
] });

test("panel saves only models, validates capabilities and rejects cross-origin changes", async () => {
  const store = new Store(":memory:");
  const scheduler = new Scheduler({ store, log: () => {} });
  const task = scheduler.addTask({ app: "news", name: "classify", schedule: { kind: "every", everyMs: 60_000 }, target: { kind: "http", method: "POST", url: "http://localhost:1", model: "codex/junior" } });
  const agent = scheduler.addTask({ app: "news", name: "agent", schedule: { kind: "every", everyMs: 60_000 }, target: { kind: "agent", runtime: "claude", model: "sonnet", prompt: "p.md" } });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", routes: createRoutes({ scheduler, store, token: "operator-secret", runtimes: registry() }) });
  const base = `http://127.0.0.1:${server.port}`;
  const patch = (body: unknown, origin: string | null = base, id = task.id) => fetch(`${base}/api/panel/tasks/${id}/model`, { method: "PATCH", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
  try {
    const options = await (await fetch(`${base}/api/tasks/models`)).json();
    expect(options.models).toHaveLength(8);
    expect((await patch({ model: "codex/advanced" }, "https://evil.example")).status).toBe(403);
    expect((await patch({ model: "codex/advanced" }, null)).status).toBe(403);
    expect((await patch({ model: "codex/basic", enabled: false })).status).toBe(400);
    expect((await patch({ model: "missing/basic" })).status).toBe(400);
    expect((await patch({ model: "codex/basic" }, base, agent.id)).status).toBe(400);
    const saved = await (await patch({ model: "codex/intermediate" })).json();
    expect(saved.task).toMatchObject({ model: "codex/intermediate", overrides: { model: "codex/intermediate" }, base: { model: "codex/junior" } });
    expect((await (await patch({ model: null })).json()).task.model).toBe("codex/junior");
    // Existing general mutation routes still require the operator token.
    expect((await fetch(`${base}/api/tasks/${task.id}`, { method: "PATCH", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ model: "codex/basic" }) })).status).toBe(401);
    expect(store.getTask(task.id)!.enabled).toBe(true);
  } finally { server.stop(true); scheduler.stop(); store.close(); }
});

test("a scheduled HTTP run uses the saved model all the way through a completion", async () => {
  const runtimes = registry();
  const seen: string[] = [];
  const app = Bun.serve({ port: 0, fetch: async (req) => {
    const requested = req.headers.get("x-space-model")!;
    const selected = runtimes.resolve(requested);
    seen.push(`${selected.runtime.name}/${selected.model}`);
    const result = await selected.runtime.complete({ model: selected.model, prompt: "test", system: "return JSON", tag: "test", tools: [], timeoutMs: 3000, maxTokens: 100 });
    return Response.json({ status: result.ok ? "ok" : "error" });
  } });
  const store = new Store(":memory:");
  const scheduler = new Scheduler({ store, log: () => {} });
  try {
    const task = scheduler.addTask({ app: "news", name: "classify", schedule: { kind: "every", everyMs: 60_000 }, target: { kind: "http", method: "POST", url: `http://localhost:${app.port}`, model: "codex/basic" } });
    scheduler.patchTask(task.id, { model: "codex/junior" });
    await scheduler.tick(); await scheduler.idle();
    expect(store.listRuns(task.id)[0]!.status).toBe("ok");
    expect(seen).toEqual(["codex/gpt-5.6-terra"]);
    scheduler.patchTask(task.id, { model: "codex/intermediate" });
    scheduler.runNow(task.id); await scheduler.idle();
    expect(seen).toEqual(["codex/gpt-5.6-terra", "codex/gpt-6-sol"]);
  } finally { app.stop(true); scheduler.stop(); store.close(); }
});
