/**
 * Shortcuts in Home's command box (docs/shortcuts.md#native-search-and-shared-resolution): after a
 * pause in typing the Space reads the text (`POST /api/shortcuts/resolve`), and when it names one
 * thing to run (arithmetic, a conversion, an action named at its start, such as `待办 明天下午3点 写周报`)
 * the box shows it above Ask Space Assistant and Enter opens the panel's Shortcuts page on it
 * (`/?page=shortcuts&run=<text>`, src/web/Shortcuts.tsx), where its form is filled from the text.
 * The rule is the web panel's (`intentToRun` in src/web/shortcuts.ts). Read leniently: an answer
 * this client does not understand offers nothing, and the box goes on as before.
 */

export const RESOLVE_PATH = "/api/shortcuts/resolve";
/** The box asks the Space after this pause in typing. */
export const RESOLVE_AFTER_MS = 250;

/** What the box shows for the sentence: the action's title and what the text filled, one line. */
export type ShortcutOffer = { title: string; detail: string };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);

/** The page the box opens for a sentence. */
export const shortcutsRunHref = (text: string) => `/?page=shortcuts&run=${encodeURIComponent(text)}`;

/** The text of an action in the interface's language (`zh` also serves `zh-CN`), else its own. */
function translated(action: Obj, lang: string): Obj | null {
  const i18n = obj(action.i18n);
  if (!i18n) return null;
  for (const [tag, text] of Object.entries(i18n)) if (tag.split("-")[0] === lang) return obj(text);
  return null;
}

/**
 * The offer for a resolve answer, or null: the first intent, when it is arithmetic, a conversion or
 * an action named at the start, the sentence means one thing only, no agent's skill took it, and the
 * action can run. Arithmetic shows its expression under `calculator`.
 */
export function shortcutOffer(answer: unknown, lang: string, calculator: string): ShortcutOffer | null {
  const r = obj(answer);
  if (!r || r.ambiguous === true || (Array.isArray(r.agentIntents) && r.agentIntents.length > 0)) return null;
  const first = Array.isArray(r.intents) ? obj(r.intents[0]) : null;
  if (!first) return null;
  if (first.kind === "calc") {
    const e = str(first.expression);
    return e ? { title: calculator, detail: e } : null;
  }
  if (first.kind !== "action" && first.kind !== "convert") return null;
  if (first.kind === "action" && (first.strong !== true || first.ambiguous === true)) return null;
  const action = obj(first.action);
  if (!action || action.available === false) return null;
  const tr = translated(action, lang);
  const title = str(tr?.title) || str(action.title) || str(action.id) || "";
  const labels = obj(tr?.inputs) ?? {};
  const args = obj(first.args) ?? {};
  const inputs = Array.isArray(action.inputs) ? action.inputs.map(obj).filter((i): i is Obj => i !== null) : [];
  const parts: string[] = [];
  for (const input of inputs) {
    const name = str(input.name);
    const value = name ? str(args[name]) : null;
    if (!name || !value) continue;
    parts.push(`${str(labels[name]) || str(input.label) || name}: ${value}`);
  }
  return { title, detail: parts.join(" · ") };
}
