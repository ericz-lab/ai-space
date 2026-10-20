/**
 * Stand-ins for the two live chat protocols (docs/runtimes.md#live-chat), for tests:
 * `claude -p --input-format stream-json … --permission-prompt-tool stdio` and `codex app-server`.
 * The first argument picks which (`claude` or `codex`); the rest are the CLI's own arguments.
 *
 * What a user message asks for (both):
 *   `approve:<command>`  the agent wants to run the command: an approval request, then the outcome
 *   `ask:<question>`     the agent asks the question with the options `A` and `B`, then says
 *                        `answered <answers as JSON>` or `skipped`
 *   `wait`               a long step: the turn waits for a steered message (answered with
 *                        `heard: <text>`) or a stop
 *   anything else        `echo: <text> [pid <pid>]`, so a test can tell whether a process was reused
 */

export function fakeLiveBin(which: "claude" | "codex"): string[] {
  return [process.execPath, import.meta.path, which];
}

type Json = Record<string, unknown>;
const out = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");

async function* lines(): AsyncGenerator<Json> {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let rest = "";
  for (;;) {
    const r = await reader.read();
    if (r.done) return;
    rest += decoder.decode(r.value, { stream: true });
    let nl: number;
    while ((nl = rest.indexOf("\n")) >= 0) {
      const line = rest.slice(0, nl).trim();
      rest = rest.slice(nl + 1);
      if (line) yield JSON.parse(line);
    }
  }
}

async function claude(args: string[]): Promise<void> {
  const sid = args.includes("--resume") ? args[args.indexOf("--resume") + 1]! : "live-session";
  let model = args.includes("--model") ? args[args.indexOf("--model") + 1]! : "default";
  let mode = args[args.indexOf("--permission-mode") + 1]!;
  // The running turn: what it waits for next.
  let turn: { waiting: "approval" | "question" | "steer" | null; command?: string } | null = null;
  const text = (t: string) => out({ type: "assistant", message: { content: [{ type: "text", text: t }] }, session_id: sid });
  const result = (isError = false) => {
    out({ type: "result", subtype: isError ? "error_during_execution" : "success", is_error: isError, result: isError ? "" : "ok", session_id: sid });
    turn = null;
  };
  for await (const m of lines()) {
    if (m.type === "control_request") {
      const req = m.request as Json;
      if (req.subtype === "set_model") model = String(req.model);
      if (req.subtype === "set_permission_mode") mode = String(req.mode);
      out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: {} } });
      if (req.subtype === "interrupt" && turn) {
        out({ type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] }, session_id: sid });
        result(true);
      }
      continue;
    }
    if (m.type === "control_response") {
      const r = (m.response as Json).response as { behavior: string; updatedInput?: { command?: string; answers?: unknown }; message?: string };
      if (turn?.waiting === "question") {
        text(r.behavior === "allow" ? `answered ${JSON.stringify(r.updatedInput?.answers)}` : "skipped");
        result();
        continue;
      }
      if (!turn || turn.waiting !== "approval") continue;
      out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", is_error: r.behavior !== "allow", content: r.behavior === "allow" ? `ran ${r.updatedInput?.command}` : String(r.message) }] }, session_id: sid });
      text(`done ${r.behavior}`);
      result();
      continue;
    }
    if (m.type !== "user") continue;
    const content = (m.message as { content: unknown }).content;
    const said = typeof content === "string" ? content : (content as { type: string; text?: string }[]).map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join(" ");
    out({ ...m, session_id: sid, isReplay: true });
    if (turn?.waiting === "steer") {
      text(`heard: ${said}`);
      result();
      continue;
    }
    out({ type: "system", subtype: "init", session_id: sid, model, permissionMode: mode });
    if (said.startsWith("approve:")) {
      const command = said.slice("approve:".length);
      turn = { waiting: "approval", command };
      out({ type: "assistant", message: { content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command } }] }, session_id: sid });
      out({ type: "control_request", request_id: "perm-1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command }, description: "Run it" } });
    } else if (said.startsWith("ask:")) {
      turn = { waiting: "question" };
      const input = { questions: [{ question: said.slice("ask:".length), header: "Pick", options: [{ label: "A", description: "the first" }, { label: "B", description: "" }], multiSelect: false }] };
      out({ type: "assistant", message: { content: [{ type: "tool_use", id: "tool-1", name: "AskUserQuestion", input }] }, session_id: sid });
      // The CLI asks the host for this tool in every permission mode.
      out({ type: "control_request", request_id: "perm-1", request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input, requires_user_interaction: true } });
    } else if (said === "wait") {
      turn = { waiting: "steer" };
      out({ type: "assistant", message: { content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "sleep" } }] }, session_id: sid });
    } else {
      turn = { waiting: null };
      text(`echo: ${said} [pid ${process.pid}] [model ${model}] [mode ${mode}]`);
      result();
    }
  }
}

async function codex(args: string[]): Promise<void> {
  // Outside plan mode Codex offers its question tool only with this feature on.
  const canAsk = args.some((a, i) => a === "--enable" && args[i + 1] === "default_mode_request_user_input");
  let thread = "";
  let serial = 0;
  let turn: { id: string; waiting: "approval" | "steer" | null } | null = null;
  const note = (method: string, params: Json) => out({ method, params: { threadId: thread, ...(turn ? { turnId: turn.id } : {}), ...params } });
  const say = (t: string) => note("item/completed", { item: { type: "agentMessage", id: `msg-${++serial}`, text: t } });
  const complete = (status: string) => {
    note("turn/completed", { turn: { id: turn!.id, status, error: null } });
    turn = null;
  };
  for await (const m of lines()) {
    const p = (m.params ?? {}) as Json;
    if (m.method === "initialize") out({ id: m.id, result: { userAgent: "fake" } });
    else if (m.method === "thread/start") out({ id: m.id, result: { thread: { id: (thread = "thread-new") } } });
    else if (m.method === "thread/resume") out({ id: m.id, result: { thread: { id: (thread = String(p.threadId)) } } });
    else if (m.method === "turn/start") {
      const input = p.input as { type: string; text?: string }[];
      const said = input.map((i) => (i.type === "text" ? i.text : `[${i.type}]`)).join(" ");
      turn = { id: `turn-${++serial}`, waiting: null };
      out({ id: m.id, result: { turn: { id: turn.id, status: "inProgress" } } });
      note("item/started", { item: { type: "userMessage", id: `u-${serial}`, content: input } });
      if (said.startsWith("approve:")) {
        turn.waiting = "approval";
        const command = said.slice("approve:".length);
        note("item/started", { item: { type: "commandExecution", id: "cmd-1", command, status: "inProgress" } });
        out({ id: 100, method: "item/commandExecution/requestApproval", params: { threadId: thread, turnId: turn.id, itemId: "cmd-1", command, reason: "Run it" } });
      } else if (said.startsWith("ask:") && canAsk) {
        turn.waiting = "approval";
        out({ id: 101, method: "item/tool/requestUserInput", params: { threadId: thread, turnId: turn.id, itemId: "ask-1", isBlocking: true, questions: [{ id: "pick", header: "Pick", question: said.slice("ask:".length), isOther: true, isSecret: false, options: [{ label: "A", description: "the first" }, { label: "B", description: "" }] }] } });
      } else if (said === "wait") {
        turn.waiting = "steer";
        note("item/started", { item: { type: "commandExecution", id: "cmd-1", command: "sleep", status: "inProgress" } });
      } else {
        say(`echo: ${said} [pid ${process.pid}] [model ${p.model ?? "default"}] [approval ${p.approvalPolicy}] [sandbox ${(p.sandboxPolicy as Json | undefined)?.type}]`);
        complete("completed");
      }
    } else if (m.method === "turn/steer") {
      if (!turn || turn.waiting !== "steer" || p.expectedTurnId !== turn.id) {
        out({ id: m.id, error: { code: -32600, message: "no active turn" } });
        continue;
      }
      out({ id: m.id, result: { turnId: turn.id } });
      const input = p.input as { text?: string }[];
      note("item/started", { item: { type: "userMessage", id: `u-${++serial}`, content: input } });
      note("item/completed", { item: { type: "commandExecution", id: "cmd-1", command: "sleep", status: "completed", exitCode: 0, aggregatedOutput: "" } });
      say(`heard: ${input.map((i) => i.text).join(" ")}`);
      complete("completed");
    } else if (m.method === "turn/interrupt") {
      out({ id: m.id, result: {} });
      if (turn) complete("interrupted");
    } else if (m.id === 101 && m.result) {
      if (!turn) continue;
      const answers = (m.result as { answers: Record<string, { answers: string[] }> }).answers;
      say(Object.keys(answers).length ? `answered ${JSON.stringify(answers)}` : "skipped");
      complete("completed");
    } else if (m.id === 100 && m.result) {
      const decision = (m.result as Json).decision;
      if (!turn) continue;
      note("serverRequest/resolved", { requestId: 100 });
      note("item/completed", { item: { type: "commandExecution", id: "cmd-1", command: "x", status: decision === "accept" ? "completed" : "declined", exitCode: decision === "accept" ? 0 : null, aggregatedOutput: decision === "accept" ? "ran" : null } });
      say(`done ${decision}`);
      complete("completed");
    } else if (m.id !== undefined && m.method) out({ id: m.id, error: { code: -32601, message: "unknown method" } });
  }
}

if (import.meta.main) {
  const [which, ...args] = process.argv.slice(2);
  if (which === "claude") await claude(args);
  else await codex(args);
}
