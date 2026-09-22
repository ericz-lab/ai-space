import { describe, expect, test } from "bun:test";
import { parseEventsSpec, parseProvidesSpec, triggersFromConsumes } from "./spec.ts";

describe("events spec", () => {
  test("publishes accept names or mappings and reject duplicates", () => {
    const spec = parseEventsSpec({ publishes: ["digest.added", { name: "digest.failed", description: "The pipeline gave up.", example: { id: "x" } }] });
    expect(spec.publishes).toEqual([{ name: "digest.added" }, { name: "digest.failed", description: "The pipeline gave up.", example: { id: "x" } }]);
    expect(() => parseEventsSpec({ publishes: ["a", "a"] })).toThrow(/declared twice/);
    expect(() => parseEventsSpec({ publishes: ["bad name"] })).toThrow(/invalid event name/);
    expect(() => parseEventsSpec({ publishes: [{ name: "a", extra: 1 }] })).toThrow(/unknown key "extra"/);
  });

  test("consumes: task, http and stream forms", () => {
    const spec = parseEventsSpec({
      consumes: [
        { event: "video-digest/digest.added", filter: { channel: ["A", "B"] }, task: "curate", debounce: "2h" },
        { event: "feed/item.added", http: { path: "/api/ingest" } },
        "portfolio/*",
      ],
    });
    expect(spec.consumes).toEqual([
      { event: "video-digest/digest.added", filter: { channel: ["A", "B"] }, kind: "task", task: "curate", debounceMs: 2 * 3_600_000 },
      { event: "feed/item.added", kind: "http", method: "POST", path: "/api/ingest" },
      { event: "portfolio/*", kind: "stream" },
    ]);
  });

  test("consumes rejects bad forms", () => {
    expect(() => parseEventsSpec({ consumes: [{ event: "x" }] })).toThrow(/expected <app>\/<event>/);
    expect(() => parseEventsSpec({ consumes: [{ event: "a/b", task: "t", http: { path: "/x" } }] })).toThrow(/task or http, not both/);
    expect(() => parseEventsSpec({ consumes: [{ event: "a/b", http: { path: "/x" }, debounce: "1m" }] })).toThrow(/debounce applies to task/);
    expect(() => parseEventsSpec({ consumes: [{ event: "a/b", http: { path: "x" } }] })).toThrow(/path must start with/);
    expect(() => parseEventsSpec({ consumes: [{ event: "a/b", http: { path: "/x", method: "HEAD" } }] })).toThrow(/unsupported method/);
    expect(() => parseEventsSpec({ consumes: [{ event: "a/b", when: 1 }] })).toThrow(/unknown key "when"/);
    expect(() => parseEventsSpec({ other: 1 })).toThrow(/unknown key "other"/);
    expect(parseEventsSpec(undefined)).toEqual({ publishes: [], consumes: [] });
  });

  test("task subscriptions become triggers on existing tasks only", () => {
    const spec = parseEventsSpec({ consumes: [{ event: "a/b", task: "t1" }, { event: "a/c", task: "t1", filter: { k: "v" }, debounce: 5000 }, { event: "a/d", http: { path: "/x" } }] });
    const map = triggersFromConsumes(spec, ["t1", "t2"]);
    expect([...map.entries()]).toEqual([["t1", [{ event: "a/b" }, { event: "a/c", filter: { k: "v" }, debounceMs: 5000 }]]]);
    expect(() => triggersFromConsumes(spec, ["t2"])).toThrow(/task "t1" is not declared/);
  });
});

describe("provides spec", () => {
  test("parses capabilities with defaults", () => {
    const caps = parseProvidesSpec({
      research: { description: "Research a symbol.", http: { method: "post", path: "/api/research" }, timeout: "2m", callers: ["portfolio", "portfolio", "thesis"] },
      ping: { http: { path: "/ping" } },
    });
    expect(caps).toEqual([
      { name: "research", description: "Research a symbol.", method: "POST", path: "/api/research", timeoutMs: 120_000, callers: ["portfolio", "thesis"] },
      { name: "ping", method: "POST", path: "/ping", timeoutMs: 60_000 },
    ]);
  });

  test("rejects bad capabilities", () => {
    expect(() => parseProvidesSpec({ "bad name": { http: { path: "/x" } } })).toThrow(/not a capability name/);
    expect(() => parseProvidesSpec({ a: { description: "no http" } })).toThrow(/http is required/);
    expect(() => parseProvidesSpec({ a: { http: { path: "/x" }, timeout: "1h" } })).toThrow(/between 1s and 15m/);
    expect(() => parseProvidesSpec({ a: { http: { path: "/x" }, callers: [] } })).toThrow(/callers must be/);
    expect(() => parseProvidesSpec({ a: { http: { path: "/x" }, secret: 1 } })).toThrow(/unknown key "secret"/);
    expect(() => parseProvidesSpec([1])).toThrow(/must map capability names/);
    expect(parseProvidesSpec(undefined)).toEqual([]);
  });
});
