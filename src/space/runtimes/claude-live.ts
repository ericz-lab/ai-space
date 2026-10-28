import { approvalTitle, liveFingerprint, LIVE_STOP_GRACE_MS, agentQuestions, PendingApprovals, questionAnswers, readLines, tail, type LiveProcess } from "./live.ts";
import { PERMISSION_MODES, type AgentQuestion, type ApprovalDecision, type BackgroundJob, type ChatCallbacks, type ChatHandle, type ChatTurn, type QuestionAnswers, type SteerInput } from "./types.ts";

/**
 * Claude Code live chat (docs/runtimes.md#live-chat): one `claude -p` process per conversation,
 * fed user messages as `stream-json` on stdin and kept open between turns.
 *
 * - Approvals: with `--permission-prompt-tool stdio` the CLI asks the host before an action its
 *   permission mode does not allow (`control_request` `can_use_tool`) and waits for the answer.
 * - Questions: `AskUserQuestion` always asks the host the same way, in every permission mode; the
 *   answers go back in the tool's input (`answers`: question text → chosen labels).
 * - Steering: a user message written while a turn runs is read after the running tool call ends
 *   and the same turn goes on with it. One written as the turn ends starts another turn of the
 *   CLI's; the run then lasts until that one ends too, so the message is never lost.
 *   `--replay-user-messages` tells when the CLI took each one in.
 * - Stop: an `interrupt` control request ends the turn and the process waits for the next one.
 * - Background work (docs/runtimes.md#background-work): a Bash call with `run_in_background` or a
 *   Monitor goes on after the turn. Each report (a Monitor event, a job's end) reaches the agent as
 *   a `<task-notification>` message: during a turn it is replayed with `origin.kind
 *   "task-notification"`; between turns the CLI starts a turn of its own for it (`system` `init`,
 *   the reply, a `result` with that origin) without replaying the message. That turn goes to the
 *   last turn's `onWake`. `system` `task_started`, `task_updated`, `task_notification` and
 *   `background_tasks_changed` keep the list of jobs (`onJobs`). Recorded from Claude Code 2.1.312
 *   in `fixtures/claude-background.jsonl`.
 */

const TURN_ARGS = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--replay-user-messages", "--permission-prompt-tool", "stdio"];

/** Turns a process may start by itself in a row before the person writes again; past it they run unseen. */
export const LIVE_MAX_WAKES = 20;
/** Ended jobs kept in the list next to the running ones. */
const KEEP_ENDED_JOBS = 20;

/** The CLI's permission mode for a turn's tier: the panel's read-only default asks instead of refusing. */
const modeOf = (t: ChatTurn) => ((PERMISSION_MODES as readonly string[]).includes(t.permissionMode ?? "") ? t.permissionMode! : "default");

/** Arguments of a live process after the binary; exported for tests. */
export function claudeLiveArgs(t: ChatTurn, extra: string[] = []): string[] {
  const args = [...TURN_ARGS, "--permission-mode", modeOf(t)];
  if (t.model) args.push("--model", t.model);
  if (t.sessionId) args.push("--resume", t.sessionId);
  if (t.systemPrompt) args.push("--append-system-prompt", t.systemPrompt);
  if (t.allowedTools?.length) args.push("--allowedTools", t.allowedTools.join(","));
  args.push(...extra);
  return args;
}

/** A user message line for the CLI's stdin. */
export function claudeUserLine(input: SteerInput): string {
  const content = input.images?.length
    ? [...(input.message ? [{ type: "text", text: input.message }] : []), ...input.images.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } }))]
    : input.message;
  return JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
}

type Turn = {
  cb: ChatCallbacks;
  /** The turn's own message has not been replayed yet (always false for a turn the process started). */
  ownPending: boolean;
  /** Messages added to the turn that the CLI has not taken in yet. */
  steers: number;
  stopping: boolean;
  sessionSeen: boolean;
  stopTimer?: ReturnType<typeof setTimeout>;
};

type Approval = { input: unknown; questions?: AgentQuestion[] };
type Event = Record<string, unknown> & { type?: string; subtype?: string; session_id?: unknown };

/** A background job's report: the replayed `<task-notification>` message, or a result that answered one. */
const fromNotice = (ev: Event) => (ev.origin as { kind?: unknown } | undefined)?.kind === "task-notification";

export class ClaudeLive implements LiveProcess {
  readonly fingerprint: string;
  sid: string | null;
  alive = true;
  lastActive = Date.now();
  private readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private current: Turn | null = null;
  private approvals: PendingApprovals<Approval> | null = null;
  /** Questions of the open `AskUserQuestion` requests, by request id. */
  private readonly questionsOf = new Map<string, AgentQuestion[]>();
  private model: string | undefined;
  private mode: string;
  private stderr: { text: () => string } = { text: () => "" };
  private serial = 0;
  /** Where turns the process starts by itself, and job changes, go: the last turn's hooks. */
  private hooks: Pick<ChatCallbacks, "onWake" | "onJobs"> = {};
  /** Turns started by the process since the person's last message. */
  private wakes = 0;
  /** Events of a turn the CLI started by itself, held until it says something worth a run. */
  private pendingWake: [string, Event][] | null = null;
  /** The CLI's own turn running now is not shown (nobody took it, or past the limit). */
  private muted = false;
  private readonly jobs = new Map<string, BackgroundJob>();
  /** Tool names by call id, so a job knows whether a Monitor or a Bash call started it. */
  private readonly toolNames = new Map<string, string>();

  constructor(
    bin: string[],
    first: ChatTurn,
    extra: string[] = [],
    private readonly maxWakes = LIVE_MAX_WAKES,
  ) {
    this.fingerprint = liveFingerprint(first);
    this.sid = first.sessionId ?? null;
    this.model = first.model;
    this.mode = modeOf(first);
    this.proc = Bun.spawn([...bin, ...claudeLiveArgs(first, extra)], { cwd: first.cwd, env: first.env ?? process.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    this.write({ type: "control_request", request_id: this.requestId(), request: { subtype: "initialize" } });
    const proc = this.proc;
    this.stderr = tail(proc.stderr);
    void readLines(proc.stdout, (line) => this.line(line))
      .catch(() => {})
      .then(() => proc.exited)
      .then((code) => this.exited(code));
  }

  get busy(): boolean {
    return this.current !== null;
  }

  get background(): boolean {
    for (const job of this.jobs.values()) if (job.status === "running") return true;
    return false;
  }

  turn(turn: ChatTurn, cb: ChatCallbacks): ChatHandle {
    const t: Turn = { cb, ownPending: true, steers: 0, stopping: false, sessionSeen: false };
    this.current = t;
    this.approvals = new PendingApprovals((event) => cb.onEvent(JSON.stringify(event)));
    this.hooks = { onWake: cb.onWake, onJobs: cb.onJobs };
    // The person wrote: the process may start turns of its own again, and one under way is this turn's now.
    this.wakes = 0;
    this.pendingWake = null;
    this.muted = false;
    // A later turn of the conversation may pick another model or tier; the process switches in place.
    if (turn.model && turn.model !== this.model) {
      this.model = turn.model;
      this.write({ type: "control_request", request_id: this.requestId(), request: { subtype: "set_model", model: turn.model } });
    }
    const mode = modeOf(turn);
    if (mode !== this.mode) {
      this.mode = mode;
      this.write({ type: "control_request", request_id: this.requestId(), request: { subtype: "set_permission_mode", mode } });
    }
    this.raw(claudeUserLine(turn));
    return this.handleOf(t);
  }

  close(): void {
    if (!this.alive) return;
    this.alive = false;
    try {
      this.proc.stdin.end();
    } catch {
      /* already closed */
    }
    setTimeout(() => this.proc.kill(), 2_000).unref?.();
  }

  // ------------------------------------------------------------------ turn operations

  private handleOf(t: Turn): ChatHandle {
    return {
      kill: () => this.stop(t),
      steer: (input) => this.steer(t, input),
      respond: (id, decision, answers) => this.respond(t, id, decision, answers),
    };
  }

  private async steer(t: Turn, input: SteerInput): Promise<void> {
    if (this.current !== t || t.stopping || !this.alive) throw new Error("the turn has ended; send the message as a new one");
    t.steers++;
    this.raw(claudeUserLine(input));
  }

  private respond(t: Turn, id: string, decision: ApprovalDecision, answers?: QuestionAnswers): boolean {
    if (this.current !== t) return false;
    const questions = this.questionsOf.get(id);
    const given = questions && decision === "allow" ? questionAnswers(questions, answers) : null;
    const approval = this.approvals?.take(id, questions && !given ? "deny" : decision, given ?? undefined);
    if (!approval) return false;
    this.questionsOf.delete(id);
    const response = questions
      ? given
        ? { behavior: "allow", updatedInput: { ...(approval.input as object), answers: Object.fromEntries(questions.flatMap((q) => (given[q.id] ? [[q.question, given[q.id]!.join(", ")]] : []))) } }
        : { behavior: "deny", message: "The user skipped the question. Go on with your best judgement, or ask again in your reply." }
      : decision === "allow" ? { behavior: "allow", updatedInput: approval.input } : { behavior: "deny", message: "The user declined this action." };
    this.write({ type: "control_response", response: { subtype: "success", request_id: id, response } });
    return true;
  }

  private stop(t: Turn): void {
    if (this.current !== t || t.stopping) return;
    t.stopping = true;
    for (const id of this.approvals?.ids() ?? []) this.respond(t, id, "deny");
    // A message still waiting in the CLI would start a turn nobody follows: end the process instead.
    if (t.steers > 0) return void this.kill();
    this.write({ type: "control_request", request_id: this.requestId(), request: { subtype: "interrupt" } });
    t.stopTimer = setTimeout(() => this.kill(), LIVE_STOP_GRACE_MS);
    t.stopTimer.unref?.();
  }

  // ------------------------------------------------------------------ the CLI's output

  private line(line: string): void {
    this.lastActive = Date.now();
    let ev: Event;
    try {
      ev = JSON.parse(line);
    } catch {
      this.current?.cb.onEvent(line);
      return;
    }
    if (ev.type === "control_request") return this.controlRequest(ev as { request_id: string; request?: { subtype?: string; tool_name?: string; input?: unknown; description?: string; decision_reason?: string } });
    if (ev.type === "control_cancel_request") {
      this.questionsOf.delete(String(ev.request_id));
      return void this.approvals?.take(String(ev.request_id), "cancelled");
    }
    if (ev.type === "control_response") return;
    if (ev.type === "assistant") this.toolCalls(ev);
    if (ev.type === "system") this.track(ev);
    const t = this.current;
    if (t) this.inTurn(t, line, ev);
    else this.between(line, ev);
  }

  private inTurn(t: Turn, line: string, ev: Event): void {
    if (typeof ev.session_id === "string") {
      this.sid = ev.session_id;
      if (!t.sessionSeen) {
        t.sessionSeen = true;
        t.cb.onSession?.(ev.session_id);
      }
    }
    if (ev.type === "user" && ev.isReplay) {
      // A background job's report the agent takes in mid-turn: shown as such, never as the person's message.
      if (fromNotice(ev)) return t.cb.onEvent(line);
      if (t.ownPending) t.ownPending = false;
      else {
        t.steers = Math.max(0, t.steers - 1);
        t.cb.onEvent(JSON.stringify({ type: "steer", text: replayText(ev) }));
      }
      return;
    }
    if (ev.type === "result") {
      // A message added at the end of the turn starts the CLI's next one: the run goes on with it.
      if (t.steers > 0 && !t.stopping) return;
      // The CLI answered a background report before reading this turn's message: the turn goes on.
      if (t.ownPending && fromNotice(ev) && !t.stopping) return t.cb.onEvent(line);
      t.cb.onEvent(line);
      const error = t.stopping ? "stopped" : ev.is_error ? String(ev.result || ev.subtype || "the runtime reported an error") : null;
      return this.endTurn(error);
    }
    t.cb.onEvent(line);
  }

  /**
   * Between turns: a turn the CLI starts by itself. Its events are held until it says something
   * (a reply, a job's report), so a turn that only opens and closes (the CLI does that when two
   * reports arrive together) makes no run; then it goes to `onWake`.
   */
  private between(line: string, ev: Event): void {
    if (ev.type === "result") {
      this.pendingWake = null;
      this.muted = false;
      return;
    }
    if (this.muted) return;
    const opens = ev.type === "assistant" || ev.type === "stream_event" || ev.type === "user" || (ev.type === "system" && (ev.subtype === "init" || ev.subtype === "task_notification"));
    if (!this.pendingWake) {
      if (!opens) return; // the CLI's own bookkeeping after a turn (status, summaries, rate limits)
      this.pendingWake = [];
    }
    this.pendingWake.push([line, ev]);
    const says = ev.type === "assistant" || ev.type === "stream_event" || ev.type === "user" || (ev.type === "system" && ev.subtype === "task_notification");
    if (says) this.wake();
  }

  private wake(): void {
    const held = this.pendingWake ?? [];
    this.pendingWake = null;
    this.muted = true; // until a run takes the turn
    this.wakes++;
    if (this.wakes > this.maxWakes + 1 || !this.hooks.onWake) return;
    const t: Turn = { cb: { onEvent() {}, onFinish() {} }, ownPending: false, steers: 0, stopping: false, sessionSeen: false };
    let cb: ChatCallbacks | null = null;
    try {
      cb = this.hooks.onWake(this.handleOf(t));
    } catch {
      cb = null;
    }
    if (!cb) return;
    if (this.wakes > this.maxWakes) {
      // Past the limit: one run says so; the turns after it run unseen until the person writes.
      cb.onEvent(JSON.stringify({ type: "notice", kind: "limit", text: `The agent answered ${this.maxWakes} background reports in a row; the next ones run without being shown until you send a message.` }));
      return cb.onFinish(null);
    }
    this.muted = false;
    t.cb = cb;
    this.current = t;
    this.approvals = new PendingApprovals((event) => cb.onEvent(JSON.stringify(event)));
    for (const [line, ev] of held) if (this.current === t) this.inTurn(t, line, ev);
  }

  private controlRequest(ev: { request_id: string; request?: { subtype?: string; tool_name?: string; input?: unknown; description?: string; decision_reason?: string } }): void {
    const req = ev.request ?? {};
    if (req.subtype === "can_use_tool" && req.tool_name === "AskUserQuestion" && this.current && !this.current.stopping && this.approvals) {
      const questions = agentQuestions((req.input as { questions?: unknown } | undefined)?.questions);
      this.questionsOf.set(ev.request_id, questions);
      this.approvals.add(ev.request_id, { input: req.input, questions }, { tool: "AskUserQuestion", title: questions.map((q) => q.question).join("\n").slice(0, 2000), questions });
      return;
    }
    if (req.subtype === "can_use_tool" && this.current && !this.current.stopping && this.approvals) {
      this.approvals.add(ev.request_id, { input: req.input }, {
        tool: req.tool_name ?? "tool",
        title: approvalTitle(req.input),
        ...(req.description || req.decision_reason ? { detail: String(req.description || req.decision_reason).slice(0, 2000) } : {}),
        input: req.input,
      });
      return;
    }
    if (req.subtype === "can_use_tool") {
      this.write({ type: "control_response", response: { subtype: "success", request_id: ev.request_id, response: { behavior: "deny", message: "No turn is running." } } });
      return;
    }
    this.write({ type: "control_response", response: { subtype: "error", request_id: ev.request_id, error: `ai-space does not handle ${req.subtype ?? "this request"}` } });
  }

  private endTurn(error: string | null): void {
    const t = this.current;
    if (!t) return;
    clearTimeout(t.stopTimer);
    for (const id of this.approvals?.ids() ?? []) this.approvals?.take(id, "cancelled");
    this.questionsOf.clear();
    this.current = null;
    this.approvals = null;
    t.cb.onFinish(error);
  }

  private exited(code: number): void {
    this.alive = false;
    this.pendingWake = null;
    // The CLI's background jobs end with it.
    let ended = false;
    for (const job of this.jobs.values()) {
      if (job.status !== "running") continue;
      job.status = "stopped";
      job.endedAt = Date.now();
      ended = true;
    }
    if (ended) this.publishJobs();
    if (!this.current) return;
    const stopping = this.current.stopping;
    this.endTurn(stopping ? "stopped" : (this.stderr.text().trim() || `runtime exited with ${code}`).slice(-800));
  }

  // ------------------------------------------------------------------ background jobs

  private toolCalls(ev: Event): void {
    const content = (ev.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (b?.type !== "tool_use" || typeof b.id !== "string") continue;
      this.toolNames.set(b.id, String(b.name ?? ""));
      if (this.toolNames.size > 500) this.toolNames.delete(this.toolNames.keys().next().value!);
    }
  }

  /** Keep the job list from the CLI's `system` events; tell the hooks when it changed. */
  private track(ev: Event): void {
    const now = Date.now();
    const id = typeof ev.task_id === "string" ? ev.task_id : "";
    let changed = false;
    if (ev.subtype === "task_started" && id) {
      const toolUseId = typeof ev.tool_use_id === "string" ? ev.tool_use_id : undefined;
      this.jobs.set(id, {
        id,
        kind: jobKind(toolUseId ? this.toolNames.get(toolUseId) : undefined, ev.task_type),
        description: String(ev.description ?? "").slice(0, 300),
        status: "running",
        startedAt: now,
        endedAt: null,
        ...(toolUseId ? { toolUseId } : {}),
      });
      changed = true;
    } else if ((ev.subtype === "task_updated" || ev.subtype === "task_notification") && id) {
      const job = this.jobs.get(id);
      const patch = (ev.subtype === "task_updated" ? ev.patch : ev) as { status?: unknown; end_time?: unknown; summary?: unknown } | undefined;
      const status = jobStatus(patch?.status);
      if (job && status && status !== job.status) {
        job.status = status;
        if (status !== "running") job.endedAt = typeof patch?.end_time === "number" ? patch.end_time : now;
        changed = true;
      }
      if (job && typeof patch?.summary === "string" && patch.summary !== job.summary) {
        job.summary = patch.summary.slice(0, 500);
        changed = true;
      }
    } else if (ev.subtype === "background_tasks_changed" && Array.isArray(ev.tasks)) {
      // The CLI's whole list of jobs still running.
      const running = new Map<string, { task_type?: unknown; description?: unknown }>();
      for (const t of ev.tasks) if (t && typeof t.task_id === "string") running.set(t.task_id, t);
      for (const job of this.jobs.values()) {
        if (job.status === "running" && !running.has(job.id)) {
          job.status = "completed";
          job.endedAt = now;
          changed = true;
        }
      }
      // A job this list names first: `task_started` follows at once and says what started it, so
      // the list goes out with that (a Monitor would read as a plain command until then).
      for (const [taskId, t] of running) {
        if (!this.jobs.has(taskId)) this.jobs.set(taskId, { id: taskId, kind: jobKind(undefined, t.task_type), description: String(t.description ?? "").slice(0, 300), status: "running", startedAt: now, endedAt: null });
      }
    }
    if (changed) this.publishJobs();
  }

  /** The last list told to the hooks, so the same list is not told twice (the CLI reports one end up to three ways). */
  private published = "";

  private publishJobs(): void {
    const ended = [...this.jobs.values()].filter((j) => j.status !== "running");
    for (const job of ended.slice(0, Math.max(0, ended.length - KEEP_ENDED_JOBS))) this.jobs.delete(job.id);
    const list = [...this.jobs.values()].map((j) => ({ ...j }));
    const text = JSON.stringify(list);
    if (text === this.published) return;
    this.published = text;
    try {
      this.hooks.onJobs?.(list);
    } catch {
      /* a listener's failure is not the process's */
    }
  }

  // ------------------------------------------------------------------ stdin

  private requestId(): string {
    return `space-${++this.serial}`;
  }

  private write(message: unknown): void {
    this.raw(JSON.stringify(message) + "\n");
  }

  private raw(text: string): void {
    if (!this.alive) return;
    try {
      this.proc.stdin.write(text);
      void this.proc.stdin.flush();
    } catch {
      this.kill();
    }
  }

  private kill(): void {
    this.alive = false;
    try {
      this.proc.kill();
    } catch {
      /* already gone */
    }
  }
}

/** What started a job: the tool call's name when known, else the CLI's task type (a Monitor is a `local_bash` task too). */
export function jobKind(tool: string | undefined, taskType: unknown): BackgroundJob["kind"] {
  const name = (tool ?? "").replace(/^mcp__.*__/, "").toLowerCase();
  if (name === "monitor") return "monitor";
  if (name === "bash") return "bash";
  if (name === "task" || name === "agent") return "agent";
  if (typeof taskType === "string" && /bash|shell/.test(taskType)) return "bash";
  if (typeof taskType === "string" && /agent/.test(taskType)) return "agent";
  return "other";
}

function jobStatus(raw: unknown): BackgroundJob["status"] | undefined {
  if (typeof raw !== "string") return undefined;
  if (/^(running|pending|started)$/.test(raw)) return "running";
  if (/^(completed|success|succeeded|done)$/.test(raw)) return "completed";
  if (/^(failed|error)$/.test(raw)) return "failed";
  if (/^(killed|stopped|cancelled|canceled|interrupted|timeout|expired)$/.test(raw)) return "stopped";
  return undefined;
}

function replayText(ev: Record<string, unknown>): string {
  const content = (ev.message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.flatMap((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? [String((c as { text?: unknown }).text ?? "")] : [])).join("\n");
  return "";
}
