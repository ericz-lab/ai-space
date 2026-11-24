import { expect, test } from "bun:test";
import { shortcutOffer, shortcutsRunHref } from "./shortcuts.ts";

const todo = {
  id: "ai-todo/create",
  title: "Create todo",
  available: true,
  inputs: [
    { name: "title", type: "text", label: "Title" },
    { name: "dueDate", type: "date", label: "Date" },
  ],
  i18n: { "zh-CN": { title: "新建待办", inputs: { title: "标题" } } },
};
const answer = (intent: object, extra: object = {}) => ({ ok: true, intents: [intent], agentIntents: [], ambiguous: false, ...extra });

test("an action named at the start is offered with what the sentence filled", () => {
  const strong = { kind: "action", key: "ai-todo/create", strong: true, action: todo, args: { title: "写周报", dueDate: "tomorrow", extra: 1 } };
  expect(shortcutOffer(answer(strong), "zh", "计算器")).toEqual({ title: "新建待办", detail: "标题: 写周报 · Date: tomorrow" });
  expect(shortcutOffer(answer(strong), "en", "Calculator")).toEqual({ title: "Create todo", detail: "Title: 写周报 · Date: tomorrow" });
  // A loose match, an ambiguous sentence, a matched agent skill or an action that cannot run: nothing.
  expect(shortcutOffer(answer({ ...strong, strong: false }), "en", "Calculator")).toBeNull();
  expect(shortcutOffer(answer(strong, { ambiguous: true }), "en", "Calculator")).toBeNull();
  expect(shortcutOffer(answer(strong, { agentIntents: [{ id: "x" }] }), "en", "Calculator")).toBeNull();
  expect(shortcutOffer(answer({ ...strong, action: { ...todo, available: false } }), "en", "Calculator")).toBeNull();
});

test("arithmetic is the calculator; an answer it does not understand offers nothing", () => {
  expect(shortcutOffer(answer({ kind: "calc", key: "calc", expression: "1+2" }), "en", "Calculator")).toEqual({ title: "Calculator", detail: "1+2" });
  expect(shortcutOffer({ ok: true, intents: [] }, "en", "Calculator")).toBeNull();
  expect(shortcutOffer(answer({ kind: "later" }), "en", "Calculator")).toBeNull();
  expect(shortcutOffer("nonsense", "en", "Calculator")).toBeNull();
});

test("the page the box opens carries the sentence", () => {
  expect(shortcutsRunHref("待办 写周报")).toBe("/?page=shortcuts&run=%E5%BE%85%E5%8A%9E%20%E5%86%99%E5%91%A8%E6%8A%A5");
});
