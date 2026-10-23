import { compilePattern, matchPattern, type PatternMachine } from "./pattern.ts";
import { isExpression } from "./calc.ts";
import { addDays, dateIn, isDate, isTime, resolveDate, resolvePeriod } from "./time.ts";
import type { Action, ActionInput } from "./types.ts";
import { SCORE, score } from "./ranking.ts";
import { BACKUP_TASK, VERIFY_TASK } from "../storage/backup/tasks.ts";

export const actionKey = (a: { id: string; peer?: string }) => (a.peer ? `${a.peer}:${a.id}` : a.id);

// Deterministic input resolution shared by web and native clients. No execution or model calls.
/** Every name and keyword of an action, in every language. */
function words(a: Action): string[] {
  return [a.title, ...a.keywords, ...Object.values(a.i18n ?? {}).flatMap((t) => [t.title ?? "", ...(t.keywords ?? [])])].filter(Boolean);
}

// ---------------------------------------------------------------- currency

const CURRENCY_NAMES: Record<string, string> = {
  美元: "USD", 美金: "USD", 刀: "USD", 人民币: "CNY", 元: "CNY", 块: "CNY", rmb: "CNY", 港币: "HKD", 港元: "HKD", 港纸: "HKD",
  欧元: "EUR", 日元: "JPY", 日币: "JPY", 韩元: "KRW", 韩币: "KRW", 英镑: "GBP", 澳元: "AUD", 加元: "CAD", 新加坡元: "SGD", 新币: "SGD", 瑞郎: "CHF", 台币: "TWD", 新台币: "TWD",
  $: "USD", "¥": "CNY", "￥": "CNY", "€": "EUR", "£": "GBP", "₩": "KRW",
};

function currency(word: string): string | undefined {
  const w = word.trim();
  if (/^[A-Za-z]{3}$/.test(w)) return w.toUpperCase();
  return CURRENCY_NAMES[w.toLowerCase()] ?? CURRENCY_NAMES[w];
}

/** "100 USD to CNY", "100美元换人民币", "$100 in EUR", "100 usd cny": amount and two codes, or null. */
export function parseConversion(text: string): { amount: number; from: string; to: string } | null {
  const q = text.trim().replace(/，/g, ",");
  const names = Object.keys(CURRENCY_NAMES).map((n) => n.replace(/[$]/g, "\\$")).sort((a, b) => b.length - a.length).join("|");
  const cur = `(?:[A-Za-z]{3}|${names})`;
  const re = new RegExp(`^(${cur})?\\s*(\\d[\\d,]*(?:\\.\\d+)?)\\s*(${cur})?\\s*(?:to|in|into|=|->|→|换成|换|兑换成|兑换|兑|转|等于多少|是多少)?\\s*(${cur})\\s*[?？]?$`, "i");
  const m = re.exec(q);
  if (!m) return null;
  const from = currency(m[1] ?? m[3] ?? "");
  const to = currency(m[4] ?? "");
  if (!from || !to || from === to || (m[1] && m[3])) return null;
  const amount = Number(m[2]!.replace(/,/g, ""));
  return Number.isFinite(amount) ? { amount, from, to } : null;
}

// ---------------------------------------------------------------- dates in the typed text

const DAY_WORDS: [RegExp, (today: string) => string][] = [
  [/(^|\s)(today|今天)(?=\s|$)|今天/i, () => "today"],
  [/(^|\s)(tomorrow|明天)(?=\s|$)|明天/i, () => "tomorrow"],
  [/后天/, (today) => addDays(today, 2)],
];
const PERIOD_WORDS: [RegExp, string][] = [
  [/(this week|本周|这周|这星期|本星期)/i, "this-week"],
  [/(next week|下周|下星期)/i, "next-week"],
  [/(this month|本月|这个月)/i, "this-month"],
  [/(today|今天|今日)/i, "today"],
  [/(tomorrow|明天)/i, "tomorrow"],
];

/**
 * Dates and times written into the text the query fills: "明天 15:00 提交报告" fills the date and time
 * inputs and leaves "提交报告". The form shows what was read before anything is submitted.
 */
export function extractWhen(text: string, inputs: ActionInput[], tz: string, now = Date.now()): { text: string; args: Record<string, string> } {
  let rest = ` ${text} `;
  const args: Record<string, string> = {};
  const date = inputs.find((i) => i.type === "date");
  const time = inputs.find((i) => i.type === "time");
  const period = inputs.find((i) => i.type === "period");
  if (period) {
    for (const [re, value] of PERIOD_WORDS) {
      if (re.test(rest)) {
        args[period.name] = value;
        rest = rest.replace(re, " ");
        break;
      }
    }
  }
  if (date) {
    const today = dateIn(now, tz);
    for (const [re, value] of DAY_WORDS) {
      if (re.test(rest)) {
        args[date.name] = value(today);
        rest = rest.replace(re, " ");
        break;
      }
    }
    const iso = /(\d{4}-\d{2}-\d{2})/.exec(rest);
    if (!args[date.name] && iso && isDate(iso[1])) {
      args[date.name] = iso[1]!;
      rest = rest.replace(iso[1]!, " ");
    }
  }
  if (time && date) {
    // 15:00, 9:30, 15点, 下午3点, 3pm
    const m = /(上午|下午|晚上)?\s*(\d{1,2})(?::(\d{2})|点(?:(\d{1,2})分?|半)?)\s*(am|pm)?|(\d{1,2})\s*(am|pm)/i.exec(rest);
    if (m) {
      let h = Number(m[2] ?? m[6]);
      const min = m[3] ? Number(m[3]) : m[4] ? Number(m[4]) : /点半/.test(m[0]) ? 30 : 0;
      const pm = /下午|晚上/.test(m[1] ?? "") || /pm/i.test(m[5] ?? m[7] ?? "");
      if (pm && h < 12) h += 12;
      if (/am/i.test(m[5] ?? m[7] ?? "") && h === 12) h = 0;
      if (h <= 23 && min <= 59) {
        args[time.name] = `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
        rest = rest.replace(m[0], " ");
        if (!args[date.name]) args[date.name] = "today";
      }
    }
  }
  return { text: rest.replace(/\s+/g, " ").trim(), args };
}

// ---------------------------------------------------------------- matching

export type Intent =
  | { kind: "calc"; key: string; expression: string }
  | { kind: "convert"; key: string; action: Action; args: { amount: number; from: string; to: string } }
  | { kind: "action"; key: string; action: Action; args: Record<string, unknown>; strong: boolean; pattern?: string; ambiguous?: boolean };

/**
 * What the typed text can run, best first: arithmetic and a conversion are direct results; an
 * action whose name or keyword starts the text is a strong match (the rest of the text fills its
 * query input); a looser match on a name, and tasks by name, come after the library's entries.
 */
export function intents(query: string, actions: Action[], tz: string, now = Date.now()): Intent[] {
  const q = query.trim();
  if (!q) return [];
  const out: Intent[] = [];
  if (isExpression(q)) out.push({ kind: "calc", key: "calc", expression: q });
  const conv = parseConversion(q);
  const convert = actions.find((a) => a.id === "space/convert" && a.builtin);
  if (conv && convert) out.push({ kind: "convert", key: "convert", action: convert, args: conv });
  if (out.length) return out;

  const patterns = patternIntents(q, actions, tz, now);
  if (patterns.length) return patterns;

  const lower = q.toLocaleLowerCase();
  const strong: Intent[] = [];
  const weak: { i: Intent; s: number }[] = [];
  for (const a of actions) {
    if (a.id === "space/run-task" || (a.id === "space/calc" && a.builtin)) continue;
    const head = words(a)
      .map((w) => w.toLocaleLowerCase())
      .filter((w) => lower === w || lower.startsWith(`${w} `) || (/[^\x00-\x7f]$/.test(w) && lower.startsWith(w)))
      .sort((x, y) => y.length - x.length)[0];
    if (head !== undefined) {
      const rest = q.slice(head.length).trim();
      strong.push({ kind: "action", key: actionKey(a), action: a, args: fill(a, rest, tz, now), strong: true });
      continue;
    }
    const s = score(q, { names: words(a), text: [a.description ?? "", ...Object.values(a.i18n ?? {}).map((t) => t.description ?? "")].join(" ") });
    // A name typed whole or from its start is what the operator means: Enter opens it.
    if (s >= SCORE.prefix) strong.push({ kind: "action", key: actionKey(a), action: a, args: fill(a, "", tz, now), strong: true });
    else if (s > 0) weak.push({ i: { kind: "action", key: actionKey(a), action: a, args: {}, strong: false }, s });
  }
  const runTask = actions.find((a) => a.id === "space/run-task" && a.builtin && a.available);
  const tasks = runTask
    ? (runTask.inputs[0]?.options ?? [])
        .map((o) => ({ o, s: score(q, { names: [o.label, o.label.split(" · ")[1] ?? ""], text: o.value }) }))
        .filter((x) => x.s >= 50)
        .sort((x, y) => y.s - x.s)
        .slice(0, 3)
        // A backup task is never strong: every app has one, and typing an app's name means the app, not its backup.
        .map(({ o, s }): Intent => ({ kind: "action", key: `task:${o.value}`, action: runTask, args: { task: o.value }, strong: s >= SCORE.prefix && !isBackup(o.label) }))
    : [];
  return [...strong, ...tasks.filter((t) => t.kind === "action" && t.strong), ...weak.sort((x, y) => y.s - x.s).map((w) => w.i), ...tasks.filter((t) => t.kind === "action" && !t.strong)];
}

/** A run-task option whose task is an app's backup or the space's backup check (label `app · name`). */
function isBackup(label: string): boolean {
  const name = label.split(" · ")[1];
  return name === BACKUP_TASK || name === VERIFY_TASK;
}

/** The arguments a strong match opens with: defaults, the dates read from the text, the text itself. */
export function fill(a: Action, rest: string, tz: string, now = Date.now()): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const i of a.inputs) if (i.default !== undefined) args[i.name] = i.default;
  const query = a.inputs.find((i) => i.query);
  if (!rest) return args;
  const when = extractWhen(rest, a.inputs, tz, now);
  Object.assign(args, when.args);
  if (query && when.text) args[query.name] = when.text;
  return args;
}

/** True when every required input has a value, so Enter can run a read at once. */
export function complete(a: Action, args: Record<string, unknown>): boolean {
  return a.inputs.every((i) => !i.required || (args[i.name] !== undefined && args[i.name] !== ""));
}

const patternCache = new Map<string, PatternMachine | null>();
function compiled(source: string): PatternMachine | null {
  if (patternCache.has(source)) return patternCache.get(source)!;
  let machine: PatternMachine | null = null;
  try { machine = compilePattern(source); } catch { /* A stale peer's invalid pattern cannot break search. */ }
  if (patternCache.size >= 256) patternCache.delete(patternCache.keys().next().value!);
  patternCache.set(source, machine);
  return machine;
}

/** Slots use the action's existing input types; normalized values remain editable. */
export function captureInput(a: Action, name: string, text: string, tz: string, now = Date.now()): string | number | undefined {
  const input = a.inputs.find((i) => i.name === name);
  if (!input) return undefined;
  if (input.type === "text") return text;
  if (input.type === "number") {
    if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) return undefined;
    const n = Number(text);
    return Number.isFinite(n) && (input.min === undefined || n >= input.min) && (input.max === undefined || n <= input.max) ? n : undefined;
  }
  if (input.type === "choice" || input.type === "task") {
    const options = input.options?.filter((o) => [o.value, o.label, ...Object.values(a.i18n ?? {}).map((t) => t.options?.[o.value])].some((v) => v?.toLowerCase() === text.toLowerCase())) ?? [];
    return options.length === 1 ? options[0]!.value : undefined;
  }
  if (input.type === "time") {
    if (isTime(text)) return text;
    const extracted = extractWhen(text, [{ name: "__date", type: "date", label: "Date" }, input], tz, now);
    return !extracted.text ? extracted.args[name] : undefined;
  }
  const extracted = extractWhen(text, [input], tz, now);
  const value = !extracted.text ? extracted.args[name] ?? text : text;
  try {
    if (input.type === "date") resolveDate(value, tz, now);
    else resolvePeriod(value, tz, now);
    return value;
  } catch { return undefined; }
}

function patternIntents(query: string, actions: Action[], tz: string, now: number): Intent[] {
  const found = new Map<string, Extract<Intent, { kind: "action" }>>();
  const budget = { remaining: 100_000 };
  for (const a of actions) {
    const sources = [...new Set([...(a.patterns ?? []), ...(a.customPatterns ?? [])])].slice(0, 32);
    for (const source of sources) {
      const machine = compiled(source);
      if (!machine) continue;
      const result = matchPattern(machine, query, (name, value) => captureInput(a, name, value, tz, now), budget);
      if (result.limited) return [];
      for (const captures of result.matches) {
        const queryInput = a.inputs.find((i) => i.query);
        const queryText = queryInput && captures[queryInput.name];
        const defaults = fill(a, typeof queryText === "string" ? queryText : "", tz, now);
        const explicit = { ...captures };
        // Keep the existing date extraction for the action's query slot. Explicit
        // typed slots take precedence; ordinary text slots retain their full text.
        if (queryInput && typeof queryText === "string") delete explicit[queryInput.name];
        const args = { ...defaults, ...explicit };
        const key = `${actionKey(a)}:pattern:${JSON.stringify(Object.entries(args).sort(([x], [y]) => x.localeCompare(y)))}`;
        found.set(key, { kind: "action", key, action: a, args, strong: true, pattern: source });
      }
    }
  }
  const matches = [...found.values()];
  if (matches.length > 1) for (const match of matches) match.ambiguous = true;
  return matches;
}
