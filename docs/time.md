# Time and timezone conventions

This is the time contract for new Space apps and changes to existing time-related behavior. It covers storage, APIs, scheduling, user interfaces, AI prompts and business calendars. App authors must distinguish an instant, a calendar date and a local time before choosing a representation.

These are development requirements, not a claim that every deployed app already conforms. The [current implementation](#current-implementation-and-migration) section records existing differences. This document introduces no runtime setting, shared library or manifest field.

## Choose the meaning first

| Meaning | Examples | Representation |
| --- | --- | --- |
| Instant | Record creation, event occurrence, completed run | Unix milliseconds internally; UTC ISO string ending in `Z` in new JSON APIs |
| Calendar date | Birthday, all-day deadline, trading session | Valid `YYYY-MM-DD`; no invented midnight or UTC conversion |
| Local date and time in a zone | Appointment, timed deadline | Local date/time plus an IANA zone; resolve to an instant for execution |
| Recurrence | Every weekday at 09:00 | Calendar rule or cron plus an explicit IANA zone |
| Duration | Timeout, retry delay, elapsed interval | Number with an explicit unit, normally milliseconds |

Use names that reveal the meaning: `createdAt`, `dueDate`, `dueAt`, `localDateTime`, `timezone`, `durationMs`. Document existing names whose meaning is less clear. Never use one untyped field interchangeably for a date and an instant in a new API.

## Storage and API boundaries

For new database schemas, store instants as integer milliseconds since the Unix epoch, following [portable SQL](storage.md#portable-sql). Existing tables containing canonical UTC ISO strings can keep them; do not migrate valid data solely to change its encoding. Both representations must denote the same instant on every machine.

New JSON APIs emit instants as canonical UTC ISO strings, for example `2026-10-01T00:00:00.000Z`. An instant input must include `Z` or an explicit numeric offset. Normalize offset input to UTC. Reject a timestamp such as `2026-10-01T09:00:00` where the endpoint requires an instant: interpreting it in the server's local zone makes deployment change its meaning.

Validate the calendar components as well as the format. A regular expression or a successful `Date.parse()` alone is insufficient validation: invalid dates must not be normalized silently. Document the accepted precision and range, reject non-finite or out-of-range timestamps, and convert upstream epoch seconds explicitly at the adapter boundary. Never guess seconds versus milliseconds from the magnitude of a value.

Keep absent values as `null` or omitted according to the endpoint contract. Do not substitute epoch zero or the current time for a missing source timestamp. If useful, preserve separate `occurredAt` and `receivedAt` values so delayed delivery does not rewrite history.

The following are illustrative app payloads, not new Space API fields:

```json
{"createdAt":"2026-10-01T00:00:00.000Z"}
```

```json
{"dueDate":"2026-10-01"}
```

```json
{"localDateTime":"2026-10-01T09:00:00","timezone":"Asia/Seoul","dueAt":"2026-10-01T00:00:00.000Z"}
```

For a timed deadline, the server resolves the local input and zone, returns the canonical instant, and stores the zone when the original intent matters. If a client supplies both forms, verify they agree. A later display-zone change must not move an existing deadline. An edit that deliberately changes its instant is an explicit reschedule.

An all-day deadline remains a date. To judge when it expires, use the task's persisted zone or its documented owner/calendar zone, and expire it at the start of the next local date. Do not attach an arbitrary 09:00 or 23:59 time. A deliberately floating time, such as “09:00 wherever I am,” is a separate product feature that must be named and documented, not the default interpretation of a missing zone.

## Timezone ownership and selection

Use IANA names such as `Asia/Seoul`, `Asia/Shanghai` and `America/New_York`; `UTC` is valid. Do not use abbreviations such as `CST` or a fixed `UTC-5` offset for a region whose offset can change. Validate a supplied zone against the runtime's timezone support; malformed or unknown explicit values receive a validation error rather than a silent fallback.

For interpreting user input, resolve the zone in this order:

1. The explicitly selected zone for this operation or calendar.
2. The user's saved timezone preference.
3. The browser's detected zone, when there is no saved preference.
4. The app's documented, explicitly configured default.

The service process's local timezone is never an implicit user preference. If no meaningful default exists and interpretation depends on a zone, request one. A headless job uses its persisted task/calendar zone or an explicitly configured business zone.

For viewing an instant, a saved display preference wins, otherwise use the browser zone or a documented CLI display zone. Viewing must not modify stored timestamps. Locale and timezone are independent: choosing Chinese changes formatting, not the zone to Shanghai.

Apps must document the default and the environment variable or preference they actually implement. Space does not currently provide a shared user-timezone preference or inject a standard timezone variable into every app. Do not assume a hypothetical `SPACE_TIMEZONE` is available. Existing app-specific configuration, such as `TODO_TZ`, remains app-owned until an implemented shared contract replaces it.

Market and business calendars own their own zones. A US trading-session boundary uses `America/New_York` regardless of the user's display zone or server location. Include the calendar or market identity when a date alone would be ambiguous.

## Scheduling and calendar arithmetic

Every new calendar-based task must declare its zone explicitly, including UTC tasks. Use the existing manifest `timezone` field:

```yaml
tasks:
  - name: morning-refresh
    schedule: "0 9 * * 1-5"
    timezone: Asia/Seoul
    run:
      http:
        method: POST
        url: "http://127.0.0.1:${PORT}/jobs/refresh"
```

The scheduler API represents this as `{ "kind": "cron", "expr": "0 9 * * 1-5", "tz": "Asia/Seoul" }`. Backup cron declarations likewise use an explicit `backup.timezone`. A schedule's zone controls when Space triggers a job; it does not change the target process's `TZ`, the app's business calendar or an AI prompt's clock. Pass any required business date or zone through the app's own contract.

One-shot `at` values must carry an offset or `Z`. `every: 1d` means a fixed 86,400,000 ms interval. For “every local day at 09:00,” use a calendar schedule rather than adding 24 hours. For “tomorrow,” advance the calendar date in the chosen zone rather than adding a fixed duration to an instant.

Daylight-saving transitions can make a local time nonexistent or occur twice. For interactive timed input, reject nonexistent times and require an explicit occurrence/offset for ambiguous times. Recurring jobs must document and test their policy for skipped and repeated local times. If relying on the scheduler library's policy, verify that behavior for the installed version; this document does not assert that Space exposes configurable transition policies.

Retries, missed runs after restart and duplicate deliveries are separate from timezone conversion. Follow the [scheduler contract](scheduler.md) and make jobs idempotent for their intended business period. For a job meant to process a scheduled date, persist or pass that date so a delayed retry does not accidentally process a new “today.”

## Display and date input

Format instants with an explicit resolved display zone, for example:

```ts
new Intl.DateTimeFormat(locale, {
  timeZone: displayTimezone,
  dateStyle: "medium",
  timeStyle: "short",
}).format(new Date(createdAt));
```

Show the active zone near scheduling controls and wherever users compare times from different calendars. Tooltips or details can expose the original UTC instant and business zone. Use relative labels such as “5 minutes ago” from instant differences.

Treat an HTML `datetime-local` value as local input, not an instant. Submit it together with the resolved zone and let the server validate and resolve it. Do not append `Z` to that value. Do not fill the input with `toISOString().slice(0, 16)`: that shows UTC clock components as though they were local.

Render a pure date from its calendar components. Avoid routing it through browser-local formatting of `new Date("YYYY-MM-DD")`, which can display the previous date. Derive “today,” “tomorrow,” overdue status and list groupings using the same effective calendar zone. A bare date must not become a timed deadline merely because its edit form was opened and saved.

## AI and CLI inputs

All date-interpreting entry points must share the same timezone resolution and validation: web chat, natural-language parse, CLI, direct API and agent tools. Include the resolved zone and a current clock in AI prompts, for example `2026-10-01T00:30:00+09:00 (Asia/Seoul)`. Capture one reference instant per operation; use it consistently when constructing prompts and validating relative-date results.

Resolve “tomorrow” or “Friday” against the person's selected zone, not the host running the model. An SSH runtime must receive the same clock context as a local runtime. Validate model-produced dates like any other untrusted input and report the resolved date and zone when confirming a dated task.

CLI and agent requests must send the selected IANA zone when relative or local time is involved. A CLI may implement a `--timezone` option or documented configuration; merely running it from a machine in the right zone does not transmit that context. Absolute instant inputs and pure date values do not need to be guessed again by a model.

## Aggregation and clocks

Each “daily,” “weekly” or “monthly” report must declare its aggregation zone and week boundary. A user's local day is the interval from that date's start to the next local date's start, converted to instants; it is not necessarily 24 hours. Query intervals as `[start, end)` so adjacent periods neither overlap nor leave a gap.

UTC aggregation is valid when intentional. Label it as UTC; do not present a UTC bucket as the user's local “today.” A trading date is the exchange's session label, which can differ from both the UTC date and the viewer's date. `toISOString().slice(0, 10)` is appropriate only when a UTC date is intended.

Use wall-clock instants for persisted timestamps and cross-process deadlines. Prefer a monotonic clock such as `performance.now()` for measuring elapsed work within one process; it must never become a persisted event timestamp. Keep machine clocks synchronized: consistent timezone conversion does not correct clock skew between peers. Handle clock jumps and overdue timers according to the scheduler or retry policy.

## Current implementation and migration

The following describes source behavior reviewed on 2026-09-30, not the live configuration of every deployment:

| Component | Existing behavior | Follow-up when changing it |
| --- | --- | --- |
| Space stores and APIs | Core stores largely use epoch milliseconds; APIs commonly emit UTC ISO strings | Preserve these meanings and document exceptions |
| Space scheduler | Cron zone is optional and otherwise follows the process zone; `at` validation accepts zone-less strings through `Date.parse()` | Explicit zones in new manifests; tighten timestamp validation with compatibility handling |
| Space panel | Ordinary timestamps use browser-local formatting | Make the active zone visible and support an explicit preference when implemented |
| Model usage and backups | Usage day/week buckets and backup week/month retention boundaries are UTC | Preserve or deliberately migrate the grouping contract; label it clearly |
| ai-todo | Audit times use UTC ISO; `due` is a date or zone-less local time; the browser supplies a zone for AI context, while CLI parse/execute omit it and use the server's configured default | Distinguish all-day and timed deadlines; persist timed intent; align CLI and browser context |
| Financial apps | Feed, whymove and sector-rotation use business-specific Shanghai/New York/Seoul calendars as well as UTC series | Document each field and aggregation calendar; do not replace exchange dates with viewer dates |
| photo-play and asset-center | Audit timestamps use UTC ISO text | Keep valid existing data; use the new-schema convention for new tables |

Before migrating legacy local timestamps, identify the zone and semantics used when they were written. Never relabel them as UTC or infer their zone from today's server location. If provenance is missing, mark the ambiguity and obtain a migration decision before converting. Keep an auditable original value, back up affected data, version incompatible API changes and avoid changing existing deadlines during a display-only migration.

## Verification checklist

For time-related behavior changes, add focused tests that cover the relevant cases:

- The same offset-bearing input denotes the same instant under different process zones, such as `TZ=UTC` and `TZ=Asia/Seoul`.
- Instant endpoints reject zone-less values; invalid dates, unknown zones and wrong epoch units are rejected.
- Local midnight, month/year boundaries and leap days produce the correct date and grouping.
- A selected DST-observing zone exercises both nonexistent and repeated local times, with a documented expected policy.
- Pure dates survive display, editing and API round trips without gaining a time or shifting a day.
- Web, CLI and AI resolve relative dates identically with the same reference instant and zone.
- Changing the display zone leaves stored instants and scheduled deadlines unchanged.
- Reports use the documented period zone and `[start, end)` boundaries; retries keep their intended business date.

Inject a reference clock into deterministic tests rather than depending on the current date. Run the app's own checks from its source directory. No live clock or system timezone needs to be changed to test these cases.
