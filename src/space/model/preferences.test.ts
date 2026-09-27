import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { ModelPreferences, createModelPreferenceRoutes } from "./preferences.ts";
import { RuntimeRegistry } from "../runtimes/registry.ts";
import { fakeModelBin } from "../runtimes/testing.ts";
import { fakeCodexBin } from "../runtimes/testing-codex.ts";
import { ModelService } from "./service.ts";
import { ModelStore } from "./store.ts";
import { createModelRoutes } from "./api.ts";

const runtimes = () => new RuntimeRegistry({ default: "claude", runtimes: [
  { name: "claude", kind: "claude-code", bin: fakeModelBin(), chatArgs: [] },
  { name: "codex", kind: "codex-cli", bin: fakeCodexBin() },
] });

test("preferences persist, validate eight tiers, and reset to environment defaults", async () => {
  const db = new Database(":memory:");
  const prefs = new ModelPreferences(db, runtimes());
  const routes = createModelPreferenceRoutes(prefs, { model: "haiku", base: "sonnet" });
  const endpoint = routes["/api/model/preferences"];
  const put = (body: unknown) => endpoint.PUT(new Request("http://localhost/api/model/preferences", { method: "PUT", body: JSON.stringify(body) }));
  try {
    expect(prefs.options()).toHaveLength(8);
    for (const option of prefs.options()) {
      expect((await put({ defaultModel: option.value })).status).toBe(200);
      expect(new ModelPreferences(db, runtimes()).read()).toBe(option.value);
    }
    for (const value of ["missing/basic", "claude/unknown", "codex/gpt-6-sol", 3, undefined]) {
      expect((await put({ defaultModel: value })).status).toBe(400);
      expect(prefs.read()).toBe("codex/advanced");
    }
    expect((await put({ defaultModel: null })).status).toBe(200);
    expect(await endpoint.GET().json()).toMatchObject({ defaultModel: null, appDefault: "haiku", baseDefault: "sonnet" });
  } finally { db.close(); }
});

test("all three apps inherit changes immediately and explicit model choices win", async () => {
  const db = new Database(":memory:");
  const registry = runtimes();
  const prefs = new ModelPreferences(db, registry);
  const store = new ModelStore(":memory:");
  const service = new ModelService({ store, runtimes: registry, log: () => {} });
  const server = Bun.serve({ port: 0, routes: createModelRoutes({ service, defaultModel: () => prefs.read() ?? "haiku" }) });
  const run = async (app: string, model?: string, tools?: string[]) => {
    const response = await fetch(`http://localhost:${server.port}/api/model/run`, { method: "POST", body: JSON.stringify({ app, prompt: "hello", model, tools }) });
    expect(response.status).toBe(200);
    return await response.json();
  };
  try {
    for (const app of ["ai-todo", "ai-calendar", "ai-notes"]) {
      prefs.update("claude/basic");
      expect((await run(app)).call).toMatchObject({ runtime: "claude", model: "haiku" });
      prefs.update("codex/intermediate");
      expect((await run(app)).call).toMatchObject({ runtime: "codex", model: "gpt-6-sol" });
      const web = await run(app, undefined, ["WebSearch", "WebFetch"]);
      expect(web.call).toMatchObject({ runtime: "codex", model: "gpt-6-sol" });
      expect(JSON.parse(web.text).args).toContain('web_search="live"');
      expect((await run(app, "claude/junior")).call).toMatchObject({ runtime: "claude", model: "sonnet" });
    }
  } finally { server.stop(true); store.close(); db.close(); }
});
