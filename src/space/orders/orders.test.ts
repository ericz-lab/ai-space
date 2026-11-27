import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunBusyError, RunRegistry } from "../agents/runs.ts";
import type { ChatCallbacks, ChatTurn, RuntimeAdapter, SteerInput } from "../runtimes/types.ts";
import { removeTemp } from "../testing.ts";
import { TeamStore } from "../team/store.ts";
import { captureHandler, createOrdersRoutes } from "./api.ts";
import { directorSystemPrompt, engineerSystemPrompt, turnMessage } from "./prompt.ts";
import { DIRECTOR_ID, OrdersService } from "./service.ts";
import { fallbackTitle, parseDecision, sortPrompt } from "./sort.ts";
import { lastWords, parseStatus, statusLine, stripStatus } from "./status.ts";
import { OrdersStore } from "./store.ts";

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "orders-"));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach(removeTemp));

const uuid = () => crypto.randomUUID();
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 1, 2, 3]);
const text = (t: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: t }] } });

/** An in-process runtime: the test ends each turn; steering is offered unless `noSteer`. */
function scripted(opts: { noSteer?: boolean; steer?: (turn: Turn, input: SteerInput) => void } = {}) {
  const turns: Turn[] = [];
  const runtime = {
    name: "fake",
    kind: "claude-code",
    capabilities: { chat: true },
    chat(turn: ChatTurn, cb: ChatCallbacks) {
      const t: Turn = { turn, cb, steered: [], end: (reply, sid = "sid-1") => { cb.onSession?.(sid); if (reply) cb.onEvent(text(reply)); cb.onFinish(null); } };
      turns.push(t);
      return {
        kill: () => queueMicrotask(() => cb.onFinish("aborted")),
        ...(opts.noSteer ? {} : { steer: async (input: SteerInput) => { t.steered.push(input); opts.steer?.(t, input); } }),
      };
    },
  } as unknown as RuntimeAdapter;
  return { runtime, turns };
}
type Turn = { turn: ChatTurn; cb: ChatCallbacks; steered: SteerInput[]; end: (reply?: string, sid?: string) => void };

/** The orders service over a real run registry, the chat route stood in by a starter of scripted turns. */
function harness(opts: { decide?: (prompt: string) => Promise<string | undefined> | string | undefined; noSteer?: boolean; steer?: (turn: Turn, input: SteerInput) => void; sortTimeoutMs?: number; db?: Database; data?: string } = {}) {
  const db = opts.db ?? new Database(":memory:");
  const data = opts.data ?? tempDir();
  const store = new OrdersStore(db, { dataDir: data });
  const team = new TeamStore(db);
  const runs = new RunRegistry(db);
  const { runtime, turns } = scripted({ noSteer: opts.noSteer, steer: opts.steer });
  const bodies: Record<string, unknown>[] = [];
  const events: { name: string; data: Record<string, unknown> }[] = [];
  const notes: { title: string; text: string; url: string; key: string; channel?: string }[] = [];
  const prompts: string[] = [];
  const chat = async (req: Request & { params: Record<string, string> }) => {
    const body = (await req.json()) as Record<string, unknown>;
    bodies.push(body);
    expect(req.params).toEqual({ app: "space", agent: "director" });
    try {
      const run = runs.start({ agent: DIRECTOR_ID, runtime, turn: { message: String(body.message), images: (body.images as never) ?? [], sessionId: body.sessionId as string | undefined, permissionMode: body.permissionMode as string | undefined, interactive: body.interactive === true, cwd: "/" } });
      return new Response("data: {}\n\n", { headers: { "x-run-id": run.id } });
    } catch (e) {
      if (e instanceof RunBusyError) return Response.json({ ok: false, error: e.message }, { status: 409 });
      throw e;
    }
  };
  const service = new OrdersService({
    store,
    team,
    runs,
    chat,
    decide: async (prompt) => {
      prompts.push(prompt);
      return opts.decide ? await opts.decide(prompt) : '{"new": "A topic"}';
    },
    publish: (name, d) => events.push({ name, data: d }),
    notify: async (n) => { notes.push(n); },
    channels: () => ["default", "phone"],
    sortTimeoutMs: opts.sortTimeoutMs ?? 1000,
    log: () => {},
  });
  service.start();
  return { db, data, store, team, runs, turns, bodies, events, notes, prompts, service };
}

describe("status line", () => {
  test("read from the last line, in the canonical and the tolerated forms", () => {
    expect(parseStatus(`Done.\n\n${statusLine("done")}`)).toBe("done");
    expect(parseStatus("问你一下：要删吗？\n〔状态: needs-you · 负责人: 总管〕")).toBe("needs-you");
    expect(parseStatus("x\n[status: failed]")).toBe("failed");
    expect(parseStatus("x\n〔状态：working〕\n\n")).toBe("working");
    expect(parseStatus("〔状态: needs-you〕 in the middle\nthen more")).toBeUndefined();
    expect(parseStatus("no line")).toBeUndefined();
    expect(parseStatus("x\n〔状态: maybe〕")).toBeUndefined();
  });

  test("taken out of what is shown; the last words for a notification", () => {
    expect(stripStatus("Answer.\n\n〔状态: done〕\n")).toBe("Answer.");
    expect(stripStatus("Answer only")).toBe("Answer only");
    expect(lastWords("I found two.\n\n**Which one should I keep?**\n\n〔状态: needs-you〕")).toBe("Which one should I keep?");
    expect(lastWords("x".repeat(300), 20)).toHaveLength(20);
  });
});

describe("director prompt", () => {
  test("carries the rules, the exact status line, delegation and the team from the table", () => {
    const p = directorSystemPrompt("/ws", [
      { role: "director", title: "Director", agent: "space/director", summary: "me", permission: "ask", enabled: true },
      { role: "engineer", title: "Engineer", agent: "space/engineer", summary: "Changes an app.", permission: "edit", enabled: true },
      { role: "designer", title: "Designer", agent: "ai-design/designer", summary: "Draws pages.", permission: "full", enabled: true },
      { role: "writer", title: "Writer", agent: "blog/writer", summary: "Off.", permission: "ask", enabled: false },
    ]);
    expect(p).toContain("restating the order in one line");
    expect(p).toContain("Ask first when the order touches the platform itself (ai-space, core/), more than one app, deleting or moving data, a deploy");
    expect(p).toContain("A screenshot shows what was on the person's screen");
    for (const s of ["done", "working", "needs-you", "failed"] as const) expect(p).toContain(statusLine(s));
    // Delegation: the brief's parts, one delegate per order, say vs stop, one follow-up, never approvals.
    for (const words of ["Goal", "Where", "Done when", "Do not touch", "written out in words", "One delegate per order at a time", "`say`", "`stop`", "--continue", "one follow-up at most", "Never answer an approval for a delegate", "space delegate start <role> --brief-file -"]) expect(p).toContain(words);
    // The team from the table: enabled members other than the Director, with role, agent, permission and summary.
    expect(p).toContain("- engineer (Engineer, space/engineer; may change files in its working directory without asking): Changes an app.");
    expect(p).toContain("- designer (Designer, ai-design/designer; full permission: runs any command without asking): Draws pages.");
    expect(p).not.toContain("blog/writer");
    expect(directorSystemPrompt("/ws")).toContain("no one to delegate to");
  });

  test("the Engineer works in app-src, follows each app's AGENTS.md and deploys only when briefed to", () => {
    const p = engineerSystemPrompt("/ws", "/skills/app-fix/scope.ts");
    for (const words of ["app-src/<app>/", "apps/<app>/ is the deployed copy", "its own AGENTS.md", "deploy channel it names", "Deploy only when the brief says to deploy", "bun /skills/app-fix/scope.ts app-src/<app>", "A message from the Director can arrive while you work"]) expect(p).toContain(words);
  });

  test("a turn's message names each order, how it came and its screenshot", () => {
    const m = turnMessage([
      { id: 3, text: "看下这个报错", via: "voice", createdAt: Date.parse("2026-11-26T10:31:00Z"), imagePath: "/x.jpg" },
      { id: 4, text: "还有这个", via: null, createdAt: Date.parse("2026-11-26T10:32:00Z"), imagePath: null },
    ]);
    expect(m).toBe("〔Order #3 · spoken · 2026-11-26T10:31:00Z · screenshot attached〕\n看下这个报错\n\n〔Order #4 · 2026-11-26T10:32:00Z〕\n还有这个");
  });
});

describe("store", () => {
  test("an order is kept once per client id; its screenshot is a file, removed with the order", async () => {
    const store = new OrdersStore(new Database(":memory:"), { dataDir: tempDir() });
    const id = uuid();
    const first = await store.add({ clientId: id, text: "one", via: "voice", image: { bytes: PNG, mime: "image/png" } });
    expect(first.created).toBe(true);
    expect(first.order).toMatchObject({ id: 1, clientId: id, topicId: null, imageMime: "image/png", imageBytes: PNG.byteLength, runId: null });
    expect(first.order.imagePath!.startsWith(store.imageDir)).toBe(true);
    expect(new Uint8Array(await Bun.file(first.order.imagePath!).arrayBuffer())).toEqual(PNG);
    const again = await store.add({ clientId: id, text: "different words", image: { bytes: JPEG, mime: "image/jpeg" } });
    expect(again).toEqual({ order: first.order, created: false });
    expect(store.unsorted()).toHaveLength(1);
    expect(await store.remove(1)).toBe(true);
    expect(existsSync(first.order.imagePath!)).toBe(false);
    expect(await store.remove(1)).toBe(false);
  });

  test("an older topics table gains the added columns; settings default and round-trip through panel_kv", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE order_topics (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, session_id TEXT, created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'working', archived INTEGER NOT NULL DEFAULT 0)");
    db.exec("INSERT INTO order_topics (title, session_id, created_at, last_active_at) VALUES ('old', 'sid-old', 1, 1)");
    const store = new OrdersStore(db, { dataDir: tempDir() });
    expect(store.topic(1)).toMatchObject({ title: "old", sessionId: "sid-old", runId: null, summary: "" });
    new OrdersStore(db, { dataDir: tempDir() }); // a second open changes nothing
    expect(store.settings()).toEqual({ topicDays: 3, notify: "default" });
    expect(store.setSettings({ topicDays: 7, notify: "off" })).toEqual({ topicDays: 7, notify: "off" });
    expect(db.query("SELECT value FROM panel_kv WHERE key = 'orders.topicDays'").get()).toEqual({ value: "7" });
    db.query("UPDATE panel_kv SET value = '99' WHERE key = 'orders.topicDays'").run();
    expect(store.settings().topicDays).toBe(3);
    expect(store.pinnedSessions()).toEqual(["sid-old"]);
    store.patchTopic(1, { archived: true });
    expect(store.pinnedSessions()).toEqual([]);
  });
});

describe("topic decision", () => {
  const cand = (id: number, extra: Partial<{ waiting: boolean; title: string }> = {}) => ({ id, title: extra.title ?? `Topic ${id}`, lastActiveAt: Date.now() - 60_000, waiting: extra.waiting ?? false, orders: ["an order"], messages: ["person: hi", "director: hello"] });

  test("the answer is one line of JSON naming an offered topic or a new title", () => {
    expect(parseDecision('{"continue": 2}', [1, 2])).toEqual({ kind: "continue", topicId: 2 });
    expect(parseDecision('Sure: {"continue": "1"} done', [1])).toEqual({ kind: "continue", topicId: 1 });
    expect(parseDecision('{"continue": 9}', [1, 2])).toBeUndefined();
    expect(parseDecision('{"new": "  Printer setup "}', [])).toEqual({ kind: "new", title: "Printer setup" });
    expect(parseDecision('{"new": ""}', [])).toBeUndefined();
    expect(parseDecision("I think topic 2", [2])).toBeUndefined();
    expect(parseDecision("{not json}", [2])).toBeUndefined();
    expect(fallbackTitle("\n  帮我查一下明天的天气然后提醒我带伞，顺便看看航班有没有延误以及酒店的入住时间，再订一张后天去上海的高铁票\nmore")).toHaveLength(40);
    expect(fallbackTitle("  \n ")).toBe("Order");
  });

  test("the prompt marks a waiting topic, lists every offered id and stays near its size", () => {
    const p = sortPrompt({ text: "好的", image: true }, [cand(5, { waiting: true }), cand(4)]);
    expect(p).toContain("Topic 5: Topic 5 (last active 1 min ago, WAITING for the person's answer)");
    expect(p).toContain("screenshot");
    const many = Array.from({ length: 20 }, (_, i) => ({ ...cand(i + 1), orders: ["x".repeat(500), "y".repeat(500), "z".repeat(500)], messages: ["m".repeat(500), "n".repeat(500), "o".repeat(500)] }));
    const big = sortPrompt({ text: "q".repeat(3000), image: false }, many);
    expect(big.length).toBeLessThanOrEqual(7_200);
    for (let i = 1; i <= 20; i++) expect(big).toContain(`Topic ${i}:`);
  });

  test("continue, new, an answer to the waiting topic, and the fallbacks", async () => {
    let answer: string | undefined | Promise<string | undefined> = '{"new": "Weather"}';
    const h = harness({ decide: () => answer });
    await h.service.submit({ clientId: uuid(), text: "明天天气怎么样", via: "voice" });
    await h.service.idle();
    expect(h.store.topic(1)).toMatchObject({ title: "Weather", state: "working" });
    expect(h.store.get(1)).toMatchObject({ topicId: 1, routedBy: "model" });
    h.turns[0]!.end(`要带伞吗？\n${statusLine("needs-you")}`);
    await h.service.idle();
    expect(h.store.topic(1)!.state).toBe("needs-you");
    // The prompt offers topic 1 as waiting; the model sends the short answer there.
    answer = '{"continue": 1}';
    await h.service.submit({ clientId: uuid(), text: "要", via: "voice" });
    await h.service.idle();
    expect(h.prompts[1]).toContain("WAITING for the person's answer");
    expect(h.store.get(2)).toMatchObject({ topicId: 1, routedBy: "model" });
    h.turns[1]!.end(`好。\n${statusLine("done")}`);
    await h.service.idle();
    // A failed call, unusable output, an unknown id and a timeout: a new topic from the first words.
    for (const bad of [undefined, "no idea", '{"continue": 42}', new Promise<undefined>(() => {})]) {
      answer = bad;
      await h.service.submit({ clientId: uuid(), text: "Order the printer paper\nthank you" });
    }
    const h2 = harness({ decide: () => new Promise(() => {}), sortTimeoutMs: 30 });
    await h2.service.submit({ clientId: uuid(), text: "slow model" });
    await h2.service.idle();
    expect(h2.store.get(1)).toMatchObject({ routedBy: "fallback" });
    await h.service.idle();
    const fallbacks = [3, 4, 5].map((id) => h.store.get(id)!);
    expect(fallbacks.every((o) => o.routedBy === "fallback")).toBe(true);
    expect(new Set(fallbacks.map((o) => o.topicId)).size).toBe(3);
    expect(h.store.topic(fallbacks[0]!.topicId!)!.title).toBe("Order the printer paper");
  }, 10_000);

  test("only topics active within the look-back window are offered", async () => {
    const h = harness({ decide: () => '{"new": "fresh"}' });
    const old = h.store.addTopic("Long ago");
    h.store.patchTopic(old.id, { lastActiveAt: Date.now() - 5 * 86_400_000, state: "done" });
    const recent = h.store.addTopic("Yesterday");
    h.store.patchTopic(recent.id, { lastActiveAt: Date.now() - 86_400_000, state: "done" });
    await h.service.submit({ clientId: uuid(), text: "x" });
    await h.service.idle();
    expect(h.prompts[0]).toContain("Yesterday");
    expect(h.prompts[0]).not.toContain("Long ago");
    h.service.setSettings({ topicDays: 7 });
    await h.service.submit({ clientId: uuid(), text: "y" });
    await h.service.idle();
    expect(h.prompts[1]).toContain("Long ago");
    expect(() => h.service.setSettings({ topicDays: 0 })).toThrow("whole number of days");
    expect(() => h.service.setSettings({ topicDays: 31 })).toThrow();
    expect(() => h.service.setSettings({ notify: "nowhere" })).toThrow("notify must be off, default or a channel");
    expect(h.service.setSettings({ notify: "phone" })).toEqual({ topicDays: 7, notify: "phone" });
  });

  test("orders stored but not sorted when the service stopped are sorted at start; taken ones are not started again", async () => {
    const db = new Database(":memory:");
    const data = tempDir();
    const store = new OrdersStore(db, { dataDir: data });
    await store.add({ clientId: uuid(), text: "left over" });
    const h = harness({ db, data, decide: () => '{"new": "Left over"}' });
    await h.service.idle();
    expect(h.store.get(1)).toMatchObject({ topicId: 1 });
    expect(h.turns).toHaveLength(1);
    expect(h.store.get(1)!.runId).toBe(h.runs.list()[0]!.id);
  });
});

describe("director turns", () => {
  test("a turn carries the order, its screenshot, the topic's session and the team's permission, interactive", async () => {
    const h = harness({ decide: () => '{"continue": 1}' });
    h.team.update("director", { permission: "full" });
    const first = await h.service.submit({ clientId: uuid(), text: "看下这个", via: "voice", image: { bytes: JPEG } });
    expect(first.created).toBe(true);
    await h.service.idle();
    expect(h.bodies[0]).toMatchObject({ permissionMode: "bypassPermissions", interactive: true });
    expect(h.bodies[0]!.sessionId).toBeUndefined();
    expect(String(h.bodies[0]!.message)).toContain("〔Order #1 · spoken");
    expect(h.bodies[0]!.images).toEqual([{ name: "order-1.jpeg", mediaType: "image/jpeg", data: Buffer.from(JPEG).toString("base64") }]);
    h.turns[0]!.end(`看到了。\n${statusLine("done")}`, "sid-topic");
    await h.service.idle();
    expect(h.store.topic(1)).toMatchObject({ sessionId: "sid-topic", state: "done", summary: "看到了。" });
    h.team.update("director", { permission: "ask" });
    await h.service.submit({ clientId: uuid(), text: "继续" });
    await h.service.idle();
    expect(h.bodies[1]).toMatchObject({ sessionId: "sid-topic", interactive: true });
    expect(h.bodies[1]!.permissionMode).toBeUndefined();
    h.team.update("director", { permission: "edit" });
    h.turns[1]!.end("ok", "sid-topic");
    await h.service.submit({ clientId: uuid(), text: "再继续" });
    await h.service.idle();
    expect(h.bodies[2]!.permissionMode).toBe("acceptEdits");
  });

  test("an order for a running turn is steered into it", async () => {
    const h = harness({ decide: () => '{"continue": 1}' });
    await h.service.submit({ clientId: uuid(), text: "first" });
    await h.service.idle();
    await h.service.submit({ clientId: uuid(), text: "and also this", image: { bytes: PNG } });
    await h.service.idle();
    expect(h.turns).toHaveLength(1);
    expect(h.turns[0]!.steered[0]!.message).toContain("and also this");
    expect(h.turns[0]!.steered[0]!.images?.[0]?.mediaType).toBe("image/png");
    expect(h.store.get(2)!.runId).toBe(h.store.get(1)!.runId);
  });

  test("a runtime that cannot take a message: the order waits and starts the next turn when this one ends", async () => {
    const h = harness({ decide: () => '{"continue": 1}', noSteer: true });
    await h.service.submit({ clientId: uuid(), text: "first" });
    await h.service.idle();
    await h.service.submit({ clientId: uuid(), text: "second" });
    await h.service.submit({ clientId: uuid(), text: "third" });
    await h.service.idle();
    expect(h.turns).toHaveLength(1);
    expect(h.store.waiting(1).map((o) => o.id)).toEqual([2, 3]);
    h.turns[0]!.end("ok", "sid-a");
    await h.service.idle();
    expect(h.turns).toHaveLength(2);
    expect(h.bodies[1]).toMatchObject({ sessionId: "sid-a" });
    expect(String(h.bodies[1]!.message)).toMatch(/second[\s\S]*third/);
    expect(h.store.waiting(1)).toEqual([]);
  });

  test("the turn ends between the busy answer and the steer: the order starts the next turn", async () => {
    // The steer finds the turn over: the runtime ended it the moment the message came.
    const h = harness({ decide: () => '{"continue": 1}', steer: (t) => { t.end("done", "sid-r"); throw new Error("the turn has ended"); } });
    await h.service.submit({ clientId: uuid(), text: "first" });
    await h.service.idle();
    await h.service.submit({ clientId: uuid(), text: "second" });
    await h.service.idle();
    expect(h.turns).toHaveLength(2);
    expect(h.bodies[1]).toMatchObject({ sessionId: "sid-r" });
    expect(h.store.get(2)!.runId).not.toBe(h.store.get(1)!.runId);
  });

  test("a turn the person starts on the topic's session is followed; one that starts just before the order makes the chat answer busy, and the order goes into it", async () => {
    const h = harness({ decide: () => '{"continue": 1}' });
    await h.service.submit({ clientId: uuid(), text: "first" });
    await h.service.idle();
    h.turns[0]!.end(`?\n${statusLine("needs-you")}`, "sid-p");
    await h.service.idle();
    expect(h.store.topic(1)!.state).toBe("needs-you");
    // The person answers in the chat: the topic follows that turn.
    const person = scripted();
    const chatRun = h.runs.start({ agent: DIRECTOR_ID, runtime: person.runtime, turn: { message: "from the chat", sessionId: "sid-p", cwd: "/" } });
    expect(h.store.topic(1)!.runId).toBe(chatRun.id);
    person.turns[0]!.end(`ok\n${statusLine("done")}`, "sid-p");
    await h.service.idle();
    expect(h.store.topic(1)!.state).toBe("done");
    // Now a chat turn starts between the service's look and its start: the chat answers 409.
    const opts = (h.service as unknown as { opts: { chat: (r: Request & { params: Record<string, string> }) => Promise<Response> } }).opts;
    const chat = opts.chat;
    let raced = false;
    opts.chat = async (r) => {
      if (!raced) {
        raced = true;
        h.service.stop(); // not adopted by the watch: only the busy answer tells
        h.runs.start({ agent: DIRECTOR_ID, runtime: person.runtime, turn: { message: "raced", sessionId: "sid-p", cwd: "/" } });
      }
      return chat(r);
    };
    await h.service.submit({ clientId: uuid(), text: "second" });
    await h.service.idle();
    expect(h.bodies.at(-1)).toMatchObject({ sessionId: "sid-p" });
    expect(person.turns[1]!.steered[0]!.message).toContain("second");
    expect(h.store.get(2)!.runId).toBe(h.runs.running()[0]!.id);
  });

  test("a turn that does not start leaves the order waiting and the topic failed; a resend tries again", async () => {
    const h = harness({ decide: () => '{"new": "x"}' });
    const refuse = { on: true };
    const orig = (h.service as unknown as { opts: { chat: (r: Request & { params: Record<string, string> }) => Promise<Response> } }).opts;
    const chat = orig.chat;
    orig.chat = async (r) => (refuse.on ? Response.json({ ok: false, error: "runtime claude is not configured on this space" }, { status: 501 }) : chat(r));
    await h.service.submit({ clientId: uuid(), text: "first" });
    await h.service.idle();
    expect(h.store.topic(1)).toMatchObject({ state: "failed", summary: "The Director's turn did not start: runtime claude is not configured on this space" });
    expect(h.store.waiting(1)).toHaveLength(1);
    refuse.on = false;
    h.service.resend(1);
    await h.service.idle();
    expect(h.turns).toHaveLength(1);
    expect(h.store.topic(1)!.state).toBe("working");
  });
});

describe("state, events and the notification", () => {
  test("approvals and the status line make needs-you, notified once per wait; events carry no picture", async () => {
    const h = harness({ decide: () => '{"new": "Clean up"}' });
    await h.service.submit({ clientId: uuid(), text: "删掉旧的备份", via: "voice", image: { bytes: PNG } });
    await h.service.idle();
    const t = h.turns[0]!;
    t.cb.onEvent(JSON.stringify({ type: "approval_request", id: "a1", tool: "Bash", title: "Run rm -rf old/" }));
    expect(h.store.topic(1)!.state).toBe("needs-you");
    expect(h.service.asking(h.store.topic(1)!)).toEqual(["Run rm -rf old/"]);
    t.cb.onEvent(JSON.stringify({ type: "approval_request", id: "a2", tool: "Bash", title: "Run ls" }));
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0]).toMatchObject({ title: "Waiting for you: Clean up", text: "Run rm -rf old/", url: "/#order=1", key: "orders:1" });
    t.cb.onEvent(JSON.stringify({ type: "approval_resolved", id: "a1", decision: "allow" }));
    expect(h.store.topic(1)!.state).toBe("needs-you");
    t.cb.onEvent(JSON.stringify({ type: "approval_resolved", id: "a2", decision: "allow" }));
    expect(h.store.topic(1)!.state).toBe("working");
    t.end(`删了 3 个。还有一个在用，要删吗？\n${statusLine("needs-you")}`);
    await h.service.idle();
    expect(h.store.topic(1)).toMatchObject({ state: "needs-you", summary: "删了 3 个。还有一个在用，要删吗？" });
    expect(h.notes).toHaveLength(2);
    expect(h.notes[1]!.text).toBe("删了 3 个。还有一个在用，要删吗？");
    const names = h.events.map((e) => e.name);
    expect(names).toEqual(["order.issued", "order.sorted", "order.state", "order.state", "order.state", "order.state"]);
    expect(h.events[0]!.data).toMatchObject({ id: 1, text: "删掉旧的备份", via: "voice", image: { mime: "image/png", bytes: PNG.byteLength }, url: "/#order=1" });
    expect(typeof h.events[0]!.data.createdAt).toBe("string");
    expect(h.events[1]!.data).toEqual({ id: 1, topic: { id: 1, title: "Clean up", new: true }, by: "model" });
    expect(h.events.map((e) => e.data.state).filter(Boolean)).toEqual(["working", "needs-you", "working", "needs-you"]);
    expect(h.events[5]!.data).toMatchObject({ topic: { id: 1, title: "Clean up" }, order: 1, summary: "删了 3 个。还有一个在用，要删吗？" });
    // Nothing in any event is the picture or a path to it.
    const all = JSON.stringify(h.events);
    expect(all).not.toContain(Buffer.from(PNG).toString("base64"));
    expect(all).not.toContain(h.data);
  });

  test("a reply without a status line is done, a failed run is failed, notify off sends nothing", async () => {
    const h = harness({ decide: () => '{"new": "x"}' });
    h.service.setSettings({ notify: "off" });
    await h.service.submit({ clientId: uuid(), text: "a" });
    await h.service.idle();
    h.turns[0]!.end("Here it is.");
    await h.service.idle();
    expect(h.store.topic(1)!.state).toBe("done");
    await h.service.submit({ clientId: uuid(), text: "b" });
    await h.service.idle();
    h.turns[1]!.cb.onFinish("the CLI crashed");
    await h.service.idle();
    expect(h.store.topic(2)).toMatchObject({ state: "failed", summary: "the CLI crashed" });
    await h.service.submit({ clientId: uuid(), text: "c" });
    await h.service.idle();
    h.turns[2]!.end(`?\n${statusLine("needs-you")}`);
    await h.service.idle();
    expect(h.store.topic(3)!.state).toBe("needs-you");
    expect(h.notes).toEqual([]);
  });

  test("a channel chosen in the setting is named; a restart turns a cut turn into failed", async () => {
    const db = new Database(":memory:");
    const data = tempDir();
    const h = harness({ db, data, decide: () => '{"new": "x"}' });
    h.service.setSettings({ notify: "phone" });
    await h.service.submit({ clientId: uuid(), text: "a" });
    await h.service.idle();
    h.turns[0]!.cb.onEvent(JSON.stringify({ type: "approval_request", id: "q", tool: "AskUserQuestion", title: "Ask", questions: [{ question: "Which one?" }] }));
    expect(h.notes[0]).toMatchObject({ channel: "phone", text: "Which one?" });
    h.service.stop();
    // The process dies: a new registry marks the run interrupted; the service shows the topic failed.
    const again = harness({ db, data, decide: () => '{"new": "x"}' });
    expect(again.store.topic(1)).toMatchObject({ state: "failed", summary: "ai-space restarted during the turn" });
  });
});

describe("capture target and routes", () => {
  test("text and image bodies, refusals, the caller check and the repeated id", async () => {
    const h = harness({ decide: () => '{"new": "x"}' });
    const handle = captureHandler(h.service);
    const id = uuid();
    const post = (body: BodyInit, headers: Record<string, string>, caller = "space") => handle(new Request("http://space.local/api/capture/order", { method: "POST", headers: { "x-space-caller": caller, ...headers }, body }));
    const ok = await post(JSON.stringify({ text: "记一下", via: "voice", id }), { "content-type": "application/json" });
    expect(await ok.json()).toEqual({ ok: true, url: "/#order=1", label: "Order #1" });
    const again = await post(JSON.stringify({ text: "记一下", via: "voice", id }), { "content-type": "application/json" });
    expect(await again.json()).toEqual({ ok: true, url: "/#order=1", label: "Order #1" });
    const form = (parts: Record<string, string | Blob>) => {
      const f = new FormData();
      for (const [k, v] of Object.entries(parts)) f.append(k, v);
      return f;
    };
    const img = await handle(new Request("http://space.local/x", { method: "POST", headers: { "x-space-caller": "hub/space" }, body: form({ file: new Blob([JPEG], { type: "image/jpeg" }), text: "这个", via: "voice", id: uuid() }) }));
    expect(await img.json()).toEqual({ ok: true, url: "/#order=2", label: "Order #2" });
    expect(h.store.get(2)).toMatchObject({ imageMime: "image/jpeg", via: "voice" });
    const refused = async (res: Response | Promise<Response>, status: number, words: string) => {
      const r = await res;
      expect(r.status).toBe(status);
      expect(((await r.json()) as { error: string }).error).toContain(words);
    };
    await refused(handle(new Request("http://x/", { method: "POST", headers: { "x-space-caller": "space" }, body: form({ file: new Blob([JPEG]), id: uuid() }) })), 400, "needs the words");
    await refused(handle(new Request("http://x/", { method: "POST", headers: { "x-space-caller": "space" }, body: form({ file: new Blob([new Uint8Array([1, 2, 3, 4])]), text: "x", id: uuid() }) })), 400, "PNG, JPEG");
    await refused(handle(new Request("http://x/", { method: "POST", headers: { "x-space-caller": "space" }, body: form({ file: new Blob([new Uint8Array(4 * 1024 * 1024 + 1)]), text: "x", id: uuid() }) })), 413, "limit");
    await refused(post(JSON.stringify({ text: "x", id: "nope" }), { "content-type": "application/json" }), 400, "UUID");
    await refused(post(JSON.stringify({ text: " ", id: uuid() }), { "content-type": "application/json" }), 400, "empty");
    await refused(post(JSON.stringify({ text: "x", via: "telepathy", id: uuid() }), { "content-type": "application/json" }), 400, "via");
    await refused(post(JSON.stringify({ text: "x", id: uuid() }), { "content-type": "application/json" }, "notes"), 403, "panel's clients");
    await refused(post(JSON.stringify({ text: "x", id: uuid() }), { "content-type": "application/json" }, "consumer:bot"), 403, "panel's clients");
    await refused(post("x", { "content-type": "text/plain" }), 415, "JSON");
  });

  test("the routes are the owner's; the screenshot is served to the owner only and never cached", async () => {
    const h = harness({ decide: () => '{"new": "Screens"}' });
    let caller: string | null = null;
    const routes = createOrdersRoutes({ service: h.service, store: h.store, team: h.team, callerApp: async () => caller, channels: () => ["default"] });
    const call = (path: string, method = "GET", body?: unknown, params: Record<string, string> = {}) => {
      const key = Object.keys(routes).find((k) => new RegExp(`^${k.replace(/:[a-z]+/g, "[^/]+")}$`).test(path.split("?")[0]!))!;
      return routes[key]![method as "GET"]!(Object.assign(new Request(`http://space.local${path}`, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) }), { params }));
    };
    const typed = await call("/api/orders", "POST", { text: "typed order", image: { mediaType: "image/png", data: Buffer.from(PNG).toString("base64") } });
    expect(typed.status).toBe(201);
    expect(await typed.json()).toMatchObject({ ok: true, order: { id: 1, label: "Order #1", via: "type", image: { mime: "image/png", url: "/api/orders/1/image" } }, url: "/#order=1" });
    await h.service.idle();
    const list = (await (await call("/api/orders")).json()) as { topics: { id: number; title: string; state: string }[]; sorting: number; settings: unknown; channels: string[]; full: boolean };
    expect(list).toMatchObject({ topics: [{ id: 1, title: "Screens", state: "working" }], sorting: 0, settings: { topicDays: 3, notify: "default" }, channels: ["default"], full: false });
    const one = await (await call("/api/orders/1", "GET", undefined, { id: "1" })).json();
    expect(one).toMatchObject({ order: { id: 1, topic: 1 }, topic: { id: 1 } });
    const image = await call("/api/orders/1/image", "GET", undefined, { id: "1" });
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(PNG);
    // Into the topic directly: filed by the person, steered into the running turn.
    const into = await call("/api/orders", "POST", { text: "more", topic: 1 });
    expect(((await into.json()) as { order: { topic: number } }).order.topic).toBe(1);
    await h.service.idle();
    expect(h.store.get(2)!.routedBy).toBe("person");
    expect(h.turns[0]!.steered).toHaveLength(1);
    expect((await call("/api/orders/topics/1", "PATCH", { title: "Renamed" }, { id: "1" })).status).toBe(200);
    expect(h.store.topic(1)!.title).toBe("Renamed");
    const moved = await call("/api/orders/2/move", "POST", { title: "Elsewhere" }, { id: "2" });
    expect(((await moved.json()) as { order: { topic: number; routedBy: string } }).order).toMatchObject({ topic: 2, routedBy: "person" });
    expect((await call("/api/orders/settings", "PUT", { topicDays: 40 })).status).toBe(400);
    expect((await call("/api/orders/settings", "PUT", { topicDays: 5, notify: "off" })).status).toBe(200);
    expect((await call("/api/orders/1", "DELETE", undefined, { id: "1" })).status).toBe(200);
    expect((await call("/api/orders/1/image", "GET", undefined, { id: "1" })).status).toBe(404);
    caller = "notes";
    for (const [path, method, params] of [["/api/orders", "GET", {}], ["/api/orders/2/image", "GET", { id: "2" }], ["/api/orders", "POST", {}], ["/api/orders/settings", "PUT", {}]] as const) {
      expect((await call(path, method, method === "GET" ? undefined : { text: "x" }, params)).status).toBe(403);
    }
  });
});
