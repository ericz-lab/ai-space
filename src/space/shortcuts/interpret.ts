import { actionKey, captureInput, parseConversion } from "./resolve.ts";
import { isExpression } from "./calc.ts";
import type { Action } from "./types.ts";

/**
 * The command box's last layer (docs/shortcuts.md#model-interpretation): a longer sentence the
 * deterministic layers may not read is also shown to the basic-tier model, which picks one action
 * (with its form filled) or one agent intent. It runs beside `resolve`, never instead of it, and its
 * answer is only a suggestion: nothing runs until the person submits the form or picks the agent.
 */

/** Interpretation starts at this many units: six for Chinese or mixed text, four for English alone. */
export const MIN_UNITS = 6;
export const MIN_WORDS_LATIN = 4;
/** At most this many actions and agent intents go into one prompt. */
const MAX_ACTIONS = 60;
const MAX_INTENTS = 32;
const MAX_OPTIONS = 20;

/**
 * How long the text is, as a person counts it: a run of Latin letters and digits (`meeting`,
 * `2026`, `15:30`, `12pm`) is one unit, any other letter (a Chinese character) is one; spaces and
 * punctuation do not count. `明天12点开会` is six units, `tomorrow meeting at 12pm` four.
 */
export function countUnits(text: string): number {
  return text.match(/(?:\d+(?:[.,:]\d+)*|[\p{Script=Latin}'-])+|[\p{L}\p{M}]/gu)?.length ?? 0;
}

/** Whether the text is worth a model call: long enough, and not arithmetic or a conversion the box already answers. */
export function wantsInterpretation(text: string): boolean {
  const q = text.trim();
  // Any letter outside the Latin script (Chinese, mixed text) counts per character, so it needs more.
  const latinOnly = !/(?![\p{Script=Latin}])[\p{L}]/u.test(q);
  return countUnits(q) >= (latinOnly ? MIN_WORDS_LATIN : MIN_UNITS) && !isExpression(q) && !parseConversion(q);
}

export type InterpretIntent = { id: string; title: string };

export type Interpretation =
  | { kind: "action"; key: string; action: Action; args: Record<string, unknown> }
  | { kind: "agent"; id: string };

export const SYSTEM = [
  "You route one sentence typed into a command box to at most one entry of a catalogue.",
  "Reply with a single JSON object and nothing else:",
  '{"kind":"action","id":"<action id>","args":{"<input>":<value>}} to fill an action\'s form,',
  '{"kind":"agent","id":"<intent id>"} to hand the sentence to an agent,',
  '{"kind":"none"} when no entry fits.',
  "Use only ids and input names from the catalogue. Leave out inputs the sentence does not give.",
  "Values: date = YYYY-MM-DD or today/tomorrow/yesterday; time = HH:MM (24h); period = today, tomorrow, this-week, next-week, this-month, last-7-days or YYYY-MM-DD..YYYY-MM-DD; choice/task = one listed value; number = a number; text = the words from the sentence.",
].join("\n");

/** The actions the model may pick: available, not the ones the box computes itself. */
function candidates(actions: Action[]): Action[] {
  return actions.filter((a) => a.available && a.id !== "space/calc" && a.id !== "space/convert").slice(0, MAX_ACTIONS);
}

/** The user prompt: the zone and date the sentence is read in, the catalogue, then the sentence. */
export function buildPrompt(text: string, actions: Action[], intents: InterpretIntent[], tz: string, now = Date.now()): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "long" }).format(now);
  const catalogue = {
    actions: candidates(actions).map((a) => ({
      id: actionKey(a),
      title: [a.title, ...Object.values(a.i18n ?? {}).map((t) => t.title).filter(Boolean)].join(" / "),
      ...(a.description ? { description: a.description.slice(0, 200) } : {}),
      effect: a.effect,
      inputs: a.inputs.map((i) => ({
        name: i.name,
        type: i.type,
        label: i.label,
        ...(i.required ? { required: true } : {}),
        ...(i.options?.length ? { options: i.options.slice(0, MAX_OPTIONS).map((o) => o.value === o.label ? o.value : `${o.value} (${o.label})`) } : {}),
      })),
    })),
    agents: intents.slice(0, MAX_INTENTS).map((i) => ({ id: i.id, title: i.title })),
  };
  return `Today is ${today} in ${tz}.\n\nCatalogue:\n${JSON.stringify(catalogue)}\n\nSentence:\n${text.trim()}`;
}

/** The first JSON object in the model's answer, or undefined. */
function firstObject(answer: string): Record<string, unknown> | undefined {
  const start = answer.indexOf("{");
  const end = answer.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const v = JSON.parse(answer.slice(start, end + 1));
    return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The model's answer checked against the catalogue: an unknown id is no suggestion, and every
 * argument goes through the same input check a sentence pattern's slot does, so a value the form
 * would not accept is dropped rather than shown.
 */
export function parseInterpretation(answer: string, actions: Action[], intents: InterpretIntent[], tz: string, now = Date.now()): Interpretation | null {
  const o = firstObject(answer);
  if (!o || typeof o.id !== "string") return null;
  if (o.kind === "agent") return intents.some((i) => i.id === o.id) ? { kind: "agent", id: o.id } : null;
  if (o.kind !== "action") return null;
  const action = candidates(actions).find((a) => actionKey(a) === o.id);
  if (!action) return null;
  const args: Record<string, unknown> = {};
  for (const i of action.inputs) if (i.default !== undefined) args[i.name] = i.default;
  const raw = o.args && typeof o.args === "object" && !Array.isArray(o.args) ? (o.args as Record<string, unknown>) : {};
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== "string" && typeof value !== "number") continue;
    const text = String(value).trim();
    if (!text || text.length > 500) continue;
    const v = captureInput(action, name, text, tz, now);
    if (v !== undefined) args[name] = v;
  }
  return { kind: "action", key: `model:${actionKey(action)}`, action, args };
}
