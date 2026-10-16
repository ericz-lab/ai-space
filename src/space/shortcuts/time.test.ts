import { expect, test } from "bun:test";
import { addDays, dateIn, isDate, isTimezone, localInstant, resolveDate, resolvePeriod } from "./time.ts";

// 2026-10-16 23:30 UTC: already Saturday 17th in Seoul, still Friday 16th in New York.
const NOW = Date.parse("2026-10-16T23:30:00Z");

test("relative dates resolve in the operator's zone, not the server's", () => {
  expect(dateIn(NOW, "Asia/Seoul")).toBe("2026-10-17");
  expect(dateIn(NOW, "America/New_York")).toBe("2026-10-16");
  expect(resolveDate("today", "Asia/Seoul", NOW)).toBe("2026-10-17");
  expect(resolveDate("tomorrow", "America/New_York", NOW)).toBe("2026-10-17");
  expect(resolveDate("yesterday", "UTC", NOW)).toBe("2026-10-15");
  expect(resolveDate("2026-02-28", "UTC", NOW)).toBe("2026-02-28");
  expect(() => resolveDate("2026-02-30", "UTC", NOW)).toThrow(/not a date/);
  expect(() => resolveDate("next friday", "UTC", NOW)).toThrow();
});

test("periods are inclusive dates with Monday weeks", () => {
  expect(resolvePeriod("today", "Asia/Seoul", NOW)).toEqual({ from: "2026-10-17", to: "2026-10-17" });
  // Seoul's Saturday 17th sits in the week of Monday 12th; New York's Friday 16th too.
  expect(resolvePeriod("this-week", "Asia/Seoul", NOW)).toEqual({ from: "2026-10-12", to: "2026-10-18" });
  expect(resolvePeriod("next-week", "America/New_York", NOW)).toEqual({ from: "2026-10-19", to: "2026-10-25" });
  expect(resolvePeriod("this-month", "UTC", Date.parse("2026-02-10T00:00:00Z"))).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  expect(resolvePeriod("this-month", "UTC", Date.parse("2026-12-31T00:00:00Z"))).toEqual({ from: "2026-12-01", to: "2026-12-31" });
  expect(resolvePeriod("last-7-days", "UTC", NOW)).toEqual({ from: "2026-10-10", to: "2026-10-16" });
  expect(resolvePeriod("2026-10-01..2026-10-03", "UTC", NOW)).toEqual({ from: "2026-10-01", to: "2026-10-03" });
  expect(() => resolvePeriod("2026-10-03..2026-10-01", "UTC", NOW)).toThrow();
});

test("zones are IANA names; dates are checked component by component", () => {
  expect(isTimezone("Asia/Seoul")).toBe(true);
  expect(isTimezone("UTC")).toBe(true);
  expect(isTimezone("Mars/Base")).toBe(false);
  expect(isTimezone("UTC+9")).toBe(false);
  expect(isDate("2024-02-29")).toBe(true);
  expect(isDate("2026-02-29")).toBe(false);
  expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
});

test("a local wall clock becomes one instant; a skipped one is refused", () => {
  expect(new Date(localInstant("2026-10-17", "15:00", "Asia/Seoul")).toISOString()).toBe("2026-10-17T06:00:00.000Z");
  expect(new Date(localInstant("2026-07-01", "09:30", "America/New_York")).toISOString()).toBe("2026-07-01T13:30:00.000Z");
  expect(() => localInstant("2026-03-08", "02:30", "America/New_York")).toThrow(/does not exist/);
  // The repeated hour takes the earlier instant (EDT).
  expect(new Date(localInstant("2026-11-01", "01:30", "America/New_York")).toISOString()).toBe("2026-11-01T05:30:00.000Z");
});
