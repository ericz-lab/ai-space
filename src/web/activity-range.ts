import type { UsageRow } from "./api.ts";

export type UsageWindow = "7d" | "30d" | "90d" | "all";
const DAY = 86_400_000;

/** Rolling windows touch partial UTC days at both ends, just like the usage API. */
export function activityRange(rows: UsageRow[], window: UsageWindow, now: number) {
  const today = Math.floor(now / DAY) * DAY;
  let first: string | null = null;
  for (const row of rows) for (const d of row.daily) if (first === null || d.day < first) first = d.day;
  const start = window === "all" ? (first ? Date.parse(first + "T00:00:00Z") : today) : Math.floor((now - Number.parseInt(window) * DAY) / DAY) * DAY;
  const days = Math.max(1, Math.round((today - start) / DAY) + 1);
  // Bound SVG work for long-lived spaces, retaining every day in equal-sized buckets.
  const bucketDays = Math.ceil(days / 90);
  return { start, end: today, first, days, bucketDays, buckets: Math.ceil(days / bucketDays) };
}

export function activityBars(row: UsageRow | undefined, range: ReturnType<typeof activityRange>) {
  const values = Array<number>(range.buckets).fill(0);
  for (const d of row?.daily ?? []) {
    const day = Math.round((Date.parse(d.day + "T00:00:00Z") - range.start) / DAY);
    if (day < 0 || day >= range.days) continue;
    const index = Math.floor(day / range.bucketDays);
    values[index]! += row?.activeMs == null ? d.opens : d.activeMs;
  }
  return values;
}
