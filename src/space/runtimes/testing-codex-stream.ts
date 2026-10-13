/** Model-free stdio app-server used only by codex-stream.test.ts. */
import { pumpLines } from "./process.ts";
const mode = process.argv[2];
const send = (value: unknown) => console.log(JSON.stringify(value));
await pumpLines(Bun.stdin.stream(), line => {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ id: m.id, result: {} });
  if (m.method === "config/read") send({ id: m.id, result: { config: { mcp_servers: { example: {} } } } });
  if (m.method === "thread/start") {
    if (!m.params.ephemeral || m.params.sandbox !== "read-only" || m.params.config["mcp_servers.example.enabled"] !== false || m.params.baseInstructions !== "custom system") {
      send({ id: m.id, error: { message: "isolation missing" } }); return;
    }
    send({ id: m.id, result: { thread: { id: "test-thread" } } });
  }
  if (m.method === "turn/start") {
    if ((mode === "priority" && m.params.serviceTier !== "priority") || (mode === "ok" && "serviceTier" in m.params)) {
      send({ id: m.id, error: { message: "unexpected service tier" } }); return;
    }
    if (mode === "hang") return;
    if (mode === "tool") { send({ id: 99, method: "item/commandExecution/requestApproval", params: {} }); return; }
    send({ method: "item/agentMessage/delta", params: { threadId: "test-thread", delta: "hello " } });
    setTimeout(() => {
      if (mode === "cut") { process.exit(0); }
      send({ method: "item/agentMessage/delta", params: { threadId: "test-thread", delta: "world" } });
      send({ method: "thread/tokenUsage/updated", params: { threadId: "test-thread", tokenUsage: { total: { inputTokens: 110, cachedInputTokens: 100, outputTokens: 5 } } } });
      send({ method: "turn/completed", params: { threadId: "test-thread", turn: { status: "completed" } } });
    }, 40);
  }
});
