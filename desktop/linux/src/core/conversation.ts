import { type Activity, type ChatImage, type ChatStep, type Failure, type Permission, type TurnRequest, TurnReply, classifyFailure, granting, turnBody } from "./chat.ts";
import { SpaceError } from "./check.ts";
import type { SSEMessage } from "./sse.ts";
import { escapeSegment } from "./url.ts";
import { historySteps, type HistoryStep } from "../../../../src/web/chat-steps.ts";

/**
 * One native conversation with an agent, shared by the main window and Quick Chat: the Mac's
 * `ChatController` (desktop/macos/AISpace/Desktop/ChatController.swift) without a UI toolkit.
 * Each turn is a background run on the Space: a dropped stream reattaches after the last event it
 * saw, and only Stop ends the run, so closing a window or losing the network never resends a prompt.
 */

export type ChatMessage = {
  id: string;
  role: "user" | "agent";
  text: string;
  images: ChatImage[];
  tools: string[];
  steps: ChatStep[];
  denied: string[];
  activity?: Activity;
  live: boolean;
  /** Messages added to the running turn that the agent has not read yet. */
  pending: string[];
  failure?: Failure;
  /** An error result with no reply text, drawn under the steps (it is part of `text` too). */
  note?: string;
  /** Stop ended the turn (also said at the end of `text`). */
  stopped?: boolean;
  /** Restored from a stored session: its runs of tool calls fold to one line. */
  historic: boolean;
};

export type SessionInfo = { sid: string; title: string; ts: number; runtime?: string | null; model?: string | null };
export type RunInfo = { id: string; agent: string; message: string; status: string };

/** The native calls a conversation needs; the app's are libsoup requests with the connection's cookies. */
export interface ChatApi {
  /** An event stream; `runId` is the response's `x-run-id`. Throws `SpaceError` before the stream opens. */
  events(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<{ runId?: string; messages: AsyncIterable<SSEMessage>; close(): void }>;
  send(method: string, path: string, body: Record<string, unknown>): Promise<unknown>;
  get(path: string): Promise<unknown>;
}

export type ConversationOptions = {
  permission: () => Permission;
  setPermission: (p: Permission) => void;
  sleep: (ms: number) => Promise<void>;
  newId: () => string;
  /** Called after every change: the view redraws from `messages`, `busy` and `error`. */
  onChange: () => void;
  /** A turn may install or change apps, even when it fails or is stopped. */
  onTurnEnded?: () => void;
  text: { stopped: string; signIn: string; lost: string; grantMessage: string; noTurn: string; answerFailed: (why: string) => string };
};

type Source = { kind: "new"; turn: TurnRequest } | { kind: "attach"; runId: string };

export class Conversation {
  messages: ChatMessage[] = [];
  busy = false;
  error: string | undefined;
  sessions: SessionInfo[] = [];
  sessionId: string | undefined;
  private runId: string | undefined;
  /** One thread's identity: a late answer for a steer of an old thread must not land in a new one. */
  private thread = 0;
  private queue: { message: string; turn: TurnRequest }[] = [];
  private pending: string[] = [];
  private steersSeen = 0;
  private stopRequested = false;
  private cancelled = false;
  private stream: { close(): void } | undefined;

  constructor(
    readonly agent: { id: string; base: string },
    private readonly api: ChatApi,
    private readonly o: ConversationOptions,
  ) {}

  private message(role: ChatMessage["role"], text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
    return { id: this.o.newId(), role, text, images: [], tools: [], steps: [], denied: [], live: false, pending: [], historic: false, ...extra };
  }

  /** Picks up a turn of this agent still running on the Space, from any client. */
  attachRunning(runs: RunInfo[]): void {
    if (this.busy || this.messages.length) return;
    const run = runs.find((r) => r.agent === this.agent.id && r.status === "running");
    if (!run) return;
    this.messages.push(this.message("user", run.message));
    this.start({ kind: "attach", runId: run.id });
  }

  /**
   * Sends a message. While a turn runs it joins that turn (the agent reads it after its current
   * step); a turn that cannot take it is queued and sent next, in order, so nothing is lost.
   */
  send(text: string, images: ChatImage[] = []): void {
    const message = text.trim();
    if (!message && !images.length) return;
    const turn: TurnRequest = { message, permission: this.o.permission(), images };
    if (this.busy) {
      if (this.runId && !this.queue.length && !this.stopRequested) this.steer(turn, this.runId);
      else this.enqueue(turn);
      this.o.onChange();
      return;
    }
    this.messages.push(this.message("user", message, { images }));
    this.start({ kind: "new", turn });
  }

  /** The person's answer to an approval or a question of the running turn; undefined when it reached the Space. */
  async answer(requestId: string, allow: boolean, answers?: Record<string, string[]>): Promise<string | undefined> {
    if (!this.runId) return this.o.text.noTurn;
    try {
      await this.api.send("POST", `${this.agent.base}/runs/${escapeSegment(this.runId)}/approvals/${escapeSegment(requestId)}`, { decision: allow ? "allow" : "deny", ...(answers ? { answers } : {}) });
      return undefined;
    } catch (e) {
      return this.o.text.answerFailed((e as Error).message);
    }
  }

  private steer(turn: TurnRequest, runId: string): void {
    const label = turn.message || `🖼 ×${turn.images.length}`;
    const thread = this.thread;
    this.markPending(label, true);
    void this.api
      .send("POST", `${this.agent.base}/runs/${escapeSegment(runId)}/steer`, { message: turn.message, ...(turn.images.length ? { images: turn.images } : {}) })
      .catch(() => {
        // The person moved to another thread meanwhile: the message belonged to the one that is gone.
        if (this.thread !== thread) return;
        this.markPending(label, false);
        this.enqueue(turn);
        if (!this.busy) this.next();
        this.o.onChange();
      });
  }

  private markPending(label: string, add: boolean): void {
    if (add) this.pending.push(label);
    else {
      const at = this.pending.lastIndexOf(label);
      if (at >= 0) this.pending.splice(at, 1);
    }
    const live = [...this.messages].reverse().find((m) => m.role === "agent" && m.live);
    if (live) live.pending = [...this.pending];
  }

  /** The reply took an added message in: by its text, or the oldest waiting one for an image-only message. */
  private takePending(text: string): void {
    const wanted = text.trim();
    const at = this.pending.findIndex((p) => p.trim() === wanted);
    if (at >= 0) this.pending.splice(at, 1);
    else if (this.pending.length) this.pending.shift();
  }

  private enqueue(turn: TurnRequest): void {
    const m = this.message("user", turn.message, { images: turn.images });
    this.messages.push(m);
    this.queue.push({ message: m.id, turn });
  }

  /** The message of the last turn when that turn failed: what Try Again sends once more. */
  get retryableMessage(): string | undefined {
    const last = this.messages.at(-1);
    const prompt = this.messages.at(-2);
    if (this.busy || !last || last.role !== "agent" || !last.failure || !prompt || prompt.role !== "user") return undefined;
    return prompt.text;
  }

  retry(): void {
    const text = this.retryableMessage;
    if (text === undefined) return;
    this.messages.pop();
    this.start({ kind: "new", turn: { message: text, permission: this.o.permission(), images: this.messages.at(-1)?.images ?? [] } });
  }

  /** Raises the permission for the refused tools and asks the agent to finish the step. */
  grantAndRetry(): void {
    const last = this.messages.at(-1);
    if (this.busy || !last || last.role !== "agent" || !last.denied.length) return;
    const permission = granting(this.o.permission(), last.denied);
    this.o.setPermission(permission);
    const text = this.o.text.grantMessage;
    this.messages.push(this.message("user", text));
    this.start({ kind: "new", turn: { message: text, permission, images: [] } });
  }

  /** Stop ends the run on the Space; pressed before the run has an id, it is sent as soon as it has one. */
  stop(): void {
    this.stopRequested = true;
    if (this.runId) this.sendStop(this.runId);
    else if (this.stream) {
      // A stream without a run id (an old Space) cannot be stopped on the server: only left.
      this.cancelled = true;
      this.stream.close();
    }
  }

  private sendStop(runId: string): void {
    void this.api.send("POST", `${this.agent.base}/runs/${escapeSegment(runId)}/stop`, {}).catch(() => {});
  }

  async loadSessions(): Promise<void> {
    try {
      const body = (await this.api.get(`${this.agent.base}/sessions`)) as { sessions?: SessionInfo[] };
      this.sessions = Array.isArray(body.sessions) ? body.sessions.filter((s) => typeof s?.sid === "string") : [];
      this.o.onChange();
    } catch {}
  }

  /** Shows a stored conversation; the next message continues it. */
  async open(session: SessionInfo): Promise<void> {
    if (this.busy) return;
    try {
      const body = (await this.api.get(`${this.agent.base}/sessions/${escapeSegment(session.sid)}`)) as { messages?: { role: string; text?: string; tools?: { name: string }[]; steps?: HistoryStep[] }[] };
      this.messages = (body.messages ?? []).flatMap((m) => {
        const user = m.role === "user";
        const steps = user ? [] : historySteps((m.steps ?? []).filter((s) => s && (s.kind === "text" || s.kind === "tool")));
        if (!m.text && !steps.length) return [];
        return [this.message(user ? "user" : "agent", m.text ?? "", { tools: (m.tools ?? []).map((t) => t.name), steps, historic: !user })];
      });
      this.sessionId = session.sid;
      this.thread++;
      this.error = undefined;
    } catch (e) {
      this.error = (e as Error).message;
    }
    this.o.onChange();
  }

  newConversation(): void {
    if (this.busy) return;
    this.messages = [];
    this.sessionId = undefined;
    this.thread++;
    this.error = undefined;
    this.o.onChange();
  }

  private next(): boolean {
    const q = this.queue.shift();
    if (!q) return false;
    this.start({ kind: "new", turn: q.turn }, q.message);
    return true;
  }

  private start(source: Source, replyingTo?: string): void {
    this.busy = true;
    this.error = undefined;
    this.stopRequested = false;
    this.cancelled = false;
    this.pending = [];
    this.steersSeen = 0;
    const reply = new TurnReply();
    if (source.kind === "attach") reply.activity = { kind: "reconnecting" };
    const placeholder = this.message("agent", "", { live: true, ...(reply.activity ? { activity: reply.activity } : {}) });
    // A queued turn's reply belongs right after its own message, not at the end.
    const at = replyingTo ? this.messages.findIndex((m) => m.id === replyingTo) : -1;
    if (at >= 0) this.messages.splice(at + 1, 0, placeholder);
    else this.messages.push(placeholder);
    this.runId = source.kind === "attach" ? source.runId : undefined;
    this.o.onChange();
    void this.run(source, reply, placeholder);
  }

  private async run(source: Source, reply: TurnReply, target: ChatMessage): Promise<void> {
    let lastSeq = 0;
    let failures = 0;
    while (!reply.finished && !this.cancelled) {
      try {
        let opened;
        if (this.runId) opened = await this.api.events("GET", `${this.agent.base}/runs/${escapeSegment(this.runId)}/events?after=${lastSeq}`);
        else if (source.kind === "new") {
          opened = await this.api.events("POST", `${this.agent.base}/chat`, turnBody(source.turn, this.sessionId));
          this.runId = opened.runId;
          if (this.stopRequested && this.runId) this.sendStop(this.runId);
        } else break;
        this.stream = opened;
        for await (const m of opened.messages) {
          if (m.id !== undefined) {
            if (m.id <= lastSeq) continue;
            lastSeq = m.id;
          }
          reply.apply(m.data);
          failures = 0;
          this.update(target, reply);
          if (reply.finished) break;
        }
      } catch (e) {
        if (e instanceof SpaceError && e.kind === "signin") {
          this.fail(target, { kind: "connection", detail: this.o.text.signIn });
          break;
        }
        // A turn that never got a run cannot be reattached; one that did is resumed.
        if (!this.runId) {
          this.fail(target, e instanceof SpaceError && e.kind === "http" ? classifyFailure(e.message) : { kind: "connection", detail: (e as Error).message });
          break;
        }
      } finally {
        this.stream = undefined;
      }
      if (reply.finished || this.cancelled) break;
      failures++;
      if (failures > 20) {
        this.fail(target, { kind: "connection", detail: this.o.text.lost });
        break;
      }
      reply.activity = { kind: "reconnecting" };
      this.update(target, reply);
      await this.o.sleep(Math.min(10, failures * 2) * 1000);
    }
    if (reply.sessionId) this.sessionId = reply.sessionId;
    reply.end();
    this.update(target, reply);
    target.live = false;
    target.pending = [];
    delete target.activity;
    this.runId = undefined;
    this.o.onTurnEnded?.();
    if (!this.next()) {
      this.pending = [];
      this.stopRequested = false;
      this.busy = false;
    }
    this.o.onChange();
  }

  private update(target: ChatMessage, reply: TurnReply): void {
    // A failure is drawn as its own card, so the text keeps only what the agent wrote.
    let text = reply.failure === undefined ? reply.text : reply.body;
    if (reply.stopped) text += (text ? "\n\n" : "") + this.o.text.stopped;
    target.text = text;
    target.tools = [...reply.tools];
    target.steps = reply.steps;
    target.denied = [...reply.denied];
    if (reply.failure === undefined && reply.note !== undefined) target.note = reply.note;
    if (reply.stopped) target.stopped = true;
    while (this.steersSeen < reply.consumedSteers.length) this.takePending(reply.consumedSteers[this.steersSeen++]!);
    target.pending = [...this.pending];
    if (reply.activity) target.activity = reply.activity;
    else delete target.activity;
    if (reply.failure !== undefined) target.failure = classifyFailure(reply.failure);
    this.o.onChange();
  }

  private fail(target: ChatMessage, failure: Failure): void {
    delete target.activity;
    target.failure = failure;
    this.o.onChange();
  }
}
