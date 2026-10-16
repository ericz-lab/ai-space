import { PERIODS, RELATIVE_DATES } from "./types.ts";

/**
 * Calendar arithmetic for action inputs (docs/time.md): "today", "this-week" and friends resolve to
 * calendar dates in the run's timezone, never the server's. Weeks start on Monday. A date stays a
 * `YYYY-MM-DD` label: it is never turned into a midnight instant.
 */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** True for an IANA zone the runtime knows (`UTC` included); abbreviations like CST are refused. */
export function isTimezone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz.trim() || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The calendar date of `at` in `tz`. */
export function dateIn(at: number, tz: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
}

/** A valid calendar date: the components are checked, so 2026-02-30 is refused instead of rolling over. */
export function isDate(s: unknown): s is string {
  const m = typeof s === "string" ? DATE_RE.exec(s) : null;
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

export function isTime(s: unknown): s is string {
  return typeof s === "string" && TIME_RE.test(s);
}

/** `date` moved by `days` calendar days (pure date arithmetic, no zone involved). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Monday = 0 … Sunday = 6. */
function weekday(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/** A date input's value: a `YYYY-MM-DD` as given, a relative word resolved in `tz` at `now`. */
export function resolveDate(value: string, tz: string, now: number): string {
  const today = dateIn(now, tz);
  if (value === "today") return today;
  if (value === "tomorrow") return addDays(today, 1);
  if (value === "yesterday") return addDays(today, -1);
  if (isDate(value)) return value;
  throw new Error(`"${value}" is not a date (YYYY-MM-DD or ${RELATIVE_DATES.join(", ")})`);
}

/** A period input's value as inclusive dates. */
export function resolvePeriod(value: string, tz: string, now: number): { from: string; to: string } {
  const today = dateIn(now, tz);
  switch (value) {
    case "today":
      return { from: today, to: today };
    case "tomorrow":
      return { from: addDays(today, 1), to: addDays(today, 1) };
    case "this-week": {
      const monday = addDays(today, -weekday(today));
      return { from: monday, to: addDays(monday, 6) };
    }
    case "next-week": {
      const monday = addDays(today, 7 - weekday(today));
      return { from: monday, to: addDays(monday, 6) };
    }
    case "this-month": {
      const first = `${today.slice(0, 8)}01`;
      const next = addDays(`${today.slice(0, 7)}-28`, 4);
      return { from: first, to: addDays(`${next.slice(0, 8)}01`, -1) };
    }
    case "last-7-days":
      return { from: addDays(today, -6), to: today };
  }
  const m = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(value);
  if (m && isDate(m[1]) && isDate(m[2]) && m[1]! <= m[2]!) return { from: m[1]!, to: m[2]! };
  throw new Error(`"${value}" is not a period (${PERIODS.join(", ")} or YYYY-MM-DD..YYYY-MM-DD)`);
}

/**
 * The instant of a local date and time in `tz`, or an error when the wall clock does not exist there
 * (a daylight-saving gap). An ambiguous time (the repeated hour) takes the earlier instant.
 */
export function localInstant(date: string, time: string, tz: string): number {
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const [h, mi] = time.split(":").map(Number) as [number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  // Two passes over the zone's offset find the instant whose wall clock is `wall`.
  const candidates = new Set<number>();
  for (const guess of [wall - offsetAt(wall, tz), wall - offsetAt(wall - 86_400_000, tz), wall - offsetAt(wall + 86_400_000, tz)]) {
    if (wallClock(guess, tz) === wall) candidates.add(guess);
  }
  if (!candidates.size) throw new Error(`${date} ${time} does not exist in ${tz} (a clock change skips it)`);
  return Math.min(...candidates);
}

function wallClock(at: number, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(new Date(at))
      .map((p) => [p.type, p.value]),
  );
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
}

function offsetAt(at: number, tz: string): number {
  return wallClock(Math.floor(at / 60_000) * 60_000, tz) - Math.floor(at / 60_000) * 60_000;
}
