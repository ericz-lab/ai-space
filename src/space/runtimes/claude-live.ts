import { approvalTitle, liveFingerprint, LIVE_STOP_GRACE_MS, agentQuestions, PendingApprovals, questionAnswers, readLines, tail, type LiveProcess } from "./live.ts";
import { PERMISSION_MODES, type AgentQuestion, type ApprovalDecision, type ChatCallbacks, type ChatHandle, type ChatTurn, type QuestionAnswers, type SteerInput } from "./types.ts";

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
 */

const TURN_ARGS = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--replay-user-messages", "--permission-prompt-tool", "stdio"];

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
  /** The turn's own message has not been replayed yet. */
  ownPending: boolean;
  /** Messages added to the turn that the CLI has not taken in yet. */
  steers: number;
  stopping: boolean;
  sessionSeen: boolean;
  stopTimer?: ReturnType<typeof setTimeout>;
};

type Approval = { input: unknown; questions?: AgentQuestion[] };

export class ClaudeLive implements LiveProcess {
  readonly fingerprint: string;
  sid: string | null;
  alive = true;
  private readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private current: Turn | null = null;
  private approvals: PendingApprovals<Approval> | null = null;
  /** Questions of the open `AskUserQuestion` requests, by request id. */
  private readonly questionsOf = new Map<string, AgentQuestion[]>();
  private model: string | undefined;
  private mode: string;
  private stderr: { text: () => string } = { text: () => "" };
  private serial = 0;

  constructor(bin: string[], first: ChatTurn, extra: string[] = []) {
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

  turn(turn: ChatTurn, cb: ChatCallbacks): ChatHandle {
    const t: Turn = { cb, ownPending: true, steers: 0, stopping: false, sessionSeen: false };
    this.current = t;
    this.approvals = new PendingApprovals((event) => cb.onEvent(JSON.stringify(event)));
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
    return {
      kill: () => this.stop(t),
      steer: (input) => this.steer(t, input),
      respond: (id, decision, answers) => this.respond(t, id, decision, answers),
    };
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
    let ev: Record<string, unknown> & { type?: string; subtype?: string; session_id?: unknown };
    try {
      ev = JSON.parse(line);
    } catch {
      this.current?.cb.onEvent(line);
      return;
    }
    const t = this.current;
    if (ev.type === "control_request") return this.controlRequest(ev as { request_id: string; request?: { subtype?: string; tool_name?: string; input?: unknown; description?: string; decision_reason?: string } });
    if (ev.type === "control_cancel_request") {
      this.questionsOf.delete(String(ev.request_id));
      return void this.approvals?.take(String(ev.request_id), "cancelled");
    }
    if (ev.type === "control_response") return;
    if (!t) return; // between turns: nothing to report to
    if (typeof ev.session_id === "string") {
      this.sid = ev.session_id;
      if (!t.sessionSeen) {
        t.sessionSeen = true;
        t.cb.onSession?.(ev.session_id);
      }
    }
    if (ev.type === "user" && ev.isReplay) {
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
      t.cb.onEvent(line);
      const error = t.stopping ? "stopped" : ev.is_error ? String(ev.result || ev.subtype || "the runtime reported an error") : null;
      return this.endTurn(error);
    }
    t.cb.onEvent(line);
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
    if (!this.current) return;
    const stopping = this.current.stopping;
    this.endTurn(stopping ? "stopped" : (this.stderr.text().trim() || `runtime exited with ${code}`).slice(-800));
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

function replayText(ev: Record<string, unknown>): string {
  const content = (ev.message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.flatMap((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? [String((c as { text?: unknown }).text ?? "")] : [])).join("\n");
  return "";
}
