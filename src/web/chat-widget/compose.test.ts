import { describe, expect, test } from "bun:test";
import { Drafts, giveBack, isSendKey, type DraftStorage } from "./compose.ts";

function memory(): DraftStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

describe("drafts", () => {
  test("one entry per scope and thread; the scope before its first thread has its own", () => {
    const d = new Drafts("p:");
    d.set("note:1", 4, "for thread 4");
    d.set("note:1", null, "before any thread");
    d.set("note:2", 4, "another scope");
    expect(d.get("note:1", 4)).toBe("for thread 4");
    expect(d.get("note:1", null)).toBe("before any thread");
    expect(d.get("note:2", 4)).toBe("another scope");
    expect(d.get("note:1", 5)).toBe("");
  });

  test("kept in the storage so a reload finds it; blank text forgets the entry", () => {
    const s = memory();
    new Drafts("p:", s).set("note:1", 4, "half a question");
    expect([...s.data]).toEqual([["p:note:1#4", "half a question"]]);
    expect(new Drafts("p:", s).get("note:1", 4)).toBe("half a question");
    const d = new Drafts("p:", s);
    d.set("note:1", 4, "  \n");
    expect(s.data.size).toBe(0);
    expect(d.get("note:1", 4)).toBe("");
  });

  test("a storage that throws is ignored; the page still has its copy", () => {
    const boom = () => {
      throw new Error("denied");
    };
    const d = new Drafts("p:", { getItem: boom, setItem: boom, removeItem: boom });
    expect(d.get("s", 1)).toBe("");
    d.set("s", 1, "kept");
    expect(d.get("s", 1)).toBe("kept");
  });
});

describe("giveBack", () => {
  test("a message that was never sent returns to the box, before what was typed since", () => {
    expect(giveBack("the question", "")).toBe("the question");
    expect(giveBack("the question", "  \n")).toBe("the question");
    expect(giveBack("the question", "typed since")).toBe("the question\ntyped since");
  });

  test("a retry took nothing from the box, so a retry that never starts leaves the box exactly as it is", () => {
    expect(giveBack("", "important new draft")).toBe("important new draft");
    expect(giveBack("", "")).toBe("");
  });
});

describe("isSendKey", () => {
  const key = (over: Partial<Parameters<typeof isSendKey>[0]>) => ({ key: "Enter", shiftKey: false, isComposing: false, keyCode: 13, ...over });

  test("Enter sends; Shift+Enter and other keys do not", () => {
    expect(isSendKey(key({}))).toBe(true);
    expect(isSendKey(key({ shiftKey: true }))).toBe(false);
    expect(isSendKey(key({ key: "a", keyCode: 65 }))).toBe(false);
  });

  test("Enter that confirms an input method's candidate does not send, in Chrome (isComposing) or Safari (key code 229)", () => {
    expect(isSendKey(key({ isComposing: true }))).toBe(false);
    expect(isSendKey(key({ keyCode: 229 }))).toBe(false);
  });
});
