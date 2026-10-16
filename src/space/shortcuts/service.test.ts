import { describe, expect, test } from "bun:test";
import { Bus } from "../bus/bus.ts";
import { parseProvidesSpec } from "../bus/spec.ts";
import { BusStore } from "../bus/store.ts";
import { Store } from "../scheduler/store.ts";
import type { Run as TaskRun, Task } from "../scheduler/types.ts";
import { createShortcutRoutes } from "./api.ts";
import { Shortcuts, normalize } from "./service.ts";
import { ShortcutStore } from "./store.ts";

const NOW = Date.parse("2026-10-16T23:30:00Z");

const PROVIDES = parseProvidesSpec({
  create: {
    http: { method: "POST", path: "/cap/create" },
    timeout: "1s",
    action: {
      title: "Create todo",
      keywords: ["todo"],
      template: "todo",
      effect: "write",
      idempotent: true,
      result: "receipt",
      inputs: [
        { name: "title", type: "text", label: "Title", required: true, query: true },
        { name: "dueDate", type: "date", label: "Date" },
        { name: "dueTime", type: "time", label: "Time" },
      ],
      i18n: { zh: { title: "新建待办", inputs: { title: "标题" } } },
    },
  },
  note: { http: { method: "POST", path: "/cap/note" }, timeout: "1s", action: { title: "Note", effect: "write", result: "receipt", inputs: [{ name: "text", type: "text", label: "Text", required: true }] } },
  plain: { http: { path: "/cap/plain" } },
});

const NEWS = parseProvidesSpec({
  news: {
    http: { path: "/cap/news" },
    action: { title: "News", template: "news", result: "list", inputs: [{ name: "period", type: "period", label: "Period", default: "today" }, { name: "q", type: "text", label: "Topic", query: true }] },
  },
});

type Answer = (body: Record<string, unknown>, path: string) => Response | Promise<Response>;

function harness(answer: Answer, opts: { tasks?: Task[]; runs?: TaskRun[]; rates?: boolean } = {}) {
  const events = new Store(":memory:");
  const busStore = new BusStore(":memory:");
  const store = new ShortcutStore(":memory:");
  const seen: { path: string; body: Record<string, unknown>; caller: string | null }[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    seen.push({ path, body, caller: new Headers(init.headers).get("x-space-caller") });
    // Like a real fetch, the bus's timeout aborts the wait.
    const aborted = new Promise<never>((_, reject) => init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("timed out"), { name: "TimeoutError" }))));
    return Promise.race([answer(body, path), aborted]);
  };
  const bus = new Bus({ store: busStore, events, servicePort: (app) => (app === "gone" ? undefined : 9000), fetch, log: () => {}, now: () => NOW });
  bus.syncApp("todo", { provides: PROVIDES });
  bus.syncApp("feed", { provides: NEWS });
  if (opts.rates !== false) bus.syncApp("fx-desk", { provides: parseProvidesSpec({ rates: { http: { path: "/cap/rates" } } }) });
  const tasks = opts.tasks ?? [];
  const started: string[] = [];
  const scheduler = {
    runNow: (id: string) => {
      const t = tasks.find((x) => x.id === id)!;
      if (t.state.runningAt !== undefined) return false;
      t.state.runningAt = NOW;
      started.push(id);
      return true;
    },
    getTask: (id: string) => tasks.find((t) => t.id === id),
    listTasks: () => tasks,
    listRuns: (id: string) => (opts.runs ?? []).filter((r) => r.taskId === id),
  };
  const shortcuts = new Shortcuts({ store, bus, scheduler, now: () => NOW, waitMs: 2_000 });
  return { shortcuts, seen, started, tasks, store, close: () => (store.close(), busStore.close(), events.close()) };
}

const ok = (j: unknown) => Response.json(j);
const TZ = "Asia/Seoul";

describe("catalogue", () => {
  test("built-ins, app actions and the unfilled slots, each with its availability", () => {
    const h = harness(() => ok({}));
    try {
      const ids = h.shortcuts.catalogue().map((a) => `${a.id}:${a.available}`);
      expect(ids).toEqual(["space/calc:true", "space/convert:true", "space/run-task:false", "feed/news:true", "todo/create:true", "todo/note:true", "space/calendar:false"]);
      const calendar = h.shortcuts.catalogue().find((a) => a.id === "space/calendar")!;
      expect(calendar.reason).toContain("template: calendar");
    } finally {
      h.close();
    }
  });

  test("conversion is unavailable without a rates provider, and says which", () => {
    const h = harness(() => ok({}), { rates: false });
    try {
      const convert = h.shortcuts.catalogue().find((a) => a.id === "space/convert")!;
      expect(convert.available).toBe(false);
      expect(convert.reason).toContain("fx-desk/rates");
    } finally {
      h.close();
    }
  });

  test("an action is held to its manifest rules", () => {
    expect(() => parseProvidesSpec({ x: { http: { path: "/x" }, action: { title: "X", result: "table" } } })).toThrow(/result/);
    expect(() => parseProvidesSpec({ x: { http: { path: "/x" }, action: { title: "X", result: "list", template: "todo" } } })).toThrow(/receipt/);
    expect(() => parseProvidesSpec({ x: { http: { path: "/x" }, action: { title: "X", result: "list", idempotent: true } } })).toThrow(/write/);
    expect(() => parseProvidesSpec({ x: { http: { path: "/x" }, callers: ["a"], action: { title: "X", result: "list" } } })).toThrow(/space/);
    expect(() => parseProvidesSpec({ x: { http: { path: "/x" }, action: { title: "X", result: "list", inputs: [{ name: "timezone", label: "Z" }] } } })).toThrow(/input name/);
    expect(() => parseProvidesSpec({ x: { http: { path: "/x" }, action: { title: "X", result: "list", inputs: [{ name: "d", type: "date", label: "D", default: "someday" }] } } })).toThrow(/default/);
    expect(() => parseProvidesSpec({ x: { http: { path: "/x" }, action: { title: "X", result: "list", i18n: { zh: { inputs: { nope: "不" } } } } } })).toThrow(/no input/);
  });
});

describe("runs", () => {
  test("the calculator runs without any provider", async () => {
    const h = harness(() => ok({}));
    try {
      const { run } = await h.shortcuts.start({ action: "space/calc", args: { expression: "128 * 3 + 56" } });
      expect(run.status).toBe("ok");
      expect(run.result).toEqual({ kind: "value", value: 440, text: "440" });
      const bad = await h.shortcuts.start({ action: "space/calc", args: { expression: "1/0" } });
      expect(bad.run.status).toBe("error");
      expect(bad.run.error).toBe("division by zero");
      expect(h.seen).toEqual([]);
    } finally {
      h.close();
    }
  });

  test("conversion: cross rate, currency precision, source and quote time, rates reused", async () => {
    const h = harness(() => ok({ ok: true, base: "USD", rates: { CNY: 7.1, JPY: 150, EUR: 0.9 }, asOf: "2026-10-16T00:00:00Z", source: "open.er-api.com", stale: true }));
    try {
      const a = await h.shortcuts.preview({ action: "space/convert", args: { amount: 100, from: "usd", to: "CNY" } });
      expect(a).toMatchObject({ kind: "value", value: 710, text: "710.00 CNY", source: "open.er-api.com", asOf: "2026-10-16T00:00:00Z", stale: true });
      const b = await h.shortcuts.preview({ action: "space/convert", args: { amount: "1,000", from: "EUR", to: "JPY" } });
      expect(b).toMatchObject({ value: 166667, text: "166,667 JPY" });
      await expect(h.shortcuts.preview({ action: "space/convert", args: { amount: 1, from: "USD", to: "XYZ" } })).rejects.toThrow(/no rate for XYZ/);
      expect(h.seen.filter((s) => s.path === "/cap/rates")).toHaveLength(1);
      expect(h.seen[0]!.caller).toBe("space");
    } finally {
      h.close();
    }
  });

  test("arguments are validated and relative dates resolved in the run's zone before the provider sees them", async () => {
    const h = harness(() => ok({ ok: true, items: [{ title: "Fed", url: "https://x.test/1", at: "2026-10-17T01:00:00+09:00", source: "Reuters" }, { nope: 1 }] }));
    try {
      await expect(h.shortcuts.start({ action: "feed/news", args: { period: "today" } })).rejects.toThrow(/timezone is required/);
      await expect(h.shortcuts.start({ action: "feed/news", args: { period: "today" }, timezone: "KST" })).rejects.toThrow(/IANA/);
      await expect(h.shortcuts.start({ action: "feed/news", args: { period: "someday" }, timezone: TZ })).rejects.toThrow(/Period/);
      await expect(h.shortcuts.start({ action: "feed/news", args: { extra: 1 }, timezone: TZ })).rejects.toThrow(/no input "extra"/);
      await expect(h.shortcuts.start({ action: "todo/create", args: { dueDate: "today" }, timezone: TZ })).rejects.toThrow(/Title is required/);
      await expect(h.shortcuts.start({ action: "todo/create", args: { title: "x", dueTime: "15:00" }, timezone: TZ })).rejects.toThrow(/needs a date/);
      const { run } = await h.shortcuts.start({ action: "feed/news", args: { period: "today", q: " fed " }, timezone: TZ });
      expect(run.status).toBe("ok");
      expect(run.args).toEqual({ period: "today", q: " fed " });
      expect(run.resolved).toEqual({ period: { from: "2026-10-17", to: "2026-10-17" }, q: "fed" });
      expect(h.seen[0]!.body).toEqual({ period: { from: "2026-10-17", to: "2026-10-17" }, q: "fed", timezone: TZ, now: "2026-10-16T23:30:00.000Z" });
      expect(run.result).toEqual({ kind: "list", items: [{ title: "Fed", url: "https://x.test/1", at: "2026-10-16T16:00:00.000Z", source: "Reuters" }] });
    } finally {
      h.close();
    }
  });

  test("a repeated submission answers the first run and writes once", async () => {
    let n = 0;
    const h = harness(() => ok({ ok: true, items: [{ id: ++n, title: "Report", url: "https://todo.test/#1" }] }));
    try {
      const first = await h.shortcuts.start({ action: "todo/create", args: { title: "Report", dueDate: "tomorrow", dueTime: "15:00" }, timezone: TZ, requestId: "req-00000001" });
      const again = await h.shortcuts.start({ action: "todo/create", args: { title: "Report" }, timezone: TZ, requestId: "req-00000001" });
      expect(first.duplicate).toBe(false);
      expect(again.duplicate).toBe(true);
      expect(again.run.id).toBe(first.run.id);
      expect(h.seen).toHaveLength(1);
      expect(h.seen[0]!.body).toMatchObject({ title: "Report", dueDate: "2026-10-18", dueTime: "15:00", timezone: TZ });
      expect(typeof h.seen[0]!.body.idempotencyKey).toBe("string");
      expect(first.run.result).toEqual({ kind: "receipt", items: [{ id: "1", title: "Report", url: "https://todo.test/#1" }] });
    } finally {
      h.close();
    }
  });

  test("a write whose answer is lost is unknown; only an idempotent provider is retried, with the same key", async () => {
    let fail = true;
    const h = harness(async (_b, path) => {
      if (fail) {
        fail = path === "/cap/create" ? false : true;
        // The provider took the request but the answer never arrived in time.
        await new Promise((r) => setTimeout(r, 1_500));
      }
      return ok({ ok: true, items: [{ id: 7, title: "Report" }] });
    });
    try {
      const { run } = await h.shortcuts.start({ action: "todo/create", args: { title: "Report" }, timezone: TZ, requestId: "req-unknown1" });
      await h.shortcuts.idle();
      const lost = h.shortcuts.getRun(run.id)!;
      expect(lost.status).toBe("unknown");
      expect(lost.error).toContain("may have happened");
      const retried = await h.shortcuts.retry(run.id);
      expect(retried.status).toBe("ok");
      expect(retried.attempts).toBe(2);
      expect(h.seen[1]!.body.idempotencyKey).toBe(h.seen[0]!.body.idempotencyKey);

      fail = true;
      const note = await h.shortcuts.start({ action: "todo/note", args: { text: "hi" }, timezone: TZ });
      await h.shortcuts.idle();
      expect(h.shortcuts.getRun(note.run.id)!.status).toBe("unknown");
      await expect(h.shortcuts.retry(note.run.id)).rejects.toThrow(/check it there/);
    } finally {
      h.close();
    }
  }, 20_000);

  test("provider failures are errors with the provider's words, never an empty result", async () => {
    const h = harness((_b, path) => (path === "/cap/news" ? new Response(JSON.stringify({ ok: false, error: "feed database locked" }), { status: 500 }) : ok({ ok: true })));
    try {
      const { run } = await h.shortcuts.start({ action: "feed/news", args: {}, timezone: TZ });
      expect(run.status).toBe("error");
      expect(run.error).toBe("feed answered 500: feed database locked");
      const receipt = await h.shortcuts.start({ action: "todo/note", args: { text: "x" }, timezone: TZ });
      expect(receipt.run.status).toBe("error");
      expect(receipt.run.error).toContain("no items");
      await expect(h.shortcuts.start({ action: "space/calendar", args: {} })).rejects.toThrow(/not configured/);
    } finally {
      h.close();
    }
  });

  test("a task run follows the scheduler: overlap refused, status read from the run record", async () => {
    const task = { id: "t1", app: "daily", name: "report", state: {} } as unknown as Task;
    const runs: TaskRun[] = [];
    const h = harness(() => ok({}), { tasks: [task], runs });
    try {
      const { run } = await h.shortcuts.start({ action: "space/run-task", args: { task: "t1" } });
      expect(run.status).toBe("running");
      expect(run.result).toMatchObject({ kind: "task", task: "daily · report", status: "running" });
      const twice = await h.shortcuts.start({ action: "space/run-task", args: { task: "t1" } });
      expect(twice.run.status).toBe("error");
      expect(twice.run.error).toContain("already running");
      await expect(h.shortcuts.start({ action: "space/run-task", args: { task: "nope" } })).rejects.toThrow(/choices/);
      // The scheduler finishes it.
      task.state.runningAt = undefined;
      runs.push({ id: 42, taskId: "t1", startedAt: NOW, endedAt: NOW + 5_000, status: "ok", trigger: "manual", output: "done" });
      const done = h.shortcuts.getRun(run.id)!;
      expect(done.status).toBe("ok");
      expect(done.result).toMatchObject({ kind: "task", runId: 42, status: "ok", output: "done" });
      expect(h.started).toEqual(["t1"]);
    } finally {
      h.close();
    }
  });
});

describe("api", () => {
  test("routes answer the catalogue, start runs and refuse a write preview", async () => {
    const h = harness(() => ok({ ok: true, items: [{ id: 1, title: "x" }] }));
    try {
      const routes = createShortcutRoutes({ shortcuts: h.shortcuts });
      const call = async (path: string, method: "GET" | "POST", body?: unknown, params: Record<string, string> = {}) => {
        const req = Object.assign(new Request(`http://space${path}`, { method, ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) }), { params });
        const res = await routes[path.split("?")[0]!.replace(/\/\d+(\/|$)/, "/:id$1")]![method]!(req);
        return { status: res.status, body: (await res.json()) as Record<string, any> };
      };
      expect((await call("/api/shortcuts/actions", "GET")).body.actions.length).toBe(7);
      const started = await call("/api/shortcuts/runs", "POST", { action: "todo/create", args: { title: "x" }, timezone: TZ, requestId: "req-api00001" });
      expect(started.status).toBe(201);
      expect(started.body.run.idempotencyKey).toBeUndefined();
      expect((await call("/api/shortcuts/runs", "POST", { action: "todo/create", args: { title: "x" }, timezone: TZ, requestId: "req-api00001" })).status).toBe(200);
      expect((await call(`/api/shortcuts/runs/${started.body.run.id}`, "GET", undefined, { id: String(started.body.run.id) })).body.run.status).toBe("ok");
      expect((await call("/api/shortcuts/runs?limit=5", "GET")).body.runs).toHaveLength(1);
      expect((await call("/api/shortcuts/preview", "POST", { action: "todo/create", args: { title: "x" }, timezone: TZ })).status).toBe(400);
      expect((await call("/api/shortcuts/runs", "POST", { nope: 1 })).status).toBe(400);
      expect((await call("/api/shortcuts/runs", "POST", { action: "space/nothing" })).status).toBe(404);
    } finally {
      h.close();
    }
  });
});

test("results keep only safe links and real instants", () => {
  const r = normalize("list", { items: [{ title: "a", url: "javascript:alert(1)", at: "2026-10-01T09:00:00" }, { title: "b", date: "2026-02-30", time: "25:00" }] }, "app");
  expect(r).toEqual({ kind: "list", items: [{ title: "a" }, { title: "b" }] });
});

test("pattern API validates before saving, exposes the catalogue and does not execute actions", async () => {
  const h = harness(() => ok({}));
  try {
    const routes = createShortcutRoutes({ shortcuts: h.shortcuts });
    const save = async (body: unknown) => routes["/api/shortcuts/patterns"]!.POST!(Object.assign(new Request("http://space/api/shortcuts/patterns", { method: "POST", body: JSON.stringify(body) }), { params: {} }));
    expect((await save({ action: "feed/news", patterns: ["[帮我]查金融新闻[ {q}]"] })).status).toBe(200);
    expect(h.shortcuts.find("feed/news")?.customPatterns).toEqual(["[帮我]查金融新闻[ {q}]"]);
    for (const patterns of [["查{unknown}"], ["[unclosed"], ["{q}"], "news", [12]]) {
      expect((await save({ action: "feed/news", patterns })).status).toBe(400);
      expect(h.shortcuts.find("feed/news")?.customPatterns).toEqual(["[帮我]查金融新闻[ {q}]"]);
    }
    expect((await save({ action: "missing/news", patterns: ["news"] })).status).toBe(404);
    expect((await save({ action: "feed/news", peer: "other", patterns: ["news"] })).status).toBe(404);
    expect((await save({ action: "feed/news", peer: 12, patterns: [] })).status).toBe(400);
    expect((await save({ action: "feed/news", patterns: [] })).status).toBe(200);
    expect(h.shortcuts.find("feed/news")?.customPatterns).toEqual([]);
    expect(h.seen).toEqual([]);
    expect(h.store.listRuns()).toEqual([]);
  } finally { h.close(); }
});

test("manifest patterns validate slots and preserve backwards compatibility", () => {
  const action = { title: "News", result: "list", inputs: [{ name: "q", type: "text", label: "Topic" }] };
  expect(parseProvidesSpec({ news: { http: { path: "/news" }, action: { ...action, patterns: ["金融新闻[ {q}]"] } } })[0]!.action?.patterns).toEqual(["金融新闻[ {q}]"]);
  expect(parseProvidesSpec({ news: { http: { path: "/news" }, action } })[0]!.action?.patterns).toBeUndefined();
  expect(() => parseProvidesSpec({ news: { http: { path: "/news" }, action: { ...action, patterns: ["news{other}"] } } })).toThrow(/Unknown input/);
});
