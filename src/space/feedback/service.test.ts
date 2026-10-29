import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { FeedbackError, FeedbackService, type FixerPort, type RunEnd } from "./service.ts";
import { FeedbackStore } from "./store.ts";
import { type Caller, TodoSink } from "./todo.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36";
const RESULT = (status: string, extra = "") => `Summary.\nRESULT: {"status":"${status}","summary":"did it","commit":"abc1234","pushed":true${extra}}`;

/** ai-todo as its capabilities answer, keeping every call. */
function fakeTodo(opts: { status?: boolean; failAdd?: boolean } = {}) {
  const calls: { capability: string; body: unknown }[] = [];
  let next = 300;
  const call: Caller = async (capability, body) => {
    const json = "json" in body ? body.json : Object.fromEntries([...body.form.entries()].map(([k, v]) => [k, typeof v === "string" ? v : `file:${(v as File).name}`]));
    calls.push({ capability, body: json });
    if (capability === "add") return opts.failAdd ? { status: 500, text: '{"ok":false,"error":"db locked"}' } : { status: 201, text: JSON.stringify({ ok: true, todos: [{ id: ++next }] }) };
    if (capability === "status" && opts.status === false) return { status: 404, text: '{"ok":false,"error":"ai-todo does not provide status"}' };
    if (capability === "task") return { status: 200, text: JSON.stringify({ ok: true, todo: { status: "review" }, records: [{ content: "rejected: still broken", source: "human", createdAt: "2026-10-27" }] }) };
    return { status: 200, text: '{"ok":true}' };
  };
  return { calls, sink: new TodoSink(call, "", "https://todo.example.com/{lang}") };
}

/** The engineer: each start returns a run whose end the test decides. */
function fakeFixer() {
  const starts: { machine: string; body: Parameters<FixerPort["start"]>[1] }[] = [];
  const ends = new Map<string, (e: RunEnd) => void>();
  let fail: string | null = null;
  const port: FixerPort = {
    async start(machine, body) {
      if (fail) throw new Error(fail);
      starts.push({ machine, body });
      return `run-${starts.length}`;
    },
    wait: (_m, runId) => new Promise((resolve) => ends.set(runId, resolve)),
  };
  const end = async (runId: string, e: Partial<RunEnd> & { text: string }) => {
    for (let i = 0; i < 50 && !ends.has(runId); i++) await Bun.sleep(1);
    ends.get(runId)!({ status: "done", error: null, ...e });
  };
  return { port, starts, end, failWith: (m: string | null) => (fail = m) };
}

function setup(o: { todo?: ReturnType<typeof fakeTodo>; machines?: string[]; deploy?: (app: string) => Promise<{ ok: boolean; log: string }> } = {}) {
  const store = new FeedbackStore(new Database(":memory:"));
  const todo = o.todo ?? fakeTodo();
  const fixer = fakeFixer();
  const logs: string[] = [];
  const deploys: string[] = [];
  const service = new FeedbackService({
    store,
    name: "home",
    app: (app) => (app === "ai-todo" || app === "theme-watch" ? { title: app === "ai-todo" ? "AI Todo" : "Theme Watch", zhTitle: "AI 待办", repo: `git@example.com:me/${app}.git`, hasDeployCheck: true } : undefined),
    todo: () => todo.sink,
    fixer: fixer.port,
    machines: () => o.machines ?? ["hub"],
    deploy: async (app) => {
      deploys.push(app);
      return o.deploy ? o.deploy(app) : { ok: true, log: "deployed" };
    },
    log: (l) => logs.push(l),
  });
  store.saveSettings({ enabled: true });
  return { store, service, todo, fixer, logs, deploys };
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await Bun.sleep(1);
  expect(cond()).toBe(true);
};

const body = (text: string, extra: Record<string, unknown> = {}) => ({ text, context: { url: "https://todo.example.com/?view=review", viewport: { w: 375, h: 812, dpr: 3 }, theme: "dark", lang: "zh-CN" }, ...extra });

describe("switches", () => {
  test("off by default, per app, and the config says only what the button needs", () => {
    const { service, store } = setup();
    store.saveSettings({ enabled: false });
    expect(service.config("ai-todo", UA)).toEqual({ ok: true, enabled: false });
    store.saveSettings({ enabled: true, apps: { "theme-watch": "off" } });
    expect(service.config("theme-watch", UA)).toEqual({ ok: true, enabled: false });
    expect(service.config("nope", UA)).toEqual({ ok: true, enabled: false });
    expect(service.config("ai-todo", UA)).toEqual({
      ok: true,
      enabled: true,
      mode: "auto",
      errors: true,
      app: { name: "ai-todo", title: "AI Todo", zh: "AI 待办" },
      client: { kind: "desktop-browser", en: "Desktop browser (Chrome · Linux)", zh: "桌面浏览器 (Chrome · Linux)" },
      machine: "",
      machines: [{ value: "", label: "home" }, { value: "hub", label: "hub" }],
      shortcut: "Alt+Shift+F",
    });
    store.saveSettings({ appsDefault: false, apps: { "ai-todo": "on" } });
    expect([service.enabledFor("ai-todo"), service.enabledFor("theme-watch")]).toEqual([true, false]);
  });

  test("the engineer's machine must be a peer", () => {
    const { service } = setup();
    expect(() => service.saveSettings({ machine: "elsewhere" })).toThrow(FeedbackError);
    expect(service.saveSettings({ machine: "hub" }).machine).toBe("hub");
    expect(() => service.saveSettings({ mode: "x" })).toThrow("mode must be");
  });

  test("a submission for a switched-off or unknown app is refused", async () => {
    const { service, store } = setup();
    await expect(service.submit("nope", body("x"), UA)).rejects.toMatchObject({ status: 404 });
    store.saveSettings({ apps: { "ai-todo": "off" } });
    await expect(service.submit("ai-todo", body("x"), UA)).rejects.toMatchObject({ status: 403 });
  });
});

describe("submit", () => {
  test("later: a task with tags, plan and picture; nothing starts", async () => {
    const { service, todo, fixer, store } = setup();
    const r = await service.submit("ai-todo", body("暗色下标题看不清 token=abc123", { mode: "later", images: [{ name: "s.png", data: PNG }] }), UA);
    expect(r).toEqual({ id: 1, status: "later", todoId: 301, todoUrl: "https://todo.example.com/?todo=301" });
    expect(todo.calls.map((c) => c.capability)).toEqual(["add", "plan", "record"]);
    // Chinese feedback names the app in Chinese.
    expect(todo.calls[0]!.body).toMatchObject({ drafts: [{ title: "[AI 待办] 暗色下标题看不清 token=[redacted]", tags: ["feedback", "ai-todo"] }], source: "ai" });
    expect(String((todo.calls[1]!.body as { content: string }).content)).toContain("- Pictures: 1");
    expect(todo.calls[2]!.body).toMatchObject({ todoId: "301", content: "反馈附带的截图。", images: "file:s.png" });
    expect(fixer.starts).toHaveLength(0);
    expect(store.get(1)!.text).not.toContain("abc123");
    expect(service.counts().later).toBe(1);
  });

  test("validation, double clicks and the hourly cap", async () => {
    const { service } = setup();
    await expect(service.submit("ai-todo", body("  "), UA)).rejects.toMatchObject({ status: 400 });
    await expect(service.submit("ai-todo", body("x".repeat(4001)), UA)).rejects.toMatchObject({ status: 400 });
    await expect(service.submit("ai-todo", body("x", { images: [{ data: "AAAA" }] }), UA)).rejects.toMatchObject({ status: 400 });
    const first = await service.submit("ai-todo", body("same", { mode: "later" }), UA);
    expect(await service.submit("ai-todo", body("same", { mode: "later" }), UA)).toMatchObject({ id: first.id, repeated: true });
    for (let i = 0; i < 29; i++) await service.submit("ai-todo", body(`n${i}`, { mode: "later" }), UA);
    await expect(service.submit("ai-todo", body("one more", { mode: "later" }), UA)).rejects.toMatchObject({ status: 429 });
  });

  test("without ai-todo the feedback is kept as recorded", async () => {
    const { service } = setup({ todo: fakeTodo({ failAdd: true }) });
    expect(await service.submit("ai-todo", body("x"), UA)).toMatchObject({ status: "recorded", todoId: null });
  });
});

describe("fixing", () => {
  test("auto: the engineer starts at once, the task moves to doing then review", async () => {
    const { service, todo, fixer, store } = setup();
    const r = await service.submit("ai-todo", body("Button overlaps the list"), UA);
    expect(r.status).toBe("queued");
    // The page is zh-CN, so the app is named in Chinese even for English words.
    expect(todo.calls[0]!.body).toMatchObject({ drafts: [{ title: "[AI 待办] Button overlaps the list" }] });
    await until(() => fixer.starts.length === 1);
    expect(fixer.starts[0]!.machine).toBe("");
    expect(fixer.starts[0]!.body).toMatchObject({ model: "claude/intermediate", effort: "xhigh", permissionMode: "bypassPermissions" });
    expect(fixer.starts[0]!.body.message).toContain("Fix request for the app \"AI Todo\"");
    expect(store.get(1)).toMatchObject({ status: "fixing", runId: "run-1", runMachine: "" });
    await fixer.end("run-1", { text: RESULT("fixed", ',"deployed":true') });
    await service.idle();
    expect(store.get(1)).toMatchObject({ status: "review" });
    const caps = todo.calls.map((c) => `${c.capability}${(c.body as { status?: string }).status ? `:${(c.body as { status: string }).status}` : ""}`);
    expect(caps).toEqual(["add", "plan", "status:doing", "record", "record", "status:review"]);
    expect(String((todo.calls[4]!.body as { content: string }).content)).toContain("修复工程师：已修好，等你验收。");
    expect(String((todo.calls[4]!.body as { content: string }).content)).toContain("提交 abc1234");
  });

  test("one run per app: feedback meanwhile goes to the next run together", async () => {
    const { service, fixer, store } = setup();
    await service.submit("ai-todo", body("one"), UA);
    await service.submit("ai-todo", body("two"), UA);
    await service.submit("ai-todo", body("three"), UA);
    expect(fixer.starts).toHaveLength(1);
    expect(store.get(2)!.status).toBe("queued");
    await fixer.end("run-1", { text: RESULT("not-fixed") });
    for (let i = 0; i < 50 && fixer.starts.length < 2; i++) await Bun.sleep(1);
    expect(store.get(1)!.status).toBe("failed");
    expect(fixer.starts).toHaveLength(2);
    expect(fixer.starts[1]!.body.message).toContain("are 2 pieces");
    await fixer.end("run-2", { text: 'RESULT: {"status":"fixed","items":[{"id":2,"status":"fixed"},{"id":3,"status":"needs-person","note":"product call"}]}' });
    await service.idle();
    expect([store.get(2)!.status, store.get(3)!.status]).toEqual(["review", "skipped"]);
  });

  test("later, then a batch from Settings; a run that errors is not fixed", async () => {
    const { service, fixer, store } = setup();
    store.saveSettings({ mode: "later" });
    await service.submit("ai-todo", body("a"), UA);
    await service.submit("theme-watch", body("b"), UA);
    expect(fixer.starts).toHaveLength(0);
    expect(service.fix({ app: "ai-todo" })).toEqual({ queued: 1 });
    expect(service.fix({})).toEqual({ queued: 1 });
    expect(fixer.starts).toHaveLength(2);
    await fixer.end("run-1", { status: "error", error: "model overloaded", text: RESULT("fixed") });
    await fixer.end("run-2", { text: RESULT("fixed") });
    await service.idle();
    expect(store.get(1)).toMatchObject({ status: "failed" });
    expect(store.get(1)!.note).toContain("model overloaded");
    expect(store.get(2)!.status).toBe("review");
  });

  test("again: a second try carries the task's records", async () => {
    const { service, fixer, store } = setup();
    await service.submit("ai-todo", body("a"), UA);
    await fixer.end("run-1", { text: RESULT("fixed") });
    await service.idle();
    expect(service.fix({ ids: [1, 99] })).toEqual({ queued: 1 });
    expect(fixer.starts).toHaveLength(1);
    for (let i = 0; i < 50 && fixer.starts.length < 2; i++) await Bun.sleep(1);
    expect(fixer.starts[1]!.body.message).toContain("rejected: still broken");
    await fixer.end("run-2", { text: RESULT("fixed") });
    await service.idle();
    expect(store.get(1)!.status).toBe("review");
  });

  test("on a peer: its fix comes back through origin and is deployed here", async () => {
    const { service, fixer, store, deploys, todo } = setup();
    store.saveSettings({ machine: "hub" });
    await service.submit("ai-todo", body("a"), UA);
    expect(fixer.starts[0]!.machine).toBe("hub");
    expect(fixer.starts[0]!.body.message).toContain('runs on another machine, "home"');
    await fixer.end("run-1", { text: RESULT("fixed") });
    await service.idle();
    expect(deploys).toEqual(["ai-todo"]);
    expect(store.get(1)).toMatchObject({ status: "review", runMachine: "hub" });
    expect(todo.calls.some((c) => String((c.body as { content?: string }).content ?? "").includes("Deployed on home") || String((c.body as { content?: string }).content ?? "").includes("已在 home"))).toBe(true);
  });

  test("the page picks the machine: that row runs there, whatever Settings say", async () => {
    const { service, fixer, store } = setup();
    store.saveSettings({ machine: "hub" });
    expect(service.config("ai-todo", UA)).toMatchObject({ machine: "hub" });
    await service.submit("ai-todo", body("here please", { machine: "" }), UA);
    expect(store.get(1)!.fixMachine).toBe("");
    expect(fixer.starts[0]!.machine).toBe("");
    await expect(service.submit("ai-todo", body("x", { machine: "elsewhere" }), UA)).rejects.toThrow(FeedbackError);
  });

  test("one run goes to one machine: rows meant for another wait for the next run", async () => {
    const { service, fixer, store } = setup();
    store.saveSettings({ mode: "later" });
    await service.submit("ai-todo", body("one", { machine: "hub" }), UA);
    await service.submit("ai-todo", body("two"), UA);
    await service.submit("ai-todo", body("three", { machine: "hub" }), UA);
    expect(service.fix({ app: "ai-todo" })).toEqual({ queued: 3 });
    expect(fixer.starts).toHaveLength(1);
    expect(fixer.starts[0]!.machine).toBe("hub");
    expect(fixer.starts[0]!.body.message).toContain("are 2 pieces");
    expect(store.get(2)!.status).toBe("queued");
    await fixer.end("run-1", { text: RESULT("not-fixed") });
    for (let i = 0; i < 50 && fixer.starts.length < 2; i++) await Bun.sleep(1);
    expect(fixer.starts[1]!.machine).toBe("");
    await fixer.end("run-2", { text: RESULT("not-fixed") });
    await service.idle();
    // Fix again keeps the person's machine.
    service.fix({ ids: [1] });
    await until(() => fixer.starts.length === 3);
    expect(fixer.starts[2]!.machine).toBe("hub");
    await fixer.end("run-3", { text: RESULT("not-fixed") });
    await service.idle();
  });

  test("on a peer: a failed deploy leaves the feedback failed with the reason", async () => {
    const { service, fixer, store } = setup({ deploy: async () => ({ ok: false, log: "app-src/ai-todo has local changes" }) });
    store.saveSettings({ machine: "hub" });
    await service.submit("ai-todo", body("a"), UA);
    await fixer.end("run-1", { text: RESULT("fixed") });
    await service.idle();
    expect(store.get(1)!.status).toBe("failed");
    expect(store.get(1)!.note).toContain("local changes");
  });

  test("an engineer that cannot start fails the feedback with the reason; an older ai-todo without status still works", async () => {
    const { service, fixer, store, todo } = setup({ todo: fakeTodo({ status: false }) });
    fixer.failWith("hub has no Fix Engineer yet");
    await service.submit("ai-todo", body("a"), UA);
    await service.idle();
    expect(store.get(1)).toMatchObject({ status: "failed" });
    expect(store.get(1)!.note).toContain("hub has no Fix Engineer yet");
    fixer.failWith(null);
    service.fix({ ids: [1] });
    await fixer.end("run-1", { text: RESULT("fixed") });
    await service.idle();
    expect(store.get(1)!.status).toBe("review");
    expect(todo.calls.filter((c) => c.capability === "status")).toHaveLength(2);
  });

  test("after a restart a local fix is failed; queued feedback starts again", async () => {
    const { service, store, fixer } = setup();
    const ctx = { url: "", path: "", title: "", viewport: { w: 0, h: 0, dpr: 0 }, touch: false, theme: "light" as const, lang: "", elements: [], errors: [], tz: "" };
    const c = { kind: "desktop-browser" as const, os: "Linux", browser: "Chrome" };
    const a = store.add({ app: "ai-todo", text: "a", context: ctx, client: c, status: "fixing" });
    store.patch(a.id, { runId: "old", todoId: 1 });
    const b = store.add({ app: "theme-watch", text: "b", context: ctx, client: c, status: "queued" });
    store.patch(b.id, { todoId: 2 });
    service.resume();
    expect(store.get(a.id)).toMatchObject({ status: "failed", note: expect.stringContaining("restarted") });
    expect(fixer.starts).toHaveLength(1);
    await fixer.end("run-1", { text: RESULT("fixed") });
    await service.idle();
  });
});

describe("following the task", () => {
  /** ai-todo whose tasks have the given states; a missing id is deleted ("no such todo"). */
  function todoWith(states: Record<number, string>, peer = "", reads: number[] = []) {
    const call: Caller = async (capability, b) => {
      if (capability !== "task") return { status: 200, text: '{"ok":true}' };
      const id = Number(("json" in b ? (b.json as { id: number }) : { id: 0 }).id);
      reads.push(id);
      if (states[id] === "bus404") return { status: 404, text: '{"ok":false,"error":"ai-todo does not provide task"}' };
      if (!(id in states)) return { status: 404, text: '{"ok":false,"error":"no such todo"}' };
      return { status: 200, text: JSON.stringify({ ok: true, todo: { id, status: states[id] }, records: [] }) };
    };
    return new TodoSink(call, peer);
  }

  function rows(store: FeedbackStore, list: { status: string; todoId: number | null; todoPeer?: string }[]) {
    return list.map((r, i) => {
      const row = store.add({ app: "ai-todo", text: `row ${i}`, context: { url: "", path: "/", title: "", viewport: { w: 0, h: 0, dpr: 1 }, touch: false, theme: "light", lang: "en", elements: [], errors: [], tz: "UTC" }, client: { kind: "desktop-browser", os: "Linux", browser: "Chrome" }, status: "review" });
      return store.patch(row.id, { status: r.status as never, todoId: r.todoId, todoPeer: r.todoPeer ?? "" })!.id;
    });
  }

  function make(states: Record<number, string>, o: { peers?: Record<string, Record<number, string>>; now?: () => number } = {}) {
    const store = new FeedbackStore(new Database(":memory:"));
    const reads: number[] = [];
    const here = todoWith(states, "", reads);
    const service = new FeedbackService({
      store,
      name: "home",
      app: () => undefined,
      todo: () => here,
      todoAt: (peer) => (peer === "" ? here : o.peers?.[peer] ? todoWith(o.peers[peer]!, peer, reads) : undefined),
      fixer: fakeFixer().port,
      machines: () => [],
      log: () => {},
      ...(o.now ? { now: o.now } : {}),
    });
    return { store, service, reads };
  }

  test("a task done in ai-todo is accepted; dropped or deleted is dropped; open ones stay", async () => {
    const { store, service } = make({ 1: "done", 2: "dropped", 4: "review", 5: "doing", 6: "done", 7: "done" });
    const ids = rows(store, [
      { status: "review", todoId: 1 },
      { status: "skipped", todoId: 2 },
      { status: "failed", todoId: 3 },
      { status: "review", todoId: 4 },
      { status: "review", todoId: 5 },
      { status: "fixing", todoId: 6 },
      { status: "later", todoId: 7 },
      { status: "recorded", todoId: null },
    ]);
    await service.syncTodos();
    expect(ids.map((id) => store.get(id)!.status)).toEqual(["accepted", "dropped", "dropped", "review", "review", "fixing", "accepted", "recorded"]);
    expect(service.counts()).toMatchObject({ accepted: 2, dropped: 2, review: 2, fixing: 1, recorded: 1 });
    expect(service.recent("ai-todo").find((r) => r.id === ids[6])!.status).toBe("accepted");
  });

  test("a task held on a peer is read there, and an unknown answer changes nothing", async () => {
    const { store, service } = make({ 1: "bus404" }, { peers: { hub: { 9: "done" } } });
    const [mine, theirs, lost] = rows(store, [
      { status: "review", todoId: 1 },
      { status: "review", todoId: 9, todoPeer: "hub" },
      { status: "review", todoId: 9, todoPeer: "gone-peer" },
    ]);
    await service.syncTodos();
    expect(store.get(mine!)!.status).toBe("review");
    expect(store.get(theirs!)!.status).toBe("accepted");
    expect(store.get(lost!)!.status).toBe("review");
  });

  test("at most once a minute, unless forced; reads share the running sync", async () => {
    let now = 1_000_000;
    const { store, service, reads } = make({ 1: "review" }, { now: () => now });
    rows(store, [{ status: "review", todoId: 1 }]);
    await Promise.all([service.refresh(), service.refresh()]);
    expect(reads).toEqual([1]);
    await service.refresh();
    expect(reads).toEqual([1]);
    now += 61_000;
    await service.refresh();
    expect(reads).toEqual([1, 1]);
    await service.syncTodos(true);
    expect(reads).toEqual([1, 1, 1]);
  });
});
