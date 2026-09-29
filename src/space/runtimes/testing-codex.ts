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
  if (mode === "image" || mode === "noimage") {
    // What Codex's image tool does: save under $CODEX_HOME/generated_images/<thread>/, say nothing in the stream.
    const thread = "c0de0002-0000-4000-8000-000000000000";
    console.log(JSON.stringify({ type: "thread.started", thread_id: thread }));
    const home = process.env.CODEX_HOME ?? `${process.env.HOME}/.codex`;
    const inputs = args.flatMap((a, i) => (a === "--image" ? [args[i + 1]!] : []));
    if (mode === "image") await Bun.write(`${home}/generated_images/${thread}/exec-1.png`, inputs.length ? Bun.file(inputs[0]!) : new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ prompt, cwd: process.cwd(), args, inputs }) } }));
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 7000, cached_input_tokens: 2000, output_tokens: 150 } }));
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
