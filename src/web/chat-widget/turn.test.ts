import { describe, expect, test } from "bun:test";
import { followTurn, newRequestId, readTurn, turnBody } from "./turn.ts";

const sse = (...events: [string, unknown][]) => events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
const stream = (text: string, status = 200) => new Response(text, { status, headers: { "content-type": "text/event-stream" } });
const refusal = (status: number, error: string) => new Response(JSON.stringify({ ok: false, error }), { status, headers: { "content-type": "application/json" } });
/** A stream that sends what it is given and then breaks, like a connection that drops. */
const broken = (text: string) => {
  let sent = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent) return c.error(new Error("connection reset"));
        sent = true;
        c.enqueue(new TextEncoder().encode(text));
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
};
const never = new AbortController().signal;

describe("turnBody", () => {
  test("what the app's context says for this turn wins over the mount options, the timeout included", () => {
    const body = turnBody("hi", [3], "req-12345678", { system: "s", text: "", ack: "a", timeoutMs: 600_000, tools: ["WebSearch"] }, { timeoutMs: 300_000, model: "opus", thinking: 0, tools: ["Read"] });
    expect(body).toEqual({ message: "hi", attachments: [3], requestId: "req-12345678", context: { system: "s", text: "", ack: "a" }, model: "opus", tools: ["WebSearch"], thinking: 0, timeoutMs: 600_000 });
  });

  test("the mount options fill in what the context leaves out; nothing is sent for what neither says", () => {
    expect(turnBody("hi", [], "req-12345678", {}, { timeoutMs: 120_000 })).toEqual({ message: "hi", attachments: [], requestId: "req-12345678", context: {}, timeoutMs: 120_000 });
    expect(turnBody("hi", [], "req-12345678", {}, {})).toEqual({ message: "hi", attachments: [], requestId: "req-12345678", context: {} });
  });

  test("request ids are unique and fit the service's pattern", () => {
    const a = newRequestId();
    expect(a).not.toBe(newRequestId());
    expect(a).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,79}$/);
  });
});

describe("readTurn", () => {
  test("start, the text as it grows, then the result", async () => {
    const seen: string[] = [];
    const end = await readTurn(
      async () => stream(sse(["start", { user: { id: 7 } }], ["delta", { text: "he" }], ["delta", { text: "llo" }], ["done", { ok: true, assistant: { id: 8, content: "hello" } }])),
      never,
      { start: (i) => seen.push(`start:${i.user?.id}`), text: (t) => seen.push(t) },
    );
    expect(seen).toEqual(["start:7", "he", "hello"]);
    expect(end).toMatchObject({ kind: "final", final: { ok: true, assistant: { id: 8 } } });
  });

  test("a refusal is not a loss: nothing was started", async () => {
    expect(await readTurn(async () => refusal(409, "this thread is still answering"), never, { text: () => {} })).toEqual({ kind: "refused", status: 409, error: "this thread is still answering" });
  });

  test("a gateway error, a failed fetch and a stream that ends early are losses", async () => {
    expect((await readTurn(async () => refusal(502, "ai-space unreachable"), never, { text: () => {} })).kind).toBe("lost");
    expect((await readTurn(async () => { throw new TypeError("fetch failed"); }, never, { text: () => {} })).kind).toBe("lost");
    expect((await readTurn(async () => stream(sse(["start", {}], ["delta", { text: "x" }])), never, { text: () => {} })).kind).toBe("lost");
    expect((await readTurn(async () => broken(sse(["delta", { text: "x" }])), never, { text: () => {} })).kind).toBe("lost");
  });

  test("the reader's own signal is leaving, not a loss", async () => {
    const gone = new AbortController();
    gone.abort();
    expect(await readTurn(async () => { throw new DOMException("aborted", "AbortError"); }, gone.signal, { text: () => {} })).toEqual({ kind: "left" });
    expect(await readTurn(async () => stream(sse(["delta", { text: "x" }])), gone.signal, { text: () => {} })).toEqual({ kind: "left" });
  });
});

describe("followTurn", () => {
  const noSleep = async () => {};

  test("after a loss the stream is opened again and the text starts over from its first character", async () => {
    const texts: string[] = [];
    let opens = 0;
    const end = await followTurn(
      async () => (++opens === 1 ? broken(sse(["start", {}], ["delta", { text: "par" }])) : stream(sse(["start", {}], ["delta", { text: "part" }], ["delta", { text: "ial" }], ["done", { ok: true }]))),
      never,
      { text: (t) => texts.push(t), lost: (n) => texts.push(`lost:${n}`) },
      [10, 10],
      noSleep,
    );
    expect(opens).toBe(2);
    expect(texts).toEqual(["par", "lost:1", "part", "partial"]);
    expect(end.kind).toBe("final");
  });

  test("it gives up after the attempts it was given and reports the loss", async () => {
    let opens = 0;
    const end = await followTurn(async () => { opens++; throw new TypeError("offline"); }, never, { text: () => {} }, [1, 1], noSleep);
    expect(opens).toBe(3);
    expect(end).toEqual({ kind: "lost", error: "offline" });
  });

  test("a refusal is returned at once, and leaving during the wait ends it", async () => {
    let opens = 0;
    expect((await followTurn(async () => { opens++; return refusal(404, "this thread is not answering"); }, never, { text: () => {} }, [1, 1], noSleep)).kind).toBe("refused");
    expect(opens).toBe(1);
    const gone = new AbortController();
    const end = await followTurn(async () => { throw new TypeError("offline"); }, gone.signal, { text: () => {} }, [1, 1], async () => gone.abort());
    expect(end).toEqual({ kind: "left" });
  });
});
