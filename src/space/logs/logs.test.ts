import { expect, test } from "bun:test";
import { readLines, renderLogsCommand, unitFor, wrap } from "./logs.ts";
import { DEFAULT_SERVICE_LOGS } from "../config.ts";

test("renderLogsCommand substitutes the three words and nothing else", () => {
  expect(renderLogsCommand(DEFAULT_SERVICE_LOGS, { app: "demo", lines: 50, follow: false })).toBe("journalctl --user -u demo -n 50 --no-pager");
  expect(renderLogsCommand(DEFAULT_SERVICE_LOGS, { app: "demo", lines: 50, follow: true })).toBe("journalctl --user -u demo -n 50 --no-pager -f");
  expect(renderLogsCommand("tail -n {lines} {follow} /var/log/{app}.log", { app: "space", lines: 3, follow: true })).toBe("tail -n 3 -f /var/log/ai-space.log");
  expect(renderLogsCommand("x {app} {lines}", { app: "a", lines: 1_000_000, follow: false })).toBe("x a 10000");
  expect(renderLogsCommand("x {app} {lines}", { app: "a", lines: 0, follow: false })).toBe("x a 100");
  expect(() => renderLogsCommand(DEFAULT_SERVICE_LOGS, { app: "a; rm -rf /", lines: 1, follow: false })).toThrow(/invalid app name/);
});

test("the space itself is the ai-space unit", () => {
  expect(unitFor("space")).toBe("ai-space");
  expect(unitFor("demo")).toBe("demo");
});

test("wrap forwards the shell's signal to the command", () => {
  const w = wrap("tail -f x");
  expect(w).toContain("trap 'kill -TERM $c");
  expect(w).toContain("tail -f x 2>&1 & c=$!; wait $c");
});

test("readLines splits on newlines across chunks and keeps a last partial line", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode("a\nb"));
      c.enqueue(new TextEncoder().encode("c\nd"));
      c.close();
    },
  });
  const lines = [];
  for await (const l of readLines(stream)) lines.push(l);
  expect(lines).toEqual(["a", "bc", "d"]);
});
