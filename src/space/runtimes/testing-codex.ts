/** Codex exec stand-in. Modes are command arguments, so concurrent tests share no env overrides. */
export const fakeCodexBin = (mode = "ok") => [process.execPath, import.meta.path, mode];

if (import.meta.main) {
  const mode = process.argv[2];
  const args = process.argv.slice(3);
  const prompt = await new Response(Bun.stdin.stream()).text();
  if (mode === "hang") await Bun.sleep(60_000);
  if (mode === "exit") { console.error("CLI crash"); process.exit(3); }
  if (mode === "malformed") { console.log("not JSON"); process.exit(0); }
  if (mode === "error") {
    console.log(JSON.stringify({ type: "turn.failed", error: { message: "OAuth session expired" } }));
    process.exit(0);
  }
  if (!args.includes("--ephemeral")) console.log(JSON.stringify({ type: "thread.started", thread_id: "c0de0001-0000-4000-8000-000000000000" }));
  const systemArg = args.find((s) => s.startsWith("model_instructions_file="));
  const systemFile = systemArg ? JSON.parse(systemArg.slice(systemArg.indexOf("=") + 1)) : undefined;
  const text = JSON.stringify({ prompt, system: systemFile ? await Bun.file(systemFile).text() : null, cwd: process.cwd(), args });
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "intermediate", phase: "commentary" } }));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }));
  if (mode !== "partial") console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 120, cached_input_tokens: 100, output_tokens: 12 } }));
}
