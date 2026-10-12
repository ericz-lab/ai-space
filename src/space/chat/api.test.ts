import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelService } from "../model/service.ts";
import { ModelStore } from "../model/store.ts";
import { claudeOnly } from "../runtimes/registry.ts";
import { fakeModelBin } from "../runtimes/testing.ts";
import { createChatRoutes } from "./api.ts";
import { ChatService } from "./service.ts";
import { ChatStore } from "./store.ts";

let dir: string;
let modelStore: ModelStore;
let store: ChatStore;
let service: ChatService;
let server: ReturnType<typeof Bun.serve>;
let base: string;
let defaultModel: string;

const TOKENS: Record<string, string> = { sat_notes: "notes", sat_cal: "cal" };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "space-chat-api-"));
  modelStore = new ModelStore(join(dir, "space.db"));
  store = new ChatStore(join(dir, "space.db"));
  const model = new ModelService({ store: modelStore, runtimes: claudeOnly(fakeModelBin()), maxConcurrency: 2, log: () => {} });
  defaultModel = "haiku";
  service = new ChatService({ store, model, defaultModel: () => defaultModel, fileDir: (app) => join(dir, app, "chat"), log: () => {} });
  server = Bun.serve({
    port: 0,
    routes: createChatRoutes({ service, token: "op-token", appForToken: async (t) => TOKENS[t], widget: async () => ({ js: "window.SpaceChat={}", css: ".sc{}", etag: '"w1"' }) }),
    fetch: () => new Response("nf", { status: 404 }),
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  server.stop(true);
  store.close();
  modelStore.close();
  delete process.env.FAKE_MODEL_MODE;
  await rm(dir, { recursive: true, force: true });
});

const call = (method: string, path: string, body?: unknown, token = "sat_notes") =>
  fetch(`${base}${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

/** Events of a text/event-stream body: name and parsed data; comment lines are skipped. */
function parseSse(text: string): { event: string; data: any }[] {
  return text.split("\n\n").map((b) => b.trim()).filter((b) => b && !b.startsWith(":")).map((b) => ({ event: b.match(/^event: (.*)$/m)?.[1] ?? "message", data: JSON.parse(b.match(/^data: (.*)$/m)?.[1] ?? "null") }));
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3]);

async function upload(threadId: number, bytes: Uint8Array, name = "shot.png", token = "sat_notes") {
  const form = new FormData();
  form.set("file", new File([bytes.slice()], name, { type: "image/png" }));
  return fetch(`${base}/api/chat/threads/${threadId}/attachments`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form });
}

describe("threads", () => {
  test("create, list by scope, rename, delete; an app token scopes everything to that app", async () => {
    const created = await call("POST", "/api/chat/threads", { scope: "note:1", title: "t" });
    expect(created.status).toBe(201);
    const { thread } = (await created.json()) as any;
    expect(thread).toMatchObject({ scope: "note:1", title: "t" });
    expect(((await (await call("GET", "/api/chat/threads?scope=note:1")).json()) as any).threads.map((t: any) => t.id)).toEqual([thread.id]);
    expect(((await (await call("GET", "/api/chat/threads?scope=note:1", undefined, "sat_cal")).json()) as any).threads).toEqual([]);
    expect((await call("GET", `/api/chat/threads/${thread.id}`, undefined, "sat_cal")).status).toBe(404);
    expect(((await (await call("PATCH", `/api/chat/threads/${thread.id}`, { title: "renamed" })).json()) as any).thread.title).toBe("renamed");
    expect((await call("POST", "/api/chat/threads", { scope: "bad scope" })).status).toBe(400);
    expect((await call("POST", "/api/chat/threads", { scope: "x" }, "nope")).status).toBe(401);
    // The operator names the app.
    expect((await call("POST", "/api/chat/threads", { scope: "x" }, "op-token")).status).toBe(400);
    expect((await call("POST", "/api/chat/threads", { app: "cal", scope: "x" }, "op-token")).status).toBe(201);
    expect((await call("DELETE", `/api/chat/threads/${thread.id}`)).status).toBe(200);
    expect((await call("GET", `/api/chat/threads/${thread.id}`)).status).toBe(404);
  });
});

describe("turns", () => {
  test("a streamed turn: deltas, then done with both stored messages; the ledger has the call tagged chat", async () => {
    const { thread } = (await (await call("POST", "/api/chat/threads", { scope: "note:1" })).json()) as any;
    const res = await call("POST", `/api/chat/threads/${thread.id}/turn`, { message: "**第一问**\n第二行", context: { system: "Be brief.", text: "# 笔记", ack: "已读完。" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/event-stream");
    const events = parseSse(await res.text());
    expect(events.map((e) => e.event)).toEqual(["start", "delta", "delta", "done"]);
    const done = events[3]!.data;
    expect(done.ok).toBe(true);
    expect(done.user).toMatchObject({ role: "user", content: "**第一问**\n第二行", attachments: [] });
    expect(events[0]!.data).toMatchObject({ turn: { status: "running", userMessageId: done.user.id }, user: { id: done.user.id, content: "**第一问**\n第二行" } });
    expect(done.assistant.role).toBe("assistant");
    expect(events.slice(1, 3).map((e) => e.data.text).join("")).toBe(done.assistant.content);
    expect(done.assistant.content).toStartWith("answer to: # 笔记\n\n---\n\n[assistant]\n已读完。\n\n[user]\n**第一问**\n第二行 [args:");
    expect(done.assistant.content).toContain("--system-prompt Be brief.");
    expect(done.assistant).toMatchObject({ backend: "local", model: "haiku", costUsd: 0.0123 });
    expect(done.thread.title).toBe("第一问");
    expect(done.call).toMatchObject({ app: "notes", tag: "chat", status: "ok" });
    expect(modelStore.get(done.call.id)).toMatchObject({ app: "notes", tag: "chat" });
    const detail = (await (await call("GET", `/api/chat/threads/${thread.id}`)).json()) as any;
    expect(detail.messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
    expect(detail.running).toBe(false);
  });

  test("the history is replayed on the next turn; a failed answer keeps its partial text and is skipped afterwards", async () => {
    const { thread } = (await (await call("POST", "/api/chat/threads", { scope: "s" })).json()) as any;
    await (await call("POST", `/api/chat/threads/${thread.id}/turn?stream=0`, { message: "one" })).json();
    process.env.FAKE_MODEL_MODE = "error";
    const failed = await call("POST", `/api/chat/threads/${thread.id}/turn?stream=0`, { message: "two" });
    expect(failed.status).toBe(502);
    const f = (await failed.json()) as any;
    expect(f).toMatchObject({ ok: false, error: "simulated runtime failure", assistant: { error: "simulated runtime failure", content: "" } });
    delete process.env.FAKE_MODEL_MODE;
    const third = (await (await call("POST", `/api/chat/threads/${thread.id}/turn?stream=0`, { message: "three" })).json()) as any;
    expect(third.assistant.content).toContain("[user]\none\n\n[assistant]\nanswer to: [user]\none [args:");
    expect(third.assistant.content).not.toContain("[user]\ntwo");
    expect(store.listMessages(thread.id).length).toBe(6);
  });

  test("one turn at a time per thread", async () => {
    const { thread } = (await (await call("POST", "/api/chat/threads", { scope: "s" })).json()) as any;
    process.env.FAKE_MODEL_MODE = "hang";
    const first = call("POST", `/api/chat/threads/${thread.id}/turn?stream=0`, { message: "slow", timeoutMs: 400 });
    await Bun.sleep(80);
    expect((await call("POST", `/api/chat/threads/${thread.id}/turn?stream=0`, { message: "again" })).status).toBe(409);
    expect(((await (await call("GET", `/api/chat/threads/${thread.id}`)).json()) as any).running).toBe(true);
    expect((await first).status).toBe(502);
  });

  test("a thread cannot be deleted while it answers, alone or with its scope", async () => {
    const { thread } = (await (await call("POST", "/api/chat/threads", { scope: "s" })).json()) as any;
    process.env.FAKE_MODEL_MODE = "hang";
    const first = call("POST", `/api/chat/threads/${thread.id}/turn?stream=0`, { message: "slow", timeoutMs: 400 });
    await Bun.sleep(80);
    expect((await call("DELETE", `/api/chat/threads/${thread.id}`)).status).toBe(409);
    expect((await call("DELETE", "/api/chat/threads?scope=s")).status).toBe(409);
    const done = (await (await first).json()) as any;
    expect(done.thread.id).toBe(thread.id);
    expect(store.listMessages(thread.id).length).toBe(2);
    expect((await call("DELETE", `/api/chat/threads/${thread.id}`)).status).toBe(200);
    expect(store.listMessages(thread.id)).toEqual([]);
  });

  test("validation: message, tools outside the chat set, too many attachments", async () => {
    const { thread } = (await (await call("POST", "/api/chat/threads", { scope: "s" })).json()) as any;
    expect((await call("POST", `/api/chat/threads/${thread.id}/turn`, { message: "  " })).status).toBe(400);
    expect((await call("POST", `/api/chat/threads/${thread.id}/turn`, { message: "x", tools: ["Bash(rm:*)"] })).status).toBe(400);
    expect((await call("POST", `/api/chat/threads/${thread.id}/turn`, { message: "x", attachments: [1, 2, 3, 4, 5] })).status).toBe(400);
    expect((await call("POST", `/api/chat/threads/${thread.id}/turn`, { message: "x", attachments: [999] })).status).toBe(400);
    expect(store.listMessages(thread.id)).toEqual([]);
  });
});

describe("durable turns", () => {
  const rid = (n: number) => `req-0000-${n}`;
  const newThread = async () => ((await (await call("POST", "/api/chat/threads", { scope: "s" })).json()) as any).thread as { id: number };
  /** Post a turn, read its stream until the first delta, then drop the connection like a closed tab. */
  const postAndLeave = async (threadId: number, body: unknown) => {
    const gone = new AbortController();
    const res = await fetch(`${base}/api/chat/threads/${threadId}/turn`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer sat_notes" }, body: JSON.stringify(body), signal: gone.signal });
    const reader = res.body!.getReader();
    let text = "";
    while (!text.includes("event: delta")) {
      const { done, value } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    gone.abort();
    await reader.read().catch(() => {});
    return text;
  };

  test("with a request id the turn outlives its connection; the thread shows it running and a reader can come back to it", async () => {
    const thread = await newThread();
    process.env.FAKE_MODEL_MODE = "slow";
    expect(await postAndLeave(thread.id, { message: "long", requestId: rid(1) })).toContain("event: start");
    await Bun.sleep(100);
    const mid = (await (await call("GET", `/api/chat/threads/${thread.id}`)).json()) as any;
    expect(mid.running).toBe(true);
    expect(mid.turn).toMatchObject({ status: "running", requestId: rid(1), userMessageId: mid.messages[0].id, text: "answer to:" });
    expect(mid.messages.map((m: any) => m.role)).toEqual(["user"]);
    // The text so far is in the turn's row too, which is what a restart would settle it with.
    expect(store.runningTurns().map((r) => r.partial)).toEqual(["answer to:"]);

    const again = parseSse(await (await call("GET", `/api/chat/threads/${thread.id}/turn`)).text());
    expect(again.map((e) => e.event)).toEqual(["start", "delta", "delta", "done"]);
    const done = again.at(-1)!.data;
    expect(again.filter((e) => e.event === "delta").map((e) => e.data.text).join("")).toBe(done.assistant.content);
    expect(done).toMatchObject({ ok: true, user: { content: "long" } });
    expect(done.assistant.error).toBeUndefined();
    expect(modelStore.get(done.call.id)).toMatchObject({ status: "ok" });
    expect((await call("GET", `/api/chat/threads/${thread.id}/turn`)).status).toBe(404);
    expect(((await (await call("GET", `/api/chat/threads/${thread.id}`)).json()) as any).running).toBe(false);
  });

  test("without a request id the turn still ends with its connection, stored as aborted", async () => {
    const thread = await newThread();
    process.env.FAKE_MODEL_MODE = "slow";
    await postAndLeave(thread.id, { message: "long" });
    for (let i = 0; i < 50 && service.isRunning(thread.id); i++) await Bun.sleep(20);
    const [, answer] = store.listMessages(thread.id);
    expect(answer).toMatchObject({ role: "assistant", error: "aborted", content: "answer to:" });
    expect(answer!.state).toBeUndefined();
  });

  test("a repeated request id is the same turn: no second message, no second model call", async () => {
    const thread = await newThread();
    const body = { message: "once", requestId: rid(2) };
    const a = (await (await call("POST", `/api/chat/threads/${thread.id}/turn?stream=0`, body)).json()) as any;
    const b = (await (await call("POST", `/api/chat/threads/${thread.id}/turn?stream=0`, body)).json()) as any;
    expect(b.user.id).toBe(a.user.id);
    expect(b.assistant).toEqual(a.assistant);
    const streamed = parseSse(await (await call("POST", `/api/chat/threads/${thread.id}/turn`, body)).text());
    expect(streamed.map((e) => e.event)).toEqual(["start", "done"]);
    expect(streamed[1]!.data.assistant.id).toBe(a.assistant.id);
    expect(store.listMessages(thread.id).length).toBe(2);
    expect(modelStore.list({ app: "notes" }).length).toBe(1);

    // While it runs, a repeat joins the turn instead of being refused as a second one.
    process.env.FAKE_MODEL_MODE = "slow";
    const slow = { message: "twice", requestId: rid(3) };
    const p = call("POST", `/api/chat/threads/${thread.id}/turn?stream=0`, slow);
    await Bun.sleep(150);
    const joining = call("POST", `/api/chat/threads/${thread.id}/turn`, slow);
    expect((await call("POST", `/api/chat/threads/${thread.id}/turn?stream=0`, { message: "other", requestId: rid(4) })).status).toBe(409);
    const joined = parseSse(await (await joining).text());
    const original = (await (await p).json()) as any;
    expect(joined.at(-1)!.data.assistant.id).toBe(original.assistant.id);
    expect(joined.filter((e) => e.event === "delta").map((e) => e.data.text).join("")).toBe(original.assistant.content);
    expect(store.listMessages(thread.id).length).toBe(4);
    expect((await call("POST", `/api/chat/threads/${thread.id}/turn`, { message: "x", requestId: "short" })).status).toBe(400);
  });

  test("stop ends the answer as stopped, with what arrived; the pair is left out of the next replay", async () => {
    const thread = await newThread();
    process.env.FAKE_MODEL_MODE = "slow";
    process.env.FAKE_MODEL_DELAY_MS = "5000";
    try {
      const res = await call("POST", `/api/chat/threads/${thread.id}/turn`, { message: "stop me", requestId: rid(5) });
      const reader = res.body!.getReader();
      let text = "";
      const pump = (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          text += new TextDecoder().decode(value);
        }
      })();
      for (let i = 0; i < 100 && !text.includes("event: delta"); i++) await Bun.sleep(20);
      expect(await (await call("POST", `/api/chat/threads/${thread.id}/stop`)).json()).toEqual({ ok: true, stopped: true });
      await pump;
      const last = parseSse(text).at(-1)!;
      expect(last.event).toBe("error");
      expect(last.data).toMatchObject({ ok: false, error: "stopped", assistant: { state: "stopped", error: "stopped", content: "answer to:" } });
      expect(await (await call("POST", `/api/chat/threads/${thread.id}/stop`)).json()).toEqual({ ok: true, stopped: false });
      expect((await call("POST", `/api/chat/threads/${thread.id}/stop`, undefined, "sat_cal")).status).toBe(404);
    } finally {
      delete process.env.FAKE_MODEL_DELAY_MS;
    }
    delete process.env.FAKE_MODEL_MODE;
    const next = (await (await call("POST", `/api/chat/threads/${thread.id}/turn?stream=0`, { message: "after" })).json()) as any;
    expect(next.assistant.content).not.toContain("stop me");
  });

  test("a turn a restart cut is settled as interrupted with the text it had saved", async () => {
    const thread = await newThread();
    const user = store.addMessage(thread.id, { role: "user", content: "cut" });
    const record = store.addTurn({ app: "notes", threadId: thread.id, userMessageId: user.id, requestId: rid(6) });
    store.savePartial(record.id, "half an ans");
    expect(service.settleInterrupted()).toBe(1);
    expect(service.settleInterrupted()).toBe(0);
    const detail = (await (await call("GET", `/api/chat/threads/${thread.id}`)).json()) as any;
    expect(detail.running).toBe(false);
    expect(detail.messages[1]).toMatchObject({ role: "assistant", content: "half an ans", state: "interrupted" });
    expect(detail.messages[1].error).toStartWith("interrupted");
    expect(store.getTurn(record.id)).toMatchObject({ status: "interrupted", assistantMessageId: detail.messages[1].id, partial: "" });
    // The client that asked comes back with the same id and is told what happened, without a second run.
    const back = (await (await call("POST", `/api/chat/threads/${thread.id}/turn?stream=0`, { message: "cut", requestId: rid(6) })).json()) as any;
    expect(back).toMatchObject({ ok: false, assistant: { id: detail.messages[1].id, state: "interrupted" } });
    expect(modelStore.list({ app: "notes" }).length).toBe(0);
    const next = (await (await call("POST", `/api/chat/threads/${thread.id}/turn?stream=0`, { message: "after" })).json()) as any;
    expect(next.assistant.content).not.toContain("[user]\ncut");
  });

  test("a turn in flight is not settled, and a thread's turns go with it", async () => {
    const thread = await newThread();
    process.env.FAKE_MODEL_MODE = "slow";
    const p = call("POST", `/api/chat/threads/${thread.id}/turn?stream=0`, { message: "busy", requestId: rid(7) });
    await Bun.sleep(150);
    expect(service.settleInterrupted()).toBe(0);
    expect(((await (await p).json()) as any).ok).toBe(true);
    await call("DELETE", `/api/chat/threads/${thread.id}`);
    expect(store.findTurn(thread.id, rid(7))).toBeUndefined();
  });
});

describe("attachments", () => {
  test("a person's message says how many earlier images its turn did not ship", async () => {
    const { thread } = (await (await call("POST", "/api/chat/threads", { scope: "s" })).json()) as any;
    const send = async (n: number) => {
      const ids: number[] = [];
      for (let i = 0; i < n; i++) ids.push(((await (await upload(thread.id, PNG, `p${i}.png`)).json()) as any).attachment.id);
      return (await (await call("POST", `/api/chat/threads/${thread.id}/turn?stream=0`, { message: `${n} images`, attachments: ids })).json()) as any;
    };
    expect((await send(4)).user.omitted).toBeUndefined();
    expect((await send(4)).user.omitted).toBeUndefined();
    const third = await send(2);
    expect(third.user.omitted).toBe(2);
    const detail = (await (await call("GET", `/api/chat/threads/${thread.id}`)).json()) as any;
    expect(detail.messages.filter((m: any) => m.role === "user").map((m: any) => m.omitted ?? 0)).toEqual([0, 0, 2]);
  });

  test("upload, then a turn ships the file to the runtime and the message shows it", async () => {
    const { thread } = (await (await call("POST", "/api/chat/threads", { scope: "s" })).json()) as any;
    const up = await upload(thread.id, PNG);
    expect(up.status).toBe(201);
    const { attachment } = (await up.json()) as any;
    expect(attachment).toMatchObject({ name: "shot.png", type: "image/png", size: PNG.byteLength, url: `/api/chat/attachments/${attachment.id}` });
    const img = await call("GET", `/api/chat/attachments/${attachment.id}`);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(PNG);
    expect((await call("GET", `/api/chat/attachments/${attachment.id}`, undefined, "sat_cal")).status).toBe(404);

    const r = (await (await call("POST", `/api/chat/threads/${thread.id}/turn?stream=0`, { message: "看图", attachments: [attachment.id] })).json()) as any;
    expect(r.ok).toBe(true);
    expect(r.user.attachments).toEqual([attachment]);
    expect(r.assistant.content).toContain(`[user]\n看图\n(attached: a${attachment.id}.png)`);
    expect(r.assistant.content).toContain("--tools Read --allowedTools Read");
    expect(r.assistant.content).toContain(`[files: a${attachment.id}.png=${PNG.byteLength}]`);
    // The same upload cannot be sent twice.
    expect((await call("POST", `/api/chat/threads/${thread.id}/turn?stream=0`, { message: "again", attachments: [attachment.id] })).status).toBe(400);
  });

  test("not an image is 415; a huge upload is 413; deleting the thread removes the file", async () => {
    const { thread } = (await (await call("POST", "/api/chat/threads", { scope: "s" })).json()) as any;
    expect((await upload(thread.id, new TextEncoder().encode("hello world, not an image"))).status).toBe(415);
    const big = new Uint8Array(5 * 1024 * 1024 + 10);
    big.set(PNG);
    expect((await upload(thread.id, big)).status).toBe(413);
    const { attachment } = (await (await upload(thread.id, PNG)).json()) as any;
    const path = store.getAttachment("notes", attachment.id)!.path;
    expect(await Bun.file(path).exists()).toBe(true);
    await call("DELETE", `/api/chat/threads/${thread.id}`);
    expect(await Bun.file(path).exists()).toBe(false);
  });
});

describe("widget", () => {
  test("served with an etag; 304 when unchanged", async () => {
    const res = await fetch(`${base}/api/chat/widget.js`);
    expect(res.headers.get("content-type")).toStartWith("application/javascript");
    expect(await res.text()).toBe("window.SpaceChat={}");
    expect((await fetch(`${base}/api/chat/widget.js`, { headers: { "if-none-match": '"w1"' } })).status).toBe(304);
    expect(await (await fetch(`${base}/api/chat/widget.css`)).text()).toBe(".sc{}");
  });
});


test("chat inherits a changed workspace default and preserves explicit request models", async () => {
  const { thread } = await (await call("POST", "/api/chat/threads", { scope: "note:1" })).json() as any;
  for (const [preference, explicit, expected] of [["haiku", undefined, "haiku"], ["sonnet", undefined, "sonnet"], ["sonnet", "opus", "opus"]]) {
    defaultModel = preference!;
    const response = await call("POST", `/api/chat/threads/${thread.id}/turn`, { message: "hello", model: explicit });
    const done = parseSse(await response.text()).find((e) => e.event === "done");
    expect(done?.data.assistant.model).toBe(expected);
  }
});

describe("model choice", () => {
  test("the picker lists runtime/tier options with concrete models; the choice is stored per app and validated", async () => {
    const view = (await (await call("GET", "/api/chat/models")).json()) as any;
    expect(view.options).toContainEqual({ value: "claude/basic", runtime: "claude", tier: "basic", model: "haiku" });
    expect(view.options).toContainEqual({ value: "claude/advanced", runtime: "claude", tier: "advanced", model: "fable" });
    expect(view).toMatchObject({ choice: null, appModel: null, defaultModel: "haiku", effective: { value: "haiku", source: "default", runtime: "claude", model: "haiku" } });
    expect(view.fallback).toEqual(view.effective);

    const saved = (await (await call("PUT", "/api/chat/model", { model: "claude/intermediate" })).json()) as any;
    expect(saved).toMatchObject({ choice: "claude/intermediate", effective: { value: "claude/intermediate", source: "choice", model: "opus" } });
    // Per app: another app's token does not see it.
    expect(((await (await call("GET", "/api/chat/models", undefined, "sat_cal")).json()) as any).choice).toBeNull();
    expect((await (await call("GET", "/api/chat/models?model=sonnet")).json()) as any).toMatchObject({ appModel: "sonnet", effective: { source: "choice", model: "opus" }, fallback: { source: "app", model: "sonnet" } });

    expect((await call("PUT", "/api/chat/model", { model: "missing/basic" })).status).toBe(400);
    expect((await call("PUT", "/api/chat/model", { model: "bad model" })).status).toBe(400);
    expect((await call("PUT", "/api/chat/model", {})).status).toBe(400);
    expect((await call("PUT", "/api/chat/model", { model: "claude/basic" }, "nope")).status).toBe(401);
    expect((await call("GET", "/api/chat/models?model=bad%20model")).status).toBe(400);
    expect(store.getModelChoice("notes")).toBe("claude/intermediate");

    const cleared = (await (await call("PUT", "/api/chat/model", { model: null })).json()) as any;
    expect(cleared).toMatchObject({ choice: null, effective: { source: "default", model: "haiku" } });
    // The operator names the app.
    expect((await call("PUT", "/api/chat/model", { app: "cal", model: "claude/junior" }, "op-token")).status).toBe(200);
    expect(store.getModelChoice("cal")).toBe("claude/junior");
  });

  test("a turn runs on the person's choice > the app's model > the space default", async () => {
    const { thread } = (await (await call("POST", "/api/chat/threads", { scope: "note:1" })).json()) as any;
    const turn = async (model?: string) => {
      const r = (await (await call("POST", `/api/chat/threads/${thread.id}/turn?stream=0`, { message: "hi", ...(model ? { model } : {}) })).json()) as any;
      expect(modelStore.get(r.call.id)?.model).toBe(r.assistant.model);
      return r.assistant.model;
    };
    defaultModel = "sonnet";
    expect(await turn()).toBe("sonnet");
    expect(await turn("opus")).toBe("opus");
    await call("PUT", "/api/chat/model", { model: "claude/basic" });
    expect(await turn()).toBe("haiku");
    expect(await turn("opus")).toBe("haiku");
    await call("PUT", "/api/chat/model", { model: null });
    expect(await turn("opus")).toBe("opus");
  });

  test("a stored choice that no longer resolves is skipped and reported", async () => {
    store.setModelChoice("notes", "gone/basic");
    const view = (await (await call("GET", "/api/chat/models?model=opus")).json()) as any;
    expect(view).toMatchObject({ choice: "gone/basic", choiceUnavailable: true, effective: { value: "opus", source: "app" } });
    expect(service.effectiveModel("notes").source).toBe("default");
  });
});
