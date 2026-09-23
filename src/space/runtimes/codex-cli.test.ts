import { describe, expect, test } from "bun:test";
import { codexArgs, codexChatArgs, codexRemoteCommand, createCodexCli, parseCodexOutput } from "./codex-cli.ts";
import { spawnCollect } from "./process.ts";
import { fakeCodexBin } from "./testing-codex.ts";
import type { ChatTurn, CompleteInput } from "./types.ts";

const input = (over: Partial<CompleteInput> = {}): CompleteInput => ({ model: "gpt-6-luna", system: "Translate into Chinese. Only JSON.", prompt: "hello", tools: [], tag: "test", maxTokens: 100, timeoutMs: 3000, ...over });
const adapter = (mode = "ok") => createCodexCli({ name: "codex", kind: "codex-cli", bin: fakeCodexBin(mode) });

describe("Codex completions", () => {
  test("full mode retains native context and supports both native and custom system prompts", async () => {
    for (const system of ["", "Custom instructions: ' $HOME `id`\n"]) {
      const request = input({ mode: "full", system });
      const r = await adapter().complete(request);
      if (!r.ok) throw new Error(r.error);
      const answer = JSON.parse(r.text);
      expect(answer.system).toBe(system || null);
      expect(answer.cwd).toBe(process.cwd());
      for (const flag of ["--ignore-user-config", "--ignore-rules", "--disable", "project_doc_max_bytes=0"]) expect(answer.args).not.toContain(flag);
      expect(answer.args).toContain("read-only");
      const remote = codexRemoteCommand(fakeCodexBin(), request);
      const result = await spawnCollect(["bash", "-lc", remote.command], { stdin: remote.archive, timeoutMs: 5000 });
      expect(result.code).toBe(0);
      expect(JSON.parse(parseCodexOutput(result.stdout).text!).system).toBe(system || null);
      expect(await Bun.file(`${remote.dir}/system.txt`).exists()).toBe(false);
    }
  });

  test("slim removes optional context and rejects attachments before launch", async () => {
    const args = codexArgs(["codex"], input({ mode: "slim" }), "/tmp/example");
    for (const flag of ["agents.enabled=false", "include_environment_context=false", "include_permissions_instructions=false", "include_collaboration_mode_instructions=false", "code_mode_host"]) expect(args).toContain(flag);
    await expect(adapter().complete(input({ mode: "slim", files: [{ name: "a.png", path: "/missing" }] }))).rejects.toThrow(/slim/);
  });
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
    expect(adapter().capabilities).toEqual({ complete: true, agent: false, chat: true });
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


describe("Codex chat", () => {
  const turn = (over: Partial<ChatTurn> = {}): ChatTurn => ({ message: "hello", cwd: process.cwd(), model: "gpt-6-luna", systemPrompt: "Workspace identity", ...over });
  const run = (mode = "ok", over: Partial<ChatTurn> = {}) => new Promise<{ events: Record<string, any>[]; sid?: string; error: string | null }>((resolve) => {
    const events: Record<string, any>[] = [];
    let sid: string | undefined;
    const handle = adapter(mode).chat(turn(over), { onEvent: (line) => events.push(JSON.parse(line)), onSession: (value) => { sid = value; }, onFinish: (error) => resolve({ events, sid, error }) });
    if (mode === "hang") setTimeout(handle.kill, 50);
  });

  test("streams persistent sessions with full context and a separate identity", async () => {
    const result = await run();
    expect(result.error).toBeNull();
    expect(result.sid).toBe("c0de0001-0000-4000-8000-000000000000");
    expect(result.events[0]).toMatchObject({ type: "system", subtype: "init" });
    const answer = JSON.parse(result.events.filter((e) => e.type === "assistant").at(-1)!.message.content[0].text);
    expect(answer.prompt).toBe("hello");
    expect(answer.cwd).toBe(process.cwd());
    expect(answer.args).toContain('developer_instructions="Workspace identity"');
    for (const flag of ["--ephemeral", "--ignore-user-config", "--ignore-rules", "--disable", "model_instructions_file"]) expect(answer.args).not.toContain(flag);
    expect(result.events.at(-1)).toMatchObject({ type: "result", is_error: false });
  });

  test("applies permissions on both new and resumed sessions", () => {
    for (const sessionId of [undefined, "c0de0001-0000-4000-8000-000000000000"]) {
      for (const [permissionMode, sandbox] of [[undefined, "read-only"], ["acceptEdits", "workspace-write"], ["bypassPermissions", "danger-full-access"], ["invalid", "read-only"]]) {
        const args = codexChatArgs(turn({ sessionId, permissionMode }));
        expect(args[args.indexOf("--sandbox") + 1]).toBe(sandbox!);
        expect(args).toContain('approval_policy="never"');
        if (sessionId) expect(args.slice(-3)).toEqual(["resume", sessionId, "-"]);
      }
    }
  });

  test("surfaces crashes, invalid streams, auth failures, partial output and cancellation", async () => {
    for (const mode of ["exit", "malformed", "error", "partial", "hang"]) expect((await run(mode)).error).toBeTruthy();
    expect((await run("ok", { allowedTools: ["Read"] })).error).toContain("allow-lists");
  });
});

test("Codex transcript restores user text and assistant tools only for the matching workspace", async () => {
  const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { readCodexTranscript } = await import("./transcripts.ts");
  const home = await mkdtemp(join(tmpdir(), "codex-transcript-"));
  const sid = "c0de0001-0000-4000-8000-000000000000";
  try {
    await mkdir(join(home, "sessions/2026/09/23"), { recursive: true });
    await Bun.write(join(home, `sessions/2026/09/23/rollout-2026-09-23-${sid}.jsonl`), [
      { type: "session_meta", payload: { id: sid, cwd: "/workspace" } },
      { type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "hidden instructions" }] } },
      { type: "event_msg", payload: { type: "user_message", message: "hello" } },
      { type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: '{"command":"pwd"}' } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] } },
    ].map((e) => JSON.stringify(e)).join("\n"));
    expect(await readCodexTranscript("/workspace", sid, home)).toEqual([{ role: "user", text: "hello" }, { role: "ai", text: "done", tools: [{ name: "exec_command", hint: "pwd" }] }]);
    expect(await readCodexTranscript("/other", sid, home)).toBeNull();
    expect(await readCodexTranscript("/workspace", "missing-session", home)).toBeNull();
  } finally { await rm(home, { recursive: true, force: true }); }
});


test("web tool lists enable native web access locally and over SSH without enabling other tools", async () => {
  for (const tools of [["WebSearch"], ["WebFetch"], ["WebSearch", "WebFetch"]]) {
    const request = input({ tools });
    const result = await adapter().complete(request);
    if (!result.ok) throw new Error(result.error);
    const args = JSON.parse(result.text).args as string[];
    expect(args).toContain('web_search="live"');
    for (const feature of ["code_mode", "code_mode_host"]) {
      expect(args.some((value, i) => value === "--enable" && args[i + 1] === feature)).toBe(true);
      expect(args.some((value, i) => value === "--disable" && args[i + 1] === feature)).toBe(false);
    }
    expect(args).toContain("--ignore-user-config");
    for (const feature of ["shell_tool", "unified_exec", "plugins", "apps", "view_image"]) {
      expect(args.some((value, i) => value === "--disable" && args[i + 1] === feature)).toBe(true);
    }
    const remote = codexRemoteCommand(fakeCodexBin(), request);
    const output = await spawnCollect(["bash", "-lc", remote.command], { stdin: remote.archive, timeoutMs: 5000 });
    expect(output.code).toBe(0);
    expect(JSON.parse(parseCodexOutput(output.stdout).text!).args).toContain('web_search="live"');
  }
  const full = codexArgs(["codex"], input({ mode: "full", tools: ["WebSearch", "WebFetch"] }), "/tmp/web-only");
  expect(full).toContain("--ignore-user-config");
  expect(full).toContain('web_search="live"');
  expect(await adapter().complete(input({ tools: ["WebSearch", "Bash"] }))).toMatchObject({ ok: false, error: expect.stringContaining("Bash") });
  await expect(adapter().complete(input({ mode: "slim", tools: ["WebSearch"] }))).rejects.toThrow(/slim/);
});
