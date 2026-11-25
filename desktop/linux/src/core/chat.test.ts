import { describe, expect, test } from "bun:test";
import { type ChatImage, MAX_IMAGES, handOver } from "./chat.ts";

const img = (name: string, bytes = 3): ChatImage => ({ name, mediaType: "image/png", data: "A".repeat((bytes / 3) * 4) });

describe("a draft handed to another field", () => {
  test("goes into an empty field as it is", () => {
    expect(handOver({ text: "", images: [] }, { text: "hello", images: [img("a")] })).toEqual({ text: "hello", images: [img("a")] });
  });

  test("goes after what the field already holds, never over it", () => {
    expect(handOver({ text: "my notes  \n", images: [img("x")] }, { text: "the question", images: [img("a")] })).toEqual({ text: "my notes\nthe question", images: [img("x"), img("a")] });
    expect(handOver({ text: "kept", images: [] }, { text: "   ", images: [] })).toEqual({ text: "kept", images: [] });
  });

  test("its pictures stop at the Space's limits", () => {
    const four = Array.from({ length: MAX_IMAGES }, (_, i) => img(`m${i}`));
    expect(handOver({ text: "", images: four.slice(0, 3) }, { text: "", images: [img("a"), img("b")] }).images.map((i) => i.name)).toEqual(["m0", "m1", "m2", "a"]);
    const big = img("big", 6 * 1024 * 1024);
    expect(handOver({ text: "", images: [img("small", 6 * 1024 * 1024)] }, { text: "", images: [big] }).images.map((i) => i.name)).toEqual(["small"]);
  });
});
