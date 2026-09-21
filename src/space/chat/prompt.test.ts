import { describe, expect, test } from "bun:test";
import { alternate, buildPrompt, replayable } from "./prompt.ts";
import type { Attachment, Message } from "./types.ts";

const msg = (id: number, role: Message["role"], content: string, error?: string): Message => ({ id, threadId: 1, role, content, createdAt: id, ...(error ? { error } : {}) });
const att = (id: number, messageId: number, name = `p${id}.png`): Attachment => ({ id, app: "a", threadId: 1, messageId, name, type: "image/png", size: 10, path: `/x/${id}`, createdAt: id });
const fileName = (a: Attachment) => `a${a.id}.png`;

describe("replayable", () => {
  test("skips a failed answer and the message that caused it", () => {
    const out = replayable([msg(1, "user", "q1"), msg(2, "assistant", "partial", "timed out"), msg(3, "user", "q2"), msg(4, "assistant", "a2")]);
    expect(out).toEqual([{ role: "user", content: "q2" }, { role: "assistant", content: "a2" }]);
  });
});

describe("alternate", () => {
  test("merges neighbours with the same role, drops empties and a leading assistant turn", () => {
    expect(alternate([
      { role: "assistant", content: "stray" },
      { role: "user", content: "a" }, { role: "user", content: "b" },
      { role: "assistant", content: "  " }, { role: "assistant", content: "c" },
      { role: "user", content: "d" },
    ])).toEqual([{ role: "user", content: "a\n\nb" }, { role: "assistant", content: "c" }, { role: "user", content: "d" }]);
  });
});

describe("buildPrompt", () => {
  test("context first, then the ack, the history with attachment lines, the new message", () => {
    const history = [msg(1, "user", "看看这个"), msg(2, "assistant", "一张图"), msg(3, "user", "再看"), msg(4, "assistant", "好")];
    const attachments = new Map([[1, [att(10, 1, "old.png")]], [3, [att(11, 3)]]]);
    const p = buildPrompt({
      context: { text: "# 笔记\n\n正文", ack: "已读完。" }, history, attachments, shipped: new Set([11, 12]), fileName,
      message: "最后一问", messageAttachments: [att(12, 5)],
    });
    expect(p).toBe("# 笔记\n\n正文\n\n---\n\n[assistant]\n已读完。\n\n[user]\n看看这个\n(attached earlier: old.png — no longer visible)\n\n[assistant]\n一张图\n\n[user]\n再看\n(attached: a11.png)\n\n[assistant]\n好\n\n[user]\n最后一问\n(attached: a12.png)");
  });

  test("without context or history it is just the message", () => {
    expect(buildPrompt({ history: [], attachments: new Map(), shipped: new Set(), fileName, message: "hi", messageAttachments: [] })).toBe("[user]\nhi");
  });

  test("a long thread is trimmed from the oldest pair until it fits, never refused", () => {
    const history: Message[] = [];
    for (let i = 1; i <= 60; i++) history.push(msg(i, i % 2 ? "user" : "assistant", `m${i} ` + "x".repeat(100)));
    const p = buildPrompt({ history, attachments: new Map(), shipped: new Set(), fileName, message: "last", messageAttachments: [], limit: 800 });
    expect(p.length).toBeLessThanOrEqual(800);
    expect(p.endsWith("[user]\nlast")).toBe(true);
    expect(p.startsWith("[user]\n")).toBe(true);
    expect(p).toContain("m60 ");
  });
});
