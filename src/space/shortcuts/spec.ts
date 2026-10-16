import { validatePatterns } from "./pattern.ts";
import { type ActionI18n, type ActionInput, type ActionOption, type ActionSpec, EFFECTS, type Effect, INPUT_TYPES, type InputType, PERIODS, RELATIVE_DATES, RESULT_KINDS, type ResultKind, TEMPLATES, TEMPLATE_RESULTS, type Template } from "./types.ts";

/**
 * The `action:` block of a capability (docs/shortcuts.md#app-actions): the opt-in that puts the
 * capability into the command box and the Shortcuts panel, with typed inputs the page builds a
 * form from. A capability without it stays a plain bus call.
 *
 * ```yaml
 * provides:
 *   create:
 *     http: { method: POST, path: /api/capabilities/create }
 *     action:
 *       title: Create todo
 *       keywords: [todo, task]
 *       template: todo            # the phase-1 slot it fills (news, calendar, todo)
 *       effect: write             # read | write
 *       idempotent: true
 *       result: receipt           # list | receipt | value
 *       inputs:
 *         - { name: title, type: text, label: Title, required: true, query: true }
 *         - { name: dueDate, type: date, label: Date }
 *       i18n:
 *         zh: { title: 新建待办, keywords: [待办], inputs: { title: 标题, dueDate: 日期 } }
 * ```
 *
 * Parsing is strict like the rest of the manifest: an unknown key or a bad value rejects the app.
 */

const ACTION_KEYS = ["title", "description", "keywords", "patterns", "template", "effect", "idempotent", "result", "inputs", "i18n"];
const INPUT_KEYS = ["name", "type", "label", "required", "default", "options", "min", "max", "query"];
const NAME_RE = /^[a-z][a-zA-Z0-9_]*$/;
const LANG_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseActionSpec(raw: unknown, ctx: string): ActionSpec {
  if (!isRecord(raw)) throw new Error(`${ctx} must be a mapping with title / effect / result / inputs`);
  for (const key of Object.keys(raw)) if (!ACTION_KEYS.includes(key)) throw new Error(`${ctx} has unknown key "${key}"`);
  const title = requiredString(raw.title, `${ctx}.title`);
  const description = optionalString(raw.description, `${ctx}.description`);
  const keywords = stringList(raw.keywords, `${ctx}.keywords`);
  const effect = String(raw.effect ?? "read") as Effect;
  // `run` is the built-in task runner's; an app's action reads or writes.
  if (effect !== "read" && effect !== "write") throw new Error(`${ctx}.effect must be read or write`);
  const result = String(raw.result ?? "") as ResultKind;
  if (!(RESULT_KINDS as readonly string[]).includes(result)) throw new Error(`${ctx}.result must be ${RESULT_KINDS.join(", ")}`);
  let template: Template | undefined;
  if (raw.template !== undefined) {
    template = String(raw.template) as Template;
    const wants = TEMPLATE_RESULTS[template];
    if (!(TEMPLATES as readonly string[]).includes(template) || !wants) throw new Error(`${ctx}.template must be one of ${Object.keys(TEMPLATE_RESULTS).join(", ")}`);
    if (wants !== result) throw new Error(`${ctx}: template ${template} answers result: ${wants}`);
    if (template === "todo" && effect !== "write") throw new Error(`${ctx}: template todo is a write`);
  }
  if (raw.idempotent !== undefined && typeof raw.idempotent !== "boolean") throw new Error(`${ctx}.idempotent must be true or false`);
  if (raw.idempotent && effect !== "write") throw new Error(`${ctx}.idempotent applies to a write`);
  const inputs = parseInputs(raw.inputs, `${ctx}.inputs`);
  const i18n = raw.i18n === undefined ? undefined : parseI18n(raw.i18n, inputs, `${ctx}.i18n`);
  return {
    title,
    ...(description ? { description } : {}),
    keywords,
    ...(raw.patterns !== undefined ? { patterns: validatePatterns(raw.patterns, inputs.map((i) => i.name)) } : {}),
    effect: effect as Effect,
    result,
    ...(template ? { template } : {}),
    ...(raw.idempotent ? { idempotent: true } : {}),
    inputs,
    ...(i18n ? { i18n } : {}),
  };
}

function parseInputs(raw: unknown, ctx: string): ActionInput[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`${ctx} must be a list`);
  const seen = new Set<string>();
  let queries = 0;
  const out = raw.map((item, i) => {
    const where = `${ctx}[${i}]`;
    if (!isRecord(item)) throw new Error(`${where} must be a mapping with name / type / label`);
    for (const key of Object.keys(item)) if (!INPUT_KEYS.includes(key)) throw new Error(`${where} has unknown key "${key}"`);
    const name = requiredString(item.name, `${where}.name`);
    if (!NAME_RE.test(name) || ["timezone", "now", "idempotencyKey"].includes(name)) throw new Error(`${where}.name "${name}" is not an input name (a letter, then letters, digits, underscores; not timezone, now or idempotencyKey)`);
    if (seen.has(name)) throw new Error(`${ctx}: "${name}" is declared twice`);
    seen.add(name);
    const type = String(item.type ?? "text") as InputType;
    // `task` is the built-in runner's: its options are the scheduler's tasks.
    if (!(INPUT_TYPES as readonly string[]).includes(type) || type === "task") throw new Error(`${where}.type must be text, number, date, time, period or choice`);
    const label = requiredString(item.label, `${where}.label`);
    if (item.required !== undefined && typeof item.required !== "boolean") throw new Error(`${where}.required must be true or false`);
    if (item.query !== undefined && typeof item.query !== "boolean") throw new Error(`${where}.query must be true or false`);
    if (item.query) {
      if (type !== "text") throw new Error(`${where}: query fills a text input`);
      queries++;
    }
    let options: ActionOption[] | undefined;
    if (type === "choice") {
      if (!Array.isArray(item.options) || !item.options.length) throw new Error(`${where}.options must list the choices`);
      options = item.options.map((o, j) => {
        if (typeof o === "string" && o.trim()) return { value: o.trim(), label: o.trim() };
        if (isRecord(o) && typeof o.value === "string" && o.value.trim()) return { value: o.value.trim(), label: optionalString(o.label, `${where}.options[${j}].label`) ?? o.value.trim() };
        throw new Error(`${where}.options[${j}] must be a value or { value, label }`);
      });
    } else if (item.options !== undefined) throw new Error(`${where}.options apply to a choice`);
    for (const k of ["min", "max"] as const) {
      if (item[k] === undefined) continue;
      if (type !== "number") throw new Error(`${where}.${k} applies to a number`);
      if (typeof item[k] !== "number" || !Number.isFinite(item[k])) throw new Error(`${where}.${k} must be a number`);
    }
    const input: ActionInput = {
      name,
      type,
      label,
      ...(item.required ? { required: true } : {}),
      ...(options ? { options } : {}),
      ...(item.min !== undefined ? { min: item.min as number } : {}),
      ...(item.max !== undefined ? { max: item.max as number } : {}),
      ...(item.query ? { query: true } : {}),
    };
    if (item.default !== undefined) {
      const d = item.default;
      if (typeof d !== "string" && typeof d !== "number") throw new Error(`${where}.default must be a value`);
      const problem = checkDefault(input, d);
      if (problem) throw new Error(`${where}.default: ${problem}`);
      input.default = d;
    }
    return input;
  });
  if (queries > 1) throw new Error(`${ctx}: only one input can take the query`);
  return out;
}

function checkDefault(input: ActionInput, d: string | number): string | undefined {
  switch (input.type) {
    case "number":
      return typeof d === "number" ? undefined : "must be a number";
    case "date":
      return typeof d === "string" && ((RELATIVE_DATES as readonly string[]).includes(d) || DATE_RE.test(d)) ? undefined : `must be YYYY-MM-DD or ${RELATIVE_DATES.join(", ")}`;
    case "period":
      return typeof d === "string" && (PERIODS as readonly string[]).includes(d) ? undefined : `must be ${PERIODS.join(", ")}`;
    case "time":
      return typeof d === "string" && /^\d{2}:\d{2}$/.test(d) ? undefined : "must be HH:MM";
    case "choice":
      return input.options!.some((o) => o.value === String(d)) ? undefined : "must be one of the options";
    default:
      return typeof d === "string" ? undefined : "must be text";
  }
}

function parseI18n(raw: unknown, inputs: ActionInput[], ctx: string): ActionI18n {
  if (!isRecord(raw)) throw new Error(`${ctx} must map language tags to mappings`);
  const out: ActionI18n = {};
  for (const [lang, v] of Object.entries(raw)) {
    const where = `${ctx}.${lang}`;
    if (!LANG_RE.test(lang)) throw new Error(`${ctx}: "${lang}" is not a language tag`);
    if (!isRecord(v)) throw new Error(`${where} must be a mapping`);
    for (const key of Object.keys(v)) if (!["title", "description", "keywords", "inputs", "options"].includes(key)) throw new Error(`${where} has unknown key "${key}"`);
    const t: ActionI18n[string] = {};
    const title = optionalString(v.title, `${where}.title`);
    if (title) t.title = title;
    const description = optionalString(v.description, `${where}.description`);
    if (description) t.description = description;
    if (v.keywords !== undefined) t.keywords = stringList(v.keywords, `${where}.keywords`);
    if (v.inputs !== undefined) {
      if (!isRecord(v.inputs)) throw new Error(`${where}.inputs must map input names to labels`);
      t.inputs = {};
      for (const [name, label] of Object.entries(v.inputs)) {
        if (!inputs.some((i) => i.name === name)) throw new Error(`${where}.inputs: no input "${name}"`);
        t.inputs[name] = requiredString(label, `${where}.inputs.${name}`);
      }
    }
    if (v.options !== undefined) {
      if (!isRecord(v.options)) throw new Error(`${where}.options must map choice values to labels`);
      t.options = {};
      for (const [value, label] of Object.entries(v.options)) t.options[value] = requiredString(label, `${where}.options.${value}`);
    }
    out[lang] = t;
  }
  return out;
}

function stringList(raw: unknown, ctx: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || !raw.every((x) => typeof x === "string" && x.trim())) throw new Error(`${ctx} must be a list of words`);
  return [...new Set(raw.map((x: string) => x.trim()))];
}

function requiredString(v: unknown, what: string): string {
  const s = optionalString(v, what);
  if (!s) throw new Error(`${what} is required`);
  return s;
}

function optionalString(v: unknown, what: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !v.trim()) throw new Error(`${what} must be a non-empty string`);
  return v.trim();
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export { EFFECTS };
