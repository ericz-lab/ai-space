import { expect, test } from "bun:test";
import { type CallTrace, failureText, fallbackNote, traceLines } from "./call-trace.ts";

/** The fallback note and trace lines the Model usage window shows (src/web/call-trace.ts, docs/model.md#trace). */

test("the row note names the first choice and the tries, and is empty for a plain call", () => {
  expect(fallbackNote({ fallbackFrom: "codex/basic", tries: 2 }, "en")).toBe("fallback from codex/basic · 2 tries");
  expect(fallbackNote({ fallbackFrom: "codex/basic", tries: 2 }, "zh")).toBe("由 codex/basic 回退 · 尝试 2 次");
  expect(fallbackNote({ tries: 1 }, "en")).toBe("");
  expect(fallbackNote({}, "en")).toBe("");
});

test("a cause this client does not know reads as other", () => {
  expect(failureText("quota", "en")).toBe("quota used up");
  expect(failureText("something-new", "en")).toBe("other error");
});

test("the trace reads in the order it happened, and says why it stopped", () => {
  const trace: CallTrace = {
    skippedLayers: [{ source: "override-tag", model: "gone/basic" }],
    candidates: [
      { model: "claude/basic" },
      { model: "deepseek/basic", skipped: "cannot attach files" },
      { model: "codex/basic", later: "resting", restKind: "rate" },
    ],
    tries: [
      { runtime: "claude", model: "basic", ok: false, kind: "quota", ms: 1200 },
      { runtime: "codex", machine: "box", model: "basic", ok: false, kind: "transport", ms: 800, streamed: true },
    ],
    stop: "streamed",
  };
  const lines = traceLines(trace, "en");
  expect(lines[0]).toContain("gone/basic");
  expect(lines[1]).toBe("deepseek/basic skipped: cannot attach files");
  expect(lines[2]).toBe("codex/basic put last: rate limited");
  expect(lines[3]).toStartWith("1. claude/basic failed: quota used up · ");
  expect(lines[4]).toStartWith("2. box:codex/basic failed: connection failing · ");
  expect(lines[4]).toEndWith(" · after output had started");
  expect(lines[5]).toBe("Stopped: output had already reached the caller");
  expect(lines).toHaveLength(6);
});

test("an answered call adds no stop line; the model behind a gateway is shown", () => {
  const lines = traceLines({ tries: [{ runtime: "magpie", model: "basic", ok: true, ms: 500, served: "deepseek/deepseek-chat" }], stop: "answered" }, "en");
  expect(lines).toHaveLength(1);
  expect(lines[0]).toEndWith(" · served by deepseek/deepseek-chat");
});
