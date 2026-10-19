import { readFileSync } from "node:fs";

/**
 * A stand-in for `dsh --profile acp` for tests: the Agent Client Protocol over
 * newline-delimited JSON-RPC (initialize, session/new, session/resume,
 * session/set_config_option, session/prompt, session/cancel, session/close,
 * session/update, session/request_permission).
 *
 * What a prompt asks for:
 *   `approve:<command>`  a tool call, then a permission request; allow runs it, deny refuses
 *   `tool`               a tool call that completes with output
 *   `wait`               holds the turn until the client cancels
 *   `fail`               the turn ends with `stopReason: "refusal"`
 *   `model`              the current model route
 *   an image block       `saw <n> image(s): <mime types>`
 *   anything else        `echo: <text> [pid …] [model …] [mode …] [persona …] [rows …] [resumed …] [images <n>]`
 *
 * The echo carries what the runtime was started with, so a test can check the
 * `--patch` overlay, `DSH_PERMISSION_MODE`, and whether a process was reused.
 */
export async function runAcpStandIn(args: string[]): Promise<void> {
  const patchAt = args.indexOf("--patch");
  const patch = patchAt >= 0 ? readFileSync(args[patchAt + 1]!, "utf8") : "";
  const rows = ((Bun.YAML.parse(patch) as { id?: string; config?: Record<string, unknown> }[] | null) ?? []).filter((r) => r.id);
  const byId = new Map(rows.map((r) => [r.id!, r]));
  const acp = (byId.get("acp")?.config ?? {}) as { provider?: string; model?: string };
  const persona = String(((byId.get("system-prompt")?.config ?? {}) as { personaPrefix?: string }).personaPrefix ?? "");
  const mode = process.env.DSH_PERMISSION_MODE ?? "-";
  let route: [string, string] = [acp.provider ?? "deepseek-official", acp.model ?? "deepseek-v4-flash"];
  let sid: string | null = null;
  let resumed = false;
  let seq = 0;
  let onCancel: () => void = () => {};
  const approvals = new Map<number, (option: string | undefined) => void>();

  const out = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");
  const result = (id: unknown, value: Record<string, unknown>) => out({ jsonrpc: "2.0", id, result: value });
  const error = (id: unknown, message: string) => out({ jsonrpc: "2.0", id, error: { code: -32603, message } });
  const update = (u: Record<string, unknown>) => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: u } });
  const message = (text: string) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  const configOptions = () => [
    { id: "model", name: "Model", category: "model", type: "select", currentValue: JSON.stringify(route), options: [] },
    { id: "reasoning_effort", name: "Reasoning effort", category: "thought_level", type: "select", currentValue: "high", options: [] },
  ];
  const toolResult = (toolCallId: string, ok: boolean, text: string) => update({
    sessionUpdate: "tool_call_update",
    toolCallId,
    status: ok ? "completed" : "failed",
    content: [{ type: "content", content: { type: "text", text } }],
  });

  /** Ask the client to allow the tool call; resolves the chosen option id, or undefined when cancelled. */
  const permission = (toolCallId: string): Promise<string | undefined> => {
    const rpcId = 900 + seq++;
    return new Promise((resolve) => {
      approvals.set(rpcId, resolve);
      out({
        jsonrpc: "2.0",
        id: rpcId,
        method: "session/request_permission",
        params: {
          sessionId: sid,
          toolCall: { toolCallId },
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          ],
        },
      });
    });
  };

  const prompt = async (id: unknown, params: Record<string, unknown>) => {
    const blocks = (params.prompt as { type?: string; text?: string; mimeType?: string }[] | undefined) ?? [];
    const text = blocks.map((b) => (b.type === "text" ? b.text ?? "" : "")).join("");
    const images = blocks.filter((b) => b.type === "image");
    const stop = (stopReason: string) => result(id, { stopReason });
    if (text.startsWith("approve:")) {
      const command = text.slice("approve:".length).trim();
      const toolCallId = `call-${++seq}`;
      update({ sessionUpdate: "tool_call", toolCallId, title: "bash", kind: "other", status: "in_progress", rawInput: { command, description: "Run it" } });
      const option = await permission(toolCallId);
      if (option === undefined) return stop("cancelled");
      const ok = option.startsWith("allow");
      toolResult(toolCallId, ok, ok ? `ran ${command}` : "denied");
      message(ok ? "done allow" : "done deny");
      return stop("end_turn");
    }
    if (text === "tool") {
      const toolCallId = `call-${++seq}`;
      update({ sessionUpdate: "tool_call", toolCallId, title: "bash", kind: "other", status: "in_progress", rawInput: { command: "echo hi" } });
      toolResult(toolCallId, true, "hi");
      message("used tool");
      return stop("end_turn");
    }
    if (text === "wait") {
      await new Promise<void>((resolve) => {
        onCancel = () => {
          onCancel = () => {};
          resolve();
        };
      });
      return stop("cancelled");
    }
    if (text === "fail") return stop("refusal");
    if (text === "model") {
      message(`model: ${route[0]}:${route[1]}`);
      return stop("end_turn");
    }
    if (images.length) {
      message(`saw ${images.length} image(s): ${images.map((i) => i.mimeType).join(",")}`);
      return stop("end_turn");
    }
    message(`echo: ${text} [pid: ${process.pid}] [model: ${route[0]}:${route[1]}] [mode: ${mode}] [persona: ${persona}] [rows: ${rows.map((r) => r.id).join(",")}] [resumed: ${resumed}] [images ${images.length}]`);
    return stop("end_turn");
  };

  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const id = m.id;
      const method = typeof m.method === "string" ? m.method : "";
      // A response to the stand-in's permission request.
      if (id !== undefined && !method) {
        const resolve = approvals.get(Number(id));
        if (!resolve) continue;
        approvals.delete(Number(id));
        const outcome = (m.result as { outcome?: { outcome?: string; optionId?: string } } | undefined)?.outcome;
        resolve(outcome?.outcome === "selected" ? outcome.optionId : undefined);
        continue;
      }
      if (method === "initialize") {
        result(id, {
          protocolVersion: 1,
          agentInfo: { name: "deepseek-harness-acp", version: "test" },
          agentCapabilities: { promptCapabilities: { image: process.env.FAKE_DSH_ACP_IMAGES !== "0", audio: false, embeddedContext: false }, sessionCapabilities: { close: {}, list: {}, resume: {} } },
          authMethods: [],
        });
        continue;
      }
      if (method === "session/new") {
        sid = "acp-session-0001";
        result(id, { sessionId: sid, configOptions: configOptions() });
        continue;
      }
      if (method === "session/resume") {
        sid = String((m.params as { sessionId?: string } | undefined)?.sessionId ?? "acp-session-0001");
        resumed = true;
        result(id, { configOptions: configOptions() });
        continue;
      }
      if (method === "session/set_config_option") {
        const value = (m.params as { value?: unknown } | undefined)?.value;
        if (typeof value === "string") {
          try {
            const parsed = JSON.parse(value) as unknown;
            if (Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string") route = [parsed[0], parsed[1]];
          } catch {
            error(id, "bad model value");
            continue;
          }
        }
        result(id, { configOptions: configOptions() });
        continue;
      }
      if (method === "session/prompt") {
        void prompt(id, (m.params as Record<string, unknown> | undefined) ?? {});
        continue;
      }
      if (method === "session/cancel") {
        for (const resolve of approvals.values()) resolve(undefined);
        approvals.clear();
        onCancel();
        continue;
      }
      if (method === "session/close") {
        result(id, {});
        onCancel();
        for (const resolve of approvals.values()) resolve(undefined);
        approvals.clear();
        continue;
      }
      if (id !== undefined) error(id, `ai-space test stand-in does not handle ${method}`);
    }
  }
  onCancel();
  for (const resolve of approvals.values()) resolve(undefined);
}
