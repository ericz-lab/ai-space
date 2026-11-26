import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { parseManifest } from "../scheduler/manifest.ts";
import { WidgetFeed } from "./widgets.ts";
import { parsePackageManifest } from "../packages/manifest.ts";

test("package item widgets use dynamic services and isolated application deep links", async () => {
  const parsed = parsePackageManifest("spec: 2\nname: n\nversion: 1.0.0\nrequires: { spaceApi: 1, bun: 1.3.0 }\noffline: { features: [Read], online: [] }\nlaunch: { kind: process, runtime: bun, entry: app.ts, health: /healthz }\nwidgets:\n  - { name: w, source: /api/widget }\n");
  const m = { ...parsed, url: "/_space/apps/n" };
  const feed = new WidgetFeed({ list: () => [{ manifest: m }] } as never, { appFetch: async (app, path) => {
    expect([app, path]).toEqual(["n", "/api/widget"]);
    return Response.json({ ok: true, items: [{ text: "note", url: "/notes?id=1" }] });
  } });
  expect(await feed.one(m, m.widgets[0]!)).toMatchObject({ ok: true, items: [{ url: "/_space/apps/n?path=%2Fnotes%3Fid%3D1" }] });
});

afterEach(() => setSystemTime());

test("a failed source is retried after 30s, a payload is kept for its refresh", async () => {
  const m = parseManifest("name: n\nservice: { command: x, port: 9 }\nwidgets:\n  - { name: w, source: /api/widget, refresh: 5m }\n", "n");
  let calls = 0;
  let up = false;
  const fetch = (async () => {
    calls++;
    if (!up) throw new Error("socket closed");
    return Response.json({ ok: true, items: [{ text: "x" }] });
  }) as unknown as typeof globalThis.fetch;
  const feed = new WidgetFeed({ list: () => [{ manifest: m }] } as never, { fetch });
  const t0 = new Date("2026-10-08T01:00:00Z").getTime();
  setSystemTime(t0);
  expect((await feed.one(m, m.widgets[0]!)).ok).toBe(false);
  up = true;
  setSystemTime(t0 + 10_000);
  expect((await feed.one(m, m.widgets[0]!)).ok).toBe(false);
  setSystemTime(t0 + 31_000);
  expect((await feed.one(m, m.widgets[0]!)).ok).toBe(true);
  up = false;
  setSystemTime(t0 + 120_000);
  expect((await feed.one(m, m.widgets[0]!)).ok).toBe(true);
  expect(calls).toBe(2);
});

describe("actions and refresh", () => {
  const yaml = "name: todo\nservice: { command: x, port: 9 }\nwidgets:\n  - { name: list, source: /api/widget, refresh: 5m }\n  - { name: page, kind: embed, source: /board }\n";
  const payload = (n: number) => ({
    ok: true,
    items: [{ text: `${n} open` }],
    blocks: [{ type: "status", label: "Milk", value: "today", action: { id: "done:42", kind: "check", label: "Done" } }],
    views: [
      { id: "today", label: "Today", blocks: [{ type: "metric", label: "Open", value: n, url: "/?v=today" }] },
      { id: "all", label: "All", blocks: [{ type: "status", label: "Eggs", value: "later", action: { id: "done:43", kind: "check", label: "Done" } }] },
    ],
    actions: [{ id: "add", kind: "input", label: "Add" }, { id: "rerun", kind: "button", label: "Run" }],
  });
  const setup = (answer: (body: Record<string, unknown>) => Response = () => Response.json({ ok: true, message: "Saved" })) => {
    const m = parseManifest(yaml, "todo");
    const calls: { url: string; method: string; header: string | null; body: unknown }[] = [];
    let reads = 0;
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: String(input), method, header: new Headers(init?.headers).get("x-space-widget-action"), body });
      if (method === "GET") return Response.json(payload(++reads));
      return answer(body);
    }) as unknown as typeof globalThis.fetch;
    const registry = { list: () => [{ manifest: m }], get: (a: string) => (a === "todo" ? { manifest: m } : undefined) };
    const feed = new WidgetFeed(registry as never, { fetch });
    return { m, feed, calls };
  };

  test("views and actions come through sanitized, view links resolved like the blocks'", async () => {
    const m = { ...parseManifest(yaml, "todo"), url: "https://todo.example.com" };
    const feed = new WidgetFeed({ list: () => [] } as never, { fetch: (async () => Response.json(payload(1))) as unknown as typeof fetch });
    const w = await feed.one(m, m.widgets[0]!);
    if (!w.ok) throw new Error(w.error);
    expect(w.views?.map((v) => v.id)).toEqual(["today", "all"]);
    expect(w.views?.[0]?.blocks[0]?.url).toBe("https://todo.example.com/?v=today");
    expect(w.actions?.map((a) => a.id)).toEqual(["add", "rerun"]);
  });

  test("an undeclared id is refused without calling the app", async () => {
    const { feed, calls } = setup();
    expect(await feed.act("todo", "list", { action: "done:99" })).toEqual({ ok: false, status: 400, error: "unknown action" });
    expect(await feed.act("todo", "list", { action: 1 })).toMatchObject({ ok: false, status: 400 });
    expect(await feed.act("todo", "page", { action: "add" })).toMatchObject({ ok: false, status: 404 });
    expect(await feed.act("nope", "list", { action: "add" })).toMatchObject({ ok: false, status: 404 });
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  test("a declared id is POSTed to the source with the header and body; the cache is dropped on success", async () => {
    const { feed, calls } = setup();
    const r = await feed.act("todo", "list", { action: "done:43", value: "ignored for a check" });
    expect(r).toMatchObject({ ok: true, message: "Saved", widget: { id: "todo/list", ok: true, items: [{ text: "2 open" }] } });
    const post = calls.find((c) => c.method === "POST")!;
    expect(post).toEqual({ url: "http://127.0.0.1:9/api/widget", method: "POST", header: "1", body: { action: "done:43" } });
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "GET"]);
    const add = await feed.act("todo", "list", { action: "add", value: "  Buy bread  " });
    expect(add.ok).toBe(true);
    expect(calls.filter((c) => c.method === "POST").at(-1)?.body).toEqual({ action: "add", value: "Buy bread" });
  });

  test("an input needs a value of 1 to 2000 characters", async () => {
    const { feed, calls } = setup();
    expect(await feed.act("todo", "list", { action: "add", value: "   " })).toMatchObject({ ok: false, status: 400 });
    expect(await feed.act("todo", "list", { action: "add", value: "x".repeat(2001) })).toMatchObject({ ok: false, status: 400 });
    expect(await feed.act("todo", "list", { action: "add" })).toMatchObject({ ok: false, status: 400 });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("the app's { ok: false } surfaces its error, at any status, and keeps the cache", async () => {
    const { feed, calls } = setup(() => Response.json({ ok: false, error: "list is read-only" }, { status: 409 }));
    expect(await feed.act("todo", "list", { action: "rerun" })).toEqual({ ok: false, status: 502, error: "list is read-only" });
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    const html = setup(() => new Response("<html>oops</html>", { status: 500 }));
    expect(await html.feed.act("todo", "list", { action: "rerun" })).toEqual({ ok: false, status: 502, error: "HTTP 500" });
  });

  test("refresh drops the cache and reads the source again", async () => {
    const { m, feed, calls } = setup();
    await feed.one(m, m.widgets[0]!);
    await feed.one(m, m.widgets[0]!);
    expect(calls.length).toBe(1);
    const r = await feed.refresh("todo", "list");
    expect(r).toMatchObject({ ok: true, widget: { ok: true, items: [{ text: "2 open" }] } });
    expect(calls.length).toBe(2);
    expect(await feed.refresh("todo", "page")).toMatchObject({ ok: false, status: 404 });
  });

  test("a spec 2 path source is reached through appFetch, with the method, headers and body", async () => {
    const parsed = parsePackageManifest("spec: 2\nname: n\nversion: 1.0.0\nrequires: { spaceApi: 1, bun: 1.3.0 }\noffline: { features: [Read], online: [] }\nlaunch: { kind: process, runtime: bun, entry: app.ts, health: /healthz }\nwidgets:\n  - { name: w, source: /api/widget }\n");
    const m = { ...parsed, url: "/_space/apps/n" };
    const seen: { app: string; path: string; method?: string; header: string | null; body?: string }[] = [];
    const feed = new WidgetFeed({ list: () => [{ manifest: m }], get: () => ({ manifest: m }) } as never, {
      appFetch: async (app, path, init) => {
        seen.push({ app, path, method: init.method, header: new Headers(init.headers).get("x-space-widget-action"), body: init.body as string | undefined });
        return init.method === "POST" ? Response.json({ ok: true }) : Response.json({ ok: true, items: [], actions: [{ id: "rerun", kind: "button", label: "Run" }] });
      },
    });
    expect((await feed.act("n", "w", { action: "rerun" })).ok).toBe(true);
    expect(seen.map((s) => s.method ?? "GET")).toEqual(["GET", "POST", "GET"]);
    expect(seen[1]).toEqual({ app: "n", path: "/api/widget", method: "POST", header: "1", body: JSON.stringify({ action: "rerun" }) });
  });
});
