import { expect, test } from "bun:test";
import { activityBars, activityRange } from "./activity-range.ts";
import type { UsageRow } from "./api.ts";
const now = Date.parse("2026-10-14T13:00:00Z");
const row: UsageRow = { kind: "app", key: "notes", opens: 3, activeMs: 6000, sessions: 1, lastAt: null,
  daily: [{day: "2026-10-09", opens: 3, activeMs: 6000}] };

test("equal totals still get distinct date axes when all activity is recent", () => {
  const week = activityRange([row], "7d", now), month = activityRange([row], "30d", now);
  expect(week.days).toBe(8);
  expect(month.days).toBe(31);
  expect(week.first).toBe("2026-10-09");
  expect(activityBars(row, week).reduce((a,b) => a+b, 0)).toBe(6000);
  expect(activityBars(row, month).reduce((a,b) => a+b, 0)).toBe(6000);
  expect(activityBars(row, week).indexOf(6000)).not.toBe(activityBars(row, month).indexOf(6000));
});

test("all includes older history with bounded bars and counts opens for untracked apps", () => {
  const old = {...row, activeMs: null, daily: [{day:"2020-02-29",opens:2,activeMs:0}, ...row.daily]};
  const range = activityRange([old], "all", now);
  expect(range.start).toBe(Date.parse("2020-02-29T00:00:00Z"));
  expect(range.buckets).toBeLessThanOrEqual(90);
  expect(activityBars(old, range).reduce((a,b) => a+b,0)).toBe(5);
});

test("empty reports and UTC month boundaries are well-defined", () => {
  const range = activityRange([], "all", now);
  expect(range.first).toBeNull();
  expect(activityBars(undefined, range)).toEqual([0]);
  const leap = activityRange([], "7d", Date.parse("2024-03-01T00:30:00Z"));
  expect(new Date(leap.start).toISOString()).toBe("2024-02-23T00:00:00.000Z");
  expect(leap.days).toBe(8);
});
