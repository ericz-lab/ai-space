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

- **Settings → App usage**: a window like Model usage. It has a time window (7d, 30d, 90d, all) and a kind filter. Cards show total opens, total time and the most used entry. Below them is a ranking with opens, time, time per session, last use and a 30-day sparkline (time when measured, else opens).
- **Library**: a "Most used" order, by the last 30 days' time and then opens. Entries that were never used keep their default order. The choice is kept per browser.
- **Hover details** of app, agent and built-in tiles: "Last 30 days: N opens · time · last use".

## For app authors

The script is recommended, not required (see [app-spec.md](app-spec.md#usage)). The `space-app` template's page includes it. ai-todo, ai-notes and ai-calendar load it.
