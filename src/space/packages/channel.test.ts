import { expect, test } from "bun:test";
import { rejection } from "../testing.ts";
import { PackageChannel, REFUSED_HEADER, type ChannelOptions } from "./channel.ts";

test("bidirectional requests stream bodies larger than a frame with bounded credit", async () => {
  let a: PackageChannel, b: PackageChannel;
  let max = 0;
  a = new PackageChannel((text) => { max = Math.max(max, text.length); queueMicrotask(() => b.receive(text)); }, async (_meta, body) => new Response(await new Response(body).text()), "a");
  b = new PackageChannel((text) => { max = Math.max(max, text.length); queueMicrotask(() => a.receive(text)); }, async (_meta, body) => new Response(await new Response(body).text()), "b");
  try {
    const text = "x".repeat(256 * 1024);
    const [first, second] = await Promise.all([a.request({}, new Response(text).body), b.request({}, new Response("reverse").body)]);
    expect(await first.text()).toBe(text);
    expect(await second.text()).toBe("reverse");
    expect(max).toBeLessThan(64 * 1024);
  } finally { a.close(); b.close(); }
});

test("closing a connection aborts pending requests and streaming bodies", async () => {
  let a: PackageChannel, b: PackageChannel;
  a = new PackageChannel((t) => queueMicrotask(() => b.receive(t)), async () => new Response(), "a");
  let aborted = false;
  b = new PackageChannel((t) => queueMicrotask(() => a.receive(t)), async (_meta, _body, signal) => {
    signal.addEventListener("abort", () => { aborted = true; });
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("start")); } }));
  }, "b");
  const response = await a.request({});
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("start");
  a.close("revoked"); b.close("revoked");
  await expect(reader.read()).rejects.toThrow(/revoked/);
  expect(aborted).toBe(true);
});

test("rejects invalid frames and further requests on a failed channel", async () => {
  const c = new PackageChannel(() => {}, async () => new Response(), "a");
  c.receive('{"kind":"open","id":"../bad"}');
  expect((await rejection(c.request({})))?.message).toMatch(/unavailable/);
});

/** Two channel ends wired to each other through microtasks, each with its own handler, limits and classifier. */
function pair(opts: { a?: ChannelOptions; b?: ChannelOptions; handleA?: Handler; handleB?: Handler } = {}) {
  let a: PackageChannel, b: PackageChannel;
  const closed: string[] = [];
  a = new PackageChannel((t) => queueMicrotask(() => b.receive(t)), opts.handleA ?? (async () => new Response("a")), "a", () => closed.push("a"), opts.a);
  b = new PackageChannel((t) => queueMicrotask(() => a.receive(t)), opts.handleB ?? (async () => new Response("b")), "b", () => closed.push("b"), opts.b);
  return { a, b, closed, close: () => { a.close(); b.close(); } };
}
type Handler = (meta: unknown, body: ReadableStream<Uint8Array>, signal: AbortSignal) => Promise<Response>;
/** A body that sends one chunk and then stays open until it is cancelled. */
const open = (signal?: AbortSignal, onAbort?: () => void) => {
  signal?.addEventListener("abort", () => onAbort?.());
  return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("start")); } }));
};
const byApp = (meta: unknown) => { const app = (meta as { app?: unknown } | null)?.app; return typeof app === "string" ? `app:${app}` : undefined; };
const tick = () => new Promise((r) => setTimeout(r, 0));

test("the streams a side opens and the ones it accepts have separate budgets", async () => {
  const p = pair({ a: { limits: { opened: 2, accepted: 2 } }, handleA: async (_m, _b, s) => open(s), handleB: async (_m, _b, s) => open(s) });
  try {
    const mine = [await p.a.request({}), await p.a.request({})];
    // A third of A's own: refused here, without a frame, and the channel stays up.
    const third = await p.a.request({});
    expect(third.status).toBe(503);
    expect(third.headers.get(REFUSED_HEADER)).toMatch(/2 opened/);
    expect(await third.json()).toMatchObject({ ok: false, error: expect.stringMatching(/stream limit/) });
    // B can still open its two to A: A's accepted budget is its own.
    const theirs = [await p.b.request({}), await p.b.request({})];
    expect(theirs.map((r) => r.status)).toEqual([200, 200]);
    expect(p.a.counts()).toEqual({ opened: 2, accepted: 2 });
    for (const r of [...mine, ...theirs]) await r.body!.cancel();
    await tick(); await tick();
    expect(p.a.counts()).toEqual({ opened: 0, accepted: 0 });
    expect((await p.a.request({})).status).toBe(200);
    expect(p.closed).toEqual([]);
  } finally { p.close(); }
});

test("a request over the other side's budget is refused with a 503 on its own stream; the channel stays up", async () => {
  let handled = 0;
  const p = pair({ b: { limits: { accepted: 1 } }, handleB: async (_m, _b, s) => { handled++; return open(s); } });
  try {
    const first = await p.a.request({});
    const second = await p.a.request({}, new Response("a body the refusal never reads").body);
    expect(second.status).toBe(503);
    expect(second.headers.get(REFUSED_HEADER)).toMatch(/1 accepted/);
    expect(await second.json()).toMatchObject({ ok: false });
    expect(handled).toBe(1);
    await tick();
    // The refused stream left no state on either side.
    expect(p.a.counts()).toEqual({ opened: 1, accepted: 0 });
    expect(p.b.counts()).toEqual({ opened: 0, accepted: 1 });
    await first.body!.cancel(); await tick(); await tick();
    const again = (await p.a.request({})).body!.getReader();
    expect(new TextDecoder().decode((await again.read()).value)).toBe("start");
    await again.cancel();
    expect(p.closed).toEqual([]);
  } finally { p.close(); }
});

test("one consumer is capped per kind; another consumer still gets through", async () => {
  const p = pair({ a: { classify: byApp }, b: { classify: byApp, limits: { perKind: 2 } }, handleB: async (_m, _b, s) => open(s) });
  try {
    const held = [await p.a.request({ app: "chatty" }), await p.a.request({ app: "chatty" })];
    const over = await p.a.request({ app: "chatty" });
    expect(over.status).toBe(503);
    expect(over.headers.get(REFUSED_HEADER)).toMatch(/app:chatty/);
    expect((await p.a.request({ app: "quiet" })).status).toBe(200);
    // Ending one kind's streams leaves the others.
    expect(p.b.cancelKinds(["app:chatty"])).toBe(2);
    for (const r of held) expect((await rejection(r.text()))?.message).toMatch(/cancel/);
    expect(p.b.counts().accepted).toBe(1);
  } finally { p.close(); }
});

test("a reply nobody reads releases its slots on both sides after the credit idle time", async () => {
  const p = pair({ b: { limits: { creditIdleMs: 50 } }, handleB: async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("never read")); } })) });
  try {
    const unread = await p.a.request({});
    expect(unread.status).toBe(200);
    expect(p.a.counts().opened).toBe(1);
    await Bun.sleep(120);
    expect(p.b.counts().accepted).toBe(0);
    expect(p.a.counts().opened).toBe(0);
    expect((await rejection(unread.text()))?.message).toMatch(/cancelled/);
  } finally { p.close(); }
});

test("a quiet stream that is being read is not cut by the credit idle time", async () => {
  let push!: (s: string) => void;
  const p = pair({ b: { limits: { creditIdleMs: 30 } }, handleB: async () => new Response(new ReadableStream({ start(c) { push = (s) => c.enqueue(new TextEncoder().encode(s)); c.enqueue(new TextEncoder().encode("hello")); } })) });
  try {
    const reader = (await p.a.request({})).body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("hello");
    const next = reader.read();
    await Bun.sleep(120); // quiet: B waits for data, not for credit
    push("later");
    expect(new TextDecoder().decode((await next).value)).toBe("later");
    expect(p.b.counts().accepted).toBe(1);
    await reader.cancel();
  } finally { p.close(); }
});
