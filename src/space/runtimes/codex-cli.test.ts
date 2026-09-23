import { describe, expect, test } from "bun:test";
import { codexArgs, codexRemoteCommand, createCodexCli, parseCodexOutput } from "./codex-cli.ts";
import { spawnCollect } from "./process.ts";
import { fakeCodexBin } from "./testing-codex.ts";
import type { CompleteInput } from "./types.ts";

const input = (over: Partial<CompleteInput> = {}): CompleteInput => ({ model: "gpt-6-luna", system: "Translate into Chinese. Only JSON.", prompt: "hello", tools: [], tag: "test", maxTokens: 100, timeoutMs: 3000, ...over });
const adapter = (mode = "ok") => createCodexCli({ name: "codex", kind: "codex-cli", bin: fakeCodexBin(mode) });

describe("Codex completions", () => {
  test("keeps custom system and user text separate, records uncached usage, and cleans up", async () => {
    const prompt = "用户\n\"' $HOME `id` $(id)\\n";
    const system = "系统\nonly JSON\n".repeat(400);
    const chunks: string[] = [];
    const r = await adapter().complete(input({ prompt, system }), undefined, (t) => chunks.push(t));
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error);
    const answer = JSON.parse(r.text);
    expect(answer).toMatchObject({ prompt, system });
    expect(answer.cwd).not.toBe(process.cwd());
    expect(await Bun.file(`${answer.cwd}/system.txt`).exists()).toBe(false);
    expect(chunks).toEqual([r.text]);
    expect(r.usage).toEqual({ inputTokens: 20, cacheReadTokens: 100, cacheWriteTokens: 0, outputTokens: 12 });
    expect(r.costUsd).toBeUndefined();
  });

  test("uses isolated configuration, low reasoning and read-only execution", () => {
    const args = codexArgs(["codex"], input(), "/tmp/example");
    for (const word of ["--ignore-user-config", "--ignore-rules", "--ephemeral", "read-only", 'model_reasoning_effort="low"', "project_doc_max_bytes=0", "shell_tool", "plugins", "apps", 'web_search="disabled"']) expect(args).toContain(word);
    expect(args.at(-1)).toBe("-");
  });

  for (const [mode, error] of [["error", "OAuth session expired"], ["exit", "CLI crash"], ["malformed", "invalid Codex JSON"], ["partial", "without turn.completed"]]) {
    test(`rejects ${mode}`, async () => {
      const r = await adapter(mode).complete(input());
      expect(r).toMatchObject({ ok: false, error: expect.stringContaining(error!) });
    });
  }
  test("timeouts, cancellation, unsupported operations and missing binary are explicit", async () => {
    expect(await adapter("hang").complete(input({ timeoutMs: 80 }))).toMatchObject({ ok: false, error: expect.stringContaining("timed out") });
    expect(await adapter("hang").complete(input(), AbortSignal.timeout(80))).toMatchObject({ ok: false, error: "aborted" });
    expect(await adapter().complete(input({ tools: ["Read"] }))).toMatchObject({ ok: false });
    expect(await adapter().complete(input({ files: [{ name: "a.png", path: "/missing" }] }))).toMatchObject({ ok: false });
    expect(await adapter().complete(input({ thinking: 2048 }))).toMatchObject({ ok: true });
    expect(await createCodexCli({ name: "x", kind: "codex-cli", bin: ["/no-codex-here"] }).complete(input())).toMatchObject({ ok: false });
    expect(adapter().capabilities).toEqual({ complete: true, agent: false, chat: false });
    expect(() => createCodexCli({ name: "x", kind: "codex-cli", bin: [], sshHost: "-oProxyCommand=bad" })).toThrow(/host/);
  });
  test("remote wrapper transfers hostile text exactly and cleans the request directory", async () => {
    const request = input({ prompt: "中文 ' $(touch /tmp/should-not-exist) `id`\n", system: "a'\"\\\n$HOME\n" });
    const remote = codexRemoteCommand(fakeCodexBin(), request);
    const result = await spawnCollect(["bash", "-lc", remote.command], { stdin: remote.archive, timeoutMs: 5000 });
    expect(result.code).toBe(0);
    const output = parseCodexOutput(result.stdout);
    expect(JSON.parse(output.text!)).toMatchObject({ prompt: request.prompt, system: request.system, cwd: remote.dir });
    expect(await Bun.file(`${remote.dir}/system.txt`).exists()).toBe(false);
  });
  test("remote timeout kills the CLI and removes request files", async () => {
    const remote = codexRemoteCommand(fakeCodexBin("hang"), input({ timeoutMs: 50 }));
    const result = await spawnCollect(["bash", "-lc", remote.command], { stdin: remote.archive, timeoutMs: 4000 });
    expect(result.code).toBe(124);
    expect(await Bun.file(`${remote.dir}/system.txt`).exists()).toBe(false);
  });
  test("does not accept an error followed by a success envelope", () => {
    expect(parseCodexOutput('{"type":"error","message":"bad auth"}\n{"type":"turn.completed"}').error).toBe("bad auth");
    expect(parseCodexOutput("null").error).toBe("invalid Codex event");
    expect(parseCodexOutput('{"type":"turn.completed"}').error).toBe("empty Codex answer");
  });
});
