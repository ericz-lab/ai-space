import { afterEach, expect, test } from "bun:test";
import { agentPath, followRun, historyBeforeRun, postAnswer, SseParser } from "./run-follow.ts";

test("the parser joins split chunks, skips comments and drops events already seen", () => {
  const p = new SseParser();
  expect(p.push(": keepalive\n\nid: 1\ndata: {\"type\":\"a\"}\n\nid: 2\nda")).toEqual([{ type: "a" }]);
  expect(p.push("ta: {\"type\":\"b\"}\n\n")).toEqual([{ type: "b" }]);
  expect(p.lastSeq).toBe(2);
  // A reconnect replays from an older seq: what was seen is skipped, a broken line is ignored.
  p.reset();
  expect(p.push("id: 2\ndata: {\"type\":\"b\"}\n\nid: 3\ndata: {nope\n\nid: 4\ndata: {\"type\":\"done\"}\n\n")).toEqual([{ type: "done" }]);
  expect(p.lastSeq).toBe(4);
  // Lines without an id (the closing error and done) always pass.
  expect(p.push("data: {\"type\":\"done\"}\n\n")).toEqual([{ type: "done" }]);
});

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const sse = (text: string) => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } }), { headers: { "content-type": "text/event-stream" } });

test("following a run reattaches after the last seq when the stream drops, until done", async () => {
  const urls: string[] = [];
  const answers = [sse("id: 1\ndata: {\"type\":\"a\"}\n\n"), sse("id: 1\ndata: {\"type\":\"a\"}\n\nid: 2\ndata: {\"type\":\"b\"}\n\ndata: {\"type\":\"done\"}\n\n")];
  globalThis.fetch = (async (url: string) => { urls.push(url); return answers.shift()!; }) as unknown as typeof fetch;
  const seen: unknown[] = [];
  await followRun("/api/agents/space/director", "r 1", (ev) => seen.push(ev));
  expect(urls).toEqual(["/api/agents/space/director/runs/r%201/events?after=0", "/api/agents/space/director/runs/r%201/events?after=1"]);
  expect(seen).toEqual([{ type: "a" }, { type: "b" }, { type: "done" }]);
});

test("an unknown run rejects with the Space's reason; an answer reports a refusal", async () => {
  globalThis.fetch = (async () => Response.json({ ok: false, error: "unknown run" }, { status: 404 })) as unknown as typeof fetch;
  await expect(followRun("/api/x", "r", () => {})).rejects.toThrow("unknown run");
  globalThis.fetch = (async () => Response.json({ ok: false, error: "this request is no longer waiting for an answer" }, { status: 409 })) as unknown as typeof fetch;
  expect(await postAnswer("/api/x", "r", "q1", "allow")).toBe("this request is no longer waiting for an answer");
  let body = "";
  globalThis.fetch = (async (_u: string, init: RequestInit) => { body = String(init.body); return Response.json({ ok: true }); }) as unknown as typeof fetch;
  expect(await postAnswer("/api/x", "r", "q1", "allow", { a: ["Yes"] })).toBeNull();
  expect(JSON.parse(body)).toEqual({ decision: "allow", answers: { a: ["Yes"] } });
});

test("an agent's route base, here or on a peer", () => {
  expect(agentPath("space/engineer")).toBe("/api/agents/space/engineer");
  expect(agentPath("ai-design/designer", "hub")).toBe("/api/peers/hub/agents/ai-design/designer");
});

test("the transcript before a running turn is cut at the run's own message, wherever it stands", () => {
  const u = (text: string) => ({ role: "user", text });
  const ai = (text: string) => ({ role: "ai", text });
  const before = [u("〔Order #9〕 look"), ai("done #9"), u("〔Order #10〕 check"), ai("done #10")];
  // Not written yet: the whole history comes before the turn.
  expect(historyBeforeRun(before, "〔Order #11〕 fix")).toEqual(before);
  // Written with a first reply and a message steered in after it: cut at the run's message, not the last one.
  expect(historyBeforeRun([...before, u("〔Order #11〕 fix"), ai("on it"), u("〔Order #12〕 also")], "〔Order #11〕 fix")).toEqual(before);
  // The runtime was given a note before the message (chat cards' changes): still the run's message.
  expect(historyBeforeRun([...before, u("You changed: x\n\n〔Order #11〕 fix"), ai("on it")], " 〔Order #11〕 fix ")).toEqual(before);
  // A turn the agent started by itself has no message: nothing is cut.
  expect(historyBeforeRun(before, "")).toEqual(before);
  expect(historyBeforeRun(before, null)).toEqual(before);
});
