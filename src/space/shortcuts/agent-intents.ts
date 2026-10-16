import { PERIODS } from "./types.ts";
import { compilePattern, matchPattern, validatePatterns, type PatternMachine } from "./pattern.ts";

/** Backend-owned routing. Captures identify intent; the agent receives the original sentence. */
export type AgentIntent = {
  id: string;
  title: string;
  agent: string;
  skills: string[];
  patterns: string[];
  enabled: boolean;
};
export type AgentIntentView = AgentIntent & { available: boolean; reason?: string };
const NAME = /^[a-z][a-z0-9-]{0,63}$/;
export function parseAgentIntent(raw: unknown): AgentIntent {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Expected an agent intent object");
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(r)) if (!["id", "title", "agent", "skills", "patterns", "enabled"].includes(key)) throw new Error(`Unknown intent field: ${key}`);
  if (typeof r.id !== "string" || !NAME.test(r.id)) throw new Error("Invalid intent id");
  if (typeof r.title !== "string" || !r.title.trim() || r.title.length > 120) throw new Error("Intent title must contain 1–120 characters");
  if (typeof r.agent !== "string" || r.agent.split("/").length !== 2 || !r.agent.split("/").every((p) => NAME.test(p))) throw new Error("agent must be a local app/agent id");
  if (!Array.isArray(r.skills) || !r.skills.length || r.skills.length > 4 || !r.skills.every((s) => typeof s === "string" && NAME.test(s))) throw new Error("skills must contain 1–4 skill names");
  if (r.enabled !== undefined && typeof r.enabled !== "boolean") throw new Error("enabled must be a boolean");
  // Intent slots are classifiers only: their names need not be capability input names.
  if (!Array.isArray(r.patterns) || !r.patterns.length || r.patterns.length > 16 || !r.patterns.every((p) => typeof p === "string")) throw new Error("patterns must contain 1–16 sentences");
  const names = r.patterns.flatMap((p: string) => compilePattern(p).slots);
  const patterns = validatePatterns(r.patterns, names);
  return { id: r.id, title: r.title.trim(), agent: r.agent, skills: [...new Set(r.skills as string[])], patterns, enabled: r.enabled !== false };
}

const PERIOD_LABELS: Record<string, string> = {
  今天: "today", 今日: "today", 明天: "tomorrow", 本周: "this-week", 这周: "this-week",
  下周: "next-week", 本月: "this-month", "this week": "this-week", "next week": "next-week",
  "this month": "this-month", 最近七天: "last-7-days", 最近7天: "last-7-days",
};
function capture(name: string, text: string): string | undefined {
  // Opt-in tolerance for short trailing text, counted as Unicode code points.
  if (name === "suffix2") return Array.from(text).length <= 2 ? text : undefined;
  if (name !== "period") return text;
  const word = text.toLowerCase().replace(/的$/, "");
  return PERIOD_LABELS[word] ?? ((PERIODS as readonly string[]).includes(word) ? word : undefined);
}
const cache = new Map<string, PatternMachine>();
/** Whole-sentence matches, one candidate per target intent, not per capture split. */
export function matchAgentIntents(text: string, definitions: AgentIntentView[]): AgentIntentView[] {
  const matches: AgentIntentView[] = [];
  const budget = { remaining: 100_000 };
  for (const definition of definitions) {
    if (!definition.enabled) continue;
    for (const source of definition.patterns) {
      let machine = cache.get(source);
      if (!machine) {
        try { machine = compilePattern(source); } catch { continue; }
        if (cache.size >= 256) cache.delete(cache.keys().next().value!);
        cache.set(source, machine);
      }
      const result = matchPattern(machine, text, capture, budget);
      if (result.limited) return [];
      if (result.matches.length) { matches.push(definition); break; }
    }
  }
  return matches;
}
