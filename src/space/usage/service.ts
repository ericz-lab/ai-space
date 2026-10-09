import type { UsageStore } from "./store.ts";
import { type BeatResult, KEY_PATTERN, KINDS, type Kind, SOURCES, type Source, TAB_PATTERN, type UsageRow, WINDOW_MS, type Window } from "./types.ts";

/**
 * The usage service (docs/usage.md): validates what the panel, the heartbeat
 * script and the agent runs report, and records it. A failure here never
 * reaches the thing being used: the hooks swallow and log their errors.
 */

/** What the agent hooks need of a run (`RunInfo` in agents/runs.ts). */
export type AgentRun = { id: string; agent: string; sessionId: string | null; sid: string | null; startedAt: number; finishedAt: number | null };

export class UsageService {
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(
    readonly store: UsageStore,
    opts: { now?: () => number; log?: (line: string) => void } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((l) => console.error(`[usage] ${l}`));
  }

  /** An open from the panel; throws on a malformed one. */
  open(input: { kind?: unknown; key?: unknown; source?: unknown }): void {
    const kind = input.kind as Kind;
    const source = input.source as Source;
    if (!KINDS.includes(kind)) throw new Error(`kind must be one of ${KINDS.join(", ")}`);
    if (typeof input.key !== "string" || !KEY_PATTERN.test(input.key)) throw new Error("invalid key");
    if (!SOURCES.includes(source)) throw new Error(`source must be one of ${SOURCES.join(", ")}`);
    this.store.addOpen(kind, input.key, source, this.now());
  }

  /** A heartbeat of an app's page; throws on a malformed tab id. */
  beat(app: string, tab: unknown): BeatResult {
    if (typeof tab !== "string" || !TAB_PATTERN.test(tab)) throw new Error("invalid tab");
    return this.store.beat(app, tab, this.now());
  }

  /** `RunRegistry`'s start hook: one turn is one open of the agent. */
  runStarted = (run: AgentRun): void => {
    try {
      this.store.addOpen("agent", run.agent, "chat", run.startedAt);
    } catch (e) {
      this.log(`${run.agent}: open not recorded: ${(e as Error).message}`);
    }
  };

  /** `RunRegistry`'s end hook: the turn extends its conversation's segment, or starts one. */
  runEnded = (run: AgentRun): void => {
    try {
      const tabs = [run.sessionId, run.sid].filter((s): s is string => !!s);
      this.store.agentTurn(run.agent, tabs, run.sid ?? run.sessionId ?? run.id, run.startedAt, run.finishedAt ?? this.now());
    } catch (e) {
      this.log(`${run.agent}: turn not recorded: ${(e as Error).message}`);
    }
  };

  report(window: Window, kind?: Kind): UsageRow[] {
    const span = WINDOW_MS[window];
    return this.store.summary(Number.isFinite(span) ? this.now() - span : 0, kind);
  }
}
