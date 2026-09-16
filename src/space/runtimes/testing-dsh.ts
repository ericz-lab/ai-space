/**
 * A stand-in for `dsh --profile headless --json` for tests: reads the task
 * (stdin when the last argument is `-`, else the last argument), reads the
 * `--patch` file when given, and prints the harness's event lines. The `text`
 * event echoes the task, the arguments and the patch's row ids so a test can
 * check what reached the runtime. FAKE_DSH_MODE: `ok` (default), `tools`
 * (adds a tool call and a failed tool result), `error` (a failed turn, exit
 * 1), `crash` (no events, exit 3), `hang`.
 *
 * Used as the `bin` of a deepseek-harness runtime in tests; `fakeDshBin()` builds the command.
 */

export function fakeDshBin(): string[] {
  return [process.execPath, import.meta.path];
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const mode = process.env.FAKE_DSH_MODE ?? "ok";
  const last = args[args.length - 1] ?? "";
  const task = last === "-" ? await new Response(Bun.stdin.stream()).text() : last;
  const patchAt = args.indexOf("--patch");
  const patch = patchAt >= 0 ? await Bun.file(args[patchAt + 1]!).text() : "";
  const rows = [...patch.matchAll(/^- id: (\S+)/gm)].map((m) => m[1]);
  const resume = args.indexOf("--session-id");
  const sid = resume >= 0 ? args[resume + 1] : "session-0000fake-0000-4000-8000-000000000001";
  const out = (o: unknown) => console.log(JSON.stringify(o));

  if (mode === "hang") await new Promise(() => {});
  if (mode === "crash") {
    process.stderr.write("dsh: simulated crash\n");
    process.exit(3);
  }
  out({ type: "session", sessionId: sid, cwd: process.cwd() });
  out({ type: "status", phase: "turn_start", turn: 1 });
  out({ type: "status", phase: "step_start", turn: 1, step: 1 });
  if (mode === "error") {
    out({ type: "status", phase: "step_end", turn: 1, step: 1 });
    out({ type: "status", phase: "turn_end", turn: 1, reason: { kind: "error", error: { message: "simulated model failure", code: "MISSING_CREDENTIAL" } } });
    out({ type: "final", text: "" });
    process.stderr.write("dsh: MISSING_CREDENTIAL: simulated model failure\n");
    process.exit(1);
  }
  out({ type: "thinking", text: "thinking about it" });
  if (mode === "tools") {
    out({ type: "tool_call", callId: "call-1", tool: "web_search", input: { queries: ["pong"] } });
    out({ type: "tool_result", callId: "call-1", status: "error", result: "network down" });
    out({ type: "status", phase: "step_end", turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } });
    out({ type: "status", phase: "step_start", turn: 1, step: 2 });
  }
  const text = `answer to: ${task.trim()} [args: ${args.filter((a) => a !== task).join(" ")}] [patch: ${rows.join(",")}] [env: ${process.env.DSH_HOME ?? "-"}]`;
  out({ type: "text", text });
  out({ type: "status", phase: "step_end", turn: 1, step: mode === "tools" ? 2 : 1, usage: { inputTokens: 32, outputTokens: 2, cacheReadTokens: 640, cacheWriteTokens: 0, totalTokens: 674 } });
  out({ type: "status", phase: "turn_end", turn: 1, reason: { kind: "completed" } });
  out({ type: "final", text });
  process.stderr.write("dsh: warning: 1 entry did not activate\n");
}
