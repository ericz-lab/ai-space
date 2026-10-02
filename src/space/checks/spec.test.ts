import { describe, expect, test } from "bun:test";
import { parseManifest } from "../scheduler/manifest.ts";
import { checkViews } from "../panel/api.ts";
import { parseChecksSpec } from "./spec.ts";

const check = (extra: Record<string, unknown> = {}) => ({ name: "today", http: { path: "/api/status" }, done: [{ path: "$.done", eq: true }], ...extra });

describe("checks spec", () => {
  test("parses assertions, when, due and timezone", () => {
    const [c] = parseChecksSpec([
      check({
        title: "Bars for today",
        when: [{ path: "$.today.open", eq: true }],
        done: [{ path: "$.latest.status", eq: "ok" }, { path: "$.at", today: true }, { path: "$.at", age: "26h" }, { path: "$.failed", lt: 20 }, { path: "$.items[0].id", exists: true }],
        due: "18:00",
        timezone: "Asia/Hong_Kong",
      }),
    ]);
    expect(c).toEqual({
      name: "today",
      title: "Bars for today",
      path: "/api/status",
      when: [{ path: "$.today.open", operator: "eq", value: true }],
      done: [
        { path: "$.latest.status", operator: "eq", value: "ok" },
        { path: "$.at", operator: "today" },
        { path: "$.at", operator: "ageLessThan", value: 26 * 3_600_000 },
        { path: "$.failed", operator: "lt", value: 20 },
        { path: "$.items[0].id", operator: "exists" },
      ],
      due: "18:00",
      timezone: "Asia/Hong_Kong",
    });
  });

  test("rejects what an inspection page could not read", () => {
    expect(() => parseChecksSpec({})).toThrow("must be a list");
    expect(() => parseChecksSpec([check({ extra: 1 })])).toThrow('unknown key "extra"');
    expect(() => parseChecksSpec([check(), check()])).toThrow("duplicate checks name");
    expect(() => parseChecksSpec([check({ http: { path: "http://x/y" } })])).toThrow("must start with /");
    expect(() => parseChecksSpec([check({ http: { path: "/x", method: "POST" } })])).toThrow("GET");
    expect(() => parseChecksSpec([check({ done: [] })])).toThrow("at least one assertion");
    expect(() => parseChecksSpec([check({ done: [{ path: "done", eq: true }] })])).toThrow("field path");
    expect(() => parseChecksSpec([check({ done: [{ path: "$.a", eq: 1, lt: 2 }] })])).toThrow("exactly one");
    expect(() => parseChecksSpec([check({ done: [{ path: "$.a", like: "x" }] })])).toThrow('unknown operator "like"');
    expect(() => parseChecksSpec([check({ due: "6pm", timezone: "UTC" })])).toThrow("local time");
    expect(() => parseChecksSpec([check({ due: "18:00" })])).toThrow("need a timezone");
    expect(() => parseChecksSpec([check({ done: [{ path: "$.at", today: true }] })])).toThrow("need a timezone");
    expect(() => parseChecksSpec([check({ due: "18:00", timezone: "Mars/Base" })])).toThrow("IANA zone");
  });

  test("the manifest carries checks and their translations; a check needs a service", () => {
    const yaml = `
name: picker
title: Picker
service: { command: run, port: 8975 }
i18n:
  zh:
    title: 选股
    checks:
      today: { title: 当日数据 }
checks:
  - name: today
    title: Bars for today
    http: { path: "/api/status?market=hk" }
    done: [{ path: $.done, eq: true }]
`;
    const m = parseManifest(yaml, "/apps/picker");
    expect(m.checks?.map((c) => c.name)).toEqual(["today"]);
    expect(checkViews({ manifest: m, manifestOnly: false, registeredAt: 0 })).toEqual([
      {
        id: "picker/today",
        app: "picker",
        appTitle: "Picker",
        name: "today",
        title: "Bars for today",
        path: "/api/status?market=hk",
        done: [{ path: "$.done", operator: "eq", value: true }],
        url: "http://127.0.0.1:8975/api/status?market=hk",
        i18n: { zh: { appTitle: "选股", title: "当日数据" } },
      },
    ]);
    expect(checkViews({ manifest: { ...m, status: "paused" }, manifestOnly: false, registeredAt: 0 })).toEqual([]);
    expect(() => parseManifest(yaml.replace("service: { command: run, port: 8975 }", ""), "/apps/picker")).toThrow("checks need a service");
    expect(() => parseManifest(yaml.replace("today: { title: 当日数据 }", "other: { title: x }"), "/apps/picker")).toThrow('no check named "other"');
  });
});
