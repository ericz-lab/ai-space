import { expect, test } from "bun:test";
import { chatBody, parseChatImages, MAX_CHAT_IMAGE_BYTES } from "./images.ts";
const image = { name: "screen.png", mediaType: "image/png", data: Buffer.from("\x89PNG\r\n\x1a\n", "latin1").toString("base64") };

test("chat images validate bytes, names, formats and budgets without accepting paths", () => {
  expect(parseChatImages([image])).toEqual([image]);
  expect(parseChatImages(undefined)).toEqual([]);
  for (const bad of [[{ ...image, data: "not base64!" }], [{ ...image, mediaType: "image/jpeg" }], [{ ...image, data: "PHN2Zz4=" }], [{ path: "/etc/passwd" }], Array(5).fill(image)]) {
    expect(() => parseChatImages(bad)).toThrow();
  }
  const bytes = Buffer.alloc(MAX_CHAT_IMAGE_BYTES, 0);
  Buffer.from("\x89PNG\r\n\x1a\n", "latin1").copy(bytes);
  const large = { ...image, data: bytes.toString("base64") };
  expect(parseChatImages([large, large])).toHaveLength(2);
  expect(() => parseChatImages([large, large, image])).toThrow(/10 MB/);
});

test("chat body bounds chunked data, validates JSON and preserves images", async () => {
  const body = { message: "", images: [image] };
  expect(await chatBody(new Request("http://space/chat", { method: "POST", body: JSON.stringify(body) }))).toEqual(body);
  const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(15 * 1024 * 1024 + 1)); c.close(); } });
  await expect(chatBody(new Request("http://space/chat", { method: "POST", body: stream }))).rejects.toThrow(/too large/);
  await expect(chatBody(new Request("http://space/chat", { method: "POST", body: "[]" }))).rejects.toThrow(/JSON/);
});
