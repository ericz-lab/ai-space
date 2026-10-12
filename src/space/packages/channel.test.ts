import { expect, test } from "bun:test";
import { PackageChannel } from "./channel.ts";

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
  await expect(c.request({})).rejects.toThrow(/unavailable/);
});
