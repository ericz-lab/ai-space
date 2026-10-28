import { describe, expect, test } from "bun:test";
import { classifyFailure, REST_MS, resetsAt, restFor } from "./failure.ts";
import { RuntimeHealth } from "./health.ts";

/** Failure classification and rest by cause: src/space/model/failure.ts, docs/model-machines.md#status. */

const NOW = Date.parse("2026-10-28T10:00:00Z");
const MIN = 60_000;

describe("classifyFailure", () => {
  const cases: [string, string][] = [
    // credit: no money left
    ["API 400: Your credit balance is too low to access the Anthropic API.", "credit"],
    ["API 402: Insufficient Balance", "credit"],
    ['{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}', "credit"],
    ["账户余额不足，请充值", "credit"],
    // quota: the plan's allowance is used up
    ["Claude AI usage limit reached|1793189400", "quota"],
    ["You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:05 PM.", "quota"],
    ["5-hour limit reached ∙ resets 3pm (America/Los_Angeles)", "quota"],
    ["You've hit your limit · resets 7pm (Europe/Berlin)", "quota"],
    ["API 429: weekly usage limit exceeded", "quota"],
    ["今日额度已用完", "quota"],
    // rate: a short limit or an overloaded vendor
    ["exceeded retry limit, last status: 429 Too Many Requests", "rate"],
    ["API 429: Number of request tokens has exceeded your per-minute rate limit", "rate"],
    ["Rate limit reached for gpt-6-luna on tokens per min (TPM): Limit 30000. Please try again in 6ms.", "rate"],
    ['API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', "rate"],
    ["model is at capacity", "rate"],
    ["You exceeded your current quota ... quotaId GenerateContentInputTokensPerModelPerMinute. Please retry in 33s", "rate"],
    // auth: the sign-in or key was refused
    ["Invalid API key · Please run /login", "auth"],
    ["API 401: invalid x-api-key", "auth"],
    ["unexpected status 401 Unauthorized: token has expired", "auth"],
    ["peer box rejected the token", "auth"],
    ["Permission denied (publickey).", "auth"],
    // transport: the link, not the account or the request
    ["ssh: connect to host box port 22: Connection refused", "transport"],
    ["client_loop: send disconnect: Broken pipe", "transport"],
    ["stream disconnected before completion: error sending request for url", "transport"],
    ["peer box: the link dropped (fetch failed) and did not come back before the call's deadline", "transport"],
    ["peer box: HTTP 502", "transport"],
    ["API 503: service unavailable", "transport"],
    ["API Error: 500 Internal server error", "transport"],
    // other: the request, or the call's own end
    ["API 400: prompt is too long: 250000 tokens > 200000 maximum", "other"],
    ["timed out after 120s", "other"],
    ["aborted", "other"],
    ["interrupted: ai-space stopped while the call was running", "other"],
    ["empty answer", "other"],
    ["Codex stream ended without turn.completed", "other"],
  ];
  for (const [error, kind] of cases) test(`${kind}: ${error.slice(0, 60)}`, () => expect(classifyFailure(error, NOW).kind).toBe(kind as never));

  test("a quota or rate failure carries the reset time it names; others never do", () => {
    expect(classifyFailure("Claude AI usage limit reached|1793189400", NOW)).toEqual({ kind: "quota", resetsAt: 1793189400_000 });
    expect(classifyFailure("API 429: slow down (retry after 30s)", NOW)).toEqual({ kind: "rate", resetsAt: NOW + 30_000 });
    expect(classifyFailure("API 401: invalid x-api-key (retry after 30s)", NOW)).toEqual({ kind: "auth" });
  });
});

describe("resetsAt", () => {
  test("reads the forms the CLIs and APIs use", () => {
    expect(resetsAt("usage limit reached|1793189400", NOW)).toBe(1793189400_000);
    expect(resetsAt('{"type":"usage_limit_reached","resets_at":1793189400}', NOW)).toBe(1793189400_000);
    expect(resetsAt('{"resets_in_seconds": 600}', NOW)).toBe(NOW + 600_000);
    expect(resetsAt("API 429: slow down (retry after 45s)", NOW)).toBe(NOW + 45_000);
    expect(resetsAt("Try again in 2h 5m", NOW)).toBe(NOW + 125 * MIN);
    expect(resetsAt("Daily free limit reached. Try again in 1 day 3 hours", NOW)).toBe(NOW + 27 * 60 * MIN);
    expect(resetsAt("Please retry in 33s", NOW)).toBe(NOW + 33_000);
    expect(resetsAt("your usage will reset at 2026-10-28 12:37:53 UTC.", NOW)).toBe(Date.parse("2026-10-28T12:37:53Z"));
    expect(resetsAt("resets at 2026-10-28T20:00:00+08:00", NOW)).toBe(Date.parse("2026-10-28T12:00:00Z"));
  });

  test("a wall-clock time is the next one in the zone it names, else the one given", () => {
    // 10:00 UTC is 03:00 in Los Angeles (PDT, UTC-7): 3pm there is 22:00 UTC the same day.
    expect(resetsAt("5-hour limit reached ∙ resets 3pm (America/Los_Angeles)", NOW)).toBe(Date.parse("2026-10-28T22:00:00Z"));
    // 10:00 UTC is 11:00 in Berlin (CET, UTC+1 after the change on the 25th): 7am has passed, so tomorrow.
    expect(resetsAt("You've hit your limit · resets 7am (Europe/Berlin)", NOW)).toBe(Date.parse("2026-10-29T06:00:00Z"));
    expect(resetsAt("resets 3:30pm", NOW, "UTC")).toBe(Date.parse("2026-10-28T15:30:00Z"));
    expect(resetsAt("try again at 3:05 PM.", NOW, "Asia/Shanghai")).toBe(Date.parse("2026-10-28T07:05:00Z") + 24 * 60 * MIN);
    expect(resetsAt("or try again at Oct 30th, 2026 9:15 AM.", NOW, "UTC")).toBe(Date.parse("2026-10-30T09:15:00Z"));
  });

  test("a time past, or further off than eight days, is not trusted", () => {
    expect(resetsAt("usage limit reached|1600000000", NOW)).toBeUndefined();
    expect(resetsAt("Try again in 30 days", NOW)).toBeUndefined();
    expect(resetsAt("please retry in a moment", NOW)).toBeUndefined();
    expect(resetsAt("nothing about time", NOW)).toBeUndefined();
  });
});

describe("restFor", () => {
  test("the default by cause, the named time when there is one, and none for auth or other", () => {
    expect(restFor({ kind: "credit" }, NOW)).toEqual({ until: NOW + 30 * MIN, said: false });
    expect(restFor({ kind: "quota" }, NOW)).toEqual({ until: NOW + 15 * MIN, said: false });
    expect(restFor({ kind: "quota", resetsAt: NOW + 3 * 60 * MIN }, NOW)).toEqual({ until: NOW + 3 * 60 * MIN, said: true });
    expect(restFor({ kind: "auth" }, NOW)).toBeUndefined();
    expect(restFor({ kind: "other" }, NOW)).toBeUndefined();
  });

  test("rate limits and transport failures in a row double, up to their caps", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => (restFor({ kind: "rate" }, NOW, n)!.until - NOW) / MIN)).toEqual([1, 2, 4, 8, 16, 30, 30]);
    expect([1, 2, 3, 4, 5].map((n) => (restFor({ kind: "transport" }, NOW, n)!.until - NOW) / MIN)).toEqual([1, 2, 4, 8, 10]);
  });
});

describe("cells rest by cause", () => {
  test("rate limits in a row back off; one long after the last rest starts over; a success clears the run", () => {
    let now = NOW;
    const h = new RuntimeHealth({ now: () => now, prober: async () => ({}) });
    const restMin = () => (Date.parse(h.list()[0]!.limitedUntil!) - now) / MIN;
    h.note("", "codex", "429 Too Many Requests");
    expect(restMin()).toBe(1);
    now += MIN;
    h.note("", "codex", "429 Too Many Requests");
    expect(restMin()).toBe(2);
    now += 2 * MIN;
    h.note("", "codex", "429 Too Many Requests");
    expect(restMin()).toBe(4);
    now += 4 * MIN + REST_MS.forget;
    h.note("", "codex", "429 Too Many Requests");
    expect(restMin()).toBe(1);
    h.note("", "codex");
    now += 2 * MIN;
    h.note("", "codex", "429 Too Many Requests");
    expect(restMin()).toBe(1);
  });

  test("the time the runtime names wins and is marked so; a shorter rest never cuts a longer one", () => {
    const now = NOW;
    const h = new RuntimeHealth({ now: () => now, prober: async () => ({}) });
    h.note("", "claude", "Claude AI usage limit reached|1793189400");
    expect(h.list()[0]).toMatchObject({ limitedUntil: new Date(1793189400_000).toISOString(), restKind: "quota", restSaid: true });
    h.note("", "claude", "client_loop: send disconnect: Broken pipe");
    expect(h.list()[0]).toMatchObject({ limitedUntil: new Date(1793189400_000).toISOString(), restKind: "quota", lastErrorKind: "transport" });
    expect(h.resting("", "claude")).toEqual({ until: new Date(1793189400_000).toISOString(), kind: "quota" });
  });

  test("auth and other failures do not rest the cell, and leave signed in to the probes", () => {
    const h = new RuntimeHealth({ now: () => NOW, prober: async () => ({}) });
    h.note("", "claude", "Invalid API key · Please run /login");
    expect(h.list()[0]).toMatchObject({ lastErrorKind: "auth" });
    expect(h.list()[0]!.limitedUntil).toBeUndefined();
    expect(h.list()[0]!.signedIn).toBeUndefined();
    expect(h.resting("", "claude")).toBeUndefined();
  });
});
