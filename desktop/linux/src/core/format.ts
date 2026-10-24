/** Times in the client's words, in the person's own zone (docs/time.md: the Space sends ISO 8601 or epoch milliseconds). */

export function toMillis(t: string | number): number {
  return typeof t === "number" ? t : Date.parse(t);
}

/** "just now", "5 minutes ago", "yesterday"; beyond a week the date itself. */
export function relativeTime(t: string | number, lang: string, now = Date.now()): string {
  const ms = toMillis(t);
  if (!Number.isFinite(ms)) return "";
  const locale = lang === "zh" ? "zh-CN" : "en";
  const diff = (ms - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return lang === "zh" ? "刚刚" : "just now";
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 7 * 86400) return rtf.format(Math.round(diff / 86400), "day");
  return new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric" }).format(new Date(ms));
}
