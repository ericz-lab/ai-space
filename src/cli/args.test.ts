import { describe, expect, test } from "bun:test";
import { need, noMore, parseArgs, parseCount, parseDuration } from "./args.ts";
import { UsageError } from "./types.ts";

describe("parseArgs", () => {
  const spec = { app: { kind: "value", alias: "a" }, wait: { kind: "bool", alias: "w" }, tag: { kind: "list" } } as const;

  test("values, booleans, lists and positionals in any order", () => {
    const r = parseArgs(["x", "--app", "demo", "-w", "y", "--tag=one", "--tag", "two"], spec);
    expect(r.flags).toEqual({ app: "demo", wait: true, tag: ["one", "two"] });
    expect(r.positional).toEqual(["x", "y"]);
  });

  test("short aliases and -- stop option parsing", () => {
    const r = parseArgs(["-a", "demo", "--", "--not-a-flag", "-x"], spec);
    expect(r.flags.app).toBe("demo");
    expect(r.positional).toEqual(["--not-a-flag", "-x"]);
  });

  test("unknown and malformed options are usage errors", () => {
    expect(() => parseArgs(["--nope"], spec)).toThrow(UsageError);
    expect(() => parseArgs(["-z"], spec)).toThrow(/unknown option -z/);
    expect(() => parseArgs(["--app"], spec)).toThrow(/needs a value/);
    expect(() => parseArgs(["--wait=1"], spec)).toThrow(/takes no value/);
  });

  test("a lone dash is positional (stdin)", () => {
    expect(parseArgs(["-"], spec).positional).toEqual(["-"]);
  });
});

test("need and noMore", () => {
  expect(need(["a"], 0, "APP")).toBe("a");
  expect(() => need([], 0, "APP")).toThrow(/APP is required/);
  expect(() => noMore(["a", "b"], 1)).toThrow(/unexpected argument: b/);
});

test("parseDuration reads the units the manifest uses", () => {
  expect(parseDuration("30m")).toBe(1_800_000);
  expect(parseDuration("2h")).toBe(7_200_000);
  expect(parseDuration("90s")).toBe(90_000);
  expect(parseDuration("1d")).toBe(86_400_000);
  expect(parseDuration("500")).toBe(500);
  expect(() => parseDuration("soon")).toThrow(UsageError);
});

test("parseCount wants a positive whole number", () => {
  expect(parseCount(undefined, 20)).toBe(20);
  expect(parseCount("5", 20)).toBe(5);
  expect(() => parseCount("0", 20)).toThrow(UsageError);
  expect(() => parseCount("x", 20)).toThrow(UsageError);
});
