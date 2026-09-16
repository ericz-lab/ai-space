/**
 * A stand-in for `claude -p --output-format json` for tests: reads the prompt on
 * stdin and answers with the CLI's result envelope. FAKE_MODEL_MODE picks the
 * behaviour: `ok` (default), `plain` (text without the envelope, like an older
 * CLI), `error` (an is_error envelope), `exit` (non-zero exit), `hang` (never
 * answers, for timeouts). The answer echoes the prompt and the arguments so a
 * test can check what reached the runtime.
 *
 * Used as `SPACE_MODEL_BIN="bun <this file>"`; `fakeModelBin()` builds that string.
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
  console.log(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: `answer to: ${prompt} [args: ${args.join(" ")}]`,
      total_cost_usd: 0.0123,
      usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 },
    }),
  );
}
