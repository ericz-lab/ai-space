/**
 * A stand-in for `claude -p --output-format json` for tests: reads the prompt on
 * stdin and answers with the CLI's result envelope. FAKE_MODEL_MODE picks the
 * behaviour: `ok` (default), `plain` (text without the envelope, like an older
 * CLI), `error` (an is_error envelope), `refused` (an is_error envelope and exit 1
 * with nothing on stderr, as the CLI does when its login has lapsed; in the stream
 * after the init line), `exit` (non-zero exit), `hang` (never
 * answers, for timeouts), `slow` (the first delta, a pause of FAKE_MODEL_DELAY_MS,
 * then the rest: an answer a test can walk away from and come back to). The answer echoes the prompt and the arguments so a
 * test can check what reached the runtime. Asked for `stream-json`, it prints
 * an init line, the answer in two text deltas and the same result envelope last.
 * A prompt that ends with an "Attached files" block makes it report each file's
 * size on disk (`[files: a1.png=812 a2.jpg=missing]`), so a test can prove the
 * bytes reached the runtime. Started with magpie's caller key (a runtime through magpie), it appends
 * that address, its token and the alias models it was given.
 *
 * Used as the `bin` of a claude-code runtime in tests; `fakeModelBin()` builds the command.
 */

export function fakeModelBin(): string[] {
  return [process.execPath, import.meta.path];
}

if (import.meta.main) {
  const prompt = await new Response(Bun.stdin.stream()).text();
  const mode = process.env.FAKE_MODEL_MODE ?? "ok";
  const args = process.argv.slice(2);
  if (mode === "hang") await new Promise(() => {});
  if (mode === "exit") {
    process.stderr.write("simulated crash\n");
    process.exit(3);
  }
  if (mode === "plain") {
    console.log(`plain answer to: ${prompt}`);
    process.exit(0);
  }
  if (mode === "error") {
    console.log(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "simulated runtime failure", usage: { input_tokens: 5, output_tokens: 0 } }));
    process.exit(0);
  }
  if (mode === "refused") {
    if (args.includes("stream-json")) console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "fake" }));
    console.log(JSON.stringify({ type: "result", subtype: "success", is_error: true, terminal_reason: "api_error", result: "Failed to authenticate: OAuth session expired and could not be refreshed", modelUsage: {} }));
    process.exit(1);
  }
  const files = [...prompt.matchAll(/^- ([a-z0-9]+\.[a-z]+): (.+)$/gm)].map(([, name, path]) => `${name}=${Bun.file(path!).size || "missing"}`);
  // Through a gateway (magpie): what the process was given, so a test sees where it would send its calls.
  const e = process.env;
  let gateway = e.ANTHROPIC_AUTH_TOKEN?.startsWith("magpie-") ? ` [gateway: ${e.ANTHROPIC_BASE_URL} token=${e.ANTHROPIC_AUTH_TOKEN ?? ""} haiku=${e.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? ""} opus=${e.ANTHROPIC_DEFAULT_OPUS_MODEL ?? ""} apikey=${e.ANTHROPIC_API_KEY ? "set" : "unset"}]` : "";
  // Through the built-in model gateway (a token ai-space issued): one Messages call to it, as the CLI would make,
  // the alias resolved through the variables it was given.
  if (e.ANTHROPIC_AUTH_TOKEN?.startsWith("sgw-")) {
    const alias = args[args.indexOf("--model") + 1] ?? "";
    const named: Record<string, string | undefined> = { haiku: e.ANTHROPIC_DEFAULT_HAIKU_MODEL, sonnet: e.ANTHROPIC_DEFAULT_SONNET_MODEL, opus: e.ANTHROPIC_DEFAULT_OPUS_MODEL, fable: e.ANTHROPIC_DEFAULT_FABLE_MODEL };
    const model = named[alias] ?? alias;
    let said = "";
    if (e.ANTHROPIC_BASE_URL) {
      const res = await fetch(`${e.ANTHROPIC_BASE_URL}/v1/messages?beta=true`, { method: "POST", headers: { authorization: `Bearer ${e.ANTHROPIC_AUTH_TOKEN}`, "content-type": "application/json", "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model, max_tokens: 10, messages: [{ role: "user", content: prompt }] }) }).catch((err: Error) => err);
      said = res instanceof Error ? `error ${res.message}` : `${res.status} ${await res.text()}`;
    }
    gateway = ` [space-gateway: model=${model} betas=${e.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS ?? ""} apikey=${e.ANTHROPIC_API_KEY ? "set" : "unset"} said=${said}]`;
  }
  const result = `answer to: ${prompt} [args: ${args.join(" ")}]${process.env.MAX_THINKING_TOKENS !== undefined ? ` [thinking: ${process.env.MAX_THINKING_TOKENS}]` : ""}${files.length ? ` [files: ${files.join(" ")}]` : ""}${gateway}`;
  if (args.includes("stream-json")) {
    const delta = (text: string) => JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
    console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "fake" }));
    console.log(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } } }));
    console.log(delta(result.slice(0, 10)));
    if (mode === "slow") await Bun.sleep(Number(process.env.FAKE_MODEL_DELAY_MS ?? 600));
    console.log(delta(result.slice(10)));
  } else if (mode === "slow") await Bun.sleep(Number(process.env.FAKE_MODEL_DELAY_MS ?? 600));
  console.log(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result,
      total_cost_usd: 0.0123,
      usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 },
    }),
  );
}
