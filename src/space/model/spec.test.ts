import { describe, expect, test } from "bun:test";
import { parseRunInput, parseWindow } from "./spec.ts";

describe("parseRunInput", () => {
  test("fills the defaults and keeps what was given", () => {
    expect(parseRunInput({ prompt: "hi" })).toEqual({ prompt: "hi", model: "sonnet", tag: "other", tools: [], timeoutMs: 120_000, maxTokens: 4096 });
    expect(parseRunInput({ prompt: "hi" }, { model: "haiku" }).model).toBe("haiku");
    expect(parseRunInput({ prompt: "hi", model: "claude-opus-5", tag: "digest", tools: ["WebSearch", " WebFetch "], timeoutMs: 5000, maxTokens: 100 })).toEqual({
      prompt: "hi",
      model: "claude-opus-5",
      tag: "digest",
      tools: ["WebSearch", "WebFetch"],
      timeoutMs: 5000,
      maxTokens: 100,
    });
  });

  test("caps the timeout and rejects bad shapes with the reason", () => {
    expect(parseRunInput({ prompt: "hi", timeoutMs: 1e9 }).timeoutMs).toBe(30 * 60_000);
    expect(() => parseRunInput({})).toThrow(/prompt is required/);
    expect(() => parseRunInput({ prompt: "  " })).toThrow(/prompt is required/);
    expect(() => parseRunInput({ prompt: "x", model: "so nnet" })).toThrow(/model/);
    expect(() => parseRunInput({ prompt: "x", model: "a;rm" })).toThrow(/model/);
    expect(() => parseRunInput({ prompt: "x", tag: "Bad Tag" })).toThrow(/tag/);
    expect(() => parseRunInput({ prompt: "x", tools: "WebSearch" })).toThrow(/tools must be an array/);
    expect(() => parseRunInput({ prompt: "x", tools: ["Bash(rm -rf /)"] })).toThrow(/invalid tool name/);
    expect(() => parseRunInput({ prompt: "x", timeoutMs: -1 })).toThrow(/timeoutMs/);
    expect(() => parseRunInput({ prompt: "x", maxTokens: 1.5 })).toThrow(/maxTokens/);
  });

  test("tool names with a matcher are allowed", () => {
    expect(parseRunInput({ prompt: "x", tools: ["Bash(git:*)", "Read"] }).tools).toEqual(["Bash(git:*)", "Read"]);
  });
});

describe("parseWindow", () => {
  test("defaults to 24h and accepts the known windows only", () => {
    expect(parseWindow(null)).toBe("24h");
    expect(parseWindow("5h")).toBe("5h");
    expect(parseWindow("30d")).toBe("30d");
    expect(() => parseWindow("1y")).toThrow(/window must be one of/);
  });
});
