import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvalTitle, liveFingerprint, LIVE_STOP_GRACE_MS, PendingApprovals, readLines, tail, type LiveProcess } from "./live.ts";
import type { ApprovalDecision, ChatCallbacks, ChatHandle, ChatTurn } from "./types.ts";

/**
 * DeepSeek Harness live chat (docs/runtimes.md#live-chat): one `dsh --profile acp`
 * process per conversation, spoken to in the Agent Client Protocol over stdio
 * (newline-delimited JSON-RPC), its session kept open between turns.
 *
 * - Approvals: the harness asks `session/request_permission` before an action its
 *   sandbox and approval preset do not cover; the answer selects `allow_once` or
 *   `reject_once` from the options the harness offered.
 * - Stop: `session/cancel`; the prompt settles with `stopReason: "cancelled"` and
 *   the process stays open for the next turn.
 * - Reuse: `session/new` names the session the conversation keeps; a later process
 *   for the same conversation resumes it with `session/resume`.
 * - Model: the overlay sets the first route, `session/set_config_option` switches
 *   it between turns.
 *
 * ACP carries one prompt at a time and has no way to add a message to a running
 * turn, so a live DeepSeek Harness turn has no `steer`.
 *
 * The persona travels in the process's `--patch` overlay (the ACP profile's own
 * prompt is replaced); the profile and its tools stay as configured.
 */

const PROTOCOL_VERSION = 1;
const MODEL_CONFIG_ID = "model";
/** The model a conversation starts on when the first turn names none. */
const DEFAULT_MODELS: Record<string, string> = { "deepseek-official": "deepseek-v4-flash", "deepseek-account": "deepseek-flash" };

export type AcpPatchOptions = {
  /** The agent's prompt: the harness's own identity and runtime context stay. */
  persona?: string;
  provider: string;
  model: string;
};

/** ACP's opaque model option value: the full route as JSON. */
export function acpModelValue(provider: string, model: string): string {
  return JSON.stringify([provider, model]);
}

/** `provider:model` or a bare model, with the configured route as the default provider. */
export function acpModel(model: string, provider: string): { provider: string; model: string } {
  const i = model.indexOf(":");
  return i > 0 ? { provider: model.slice(0, i), model: model.slice(i + 1) } : { provider, model };
}

/** The model a process starts on. */
export function defaultAcpModel(provider: string): string {
  return DEFAULT_MODELS[provider] ?? "deepseek-v4-flash";
}

/** The `--patch` overlay for a live process: the persona and the session's first model route. */
export function buildAcpPatch(o: AcpPatchOptions): string {
  const rows: string[] = [];
  if (o.persona) rows.push(`- id: system-prompt\n  config:\n    personaPrefix: ${JSON.stringify(o.persona)}`);
  rows.push(`- id: acp\n  config:\n    provider: ${JSON.stringify(o.provider)}\n    model: ${JSON.stringify(o.model)}`);
  return `${rows.join("\n")}\n`;
}

type Rpc = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
};

type Content = { type?: string; text?: string; content?: unknown };

type Update = {
  sessionUpdate?: string;
  content?: unknown;
  toolCallId?: string;
  title?: string;
  name?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
};

type SeenTool = { title: string; name?: string; input?: unknown };

type Option = { optionId: string; kind: string };
type Approval = { rpcId: number | string; options: Option[] };

type Turn = {
  cb: ChatCallbacks;
  stopping: boolean;
  stopTimer?: ReturnType<typeof setTimeout>;
};

/** Read the text of a prompt/update content block or a tool result's content list. */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const c = content as Content;
    return c.type === "text" && typeof c.text === "string" ? c.text : "";
  }
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const c = item as Content;
    if (c.type === "content") parts.push(contentText(c.content));
    else if (typeof c.text === "string") parts.push(c.text);
  }
  return parts.filter(Boolean).join("\n");
}

/** The model a `configOptions` list reports as current. */
function currentModel(options: unknown): { provider: string; model: string } | undefined {
  if (!Array.isArray(options)) return undefined;
  const option = options.find((o) => o && typeof o === "object" && (o as { id?: string }).id === MODEL_CONFIG_ID) as { currentValue?: unknown } | undefined;
  if (typeof option?.currentValue !== "string") return undefined;
  try {
    const value = JSON.parse(option.currentValue) as unknown;
    if (Array.isArray(value) && typeof value[0] === "string" && typeof value[1] === "string") return { provider: value[0], model: value[1] };
  } catch {
    /* an unknown value keeps the model the overlay set */
  }
  return undefined;
}

export type DshLiveOptions = {
  bin: string[];
  profile: string;
  provider: string;
  turn: ChatTurn;
};

export class DshLive implements LiveProcess {
  readonly fingerprint: string;
  sid: string | null;
  alive = true;
  private readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private readonly ready: Promise<string>;
  private readonly calls = new Map<number, { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  private readonly tools = new Map<string, SeenTool>();
  private readonly dir: string;
  private readonly first: ChatTurn;
  private current: Turn | null = null;
  private approvals: PendingApprovals<Approval> | null = null;
  private serial = 0;
  private stderr: { text: () => string } = { text: () => "" };
  private model: { provider: string; model: string };
  private imageSupport = false;

  constructor(opts: DshLiveOptions) {
    this.first = opts.turn;
    this.fingerprint = liveFingerprint(opts.turn);
    this.sid = opts.turn.sessionId ?? null;
    this.model = acpModel(opts.turn.model ?? defaultAcpModel(opts.provider), opts.provider);
    this.dir = mkdtempSync(join(tmpdir(), "space-dsh-acp-"));
    const file = join(this.dir, "patch.yml");
    writeFileSync(file, buildAcpPatch({ persona: opts.turn.systemPrompt, provider: this.model.provider, model: this.model.model }), { mode: 0o600 });
    this.proc = Bun.spawn([...opts.bin, "--profile", opts.profile, "--patch", file], {
      cwd: opts.turn.cwd,
      env: opts.turn.env ?? process.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
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
    const t: Turn = { cb, stopping: false };
    this.current = t;
    this.approvals = new PendingApprovals((event) => cb.onEvent(JSON.stringify(event)));
    void (async () => {
      const sid = await this.ready;
      if (this.current !== t) return;
      cb.onSession?.(sid);
      cb.onEvent(JSON.stringify({ type: "system", subtype: "init", session_id: sid, model: `${this.model.provider}:${this.model.model}` }));
      if (t.stopping) return this.cancel();
      if (turn.images?.length && !this.imageSupport) throw new Error("this model route does not support images");
      const want = acpModel(turn.model ?? defaultAcpModel(this.model.provider), this.model.provider);
      if (want.provider !== this.model.provider || want.model !== this.model.model) {
        await this.call("session/set_config_option", { sessionId: sid, configId: MODEL_CONFIG_ID, value: acpModelValue(want.provider, want.model) });
        if (this.current !== t) return;
        this.model = want;
      }
      const prompt = [
        ...(turn.message ? [{ type: "text", text: turn.message }] : []),
        ...(turn.images ?? []).map((image) => ({ type: "image", data: image.data, mimeType: image.mediaType })),
      ];
      const result = await this.call("session/prompt", { sessionId: sid, prompt });
      if (this.current !== t) return;
      const reason = String(result.stopReason ?? "end_turn");
      if (reason === "cancelled") {
        cb.onEvent(JSON.stringify({ type: "result", session_id: sid, is_error: false, subtype: "cancelled", result: "" }));
        return this.endTurn(t.stopping ? "stopped" : null);
      }
      if (reason === "refusal") {
        const error = "the agent refused the turn";
        cb.onEvent(JSON.stringify({ type: "result", session_id: sid, is_error: true, result: error }));
        return this.endTurn(error);
      }
      cb.onEvent(JSON.stringify({ type: "result", session_id: sid, is_error: false, result: "" }));
      this.endTurn(null);
    })().catch((e) => {
      if (this.current === t) this.endTurn(t.stopping ? "stopped" : `could not run DeepSeek Harness: ${(e as Error).message}`);
    });
    return {
      kill: () => this.stop(t),
      respond: (id, decision) => this.respond(t, id, decision),
    };
  }

  close(): void {
    if (!this.alive) return;
    if (this.sid) this.write({ jsonrpc: "2.0", id: ++this.serial, method: "session/close", params: { sessionId: this.sid } });
    this.alive = false;
    // ACP serves until the client disconnects: closing stdin lets the harness exit cleanly.
    try {
      this.proc.stdin.end();
    } catch {
      /* already closed */
    }
    setTimeout(() => this.kill(), 500).unref?.();
  }

  // ------------------------------------------------------------------ turn operations

  private stop(t: Turn): void {
    if (this.current !== t || t.stopping) return;
    t.stopping = true;
    for (const id of this.approvals?.ids() ?? []) this.respond(t, id, "deny");
    this.cancel();
    t.stopTimer = setTimeout(() => this.kill(), LIVE_STOP_GRACE_MS);
    t.stopTimer.unref?.();
  }

  private cancel(): void {
    if (this.sid) this.write({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.sid } });
  }

  private respond(t: Turn, id: string, decision: ApprovalDecision): boolean {
    if (this.current !== t) return false;
    const approval = this.approvals?.take(id, decision);
    if (!approval) return false;
    const option = decision === "allow"
      ? approval.options.find((o) => o.kind === "allow_once") ?? approval.options.find((o) => o.kind === "allow_always")
      : approval.options.find((o) => o.kind === "reject_once") ?? approval.options.find((o) => o.kind === "reject_always");
    this.write({
      jsonrpc: "2.0",
      id: approval.rpcId,
      result: option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } },
    });
    return true;
  }

  // ------------------------------------------------------------------ protocol

  /** Handshake, then the conversation's session: resumed when the turn names one, else a new one. */
  private async open(): Promise<string> {
    const init = await this.call("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: "ai-space", version: "1.0" } });
    const image = (init.agentCapabilities as { promptCapabilities?: { image?: unknown } } | undefined)?.promptCapabilities?.image;
    this.imageSupport = image === true;
    const base = { cwd: this.first.cwd, mcpServers: [] };
    const result = this.first.sessionId
      ? await this.call("session/resume", { sessionId: this.first.sessionId, ...base })
      : await this.call("session/new", base);
    // A resumed session answers with its options only; the id is the one the turn named.
    const sid = typeof result.sessionId === "string" ? result.sessionId : this.first.sessionId;
    if (!sid) throw new Error("DeepSeek Harness did not name the session");
    this.sid = sid;
    const current = currentModel(result.configOptions);
    if (current) this.model = current;
    return sid;
  }

  private call(method: string, params: unknown): Promise<Record<string, unknown>> {
    if (!this.alive) return Promise.reject(new Error("DeepSeek Harness is not running"));
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private line(line: string): void {
    let m: Rpc;
    try {
      m = JSON.parse(line) as Rpc;
    } catch {
      return;
    }
    if (!m || typeof m !== "object") return;
    if (m.method && m.id !== undefined) return this.serverRequest(m);
    if (m.id !== undefined) {
      const call = this.calls.get(Number(m.id));
      if (!call) return;
      this.calls.delete(Number(m.id));
      if (m.error) call.reject(new Error(m.error.message ?? "DeepSeek Harness protocol error"));
      else call.resolve(m.result ?? {});
      return;
    }
    if (m.method === "session/update" && m.params) this.update(m.params);
  }

  private serverRequest(m: Rpc): void {
    if (m.method === "session/request_permission" && m.params) return this.permission(m);
    this.write({ jsonrpc: "2.0", id: m.id!, error: { code: -32601, message: `ai-space does not handle ${m.method}` } });
  }

  private permission(m: Rpc): void {
    const params = m.params ?? {};
    const callId = String((params.toolCall as { toolCallId?: string } | undefined)?.toolCallId ?? "");
    const seen = this.tools.get(callId);
    const options = (Array.isArray(params.options) ? params.options : [])
      .filter((o): o is Option => Boolean(o) && typeof o === "object" && typeof (o as Option).optionId === "string" && typeof (o as Option).kind === "string")
      .map((o) => ({ optionId: o.optionId, kind: o.kind }));
    const t = this.current;
    if (!t || t.stopping || !this.approvals || (this.sid && typeof params.sessionId === "string" && params.sessionId !== this.sid)) {
      this.write({ jsonrpc: "2.0", id: m.id!, result: { outcome: { outcome: "cancelled" } } });
      return;
    }
    const input = seen?.input;
    const reason = input && typeof input === "object"
      ? [(input as Record<string, unknown>).description, (input as Record<string, unknown>).justification].find((v) => typeof v === "string" && v)
      : undefined;
    const id = `dsh-${String(m.id)}`;
    this.approvals.add(id, { rpcId: m.id!, options }, {
      tool: seen?.name ?? seen?.title ?? "Tool",
      title: approvalTitle(input) || seen?.title || "DeepSeek Harness",
      ...(typeof reason === "string" ? { detail: reason.slice(0, 2000) } : {}),
      input,
    });
  }

  private update(params: Record<string, unknown>): void {
    const t = this.current;
    if (!t) return;
    if (this.sid && typeof params.sessionId === "string" && params.sessionId !== this.sid) return;
    const u = (params.update ?? {}) as Update;
    const emit = (event: unknown) => t.cb.onEvent(JSON.stringify(event));
    if (u.sessionUpdate === "agent_message_chunk") {
      const text = contentText(u.content);
      if (text) emit({ type: "assistant", message: { content: [{ type: "text", text }] } });
      return;
    }
    if (u.sessionUpdate === "tool_call" && u.toolCallId) {
      const input = u.rawInput ?? {};
      this.tools.set(u.toolCallId, { title: String(u.title ?? u.name ?? "Tool"), ...(u.name ? { name: u.name } : {}), input });
      emit({ type: "assistant", message: { content: [{ type: "tool_use", id: u.toolCallId, name: u.name ?? u.title ?? "tool", input }] } });
      return;
    }
    if (u.sessionUpdate === "tool_call_update" && u.toolCallId && (u.status === "completed" || u.status === "failed")) {
      const seen = this.tools.get(u.toolCallId);
      if (seen && typeof u.title === "string" && u.title) seen.title = u.title;
      const output = contentText(u.content) || (typeof u.rawOutput === "string" ? u.rawOutput : "");
      emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: u.toolCallId, is_error: u.status === "failed", content: output.slice(0, 12_000) }] } });
    }
  }

  private endTurn(error: string | null): void {
    const t = this.current;
    if (!t) return;
    clearTimeout(t.stopTimer);
    for (const id of this.approvals?.ids() ?? []) this.approvals?.take(id, "cancelled");
    this.current = null;
    this.approvals = null;
    t.cb.onFinish(error);
  }

  private exited(code: number): void {
    this.alive = false;
    for (const call of this.calls.values()) call.reject(new Error("DeepSeek Harness exited"));
    this.calls.clear();
    rmSync(this.dir, { recursive: true, force: true });
    if (!this.current) return;
    this.endTurn(this.current.stopping ? "stopped" : (this.stderr.text().trim() || `DeepSeek Harness exited with ${code}`).slice(-800));
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
