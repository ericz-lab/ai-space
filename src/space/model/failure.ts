/**
 * Why a model call failed, read from the error the runtime returned, and how long the cell that
 * failed should rest for it (docs/model-machines.md#status). The runtimes give text: a CLI's own
 * message, an API's status and message, a peer's error passed on unchanged, an ssh failure. So the
 * reading is by words, in English and Chinese, as the CLIs and APIs write them.
 *
 *   credit     the account or key has no money left             rests 30 min, or until the time it names
 *   quota      the plan's allowance is used up for now          rests 15 min, or until the time it names
 *   rate       a short rate limit, or the vendor is overloaded  rests 1, 2, 4 … min (at most 30), or as told
 *   transport  the link failed: ssh, the network, a peer, a 5xx rests 1, 2, 4 … min (at most 10)
 *   auth       the sign-in or key was refused                   no rest: the next probe says whether it is signed in
 *   other      anything else: a bad request, a timeout, …       no rest
 *
 * A fallback (docs/model-machines.md#fallback) switches only on the first four: they are about the
 * account or the link, not the request.
 */

export const FAILURE_KINDS = ["credit", "quota", "rate", "auth", "transport", "other"] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

/** The kinds a cell rests for, and a call may move on to its next candidate for. */
export const REST_KINDS: ReadonlySet<FailureKind> = new Set(["credit", "quota", "rate", "transport"]);

/** `resetsAt`: epoch ms when the error itself said the account is back. */
export type Failure = { kind: FailureKind; resetsAt?: number };

const MIN = 60_000;
/** How long a cell rests, by cause, when the error does not say. */
export const REST_MS = {
  credit: 30 * MIN,
  quota: 15 * MIN,
  /** The first rate limit; each one in a row doubles it, up to `rateMax`. */
  rate: MIN,
  rateMax: 30 * MIN,
  /** The first transport failure; each one in a row doubles it, up to `transportMax`. */
  transport: MIN,
  transportMax: 10 * MIN,
  /** The most a time the error names is trusted: a week's window, and a day over. */
  longest: 8 * 24 * 60 * MIN,
  /** A rate limit or transport failure this long after the last rest ended starts a new run, at the first step again. */
  forget: 30 * MIN,
} as const;

/** The call's own end, not the runtime's: never a reason to rest or to switch. */
const OWN = /^(?:aborted\b|interrupted:|timed out\b)/i;
const CREDIT = /insufficient.?(?:balance|credit|fund)|insufficient_quota|credit balance is too low|\bcredits? (?:are |is )?(?:exhausted|used up)|out of credits?\b|payment required|\bAPI 402\b|余额不足|欠费|请充值/i;
const QUOTA = /usage.?limit|limit (?:has been |was )?reached|hit your (?:[\w-]+ )*limit|quota|usage_limit_reached|out of (?:budget|tokens)|budget (?:exceeded|exhausted)|limit.{0,24}resets|RESOURCE_EXHAUSTED|额度|用量|套餐|限额/i;
/** A window of a minute or less: a rate limit, whatever else the error calls it. */
const MINUTE = /per.?(?:second|minute|sec|min)\b|\b[rt]p[ms]\b|(?:token|call|request) rate limit|每分钟|每秒/i;
/** A window longer than a minute, or a plan's own limit: what MINUTE is not. */
const LONG = /usage.?limit|hit your|limit.{0,24}resets|per.?(?:hour|day|week|month)|\bhours?\b|-hour\b|hourly|daily|weekly|monthly|小时|每天|每日|每周|每月/i;
const RATE = /rate.?limit|too many requests|\b429\b|overloaded|at capacity|\b529\b|频率|太频繁|请求过多/i;
const AUTH = /not logged in|please (?:run )?\/?login|log ?in again|unauthori[sz]ed|\b401\b|invalid (?:x-)?api.?key|invalid_api_key|invalid bearer|authentication(?:_error| failed| required)|oauth token|token (?:has )?(?:expired|been revoked|is invalid)|\bforbidden\b|\b403\b|permission denied \(publickey|rejected the token|no DEEPSEEK_API_KEY|no signed-in account/i;
const TRANSPORT =
  /broken pipe|connection (?:reset|closed|refused|timed out|lost)|connection to \S+ closed|network is unreachable|no route to host|could not resolve (?:hostname|host)|name or service not known|temporary failure in name resolution|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|EPIPE|socket hang up|fetch failed|unable to connect|stream disconnected|error sending request|kex_exchange_identification|ssh_exchange_identification|^ssh: |the link dropped|peer stream:|operation timed out|\b(?:API|HTTP)(?: Error)?:? (?:50[0234]|52\d|530)\b|internal server error|bad gateway|service unavailable|gateway time-?out/i;

/** Why a call failed, and when the account is back if the error said so. */
export function classifyFailure(error: string, now = Date.now()): Failure {
  const text = error.trim();
  if (OWN.test(text)) return { kind: "other" };
  const kind = kindOf(text);
  const at = kind === "credit" || kind === "quota" || kind === "rate" ? resetsAt(text, now) : undefined;
  return at === undefined ? { kind } : { kind, resetsAt: at };
}

function kindOf(text: string): FailureKind {
  // Words inside a link are its path, not what the vendor said (a quota-increase URL on a rate limit).
  const words = text.replace(/https?:\/\/\S+/g, "");
  if (CREDIT.test(words)) return "credit";
  const minuteOnly = MINUTE.test(words) && !LONG.test(words);
  if (QUOTA.test(words) && !minuteOnly) return "quota";
  if (RATE.test(words) || minuteOnly) return "rate";
  if (AUTH.test(words)) return "auth";
  if (TRANSPORT.test(text)) return "transport";
  return "other";
}

/**
 * When the account is back, as the error says it; undefined when it does not say, or names a time
 * past or further off than `REST_MS.longest`. Read, in order: Claude Code's `limit reached|<unix>`,
 * `resets_at` / `resets_in_seconds` (Codex's and ChatGPT's), a Retry-After the API adapter appended
 * (`retry after 30s`), `try again in 2h 5m` / `resets in …`, an ISO time with its offset, and a
 * wall-clock time (`resets 3pm (America/Los_Angeles)`, `try again at Oct 29th, 2026 3:05 PM`) in the
 * zone it names, else this machine's.
 */
export function resetsAt(text: string, now = Date.now(), zone?: string): number | undefined {
  const ok = (t: number | undefined) => (t !== undefined && Number.isFinite(t) && t > now && t <= now + REST_MS.longest ? t : undefined);
  const unix = /limit reached\|(\d{10})\b/i.exec(text) ?? /"?resets_at"?\s*[:=]\s*(\d{10})\b/i.exec(text);
  if (unix) return ok(Number(unix[1]) * 1000);
  const inSeconds = /"?resets_in_seconds"?\s*[:=]\s*(\d+)/i.exec(text) ?? /retry.?after:?\s*(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?\b/i.exec(text);
  if (inSeconds) return ok(now + Math.round(Number(inSeconds[1]) * 1000));
  const after = /(?:try again|retry|resets?|back) in\s+(?:(\d+)\s*d(?:ays?)?\b[\s,]*)?(?:(\d+)\s*h(?:ours?|rs?)?\b[\s,]*)?(?:(\d+)\s*m(?:in(?:utes?|s)?)?\b[\s,]*)?(?:(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?\b)?/i.exec(text);
  if (after && (after[1] || after[2] || after[3] || after[4])) {
    const ms = ((Number(after[1] ?? 0) * 24 + Number(after[2] ?? 0)) * 60 + Number(after[3] ?? 0)) * MIN + Number(after[4] ?? 0) * 1000;
    return ok(now + ms);
  }
  const iso = /(?:resets?|reset at|try again at|available at|until)\s*(?:at\s*)?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:Z|UTC|GMT|[+-]\d{2}:?\d{2}))/i.exec(text);
  if (iso) {
    const normal = iso[1]!.replace(/^(\d{4}-\d{2}-\d{2})[ T]/, "$1T").replace(/\s*(?:UTC|GMT)$/i, "Z").replace(/\s+/g, "").replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
    return ok(Date.parse(normal));
  }
  const codex = /try again at\s+(?:([A-Z][a-z]{2})[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4}),? )?(\d{1,2}):(\d{2})\s*([AP]M)\b/i.exec(text);
  if (codex) {
    const hour = to24(Number(codex[4]), codex[6]!);
    const minute = Number(codex[5]);
    if (codex[1]) {
      const month = MONTHS.indexOf(codex[1].slice(0, 3).toLowerCase());
      if (month < 0) return undefined;
      return ok(wallTime(Number(codex[3]), month, Number(codex[2]), hour, minute, zone ?? localZone()));
    }
    return ok(nextWallTime(hour, minute, zone ?? localZone(), now));
  }
  const claude = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)\b(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z_+-]+)*)\))?/i.exec(text);
  if (claude) return ok(nextWallTime(to24(Number(claude[1]), claude[3]!), Number(claude[2] ?? 0), claude[4] ?? zone ?? localZone(), now));
  return undefined;
}

/**
 * How long a cell rests after a failure: the time the error named when it named one, else the
 * default for the cause; rate limits and transport failures double with each one in a row (`streak`,
 * 1 for the first). Undefined for the kinds that do not rest.
 */
export function restFor(failure: Failure, now: number, streak = 1): { until: number; said: boolean } | undefined {
  if (!REST_KINDS.has(failure.kind)) return undefined;
  if (failure.resetsAt !== undefined) return { until: failure.resetsAt, said: true };
  const step = Math.max(0, Math.min(streak, 16) - 1);
  const ms =
    failure.kind === "credit" ? REST_MS.credit
    : failure.kind === "quota" ? REST_MS.quota
    : failure.kind === "rate" ? Math.min(REST_MS.rate * 2 ** step, REST_MS.rateMax)
    : Math.min(REST_MS.transport * 2 ** step, REST_MS.transportMax);
  return { until: now + ms, said: false };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const to24 = (h: number, ampm: string) => (h % 12) + (/pm/i.test(ampm) ? 12 : 0);

function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** The offset of `zone` from UTC at an instant, in ms; 0 for a zone Intl does not know. */
function zoneOffset(at: number, zone: string): number {
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
        .formatToParts(new Date(at))
        .map((p) => [p.type, Number(p.value)]),
    ) as Record<string, number>;
    return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour! % 24, parts.minute!, parts.second!) - Math.floor(at / 1000) * 1000;
  } catch {
    return 0;
  }
}

/** A wall-clock time in a zone as an instant. */
function wallTime(year: number, month: number, day: number, hour: number, minute: number, zone: string): number {
  const guess = Date.UTC(year, month, day, hour, minute);
  const first = guess - zoneOffset(guess, zone);
  // Once more at the found instant, for a time near a daylight-saving change.
  return guess - zoneOffset(first, zone);
}

/** The next time the clock in `zone` shows hour:minute after `now`. */
function nextWallTime(hour: number, minute: number, zone: string, now: number): number {
  const local = new Date(now + zoneOffset(now, zone));
  const today = wallTime(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, minute, zone);
  return today > now ? today : wallTime(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1, hour, minute, zone);
}
