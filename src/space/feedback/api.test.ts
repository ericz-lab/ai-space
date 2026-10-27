import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { guardBrowserWrites } from "../auth.ts";
import { createFeedbackRoutes } from "./api.ts";
import { FeedbackService } from "./service.ts";
import { FeedbackStore } from "./store.ts";
import { TodoSink } from "./todo.ts";

type Handler = (req: Request, server?: unknown) => Response | Promise<Response>;

function setup() {
  const store = new FeedbackStore(new Database(":memory:"));
  let todo = 40;
  const service = new FeedbackService({
    store,
    name: "home",
    app: (app) => (app === "ai-todo" ? { title: "AI Todo", hasDeployCheck: true } : undefined),
    todo: () => new TodoSink(async (cap) => (cap === "add" ? { status: 201, text: JSON.stringify({ ok: true, todos: [{ id: ++todo }] }) } : { status: 200, text: '{"ok":true}' }), ""),
    fixer: { start: async () => "run-1", wait: () => new Promise(() => {}) },
    machines: () => ["hub"],
    log: () => {},
  });
  // As the entry point serves them: every write behind the same-origin guard.
  const routes = guardBrowserWrites(
    createFeedbackRoutes({
      service,
      script: async () => ({ js: "/*widget*/", etag: '"w1"' }),
      apps: () => [{ app: "ai-todo", title: "AI Todo", zh: "AI 待办", status: "active" }],
      machines: () => [{ value: "", label: "home" }, { value: "hub", label: "hub" }],
      models: () => [{ value: "claude/intermediate", runtime: "claude", tier: "intermediate", model: "opus" }],
    }),
  ) as Record<string, Record<string, Handler>>;
  const call = async (method: string, path: string, init: { body?: string; headers?: Record<string, string> } = {}) => {
    const url = new URL(path, "http://todo.example.com");
    const res = await routes[url.pathname]![method]!(new Request(url, { method, body: init.body, headers: { host: "todo.example.com", ...init.headers } }));
    const text = await res.text();
    return { status: res.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })(), headers: res.headers };
  };
  return { call, service, store };
}

const same = { origin: "http://todo.example.com", "content-type": "application/json" };
const page = { ...same, "x-space-app": "ai-todo" };

describe("feedback routes", () => {
  test("the script is served with an etag", async () => {
    const { call } = setup();
    const r = await call("GET", "/_space/feedback.js");
    expect([r.status, r.text, r.headers.get("content-type")]).toEqual([200, "/*widget*/", "text/javascript; charset=utf-8"]);
    // Checked on every load, so a new version reaches open pages at once.
    expect(r.headers.get("cache-control")).toBe("no-cache");
    expect((await call("GET", "/_space/feedback.js", { headers: { "if-none-match": '"w1"' } })).status).toBe(304);
  });

  test("config and recent need the router's app; off says only that", async () => {
    const { call, service } = setup();
    expect((await call("GET", "/_space/feedback/config")).status).toBe(400);
    expect((await call("GET", "/_space/feedback/config", { headers: { "x-space-app": "../x" } })).status).toBe(404);
    expect((await call("GET", "/_space/feedback/config", { headers: { "x-space-app": "ai-todo" } })).json).toEqual({ ok: true, enabled: false });
    service.saveSettings({ enabled: true });
    expect((await call("GET", "/_space/feedback/config", { headers: { "x-space-app": "ai-todo" } })).json).toMatchObject({ enabled: true, app: { name: "ai-todo" } });
    expect((await call("GET", "/_space/feedback/recent", { headers: { "x-space-app": "ai-todo" } })).json).toEqual({ ok: true, items: [] });
  });

  test("a submission: same origin only, through the router, while switched on", async () => {
    const { call, service } = setup();
    const body = JSON.stringify({ text: "Too small", mode: "later", context: { url: "http://todo.example.com/" } });
    expect((await call("POST", "/_space/feedback", { body, headers: page })).status).toBe(403);
    service.saveSettings({ enabled: true });
    expect((await call("POST", "/_space/feedback", { body, headers: { ...page, origin: "https://evil.example" } })).status).toBe(403);
    expect((await call("POST", "/_space/feedback", { body, headers: same })).status).toBe(400);
    expect((await call("POST", "/_space/feedback", { body: "{", headers: page })).status).toBe(400);
    const r = await call("POST", "/_space/feedback", { body, headers: page });
    expect(r.status).toBe(201);
    expect(r.json).toEqual({ ok: true, id: 1, status: "later", todoId: 41, todoUrl: null });
    expect((await call("POST", "/_space/feedback", { body, headers: page })).json).toMatchObject({ id: 1, repeated: true });
    expect((await call("POST", "/_space/feedback", { body: "x".repeat(10 * 1024 * 1024), headers: page })).status).toBe(413);
    expect((await call("GET", "/_space/feedback/recent", { headers: { "x-space-app": "ai-todo" } })).json.items).toMatchObject([{ id: 1, text: "Too small", status: "later", todoId: 41 }]);
  });

  test("settings and the list for the panel", async () => {
    const { call } = setup();
    const view = (await call("GET", "/api/panel/feedback/settings")).json;
    expect(view).toMatchObject({ ok: true, settings: { enabled: false, mode: "auto" }, apps: [{ app: "ai-todo", enabled: false }], machines: [{ value: "" }, { value: "hub" }], shortcut: "Alt+Shift+F", counts: { later: 0 } });
    const put = await call("PUT", "/api/panel/feedback/settings", { body: JSON.stringify({ enabled: true, apps: { "ai-todo": "on" }, mode: "later" }), headers: same });
    expect(put.json).toMatchObject({ settings: { enabled: true, mode: "later", apps: { "ai-todo": "on" } }, apps: [{ app: "ai-todo", enabled: true }] });
    expect((await call("PUT", "/api/panel/feedback/settings", { body: JSON.stringify({ machine: "nowhere" }), headers: same })).status).toBe(400);
    expect((await call("PUT", "/api/panel/feedback/settings", { body: JSON.stringify({ enabled: false }), headers: { ...same, origin: "https://evil.example" } })).status).toBe(403);
    await call("POST", "/_space/feedback", { body: JSON.stringify({ text: "a" }), headers: page });
    const list = (await call("GET", "/api/panel/feedback?limit=5")).json;
    expect(list).toMatchObject({ ok: true, items: [{ id: 1, app: "ai-todo", status: "later", client: "desktop-browser" }], counts: { later: 1 } });
    expect((await call("POST", "/api/panel/feedback/fix", { body: JSON.stringify({ app: "ai-todo" }), headers: same })).json).toEqual({ ok: true, queued: 1 });
  });
});
