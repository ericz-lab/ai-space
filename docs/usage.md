# Usage: how often apps and agents are used, and for how long

Status: implemented (`src/space/usage/`). The space counts how often the person opens each app, agent and panel window, and how long they use them. This is about people using things. Model tokens are recorded separately, in the model ledger ([model.md](model.md)).

## What is counted

| Entry | One open | Time in use |
| --- | --- | --- |
| app | a tile on a screen or a library card was clicked | the time its page was visible and had input within the last 2 minutes, from the [heartbeat script](#heartbeat) |
| agent | one chat turn (`RunRegistry.start`); opening the chat window alone does not count | one segment per conversation: turns less than 10 minutes apart join, and the segment runs from the first turn's start to the last turn's end |
| built-in (settings, inbox, terminal) | its tile or library card was clicked | not measured |

- Only "opened" and "in use" are recorded. Nothing says who, from which address, what was on the page or what happened inside the app.
- On a hub, opening a peer's app or built-in is recorded on the hub under the panel's id, `<peer>/<app>`. A chat with a peer's agent runs on the peer and is counted there. The machines' figures are never merged.
- An app without the heartbeat script has opens only; its time shows as a dash (`activeMs: null`). An app that has ever sent a heartbeat shows 0 in a quiet window.
- An app opened by its URL, not from the panel, has time but no open.

## Data

Two tables in `space.db` (`store.ts`). Instants are epoch milliseconds ([time.md](time.md)). Per-day figures are by UTC day, like the model ledger's.

```sql
usage_opens(id, kind, key, source, at)
  -- kind: app | agent | builtin; source: panel | library | chat
usage_sessions(id, kind, key, tab, started_at, last_at, active_ms)
  -- app: one segment per browser tab's heartbeats; agent: one per conversation (tab = session id)
```

`SPACE_USAGE_RETENTION_DAYS` limits how long rows are kept. Older rows are pruned on insert. The default, 0, keeps everything.

## Heartbeat

An app page loads the script with one line:

```html
<script src="/_space/usage.js" defer></script>
```

A page built by Bun's HTML import (or another bundler) adds the script at runtime instead, because the bundler would try to resolve `/_space/usage.js` at build time and fail (ai-todo and ai-notes do this):

```html
<script>(function(){var s=document.createElement("script");s.src="/_space/usage.js";s.defer=true;document.head.appendChild(s)})()</script>
```

The script (`script.ts`, plain ES5, under 2 KB) works like this:

- It keeps a random tab id in `sessionStorage`.
- While the page is visible and had a `pointerdown`, `keydown`, `wheel`, `touchstart` or `scroll` in the last 120 s, it sends a POST to `/_space/usage/beat {tab}` every 30 s. The first beat goes out at once.
- On `visibilitychange` to hidden, and on `pagehide`, it sends one last beat through `sendBeacon`.
- It ignores every failure, so the app never notices it.

On the server, a beat less than 90 s after its segment's last one extends the segment by that gap, up to 60 s per beat. A later beat starts a new segment. A tab's beats less than 20 s apart are dropped.

**Routing.** The router ([router.md](router.md)) sends every app hostname's `/_space/*` to ai-space and sets `X-Space-App: <app>`. The script therefore calls its own origin: it needs no CORS and the page holds no token. The app name comes from the router, never from the page, and a beat for an app this space has not registered is refused. ai-space reads `X-Space-App` only on `/_space/*`, and the panel's own site drops any `X-Space-App` a client sends. The beat is a browser write, so it goes through the same-origin check (`guardBrowserWrites`): the router passes the `Host` through, and that matches the page's `Origin`.

**Without the router** (`SPACE_ROUTER=none`, or an app reached on its port), the app's origin has no `/_space/*`. The script's requests fail silently and the app has opens only.

## Routes

```
POST /api/panel/usage/open     {kind, key, source}      the panel's pages (same origin); 204
GET  /_space/usage.js                                    the heartbeat script
POST /_space/usage/beat        {tab}                     only through the router; the app is X-Space-App; 204
GET  /api/usage?window=7d|30d|90d|all&kind=app|agent|builtin
     → { usage: [{kind, key, opens, activeMs, sessions, lastAt, daily: [{day, opens, activeMs}]}] }
```

The panel sends opens with `navigator.sendBeacon`, so an open is never held up and a link to a new tab still records one. `GET /api/usage` (default window `30d`) needs no token, like `/api/model/usage`. Rows are ordered by time in use, then by opens.

`space usage [--window 30d] [--kind app]` prints the same rows as a table.

## Panel

- **Settings → App usage**: a window like Model usage. It has a time window (7d, 30d, 90d, all) and a kind filter. Cards show total opens, total time and the most used entry. Below them is a ranking with opens, time, time per session, last use and a sparkline for the selected window (time when measured, else opens). The selected date range and its first recorded activity are shown in UTC. If all records fall within seven days, 7d, 30d, 90d and all legitimately have identical totals. Rolling windows include partial UTC days at both ends; all starts on the earliest returned activity day. All rows share that date axis, and long histories are grouped into at most 90 bars. Filter changes clear the previous results while loading, and responses from an earlier selection cannot overwrite the current one.
- **Library**: a "Most used" order, by the last 30 days' time and then opens. Entries that were never used keep their default order. The choice is kept per browser.
- **Hover details** of app, agent and built-in tiles: "Last 30 days: N opens · time · last use".

## For app authors

The script is recommended, not required (see [app-spec.md](app-spec.md#usage)). The `space-app` template's page includes it. ai-todo, ai-notes and ai-calendar load it.

## Device usage

The **Devices** section of web App usage and **Device usage** section of the native iOS/macOS App usage pages report foreground use of the Space client,
separately from application opens and agent execution time. It uses the same
7/30/90-day and all-time controls. Application-kind filters do not affect it.

- `client` is `web`, `ios`, `macos`, or `android`.
- `deviceId` is a random UUID persisted in browser local storage or native
  preferences, scoped to the Space origin. Two iOS installations have separate
  IDs and separate rows. This is a client installation/profile identity, not a
  hardware identifier. Clearing storage or reinstalling may change it; restoring
  copied native preferences can copy it. No serial number, model, hostname, IP or
  raw User-Agent is stored. The UI abbreviates the ID and exposes the full value
  in its title; the API returns it in full.
- `session` is a new random UUID for each foreground visit. Web visibility,
  pagehide/pageshow (including BFCache), iOS scene phase, macOS application
  activation and Android resume/pause start and stop reporting. Native clients
  target the selected Space, including embedded app pages. Changing the selected
  Space closes the old visit. Background catalogue refreshes do not report use.
- Web measures the panel page while visible, including idle visible time. It
  does not link identities across app hostnames or count a separate app tab when
  the panel is hidden. Embedded panels with an `AISpaceMobile/` or
  `AISpaceDesktop/` User-Agent marker defer to their native host to avoid duplicate
  web devices. Existing app heartbeat and app-open metrics remain independent.

`POST /api/panel/usage/device` accepts
`{ deviceId, client, session, active: boolean }`, returning 204. IDs must be
8–64 ASCII letters, digits, underscores or hyphens. It has the same browser
same-origin write guard as app opens; native clients use their existing Space
cookie session. This is best-effort operational telemetry, not authenticated
hardware attestation.

Clients send immediately and about every 30 seconds while foregrounded, then a
final `active: false` on exit. The server records receipt instants in milliseconds.
Beats no more than 45 seconds apart extend an interval; longer gaps start a new
interval with zero duration, so an offline/suspended period is not filled in.
Closed session IDs reject late packets. There is no offline replay queue. A lost
last beat can undercount the last interval. Native networking delays also reduce
sampling precision. A visit that only sends its first beat has zero duration.

`GET /api/usage/devices?window=7d|30d|90d|all` returns
`{ ok, window, devices: [{ deviceId, client, sessions, activeMs, lastAt }] }`.
`lastAt` is a UTC ISO instant. `sessions` counts distinct foreground visit IDs
with an observation overlapping the window; `activeMs` is the union of observed
intervals for that device/client, clipped to `[windowStart, now)`. Thus concurrent
windows do not multiply time. The same ID with a different client type remains
separate. Reports belong to the receiving Space and do not combine peers.

`usage_device_segments` is added idempotently in `space.db`; the existing opens,
sessions and `/api/usage` response are unchanged. Historical and older-client
usage has no device attribution and is not guessed or converted. The existing
usage retention setting applies to device segments too. Updated native binaries
must be installed before they can report; updating the server alone is insufficient.

### Applications used by each device

Expand a device in the web or iOS/macOS native report to see its `apps` array:
`[{ key, opens, activeMs, lastAt }]`. `key` is the catalogue application reference,
including a peer prefix when present. Labels come from the current catalogue;
removed applications keep their reference. `activeMs: null` means unmeasured,
which is different from a measured zero. Device-only historical intervals are
not retroactively assigned to an application. Older servers without `apps`
show an explicit unavailable message in updated native clients.

Native clients include `app: string | null` and an increasing `sequence` in each
foreground heartbeat. The active app is sampled on navigation and at the regular
heartbeat. Returning to the launcher or a native Space page sets `app: null`;
backgrounding closes the visit. A change of app ends the previous app interval
at receipt time and starts the next one, without starting another device visit.
Older in-flight sequence numbers cannot overwrite the latest context. Per-app
intervals are clipped and unioned independently, as the device total is.

`POST /api/panel/usage/device/open` accepts
`{ deviceId, client, eventId, key }`. The same event ID for the same device/client
counts once. Native clients send an open when an application enters the
foreground context, including returning to it after the client was backgrounded.
A heartbeat of the same app is not another open. Browser panel app clicks use
the same local-storage identity as the panel's device beats. These device opens
are a separate metric from the legacy application report.

Browser app time is intentionally **unmeasured** in this breakdown: the shared
app heartbeat script does not yet carry a panel-scoped device identity across
origins. Panel time must not be assigned to the last app link clicked. No
individual application needs changing for native measurement. Connecting browser
app time requires a separate cross-origin identity handoff before upgrading the
shared script (and adding the script to applications which do not load it).

Storage adds `app` and `sequence` columns to device segments and a deduplicated
`usage_device_opens` table. These migrate idempotently; existing intervals retain
null app attribution. The usage retention policy covers both tables. Native
reports read when opened, when filters change and on pull/toolbar refresh; they
can show a zero-duration visit until a later heartbeat has arrived and is read.
