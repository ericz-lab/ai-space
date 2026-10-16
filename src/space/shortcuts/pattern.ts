/** Small tagged NFA: literal transitions, epsilon branches, and named capture edges.
 * Inspired by interpreter/pattern_machine's template/slot/state separation. No eval,
 * user regex, NER, DFA minimization, or exponential expansion of optional groups.
 */
export type PatternEdge = { to: number; text?: string; slot?: string };
export type PatternMachine = { states: PatternEdge[][]; end: number; slots: string[] };
export const PATTERN_LIMITS = { patterns: 16, source: 256, input: 512, states: 512, depth: 4, work: 50_000, configurations: 4096 } as const;

export function compilePattern(source: string): PatternMachine {
  if (!source.trim() || source.length > PATTERN_LIMITS.source) throw new Error("Pattern must contain 1–256 characters");
  source = source.trim().replace(/\s+/g, " ");
  const states: PatternEdge[][] = [[]];
  const slots: string[] = [];
  let pos = 0;
  const node = () => {
    if (states.length >= PATTERN_LIMITS.states) throw new Error("Pattern has too many states");
    states.push([]);
    return states.length - 1;
  };
  const edge = (from: number, to: number, value: Omit<PatternEdge, "to"> = {}) => states[from]!.push({ to, ...value });
  const sequence = (start: number, closing: string, depth: number): number => {
    if (depth > PATTERN_LIMITS.depth) throw new Error("Pattern nesting exceeds 4 levels");
    let at = start;
    while (pos < source.length && source[pos] !== closing && source[pos] !== "|") {
      const ch = source[pos++]!;
      if (ch === "[" || ch === "(") {
        const end = node();
        const close = ch === "[" ? "]" : ")";
        if (ch === "[") edge(at, end);
        while (true) {
          const branch = node();
          edge(at, branch);
          const tail = sequence(branch, close, depth + 1);
          if (tail === branch) throw new Error("Empty pattern branch");
          edge(tail, end);
          if (source[pos] === "|") { pos++; continue; }
          if (source[pos++] !== close) throw new Error(`Missing ${close}`);
          break;
        }
        at = end;
      } else if (ch === "{") {
        const end = source.indexOf("}", pos);
        if (end < 0) throw new Error("Missing }");
        const name = source.slice(pos, end);
        if (!/^[a-z][a-zA-Z0-9_]*$/.test(name) || ["constructor", "prototype", "timezone", "now", "idempotencyKey"].includes(name)) throw new Error(`Invalid slot: ${name}`);
        if (slots.includes(name)) throw new Error(`Repeated slot: ${name}`);
        if (slots.length >= 4) throw new Error("At most 4 slots per pattern");
        slots.push(name);
        pos = end + 1;
        const next = node();
        edge(at, next, { slot: name });
        at = next;
      } else {
        if ("})]".includes(ch)) throw new Error(`Unexpected ${ch}`);
        let text = ch;
        if (ch === "\\") {
          if (pos === source.length) throw new Error("Trailing escape");
          text = source[pos++]!;
        }
        const next = node();
        edge(at, next, { text: /\s/.test(text) ? " " : text });
        at = next;
      }
    }
    return at;
  };
  const end = sequence(0, "", 0);
  if (pos !== source.length) throw new Error("Alternatives must be inside (...) or [...]");
  // Every accepting path needs a non-whitespace literal, so a slot cannot hijack all searches.
  const seen = new Set<number>();
  const queue = [0];
  for (let i = 0; i < queue.length; i++) {
    const at = queue[i]!;
    if (at === end) throw new Error("Every branch needs literal text");
    if (seen.has(at)) continue;
    seen.add(at);
    for (const e of states[at]!) if (!e.text?.trim()) queue.push(e.to);
  }
  return { states, end, slots };
}

export function validatePatterns(raw: unknown, names: readonly string[]): string[] {
  if (!Array.isArray(raw) || raw.length > PATTERN_LIMITS.patterns) throw new Error("patterns must be a list of at most 16 sentences");
  return [...new Set(raw.map((p) => {
    if (typeof p !== "string") throw new Error("Each pattern must be text");
    const source = p.trim();
    const machine = compilePattern(source);
    for (const slot of machine.slots) if (!names.includes(slot)) throw new Error(`Unknown input slot: ${slot}`);
    return source;
  }))];
}

export type PatternMatch = Record<string, string | number>;
/** Full-sentence matching. Keep distinct captures; never silently pick a greedy split.
 * Exhausting a bound discards all partial matches. Capture normalization can reject
 * typed values before they become candidates; execution still validates server-side.
 */
export function matchPattern(machine: PatternMachine, input: string, capture: (name: string, text: string) => string | number | undefined = (_name, text) => text, budget = { remaining: 100_000 }): { matches: PatternMatch[]; limited: boolean } {
  if (input.length > PATTERN_LIMITS.input) return { matches: [], limited: true };
  const text = input.trim().replace(/\s+/g, " ");
  const queue = [{ at: 0, pos: 0, args: {} as PatternMatch }];
  const seen = new Set<string>();
  const found = new Map<string, PatternMatch>();
  let work = 0;
  for (let i = 0; i < queue.length; i++) {
    if (queue.length > PATTERN_LIMITS.configurations) return { matches: [], limited: true };
    const { at, pos, args } = queue[i]!;
    const key = JSON.stringify([at, pos, args]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (at === machine.end && pos === text.length) {
      found.set(JSON.stringify(args), args);
      if (found.size > 8) return { matches: [], limited: true };
    }
    for (const e of machine.states[at]!) {
      if (++work > PATTERN_LIMITS.work || --budget.remaining < 0) return { matches: [], limited: true };
      if (e.slot) {
        for (let end = pos + 1; end <= text.length; end++) {
          if (++work > PATTERN_LIMITS.work || --budget.remaining < 0 || queue.length > PATTERN_LIMITS.configurations) return { matches: [], limited: true };
          const raw = text.slice(pos, end);
          if (!raw.trim() || raw !== raw.trim()) continue;
          const value = capture(e.slot, raw);
          if (value !== undefined) queue.push({ at: e.to, pos: end, args: { ...args, [e.slot]: value } });
        }
      } else if (e.text !== undefined) {
        if (text.slice(pos, pos + e.text.length).toLowerCase() === e.text.toLowerCase()) queue.push({ at: e.to, pos: pos + e.text.length, args });
      } else queue.push({ at: e.to, pos, args });
    }
  }
  return { matches: [...found.values()], limited: false };
}
