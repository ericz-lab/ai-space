import { expect, test } from "bun:test";
import { join } from "node:path";
import { streamCodex } from "./codex-stream.ts";
import { createCodexCli } from "./codex-cli.ts";
import { parseRuntimesYaml } from "./config.ts";
import { parseRunInput } from "../model/spec.ts";
import type { CompleteInput } from "./types.ts";
const input: CompleteInput = { model: "fake", system: "custom system", prompt: "hi", tools: [], mode: "slim", tag: "test", timeoutMs: 2000, maxTokens: 100 };
const bin = (mode: string) => [process.execPath, join(import.meta.dir, "testing-codex-stream.ts"), mode];

test("priority is explicit per request and cannot silently fall back to exec", async () => {
  const request = parseRunInput({ ...input, serviceTier: "priority" });
  expect(await streamCodex(bin("priority"), request, undefined, () => {})).toMatchObject({ ok: true });
  expect(() => parseRunInput({ ...input, serviceTier: "fast" })).toThrow("serviceTier");
  const runtime = createCodexCli({ name: "codex", kind: "codex-cli", bin: bin("ok") });
  expect(await runtime.complete(request, undefined, () => {})).toMatchObject({ ok: false });
});

test("omitted completion mode streams through the default slim adapter", async () => {
  const runtime = createCodexCli({ name: "codex", kind: "codex-cli", bin: bin("ok"), streamCompletions: true });
  const chunks: string[] = [];
  expect(await runtime.complete({ ...input, mode: undefined }, undefined, text => chunks.push(text))).toMatchObject({ ok: true, text: "hello world" });
  expect(chunks).toEqual(["hello ", "world"]);
});

test("app-server emits real deltas, isolates the thread and preserves usage", async () => {
  const chunks: string[] = []; let settled = false;
  const promise = streamCodex(bin("ok"), input, undefined, text => { expect(settled).toBe(false); chunks.push(text); });
  const result = await promise; settled = true;
  expect(chunks).toEqual(["hello ", "world"]);
  expect(result).toMatchObject({ ok: true, text: "hello world", usage: { inputTokens: 10, cacheReadTokens: 100, outputTokens: 5 } });
});
test("cut streams and tool requests fail explicitly without replay", async () => {
  expect(await streamCodex(bin("cut"), input, undefined, () => {})).toMatchObject({ ok: false });
  const result = await streamCodex(bin("tool"), input, undefined, () => {});
  expect(result.ok).toBe(false); if (!result.ok) expect(result.error).toContain("Unexpected tool");
});
test("timeout and caller abort terminate a waiting process", async () => {
  const abort = new AbortController();
  const result = streamCodex(bin("hang"), input, abort.signal, () => {});
  setTimeout(() => abort.abort(), 50);
  expect(await result).toMatchObject({ ok: false, error: "aborted" });
  expect(await streamCodex(bin("hang"), { ...input, timeoutMs: 50 }, undefined, () => {})).toMatchObject({ ok: false });
});
test("streamCompletions is opt-in, boolean, and local only", () => {
  expect(parseRuntimesYaml('runtimes:\n  codex:\n    kind: codex-cli\n    streamCompletions: true').config.runtimes[0]).toMatchObject({ streamCompletions: true });
  expect(() => parseRuntimesYaml('runtimes:\n  codex:\n    kind: codex-cli\n    streamCompletions: 123')).toThrow("boolean");
  expect(() => parseRuntimesYaml('runtimes:\n  codex:\n    kind: codex-cli\n    ssh: host\n    streamCompletions: true')).toThrow("local");
});
