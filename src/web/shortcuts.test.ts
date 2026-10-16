import { expect, test } from "bun:test";
import { parseProvidesSpec } from "../space/bus/spec.ts";
import type { Action } from "../space/shortcuts/types.ts";
import { captureInput, complete, extractWhen, intents, parseConversion } from "./shortcuts.ts";

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
    news: { http: { path: "/n" }, action: { title: "Financial news", keywords: ["news"], template: "news", result: "list", inputs: [{ name: "period", type: "period", label: "Period", default: "today" }, { name: "q", type: "text", label: "Topic", query: true }], i18n: { zh: { title: "财经新闻", keywords: ["新闻", "金融新闻", "快讯"] } } } },
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

test("a localized news alias selects the action and preserves topic and period arguments", () => {
  expect(keys("金融新闻")).toEqual(["action:feed/news!"]);
  expect(intents("金融新闻", ACTIONS, TZ, NOW)[0]).toMatchObject({ args: { period: "today" } });
  for (const query of ["金融新闻 本周 美联储", "金融新闻本周美联储"]) {
    expect(intents(query, ACTIONS, TZ, NOW)[0]).toMatchObject({
      key: "feed/news", strong: true, args: { period: "this-week", q: "美联储" },
    });
  }
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

test("configured sentences normalize typed slots and keep existing query matching", () => {
  const news = { ...ACTIONS[4]!, patterns: ["[帮我][查|看看](金融新闻|财经新闻)[ {q}]", "查{period}的金融新闻[ {q}]"] };
  expect(intents("帮我查金融新闻 美联储", [news], TZ, NOW)[0]).toMatchObject({ kind: "action", strong: true, args: { period: "today", q: "美联储" } });
  expect(intents("查本周的金融新闻 美联储", [news], TZ, NOW)[0]).toMatchObject({ args: { period: "this-week", q: "美联储" } });
  expect(intents("查不知道的金融新闻", [news], TZ, NOW)).toEqual([]);
  expect(intents("新闻 美联储", [news], TZ, NOW)[0]).toMatchObject({ args: { period: "today", q: "美联储" } });
});

test("custom patterns are additive, deduplicated by normalized arguments and peer-aware", () => {
  const news = { ...ACTIONS[4]!, patterns: ["金融新闻[ {q}]"], customPatterns: ["金融新闻[ {q}]", "看新闻[ {q}]"] };
  expect(intents("金融新闻", [news], TZ, NOW)).toHaveLength(1);
  expect(intents("看新闻", [news], TZ, NOW)[0]).toMatchObject({ args: { period: "today" } });
  const both = intents("金融新闻", [news, { ...news, peer: "other" }], TZ, NOW);
  expect(both).toHaveLength(2);
  expect(both.every((i) => i.kind === "action" && i.ambiguous)).toBe(true);
  expect(new Set(both.map((i) => i.key)).size).toBe(2);
});

test("multiple captures never silently select a greedy interpretation", () => {
  const action = { ...ACTIONS[3]!, patterns: ["记{title}在{dueDate}"] };
  const result = intents("记开会在明天", [action], TZ, NOW);
  expect(result[0]).toMatchObject({ args: { title: "开会", dueDate: "tomorrow" }, action: { effect: "write" } });
  expect(intents("记开会在2026-02-30", [action], TZ, NOW)).toEqual([]);
  const split = { ...ACTIONS[3]!, patterns: ["记{title}给{other}"], inputs: [{ name: "title", label: "Title", type: "text" as const }, { name: "other", label: "Other", type: "text" as const }] };
  const ambiguous = intents("记甲给乙给丙", [split], TZ, NOW);
  expect(ambiguous).toHaveLength(2);
  expect(ambiguous.every((i) => i.kind === "action" && i.ambiguous)).toBe(true);
});

test("invalid peer patterns do not break search and calculations keep precedence", () => {
  const action = { ...ACTIONS[4]!, patterns: ["[invalid", "128 * 3 + 56"] };
  expect(intents("128 * 3 + 56", [action], TZ, NOW)[0]?.kind).toBe("calc");
  expect(intents("新闻", [action], TZ, NOW)[0]).toMatchObject({ kind: "action" });
});


test("typed captures enforce bounds, translated options, task identity and complete time values", () => {
  const action: Action = { ...ACTIONS[3]!, inputs: [
    { name: "amount", type: "number", label: "Amount", min: 1, max: 100 },
    { name: "at", type: "time", label: "Time" },
    { name: "scope", type: "choice", label: "Scope", options: [{ value: "all", label: "Everything" }] },
  ], i18n: { zh: { options: { all: "全部" } } } };
  expect(captureInput(action, "amount", "12.5", TZ, NOW)).toBe(12.5);
  for (const text of ["101", "0", "12 apples", "Infinity", "0x12"]) expect(captureInput(action, "amount", text, TZ, NOW)).toBeUndefined();
  expect(captureInput(action, "scope", "全部", TZ, NOW)).toBe("all");
  expect(captureInput(action, "scope", "everything", TZ, NOW)).toBe("all");
  expect(captureInput(action, "scope", "some", TZ, NOW)).toBeUndefined();
  expect(captureInput(action, "at", "下午3点半", TZ, NOW)).toBe("15:30");
  expect(captureInput(action, "at", "15:30", TZ, NOW)).toBe("15:30");
  expect(captureInput(action, "at", "99:99", TZ, NOW)).toBeUndefined();
  expect(captureInput(action, "at", "下午3点 abc", TZ, NOW)).toBeUndefined();
  expect(captureInput(ACTIONS[2]!, "task", "market-daily · daily-report", TZ, NOW)).toBe("t1");
});

test("query slots retain period extraction and explicit slots take precedence", () => {
  const action = { ...ACTIONS[4]!, patterns: ["金融新闻[ {q}]", "查{period}的新闻[ {q}]"] };
  expect(intents("金融新闻 本周 美联储", [action], TZ, NOW)[0]).toMatchObject({ args: { period: "this-week", q: "美联储" } });
  expect(intents("查明天的新闻 本周 美联储", [action], TZ, NOW)[0]).toMatchObject({ args: { period: "tomorrow", q: "美联储" } });
});
