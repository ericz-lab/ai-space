import { expect, test } from "bun:test";
import { parseProvidesSpec } from "../space/bus/spec.ts";
import type { Action } from "../space/shortcuts/types.ts";
import { complete, extractWhen, intents, parseConversion } from "./shortcuts.ts";

const NOW = Date.parse("2026-10-16T23:30:00Z"); // Saturday 17th in Seoul
const TZ = "Asia/Seoul";

const fromManifest = (app: string, provides: Record<string, unknown>): Action[] =>
  parseProvidesSpec(provides).map((c) => ({ ...c.action!, id: `${app}/${c.name}`, app, builtin: false, available: true }));

const ACTIONS: Action[] = [
  { id: "space/calc", app: "space", builtin: true, available: true, title: "Calculator", keywords: ["calc"], effect: "read", result: "value", inputs: [{ name: "expression", type: "text", label: "Expression", required: true, query: true }] },
  { id: "space/convert", app: "space", builtin: true, available: true, title: "Convert currency", keywords: ["fx"], effect: "read", result: "value", inputs: [] },
  { id: "space/run-task", app: "space", builtin: true, available: true, title: "Run task", keywords: ["run"], effect: "run", result: "task", inputs: [{ name: "task", type: "task", label: "Task", required: true, options: [{ value: "t1", label: "market-daily · daily-report" }, { value: "t2", label: "feed · news" }] }] },
  ...fromManifest("ai-todo", {
    create: { http: { path: "/c" }, action: { title: "Create todo", keywords: ["todo"], template: "todo", effect: "write", result: "receipt", inputs: [{ name: "title", type: "text", label: "Title", required: true, query: true }, { name: "dueDate", type: "date", label: "Date" }, { name: "dueTime", type: "time", label: "Time" }], i18n: { zh: { title: "新建待办", keywords: ["待办", "提醒我"] } } } },
  }),
  ...fromManifest("feed", {
    news: { http: { path: "/n" }, action: { title: "Financial news", keywords: ["news"], template: "news", result: "list", inputs: [{ name: "period", type: "period", label: "Period", default: "today" }, { name: "q", type: "text", label: "Topic", query: true }], i18n: { zh: { title: "财经新闻", keywords: ["新闻", "快讯"] } } } },
  }),
];

const keys = (q: string) => intents(q, ACTIONS, TZ, NOW).map((i) => `${i.kind}:${i.key}${i.kind === "action" && i.strong ? "!" : ""}`);

test("arithmetic and conversions are direct results and nothing else is offered", () => {
  expect(keys("128 * 3 + 56")).toEqual(["calc:calc"]);
  expect(keys("100 USD to CNY")).toEqual(["convert:convert"]);
  expect(intents("100美元换人民币", ACTIONS, TZ, NOW)[0]).toMatchObject({ args: { amount: 100, from: "USD", to: "CNY" } });
  expect(parseConversion("$100 in eur")).toEqual({ amount: 100, from: "USD", to: "EUR" });
  expect(parseConversion("1,000 jpy krw")).toEqual({ amount: 1000, from: "JPY", to: "KRW" });
  expect(parseConversion("100 USD to USD")).toBeNull();
  expect(parseConversion("100 apples to oranges")).toBeNull();
});

test("a keyword at the start is a strong match; the rest fills the query input with dates read out", () => {
  expect(keys("新闻 美联储")).toEqual(["action:feed/news!"]);
  expect(intents("新闻 本周 美联储", ACTIONS, TZ, NOW)[0]).toMatchObject({ args: { period: "this-week", q: "美联储" } });
  expect(intents("news", ACTIONS, TZ, NOW)[0]).toMatchObject({ args: { period: "today" } });
  const todo = intents("待办 明天下午3点 提交报告", ACTIONS, TZ, NOW)[0]!;
  expect(todo).toMatchObject({ key: "ai-todo/create", args: { title: "提交报告", dueDate: "tomorrow", dueTime: "15:00" } });
  expect(intents("提醒我后天 9:30 交周报", ACTIONS, TZ, NOW)[0]).toMatchObject({ args: { title: "交周报", dueDate: "2026-10-19", dueTime: "09:30" } });
  expect(intents("todo submit the report tomorrow 3pm", ACTIONS, TZ, NOW)[0]).toMatchObject({ args: { title: "submit the report", dueDate: "tomorrow", dueTime: "15:00" } });
  // A name that only starts with the text is a loose match, offered after the library's entries.
  expect(keys("create")).toEqual(["action:ai-todo/create!"]);
  expect(keys("odo")).toEqual(["action:ai-todo/create"]);
  expect(keys("todos")).toEqual([]);
});

test("tasks match by name; plain sentences match nothing", () => {
  expect(keys("daily-report")).toEqual(["action:task:t1!"]);
  expect(keys("market-daily · daily-report")).toEqual(["action:task:t1!"]);
  expect(keys("report")).toEqual(["action:task:t1"]);
  expect(keys("what is the weather like")).toEqual([]);
});

test("extractWhen leaves text without dates alone, and a time alone means today", () => {
  const inputs = ACTIONS[3]!.inputs;
  expect(extractWhen("Q3 report", inputs, TZ, NOW)).toEqual({ text: "Q3 report", args: {} });
  expect(extractWhen("call bank 18:00", inputs, TZ, NOW)).toEqual({ text: "call bank", args: { dueDate: "today", dueTime: "18:00" } });
  expect(extractWhen("ship 2026-11-02", inputs, TZ, NOW)).toEqual({ text: "ship", args: { dueDate: "2026-11-02" } });
});

test("complete wants every required input", () => {
  const todo = ACTIONS[3]!;
  expect(complete(todo, {})).toBe(false);
  expect(complete(todo, { title: "x" })).toBe(true);
});
