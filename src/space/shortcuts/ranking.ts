function matches(query: string, ...text: (string | undefined)[]): boolean {
  const hay = text.filter(Boolean).join(" ").toLocaleLowerCase();
  return query
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

// The home screen's command box (docs/panel.md#omnibox): what it lists while the operator types, and
// whether Enter opens the first match or asks Space Assistant. The Mac client ports these rules to
// `OmniboxRules.swift`; keep the two in step.

/** What the box ranks: `names` are the entry's titles in every language and its id; `text` is everything the library search reads. */
export type Candidate = { names: string[]; text: string; peer?: string };

/** The score of a name that equals the query, starts with it, has a word starting with it, or holds it. */
export const SCORE = { exact: 100, prefix: 80, word: 60, inside: 50, text: 10 } as const;

/** At or above this, the first match is a name the operator typed: Enter opens it instead of asking. */
export const OPEN_SCORE = SCORE.inside;

/** How the query fits the entry: 0 when the library search would not show it, more the better its name fits. */
export function score(query: string, c: Candidate): number {
  const q = query.trim().toLocaleLowerCase();
  if (!q || !matches(q, c.text, ...c.names, c.peer)) return 0;
  let best: number = SCORE.text;
  for (const raw of c.names) {
    const name = raw.toLocaleLowerCase();
    if (name === q) return SCORE.exact;
    if (name.startsWith(q)) best = Math.max(best, SCORE.prefix);
    else if (name.split(/[\s\-_/·.]+/).some((w) => w.startsWith(q))) best = Math.max(best, SCORE.word);
    else if (name.includes(q)) best = Math.max(best, SCORE.inside);
  }
  return best;
}

/** The matching entries, best first; equal scores keep the given order. */
export function rank<T extends Candidate>(query: string, list: T[], limit = 6): T[] {
  return list
    .map((c, i) => ({ c, i, s: score(query, c) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.c);
}

/** Enter opens the first match when its name holds the whole query; anything else is a question for the assistant. */
export function opensByDefault(query: string, first: Candidate | undefined): boolean {
  return !!first && score(query, first) >= OPEN_SCORE;
}
