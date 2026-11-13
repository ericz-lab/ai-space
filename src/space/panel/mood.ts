import type { RunInfo } from "../agents/runs.ts";

/**
 * The Space's mood (docs/app-spec.md#space-mood): what the panel's own desk pet, and the native
 * clients' pets, show about the Space. ai-space works it out from what it already holds (the agent
 * turns running and just ended, the approvals they wait on, the inbox, the feedback waiting on the
 * person); a client only reads it and draws its pet accordingly. Rules, first match wins:
 *
 *   waiting   a running turn waits on an approval or a question             stay, opens that chat
 *   error     a turn failed in the last 10 minutes and nothing came after   stay, opens that chat
 *   working   turns are running                                             roam, opens the newest
 *   done      a turn ended well in the last minute                          roam, opens that chat
 *   waiting   the inbox has unread threads (reason inbox)                   roam, opens the inbox
 *   waiting   feedback waits on the person (reason feedback)                roam
 *   sleep     no turn started or ended for two hours                        stay
 *   idle      otherwise                                                     roam
 *
 *   GET /api/pets/mood   { ok, state, reason?, move, say?, open?, counts, asOf }
 */

export type MoodState = "working" | "waiting" | "error" | "done" | "idle" | "sleep";
export type MoodReason = "approval" | "inbox" | "feedback";
/** What a click on the pet opens: an agent's chat (`<app>/<agent>`), or the inbox. */
export type MoodOpen = { kind: "chat"; agent: string } | { kind: "inbox" };

export type SpaceMoodView = {
  ok: true;
  state: MoodState;
  reason?: MoodReason;
  /** `stay`: the pet waits in the bottom-right corner; `roam`: it walks about between rests. */
  move: "roam" | "stay";
  /** A short line over the pet, in English and Chinese; absent = nothing to say. */
  say?: { en: string; zh: string };
  open?: MoodOpen;
  counts: { running: number; waiting: number; failed: number; unread: number; feedback: number };
  asOf: string;
};

export type AgentTitle = { en: string; zh?: string };

export type MoodInput = {
  /** Turns running now. */
  running: RunInfo[];
  /** Of those, the ones waiting on the person. */
  waiting: RunInfo[];
  /** Turns that ended within QUIET_MS, any order. */
  ended: RunInfo[];
  unread: number;
  feedback: number;
  title?: (agent: string) => AgentTitle | undefined;
};

export const ERROR_MS = 10 * 60_000;
export const DONE_MS = 60_000;
export const QUIET_MS = 2 * 60 * 60_000;
/** A read is served again for this long: every client polls, and a burst of them costs one look. */
export const MOOD_CACHE_MS = 3_000;

const FAILED = new Set(["error", "timeout"]);

export function spaceMood(input: MoodInput, now: number): SpaceMoodView {
  const name = (agent: string): AgentTitle => input.title?.(agent) ?? { en: agent };
  const newest = (runs: RunInfo[], at: (r: RunInfo) => number) => [...runs].sort((a, b) => at(b) - at(a));
  const ended = newest(input.ended.filter((r) => r.finishedAt !== null), (r) => r.finishedAt!);
  const runningAgents = new Set(input.running.map((r) => r.agent));
  // A failure counts while it is the agent's last word: a later turn of the same agent, ended or
  // running, means the person is on it.
  const lastOf = new Map<string, RunInfo>();
  for (const r of ended) if (!lastOf.has(r.agent)) lastOf.set(r.agent, r);
  const failed = [...lastOf.values()].filter((r) => FAILED.has(r.status) && now - r.finishedAt! < ERROR_MS && !runningAgents.has(r.agent));
  const counts = { running: input.running.length, waiting: input.waiting.length, failed: failed.length, unread: input.unread, feedback: input.feedback };
  const base = { ok: true as const, counts, asOf: new Date(now).toISOString() };
  const line = (one: (t: AgentTitle) => [string, string], many: (n: number) => [string, string], runs: RunInfo[]) => {
    const [en, zh] = runs.length === 1 ? one(name(runs[0]!.agent)) : many(runs.length);
    return { en, zh };
  };
  const zhOf = (t: AgentTitle) => t.zh ?? t.en;

  if (input.waiting.length) {
    const runs = newest(input.waiting, (r) => r.startedAt);
    return {
      ...base,
      state: "waiting",
      reason: "approval",
      move: "stay",
      say: line((t) => [`${t.en} is waiting for you`, `${zhOf(t)} 在等你`], (n) => [`${n} agents are waiting for you`, `${n} 个 agent 在等你`], runs),
      open: { kind: "chat", agent: runs[0]!.agent },
    };
  }
  if (failed.length) {
    return {
      ...base,
      state: "error",
      move: "stay",
      say: line((t) => [`${t.en} ran into a problem`, `${zhOf(t)} 出错了`], (n) => [`${n} agents ran into a problem`, `${n} 个 agent 出错了`], failed),
      open: { kind: "chat", agent: failed[0]!.agent },
    };
  }
  if (input.running.length) {
    const runs = newest(input.running, (r) => r.startedAt);
    return {
      ...base,
      state: "working",
      move: "roam",
      say: line((t) => [`${t.en} is working`, `${zhOf(t)} 在干活`], (n) => [`${n} agents are working`, `${n} 个 agent 在干活`], runs),
      open: { kind: "chat", agent: runs[0]!.agent },
    };
  }
  const last = ended[0];
  if (last && last.status === "done" && now - last.finishedAt! < DONE_MS) {
    const t = name(last.agent);
    return { ...base, state: "done", move: "roam", say: { en: `${t.en} is done`, zh: `${zhOf(t)} 做完了` }, open: { kind: "chat", agent: last.agent } };
  }
  if (input.unread > 0) {
    return { ...base, state: "waiting", reason: "inbox", move: "roam", say: { en: input.unread === 1 ? "1 unread in the inbox" : `${input.unread} unread in the inbox`, zh: `收件箱有 ${input.unread} 条未读` }, open: { kind: "inbox" } };
  }
  if (input.feedback > 0) {
    return { ...base, state: "waiting", reason: "feedback", move: "roam", say: { en: input.feedback === 1 ? "1 piece of feedback waits for you" : `${input.feedback} pieces of feedback wait for you`, zh: `${input.feedback} 条反馈等你处理` } };
  }
  if (!ended.some((r) => now - r.finishedAt! < QUIET_MS)) return { ...base, state: "sleep", move: "stay" };
  return { ...base, state: "idle", move: "roam" };
}

export type MoodSources = {
  running: () => RunInfo[];
  waiting: () => RunInfo[];
  /** Turns running or ended within `ms`. */
  recent: (ms: number) => RunInfo[];
  unread?: () => number;
  feedback?: () => number;
  title?: (agent: string) => AgentTitle | undefined;
  now?: () => number;
};

/** The mood as `/api/pets/mood` serves it, worked out at most once every MOOD_CACHE_MS. */
export class SpaceMood {
  private last?: { at: number; view: SpaceMoodView };

  constructor(private readonly sources: MoodSources) {}

  read(): SpaceMoodView {
    const now = (this.sources.now ?? Date.now)();
    if (this.last && now - this.last.at < MOOD_CACHE_MS) return this.last.view;
    const s = this.sources;
    const count = (f?: () => number) => {
      try {
        return Math.max(0, f?.() ?? 0);
      } catch {
        return 0;
      }
    };
    const view = spaceMood(
      {
        running: s.running(),
        waiting: s.waiting(),
        ended: s.recent(QUIET_MS).filter((r) => r.status !== "running"),
        unread: count(s.unread),
        feedback: count(s.feedback),
        ...(s.title ? { title: s.title } : {}),
      },
      now,
    );
    this.last = { at: now, view };
    return view;
  }
}
