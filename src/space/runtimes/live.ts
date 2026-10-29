import type { AgentQuestion, ApprovalDecision, ChatCallbacks, ChatHandle, ChatTurn, QuestionAnswers } from "./types.ts";

/**
 * Live chat (docs/runtimes.md#live-chat): a conversation keeps one runtime process across its
 * turns instead of starting the CLI for each. The process stays connected while a turn runs, so
 * the person can answer the runtime's approval requests and add messages to the turn, and it stays
 * open after the turn for the next one. Each runtime implements `LiveProcess` over its own
 * protocol; this file holds what they share: the pool and the events the panel reads.
 *
 * Events added to the runtime's stream (Claude Code's `stream-json` shapes otherwise):
 *
 *   {"type":"approval_request","id","tool","title","detail"?,"input"?,"questions"?}  the turn waits for an answer
 *   {"type":"approval_resolved","id","decision":"allow"|"deny"|"cancelled","answers"?}
 *
 * A question the agent asks (`tool` "AskUserQuestion") is an approval request with `questions`;
 * the person answers it with `allow` and `answers` (question id → chosen labels or typed text).
 *   {"type":"steer","text"}  the agent has read a message the person added to the turn
 *   {"type":"notice","kind":"limit","text"}  the agent's turns of its own after background reports
 *                                            are no longer shown (docs/runtimes.md#background-work)
 */

/** An idle process is closed this long after its last turn. */
export const LIVE_IDLE_MS = 10 * 60_000;
/** At most this many idle processes per runtime; the oldest goes first. */
export const LIVE_MAX_IDLE = 6;
/** A stop that the runtime has not answered by then kills the process. */
export const LIVE_STOP_GRACE_MS = 4_000;
/**
 * A process whose background jobs still run is kept past the idle time, up to this long after its
 * last turn (SPACE_CHAT_BACKGROUND_MINUTES; default 2 hours, Claude Code's own cap on a background
 * command in a non-interactive run). Closing the process stops its jobs.
 */
export const LIVE_BACKGROUND_MS = backgroundMs(process.env.SPACE_CHAT_BACKGROUND_MINUTES);

export function backgroundMs(minutes: string | undefined): number {
  const n = Number(minutes);
  return minutes !== undefined && minutes.trim() !== "" && Number.isFinite(n) && n >= 0 ? n * 60_000 : 120 * 60_000;
}

export interface LiveProcess {
  /** Conversation the process holds (the runtime's session id); null until it reports one. */
  readonly sid: string | null;
  /** What a turn must share with the process to reuse it: directory, identity, environment. */
  readonly fingerprint: string;
  readonly alive: boolean;
  /** A turn runs: the person's, or one the process started by itself. */
  readonly busy: boolean;
  /** Background jobs (docs/runtimes.md#background-work) still run; a runtime without them leaves it out. */
  readonly background?: boolean;
  /** When the process last said anything (ms); the idle time counts from it when given. */
  readonly lastActive?: number;
  /** Run one turn. Only called on an idle, live process. */
  turn(turn: ChatTurn, cb: ChatCallbacks): ChatHandle;
  close(): void;
}

/** What a turn must match to go to an existing process. */
export function liveFingerprint(turn: ChatTurn): string {
  const env = Object.entries(turn.env ?? {}).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : 1));
  return String(Bun.hash(JSON.stringify([turn.cwd, turn.systemPrompt ?? "", turn.allowedTools ?? [], env])));
}

/** One runtime's live processes: reuse by conversation, close when idle, close all on shutdown. */
export class LivePool {
  private readonly procs = new Map<LiveProcess, { timer?: ReturnType<typeof setTimeout>; idleSince: number }>();

  constructor(private readonly opts: { idleMs?: number; maxIdle?: number; backgroundMs?: number } = {}) {}

  /**
   * A turn on this pool: the idle process holding the turn's session when it matches, else a new
   * one from `open`. A process whose conversation does not match is never reused.
   */
  run(turn: ChatTurn, cb: ChatCallbacks, open: () => LiveProcess): ChatHandle {
    const fingerprint = liveFingerprint(turn);
    let proc: LiveProcess | undefined;
    if (turn.sessionId) {
      for (const p of this.procs.keys()) {
        if (p.alive && !p.busy && p.sid === turn.sessionId) {
          if (p.fingerprint === fingerprint) proc = p;
          else this.drop(p, true); // same conversation, other identity: start it again with the new one
          break;
        }
      }
    }
    if (proc) clearTimeout(this.procs.get(proc)?.timer);
    else {
      proc = open();
      this.procs.set(proc, { idleSince: 0 });
    }
    const p = proc;
    return p.turn(turn, {
      ...cb,
      onFinish: (error) => {
        this.settle(p);
        cb.onFinish(error);
      },
    });
  }

  /** After a turn: keep the process for the next one, or forget it when it died. */
  private settle(p: LiveProcess): void {
    const entry = this.procs.get(p);
    if (!entry) return;
    if (!p.alive) return void this.procs.delete(p);
    entry.idleSince = Date.now();
    this.arm(p, this.opts.idleMs ?? LIVE_IDLE_MS);
    // A process with background work is not idle: its jobs would die with it.
    const idle = [...this.procs.entries()].filter(([q]) => !q.busy && !q.background).sort(([, a], [, b]) => a.idleSince - b.idleSince);
    while (idle.length > (this.opts.maxIdle ?? LIVE_MAX_IDLE)) this.drop(idle.shift()![0], true);
  }

  /**
   * Close the process once it has been quiet for the idle time. A turn it started by itself, or a
   * background job still running, keeps it, up to the background limit after the person's last turn.
   */
  private arm(p: LiveProcess, ms: number): void {
    const entry = this.procs.get(p);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (!this.procs.has(p)) return;
      if (!p.alive) return this.drop(p, false);
      const idleMs = this.opts.idleMs ?? LIVE_IDLE_MS;
      const now = Date.now();
      const held = (p.busy || p.background) && now - entry.idleSince < (this.opts.backgroundMs ?? LIVE_BACKGROUND_MS);
      const quiet = now - Math.max(entry.idleSince, p.lastActive ?? 0);
      if (held) this.arm(p, idleMs);
      else if (quiet < idleMs && !p.busy && !p.background) this.arm(p, idleMs - quiet);
      else this.drop(p, true);
    }, Math.max(1, ms));
    entry.timer.unref?.();
  }

  private drop(p: LiveProcess, close: boolean): void {
    clearTimeout(this.procs.get(p)?.timer);
    this.procs.delete(p);
    if (close) p.close();
  }

  /** Processes alive now, busy or idle (tests, status). */
  get size(): number {
    return [...this.procs.keys()].filter((p) => p.alive).length;
  }

  closeAll(): void {
    for (const p of [...this.procs.keys()]) this.drop(p, true);
  }
}

/** The approvals a live turn is waiting on, by the id the panel answers with. */
export class PendingApprovals<T> {
  private readonly map = new Map<string, T>();

  constructor(private readonly emit: (event: unknown) => void) {}

  add(id: string, value: T, request: { tool: string; title: string; detail?: string; input?: unknown; questions?: AgentQuestion[] }): void {
    this.map.set(id, value);
    this.emit({ type: "approval_request", id, ...request });
  }

  /** Take an open request out, telling the stream how it ended; undefined when it is not open. */
  take(id: string, decision: ApprovalDecision | "cancelled", answers?: QuestionAnswers): T | undefined {
    const value = this.map.get(id);
    if (value === undefined) return undefined;
    this.map.delete(id);
    this.emit({ type: "approval_resolved", id, decision, ...(answers && decision === "allow" ? { answers } : {}) });
    return value;
  }

  ids(): string[] {
    return [...this.map.keys()];
  }
}

async function* chunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) return;
      yield r.value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Read a stream line by line; resolves when it ends. */
export async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void, maxLine = 8_000_000): Promise<void> {
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of chunks(stream)) {
    rest += decoder.decode(chunk, { stream: true });
    if (rest.length > maxLine && !rest.includes("\n")) throw new Error("runtime event exceeds limit");
    let nl: number;
    while ((nl = rest.indexOf("\n")) >= 0) {
      const line = rest.slice(0, nl).trim();
      rest = rest.slice(nl + 1);
      if (line) onLine(line);
    }
  }
  if (rest.trim()) onLine(rest.trim());
}

/** Keep the last `max` characters a stream writes (a runtime's stderr, for its error message). */
export function tail(stream: ReadableStream<Uint8Array>, max = 4000): { text: () => string } {
  let text = "";
  const decoder = new TextDecoder();
  void (async () => {
    for await (const chunk of chunks(stream)) text = (text + decoder.decode(chunk, { stream: true })).slice(-max);
  })().catch(() => {});
  return { text: () => text };
}

/**
 * An agent's questions in the panel's shape, from Codex's `request_user_input` or Claude Code's
 * `AskUserQuestion` input. A question without an id (Claude's) is `q<n>`.
 */
export function agentQuestions(raw: unknown): AgentQuestion[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 8).flatMap((q, i) => {
    if (!q || typeof q !== "object") return [];
    const r = q as { id?: unknown; header?: unknown; question?: unknown; options?: unknown; multiSelect?: unknown };
    const options = (Array.isArray(r.options) ? r.options : []).slice(0, 12).flatMap((o) => {
      const label = (o as { label?: unknown } | null)?.label;
      return typeof label === "string" ? [{ label: label.slice(0, 200), description: String((o as { description?: unknown }).description ?? "").slice(0, 500) }] : [];
    });
    return [{ id: typeof r.id === "string" && r.id ? r.id : `q${i}`, header: String(r.header ?? "").slice(0, 80), question: String(r.question ?? ""), options, multiSelect: r.multiSelect === true }];
  });
}

/** Answers that name only the asked questions; null when nothing was answered (the question is skipped). */
export function questionAnswers(questions: AgentQuestion[], answers: QuestionAnswers | undefined): QuestionAnswers | null {
  if (!answers) return null;
  const out: QuestionAnswers = {};
  for (const q of questions) {
    const given = (answers[q.id] ?? []).map((a) => a.trim()).filter(Boolean);
    if (given.length) out[q.id] = q.multiSelect ? given : given.slice(0, 1);
  }
  return Object.keys(out).length ? out : null;
}

/** One line for an approval card: the command, the file, the URL, else the input as JSON. */
export function approvalTitle(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  const value = i.command ?? i.file_path ?? i.notebook_path ?? i.path ?? i.url ?? i.query ?? i.pattern ?? i.plan;
  return (typeof value === "string" ? value : JSON.stringify(input)).slice(0, 2000);
}
