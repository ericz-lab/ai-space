import { describe, expect, test } from "bun:test";
import { API_MODELS, apiCost, createAnthropicApi } from "./anthropic-api.ts";
import type { CompleteInput } from "./types.ts";

const input = (over: Partial<CompleteInput> = {}): CompleteInput => ({ prompt: "hello", system: "Be brief.", model: "haiku", tag: "t", tools: [], timeoutMs: 5000, maxTokens: 100, ...over });

describe("anthropic-api runtime", () => {
  const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const reply = { status: 200, body: {} as unknown };
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown>, headers: init?.headers as Record<string, string> });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const runtime = createAnthropicApi({ name: "api", kind: "anthropic-api", apiKey: "sk-test", apiUrl: "" }, { fetch: fakeFetch });

  test("answers only", () => {
    expect(runtime.backend).toBe("api");
    expect(runtime.capabilities).toEqual({ complete: true, agent: false, chat: false });
    expect(() => runtime.chat({ message: "x", cwd: "/" }, { onEvent: () => {}, onFinish: () => {} })).toThrow(/does not support chat/);
  });

  test("maps aliases to model ids, sends the key, reads usage and prices it", async () => {
    reply.body = { content: [{ type: "text", text: "hi there" }], usage: { input_tokens: 1_000_000, output_tokens: 0 } };
    const r = await runtime.complete(input());
    expect(r).toEqual({ ok: true, text: "hi there", usage: { inputTokens: 1_000_000, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, costUsd: 1, backend: "api" });
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0]!.body).toMatchObject({ model: API_MODELS.haiku, max_tokens: 100, system: "Be brief.", messages: [{ role: "user", content: "hello" }] });
    expect(calls[0]!.headers["x-api-key"]).toBe("sk-test");
  });

  test("an unknown model is passed through with no cost; errors carry the status", async () => {
    reply.body = { content: [{ type: "text", text: "x" }], usage: { input_tokens: 1, output_tokens: 1 } };
    const r = await runtime.complete(input({ model: "claude-future-9" }));
    expect(r).toMatchObject({ ok: true, costUsd: undefined });
    expect(calls.at(-1)!.body.model).toBe("claude-future-9");
    reply.status = 429;
    reply.body = { error: { message: "slow down" } };
    expect(await runtime.complete(input())).toEqual({ ok: false, error: "API 429: slow down", backend: "api" });
    reply.status = 200;
  });

  test("tools are refused rather than dropped", async () => {
    expect(await runtime.complete(input({ tools: ["WebSearch"] }))).toMatchObject({ ok: false, error: expect.stringMatching(/tools need a CLI runtime/) });
  });

  test("apiCost uses the list prices", () => {
    expect(apiCost("claude-sonnet-5", { inputTokens: 1e6, cacheWriteTokens: 1e6, cacheReadTokens: 1e6, outputTokens: 1e6 })).toBeCloseTo(2 + 2.5 + 0.2 + 10);
    expect(apiCost("nope", { inputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 })).toBeUndefined();
  });
});
