import { expect, test } from "bun:test";
import { buildPrompt, countUnits, parseInterpretation, wantsInterpretation } from "./interpret.ts";
import type { Action } from "./types.ts";

const todo: Action = {
  id: "todo/create", app: "todo", builtin: false, title: "Todo", keywords: ["todo"], effect: "write", result: "receipt", available: true,
  i18n: { zh: { title: "待办" } },
  inputs: [
    { name: "title", label: "Title", type: "text", query: true, required: true },
    { name: "date", label: "Date", type: "date" },
    { name: "time", label: "Time", type: "time" },
    { name: "list", label: "List", type: "choice", options: [{ value: "work", label: "Work" }, { value: "home", label: "Home" }], default: "home" },
  ],
};
const off: Action = { ...todo, id: "notes/add", app: "notes", available: false };
const intents = [{ id: "financial-news", title: "Financial news" }];
const NOW = Date.parse("2026-11-23T03:00:00Z");

test("units: a run of Latin letters and digits is one, each other letter is one, punctuation and spaces none", () => {
  expect(countUnits("明天12点开会")).toBe(6);
  expect(countUnits("明天 12点开会")).toBe(6);
  expect(countUnits("tomorrow meeting at 12pm")).toBe(4);
  expect(countUnits("明天8点开会")).toBe(6);
  expect(countUnits("8点开会")).toBe(4);
  expect(countUnits("明天下午 15:30 写周报。")).toBe(8);
  expect(countUnits("帮我记一下明天下午3点写周报")).toBe(14);
  expect(countUnits("remind me to call 2026 mom")).toBe(6);
  expect(countUnits("meeting, at 3.5")).toBe(3);
  expect(countUnits("100.5 美元")).toBe(3);
  expect(countUnits("  ，。！ ")).toBe(0);
});

test("six units for Chinese or mixed text, four words for English, never arithmetic or a conversion", () => {
  expect(wantsInterpretation("明天8点开会")).toBe(true);
  expect(wantsInterpretation("明天12点开会")).toBe(true);
  expect(wantsInterpretation("8点开会")).toBe(false);
  expect(wantsInterpretation("明天开会")).toBe(false);
  expect(wantsInterpretation("tomorrow meeting at 12pm")).toBe(true);
  expect(wantsInterpretation("meeting at 12pm")).toBe(false);
  expect(wantsInterpretation("明天 meeting at 3pm")).toBe(false);
  expect(wantsInterpretation("明天上午 meeting at 3pm")).toBe(true);
  expect(wantsInterpretation("1 + 2 + 3 + 4 + 5 + 6 + 7 + 8 + 9")).toBe(false);
  expect(wantsInterpretation("1000000美元换成人民币")).toBe(false);
});

test("the prompt names the zone's date, the available actions and the agents", () => {
  const p = buildPrompt("帮我记一下明天下午3点写周报", [todo, off], intents, "Asia/Seoul", NOW);
  expect(p).toContain("2026-11-23");
  expect(p).toContain("Asia/Seoul");
  expect(p).toContain('"id":"todo/create"');
  expect(p).toContain("Todo / 待办");
  expect(p).not.toContain("notes/add");
  expect(p).toContain('"id":"financial-news"');
  expect(p.endsWith("帮我记一下明天下午3点写周报")).toBe(true);
});

test("an action answer fills only what the form accepts", () => {
  const answer = 'Sure:\n```json\n{"kind":"action","id":"todo/create","args":{"title":"写周报","date":"tomorrow","time":"15:00","list":"work","bogus":"x"}}\n```';
  expect(parseInterpretation(answer, [todo], intents, "Asia/Seoul", NOW)).toMatchObject({
    kind: "action", key: "model:todo/create", action: { id: "todo/create" }, args: { title: "写周报", date: "tomorrow", time: "15:00", list: "work" },
  });
  const bad = parseInterpretation('{"kind":"action","id":"todo/create","args":{"title":"写周报","time":"25:99","date":"someday","list":"garden"}}', [todo], intents, "Asia/Seoul", NOW);
  expect(bad?.kind === "action" && bad.args).toEqual({ title: "写周报", list: "home" });
});

test("unknown ids, unavailable actions, none and garbage are no suggestion", () => {
  expect(parseInterpretation('{"kind":"agent","id":"financial-news"}', [todo], intents, "UTC", NOW)).toEqual({ kind: "agent", id: "financial-news" });
  expect(parseInterpretation('{"kind":"agent","id":"other"}', [todo], intents, "UTC", NOW)).toBeNull();
  expect(parseInterpretation('{"kind":"action","id":"notes/add","args":{}}', [todo, off], intents, "UTC", NOW)).toBeNull();
  expect(parseInterpretation('{"kind":"none"}', [todo], intents, "UTC", NOW)).toBeNull();
  expect(parseInterpretation("I am not sure.", [todo], intents, "UTC", NOW)).toBeNull();
  expect(parseInterpretation("{not json}", [todo], intents, "UTC", NOW)).toBeNull();
});
