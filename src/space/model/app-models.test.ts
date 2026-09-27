import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { parseManifest } from "../scheduler/manifest.ts";
import { RuntimeRegistry } from "../runtimes/registry.ts";
import { fakeModelBin } from "../runtimes/testing.ts";
import { fakeCodexBin } from "../runtimes/testing-codex.ts";
import { createModelRoutes } from "./api.ts";
import { AppModels, type AppModelSpec, createAppModelRoutes, parseAppModelSpec } from "./app-models.ts";
import { ModelPreferences } from "./preferences.ts";
import { ModelService } from "./service.ts";
import { ModelStore } from "./store.ts";

const runtimes = () => new RuntimeRegistry({ default: "claude", runtimes: [
  { name: "claude", kind: "claude-code", bin: fakeModelBin(), chatArgs: [] },
  { name: "codex", kind: "codex-cli", bin: fakeCodexBin() },
] });

function setup(specs: Record<string, AppModelSpec | undefined>, fallback = "codex/basic") {
  const db = new Database(":memory:");
  const registry = runtimes();
  const prefs = new ModelPreferences(db, registry);
  const store = new ModelStore(":memory:");
  const service = new ModelService({ store, runtimes: registry, log: () => {} });
  const state = { fallback };
  const appModels = new AppModels(db, {
    manifest: (app) => specs[app],
    fallback: () => state.fallback,
    runnable: (m) => {
      try {
        service.resolve(m);
        return true;
      } catch {
        return false;
      }
    },
    options: () => prefs.options(),
  });
  return { db, store, service, appModels, state, close: () => { store.close(); db.close(); } };
}

test("the model section takes a name or default / tags, and rejects anything else", () => {
  expect(parseAppModelSpec("junior")).toEqual({ default: "junior", tags: {} });
  expect(parseAppModelSpec({ default: "codex/intermediate", tags: { translate: "basic" } })).toEqual({ default: "codex/intermediate", tags: { translate: "basic" } });
  expect(() => parseAppModelSpec({ tier: "basic" })).toThrow(/unknown key "tier"/);
  expect(() => parseAppModelSpec({ tags: { "Bad Tag": "basic" } })).toThrow(/invalid tag/);
  expect(() => parseAppModelSpec({ default: "rm -rf /" })).toThrow(/model.default/);
  expect(() => parseAppModelSpec(["basic"])).toThrow(/mapping/);
  expect(parseManifest("model:\n  default: junior\n  tags: { translate: basic }", "/apps/feed").model).toEqual({ default: "junior", tags: { translate: "basic" } });
  expect(parseManifest("tasks: []", "/apps/feed").model).toBeUndefined();
  expect(() => parseManifest("model: { tags: [basic] }", "/apps/feed")).toThrow(/model.tags/);
});

test("layers resolve in order: tag override, app override, manifest tag, manifest default, space default", () => {
  const { appModels, close } = setup({ feed: { default: "junior", tags: { translate: "basic", curate: "claude/advanced" } } });
  try {
    // Bare tiers run on the runtime of the space's default.
    expect(appModels.resolve("feed", "translate")).toEqual({ model: "codex/basic", source: "manifest-tag" });
    expect(appModels.resolve("feed", "curate")).toEqual({ model: "claude/advanced", source: "manifest-tag" });
    expect(appModels.resolve("feed", "digest")).toEqual({ model: "codex/junior", source: "manifest-default" });
    expect(appModels.resolve("other", "digest")).toEqual({ model: "codex/basic", source: "default" });

    appModels.setOverride("feed", null, "claude/junior");
    expect(appModels.resolve("feed", "translate")).toEqual({ model: "claude/junior", source: "override-app" });
    appModels.setOverride("feed", "translate", "codex/advanced");
    expect(appModels.resolve("feed", "translate")).toEqual({ model: "codex/advanced", source: "override-tag" });
    expect(appModels.resolve("feed", "digest")).toEqual({ model: "claude/junior", source: "override-app" });

    appModels.setOverride("feed", null, null);
    appModels.setOverride("feed", "translate", null);
    expect(appModels.resolve("feed", "translate")).toEqual({ model: "codex/basic", source: "manifest-tag" });
    expect(() => appModels.setOverride("feed", null, "codex/gpt-6-sol")).toThrow(/configured runtime\/tier/);
    expect(() => appModels.setOverride("feed", "Bad Tag", "codex/basic")).toThrow(/tag/);
  } finally { close(); }
});

test("a layer this space cannot run falls through to the next", () => {
  const { appModels, state, close } = setup({ feed: { default: "missing/advanced", tags: { translate: "gemini/basic" } } }, "claude/junior");
  try {
    expect(appModels.resolve("feed", "translate")).toEqual({ model: "claude/junior", source: "default" });
    state.fallback = "sonnet";
    expect(appModels.qualify("basic")).toBe("basic");
  } finally { close(); }
});

test("the run route records which layer chose the model; an explicit model is the request's", async () => {
  const { service, appModels, store, close } = setup({ feed: { default: "junior", tags: { translate: "basic" } } });
  const server = Bun.serve({ port: 0, routes: createModelRoutes({ service, resolveModel: (app, tag) => appModels.resolve(app, tag) }) });
  const run = async (body: Record<string, unknown>) => (await (await fetch(`http://localhost:${server.port}/api/model/run`, { method: "POST", body: JSON.stringify({ app: "feed", prompt: "hi", ...body }) })).json()) as { call: Record<string, unknown> };
  try {
    expect((await run({ tag: "translate" })).call).toMatchObject({ runtime: "codex", model: "gpt-6-luna", modelSource: "manifest-tag" });
    expect((await run({ tag: "digest" })).call).toMatchObject({ runtime: "codex", modelSource: "manifest-default" });
    expect((await run({})).call).toMatchObject({ tag: "other", modelSource: "manifest-default" });
    expect((await run({ tag: "translate", model: "claude/basic" })).call).toMatchObject({ runtime: "claude", model: "haiku", modelSource: "request" });
    appModels.setOverride("feed", "translate", "claude/intermediate");
    expect((await run({ tag: "translate" })).call).toMatchObject({ runtime: "claude", modelSource: "override-tag" });
    expect(store.list({ app: "feed", limit: 1 })[0]?.modelSource).toBe("override-tag");
    expect(store.tags("feed", 0)).toEqual(["digest", "other", "translate"]);
  } finally { server.stop(true); close(); }
});

test("routes list apps with their rows and change overrides only from a same-origin browser", async () => {
  const { appModels, close } = setup({ feed: { tags: { translate: "basic" } } });
  const routes = createAppModelRoutes({ appModels, apps: () => ["feed", "notes"], seenTags: (app) => (app === "feed" ? ["chat"] : []) });
  const patch = (app: string, body: unknown, headers: Record<string, string> = { host: "localhost", origin: "http://localhost", "content-type": "application/json" }) => {
    const req = Object.assign(new Request(`http://localhost/api/panel/apps/${app}/model`, { method: "PATCH", headers, body: JSON.stringify(body) }), { params: { app } });
    return routes["/api/panel/apps/:app/model"].PATCH(req);
  };
  try {
    const list = await routes["/api/model/apps"].GET().json();
    expect(list.options.length).toBe(8);
    expect(list.apps[0]).toEqual({ app: "feed", rows: [
      { tag: null, model: "codex/basic", source: "default" },
      { tag: "chat", model: "codex/basic", source: "default" },
      { tag: "translate", manifest: "basic", model: "codex/basic", source: "manifest-tag" },
    ] });

    expect((await patch("feed", { tag: "chat", model: "claude/junior" }, { host: "localhost", "content-type": "application/json" })).status).toBe(403);
    expect((await patch("feed", { tag: "chat", model: "claude/junior" }, { host: "localhost", origin: "http://localhost" })).status).toBe(415);
    expect((await patch("ghost", { model: "claude/junior" })).status).toBe(404);
    expect((await patch("feed", { model: "claude/junior", extra: 1 })).status).toBe(400);
    expect((await patch("feed", { model: "nope/basic" })).status).toBe(400);
    const ok = await patch("feed", { tag: "chat", model: "claude/junior" });
    expect(ok.status).toBe(200);
    expect((await ok.json()).rows[1]).toEqual({ tag: "chat", override: "claude/junior", model: "claude/junior", source: "override-tag" });

    const one = routes["/api/apps/:app/model"].GET(Object.assign(new Request("http://localhost/api/apps/feed/model"), { params: { app: "feed" } }));
    expect((await one.json()).rows[1].source).toBe("override-tag");
    expect(routes["/api/apps/:app/model"].GET(Object.assign(new Request("http://localhost/api/apps/ghost/model"), { params: { app: "ghost" } })).status).toBe(404);
  } finally { close(); }
});
