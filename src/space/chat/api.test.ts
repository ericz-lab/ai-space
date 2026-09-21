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

const TOKENS: Record<string, string> = { sat_notes: "notes", sat_cal: "cal" };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "space-chat-api-"));
  modelStore = new ModelStore(join(dir, "space.db"));
  store = new ChatStore(join(dir, "space.db"));
  const model = new ModelService({ store: modelStore, runtimes: claudeOnly(fakeModelBin()), maxConcurrency: 2, log: () => {} });
  service = new ChatService({ store, model, defaultModel: "haiku", fileDir: (app) => join(dir, app, "chat"), log: () => {} });
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
    expect(events.map((e) => e.event)).toEqual(["delta", "delta", "done"]);
    const done = events[2]!.data;
    expect(done.ok).toBe(true);
    expect(done.user).toMatchObject({ role: "user", content: "**第一问**\n第二行", attachments: [] });
    expect(done.assistant.role).toBe("assistant");
    expect(events.slice(0, 2).map((e) => e.data.text).join("")).toBe(done.assistant.content);
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

  test("validation: message, tools outside the chat set, too many attachments", async () => {
    const { thread } = (await (await call("POST", "/api/chat/threads", { scope: "s" })).json()) as any;
    expect((await call("POST", `/api/chat/threads/${thread.id}/turn`, { message: "  " })).status).toBe(400);
    expect((await call("POST", `/api/chat/threads/${thread.id}/turn`, { message: "x", tools: ["Bash(rm:*)"] })).status).toBe(400);
    expect((await call("POST", `/api/chat/threads/${thread.id}/turn`, { message: "x", attachments: [1, 2, 3, 4, 5] })).status).toBe(400);
    expect((await call("POST", `/api/chat/threads/${thread.id}/turn`, { message: "x", attachments: [999] })).status).toBe(400);
    expect(store.listMessages(thread.id)).toEqual([]);
  });
});

describe("attachments", () => {
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
