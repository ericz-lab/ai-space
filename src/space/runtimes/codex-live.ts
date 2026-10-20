import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveFingerprint, LIVE_STOP_GRACE_MS, agentQuestions, PendingApprovals, questionAnswers, readLines, tail, type LiveProcess } from "./live.ts";
import type { AgentQuestion, ApprovalDecision, ChatCallbacks, ChatHandle, ChatTurn, QuestionAnswers, SteerInput } from "./types.ts";

/**
 * Codex live chat (docs/runtimes.md#live-chat): one `codex app-server` process per conversation,
 * spoken to in JSON-RPC over stdio, its thread kept open between turns. Events are translated into
 * Claude Code's `stream-json` shapes, as the one-shot `codex exec` chat does.
 *
 * - Approvals: the thread runs with `approvalPolicy: "on-request"` (unless the tier is "all
 *   permissions"), so a command or edit outside the sandbox becomes a request to the host.
 * - Questions: `request_user_input`, which Codex otherwise offers only in plan mode, is enabled for
 *   every turn; its questions reach the panel as an approval request with `questions`.
 * - Steering: `turn/steer` adds input to the running turn; it fails once the turn has ended.
 * - Stop: `turn/interrupt`; the thread stays open for the next turn.
 */

type Sandbox = { mode: "read-only" | "workspace-write" | "danger-full-access"; policy: Record<string, unknown> };

/** The panel's tier as Codex's approval policy and sandbox. */
export function codexLivePolicy(permissionMode: string | undefined): { approvalPolicy: "on-request" | "never"; sandbox: Sandbox } {
  if (permissionMode === "bypassPermissions") return { approvalPolicy: "never", sandbox: { mode: "danger-full-access", policy: { type: "dangerFullAccess" } } };
  if (permissionMode === "acceptEdits") {
    return { approvalPolicy: "on-request", sandbox: { mode: "workspace-write", policy: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } } };
  }
  const readOnly = { mode: "read-only" as const, policy: { type: "readOnly", networkAccess: false } };
  // Plan mode reads and answers; nothing to approve.
  return { approvalPolicy: permissionMode === "plan" ? "never" : "on-request", sandbox: readOnly };
}

type Rpc = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message?: string } };
type Item = { type?: string; id?: string; text?: string; command?: string; aggregatedOutput?: string | null; exitCode?: number | null; status?: string; changes?: { path: string; kind?: unknown; diff?: string }[]; server?: string; tool?: string; arguments?: unknown; result?: unknown; error?: { message?: string } | null; query?: string; content?: { type?: string; text?: string }[] };

type Turn = {
  cb: ChatCallbacks;
  id: string | null;
  /** The turn's own message item has not shown up yet. */
  ownPending: boolean;
  stopping: boolean;
  stopTimer?: ReturnType<typeof setTimeout>;
};

type Approval = { rpcId: number | string; kind: "command" | "file" | "permissions" | "question"; permissions?: unknown; questions?: AgentQuestion[] };

/** The process's command after the binary: live web search, and the question tool outside plan mode. */
export const CODEX_LIVE_ARGS = ["app-server", "-c", 'web_search="live"', "--enable", "default_mode_request_user_input"];

const TOOL_ITEMS = new Set(["commandExecution", "fileChange", "mcpToolCall", "webSearch"]);

export class CodexLive implements LiveProcess {
  readonly fingerprint: string;
  sid: string | null;
  alive = true;
  private readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private readonly ready: Promise<string>;
  private readonly calls = new Map<number, { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  private readonly fileChanges = new Map<string, string>();
  /** Questions of the open question requests, by request id. */
  private readonly questions = new Map<string, AgentQuestion[]>();
  private current: Turn | null = null;
  private approvals: PendingApprovals<Approval> | null = null;
  private serial = 0;
  private stderr: { text: () => string } = { text: () => "" };
  private imageDir: string | undefined;

  constructor(bin: string[], private readonly first: ChatTurn) {
    this.fingerprint = liveFingerprint(first);
    this.sid = first.sessionId ?? null;
    this.proc = Bun.spawn([...bin, ...CODEX_LIVE_ARGS], { cwd: first.cwd, env: first.env ?? process.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const proc = this.proc;
    this.stderr = tail(proc.stderr);
    void readLines(proc.stdout, (line) => this.line(line))
      .catch(() => {})
      .then(() => proc.exited)
      .then((code) => this.exited(code));
    this.ready = this.open();
    this.ready.catch(() => this.kill());
  }

  get busy(): boolean {
    return this.current !== null;
  }

  turn(turn: ChatTurn, cb: ChatCallbacks): ChatHandle {
    const t: Turn = { cb, id: null, ownPending: true, stopping: false };
    this.current = t;
    this.approvals = new PendingApprovals((event) => cb.onEvent(JSON.stringify(event)));
    void (async () => {
      const threadId = await this.ready;
      if (this.current !== t) return;
      this.sid = threadId;
      cb.onSession?.(threadId);
      cb.onEvent(JSON.stringify({ type: "system", subtype: "init", session_id: threadId, model: turn.model ?? "codex" }));
      if (t.stopping) return this.endTurn("stopped");
      const { approvalPolicy, sandbox } = codexLivePolicy(turn.permissionMode);
      const result = await this.call("turn/start", {
        threadId,
        input: await this.input(turn),
        approvalPolicy,
        sandboxPolicy: sandbox.policy,
        ...(turn.model ? { model: turn.model } : {}),
      });
      const id = (result.turn as { id?: string } | undefined)?.id;
      if (this.current !== t) return;
      t.id = id ?? null;
      if (t.stopping) this.interrupt(t);
    })().catch((e) => {
      if (this.current === t) this.endTurn(t.stopping ? "stopped" : `could not run Codex: ${(e as Error).message}`);
    });
    return {
      kill: () => this.stop(t),
      steer: (input) => this.steer(t, input),
      respond: (id, decision, answers) => this.respond(t, id, decision, answers),
    };
  }

  close(): void {
    if (!this.alive) return;
    this.kill();
  }

  // ------------------------------------------------------------------ turn operations

  private async steer(t: Turn, input: SteerInput): Promise<void> {
    if (this.current !== t || t.stopping || !t.id || !this.sid) throw new Error("the turn cannot take a message now; send it as a new one");
    await this.call("turn/steer", { threadId: this.sid, expectedTurnId: t.id, input: await this.input(input) });
  }

  private respond(t: Turn, id: string, decision: ApprovalDecision, answers?: QuestionAnswers): boolean {
    if (this.current !== t) return false;
    const questions = this.questions.get(id);
    const given = questions && decision === "allow" ? questionAnswers(questions, answers) : null;
    // A question without answers is skipped: Codex gets no answers and the agent goes on without them.
    const approval = this.approvals?.take(id, questions && !given ? "deny" : decision, given ?? undefined);
    if (!approval) return false;
    this.questions.delete(id);
    if (approval.kind === "question") {
      this.write({ id: approval.rpcId, result: { answers: Object.fromEntries(Object.entries(given ?? {}).map(([q, a]) => [q, { answers: a }])) } });
      return true;
    }
    const result = approval.kind === "permissions"
      ? { permissions: decision === "allow" ? approval.permissions ?? {} : {}, scope: "turn" }
      : { decision: decision === "allow" ? "accept" : "decline" };
    this.write({ id: approval.rpcId, result });
    return true;
  }

  private stop(t: Turn): void {
    if (this.current !== t || t.stopping) return;
    t.stopping = true;
    for (const id of this.approvals?.ids() ?? []) this.respond(t, id, "deny");
    // Before the turn has an id there is nothing to interrupt yet: `turn` interrupts it once it does.
    if (t.id) this.interrupt(t);
    t.stopTimer = setTimeout(() => this.kill(), LIVE_STOP_GRACE_MS);
    t.stopTimer.unref?.();
  }

  private interrupt(t: Turn): void {
    if (this.sid && t.id) this.call("turn/interrupt", { threadId: this.sid, turnId: t.id }).catch(() => this.kill());
  }

  // ------------------------------------------------------------------ protocol

  /** Handshake, then the conversation's thread: resumed when the turn names one, else a new one. */
  private async open(): Promise<string> {
    await this.call("initialize", { clientInfo: { name: "ai_space", title: "ai-space", version: "1.0" } });
    this.write({ method: "initialized", params: {} });
    const t = this.first;
    const { approvalPolicy, sandbox } = codexLivePolicy(t.permissionMode);
    const params = {
      cwd: t.cwd,
      approvalPolicy,
      sandbox: sandbox.mode,
      ...(t.model ? { model: t.model } : {}),
      ...(t.systemPrompt ? { developerInstructions: t.systemPrompt } : {}),
    };
    const result = t.sessionId ? await this.call("thread/resume", { threadId: t.sessionId, ...params }) : await this.call("thread/start", params);
    const id = (result.thread as { id?: string } | undefined)?.id;
    if (!id) throw new Error("Codex did not name the thread");
    return id;
  }

  private async input(input: SteerInput): Promise<unknown[]> {
    const items: unknown[] = input.message ? [{ type: "text", text: input.message, text_elements: [] }] : [];
    if (input.images?.length) {
      this.imageDir ??= await mkdtemp(join(tmpdir(), "space-chat-images-"));
      for (const image of input.images) {
        const path = join(this.imageDir, `image${++this.serial}.${image.mediaType.split("/")[1]}`);
        await Bun.write(path, Buffer.from(image.data, "base64"));
        items.push({ type: "localImage", path });
      }
    }
    return items;
  }

  private call(method: string, params: unknown): Promise<Record<string, unknown>> {
    if (!this.alive) return Promise.reject(new Error("Codex app-server is not running"));
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }

  private line(line: string): void {
    let m: Rpc;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.method && m.id !== undefined) return this.serverRequest(m);
    if (m.id !== undefined) {
      const call = this.calls.get(Number(m.id));
      if (!call) return;
      this.calls.delete(Number(m.id));
      if (m.error) call.reject(new Error(m.error.message ?? "Codex protocol error"));
      else call.resolve(m.result ?? {});
      return;
    }
    if (m.method) this.notification(m.method, m.params ?? {});
  }

  private serverRequest(m: Rpc): void {
    const p = m.params ?? {};
    const t = this.current;
    const kind = m.method === "item/commandExecution/requestApproval" ? "command" : m.method === "item/fileChange/requestApproval" ? "file" : m.method === "item/permissions/requestApproval" ? "permissions" : m.method === "item/tool/requestUserInput" ? "question" : null;
    if (!kind || !t || t.stopping || !this.approvals || (t.id && p.turnId !== t.id)) {
      if (kind === "permissions") return this.write({ id: m.id, result: { permissions: {}, scope: "turn" } });
      if (kind === "question") return this.write({ id: m.id, result: { answers: {} } });
      if (kind) return this.write({ id: m.id, result: { decision: "decline" } });
      return this.write({ id: m.id, error: { code: -32601, message: `ai-space does not handle ${m.method}` } });
    }
    const reason = typeof p.reason === "string" && p.reason ? { detail: p.reason.slice(0, 2000) } : {};
    const id = `codex-${String(m.id)}`;
    if (kind === "question") {
      const questions = agentQuestions(p.questions);
      this.questions.set(id, questions);
      return this.approvals.add(id, { rpcId: m.id!, kind }, { tool: "AskUserQuestion", title: questions.map((q) => q.question).join("\n").slice(0, 2000), questions });
    }
    if (kind === "command") this.approvals.add(id, { rpcId: m.id!, kind }, { tool: "Bash", title: String(p.command ?? "").slice(0, 2000), ...reason, input: { command: p.command, cwd: p.cwd } });
    else if (kind === "file") this.approvals.add(id, { rpcId: m.id!, kind }, { tool: "Edit", title: this.fileChanges.get(String(p.itemId)) ?? String(p.grantRoot ?? ""), ...reason });
    else this.approvals.add(id, { rpcId: m.id!, kind, permissions: p.permissions }, { tool: "Permissions", title: JSON.stringify(p.permissions ?? {}).slice(0, 2000), ...reason });
  }

  private notification(method: string, p: Record<string, unknown>): void {
    const t = this.current;
    if (!t || (this.sid && p.threadId !== undefined && p.threadId !== this.sid)) return;
    if (t.id && p.turnId !== undefined && p.turnId !== t.id) return;
    const emit = (event: unknown) => t.cb.onEvent(JSON.stringify(event));
    if (method === "serverRequest/resolved") {
      this.questions.delete(`codex-${String(p.requestId)}`);
      return void this.approvals?.take(`codex-${String(p.requestId)}`, "cancelled");
    }
    if (method === "item/agentMessage/delta" && typeof p.delta === "string") {
      return emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: p.delta } } });
    }
    if (method === "turn/completed") {
      const turn = (p.turn ?? {}) as { status?: string; error?: { message?: string } | null };
      if (turn.status === "completed" && !t.stopping) {
        emit({ type: "result", session_id: this.sid, is_error: false });
        return this.endTurn(null);
      }
      return this.endTurn(t.stopping || turn.status === "interrupted" ? "stopped" : turn.error?.message ?? `Codex turn ${turn.status ?? "failed"}`);
    }
    if (method !== "item/started" && method !== "item/completed") return;
    const item = (p.item ?? {}) as Item;
    if (item.type === "userMessage" && method === "item/started") {
      if (t.ownPending) t.ownPending = false;
      else emit({ type: "steer", text: (item.content ?? []).flatMap((c) => (c.type === "text" && c.text ? [c.text] : [])).join("\n") });
      return;
    }
    if (item.type === "agentMessage" && method === "item/completed" && item.text) {
      return emit({ type: "assistant", message: { content: [{ type: "text", text: item.text }] } });
    }
    if (!item.type || !TOOL_ITEMS.has(item.type) || !item.id) return;
    if (item.type === "fileChange") this.fileChanges.set(item.id, (item.changes ?? []).map((c) => c.path).join(", "));
    const name = item.type === "commandExecution" ? "Bash" : item.type === "fileChange" ? "Edit" : item.type === "webSearch" ? "WebSearch" : item.tool ?? item.type;
    const input = item.type === "mcpToolCall" ? item.arguments ?? {} : { command: item.command ?? item.query ?? item.changes?.map((c) => c.path).join(", ") ?? "" };
    emit({ type: "assistant", message: { content: [{ type: "tool_use", id: item.id, name, input }] } });
    if (method === "item/completed") {
      const failed = item.status === "failed" || item.status === "declined" || (typeof item.exitCode === "number" && item.exitCode !== 0) || Boolean(item.error);
      const output = item.aggregatedOutput ?? item.error?.message ?? item.result ?? item.changes?.map((c) => c.diff ?? c.path).join("\n") ?? "";
      const content = (typeof output === "string" ? output : JSON.stringify(output)).slice(0, 12000);
      emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: item.id, is_error: failed, content }] } });
    }
  }

  private endTurn(error: string | null): void {
    const t = this.current;
    if (!t) return;
    clearTimeout(t.stopTimer);
    for (const id of this.approvals?.ids() ?? []) this.approvals?.take(id, "cancelled");
    this.questions.clear();
    this.current = null;
    this.approvals = null;
    t.cb.onFinish(error);
  }

  private exited(code: number): void {
    this.alive = false;
    for (const call of this.calls.values()) call.reject(new Error("Codex app-server exited"));
    this.calls.clear();
    if (this.imageDir) void rm(this.imageDir, { recursive: true, force: true });
    if (!this.current) return;
    this.endTurn(this.current.stopping ? "stopped" : (this.stderr.text().trim() || `Codex app-server exited with ${code}`).slice(-800));
  }

  private write(message: unknown): void {
    if (!this.alive) return;
    try {
      this.proc.stdin.write(JSON.stringify(message) + "\n");
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
