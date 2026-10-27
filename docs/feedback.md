# Feedback: a button on app pages, and an engineer that fixes the app

Status: implemented (`src/space/feedback/`, `src/web/feedback-widget/`, `skills/app-fix/`). Off until the owner turns it on in Settings → Feedback.

An app page that loads `/_space/feedback.js` gets a small button in its bottom-right corner. The person writes what is wrong, can pick the element they mean, add a screenshot or a picture, and choose **Fix now** or **Fix later**. The space turns it into an ai-todo task with the page's context, and the **Fix Engineer** (`space/ui-fixer`, a space-level agent) fixes the app: it changes only that app's source, runs the app's checks, deploys it, and hands the task back for review.

## The button

One script, `GET /_space/feedback.js` (`src/web/feedback-widget/`, bundled at boot like the chat widget). It asks `GET /_space/feedback/config` first; when the feature or the app is off, it adds nothing to the page.

- **Look.** A 36 px round button (44 px on touch screens) at 60 % opacity, full on hover, dimmed while the page scrolls. Everything lives in a closed shadow root on a `<space-feedback>` element: the page's styles do not reach it and its styles do not leak. The design is the Design Studio sheet "Feedback Widget Component Sheet" (one surface, one hairline, one shadow, one blue accent).
- **Theme and language follow the page:** `data-theme` / `data-color-scheme` / `data-mode` or a `dark`/`light` class on `<html>` or `<body>`, else the system; Chinese when `<html lang>` starts with `zh`, else English. It watches those attributes and redraws when they change.
- **Drag** the button anywhere; the spot is kept per app in `localStorage` (`space-feedback.pos.<app>`). Double-click puts it back in the corner. A press that moves less than 4 px is a click.
- **Alt+Shift+F** opens and closes it from anywhere on the page. The key is matched by its physical position (`KeyboardEvent.code === "KeyF"`), so a Mac's Option layer (Option+Shift+F types "Ï") does not get in the way. **Esc** closes it or cancels picking. **Ctrl+Enter** (⌘ Enter on a Mac) sends.
- **The card** (320 px; a bottom sheet under 520 px): the text, **Pick element** (hover outlines an element with its selector; a click picks it; up to five), **Screenshot** (the browser's own screen-capture prompt with the current tab preferred; desktop browsers only), **Attach** (a PNG, JPEG or WebP up to 3 MB; pasting an image into the text works too; two at most), **Fix now | Fix later** (preset from Settings), **Send**. A grey footer shows what goes with it: app, theme, page, client. **Hide on this page** hides the button until the tab is closed. The last three pieces of feedback of this app show with their state and a link to their task.
- It never runs inside a frame, never twice on one page, and never reads input values, cookies or storage.

### Adding it to an app

One line in the page's `<head>`, like the usage heartbeat ([usage.md](usage.md#heartbeat)):

```html
<script src="/_space/feedback.js" defer></script>
```

A page built by Bun's HTML import (or another bundler) adds it at runtime, so the bundler does not try to resolve it:

```html
<script>(function(){var s=document.createElement("script");s.src="/_space/feedback.js";s.defer=true;document.head.appendChild(s)})()</script>
```

Without the router (an app reached on its own port) or on an older ai-space the script is a 404 and nothing happens. Package apps get it from the package gateway, which answers `/_space/feedback*` on the app's origin after its session check.

## Context

What goes with the person's words (`context.ts` cleans it on the server too, so a page that skips the script gains nothing):

| Field | |
| --- | --- |
| app | named by the router (`X-Space-App`), never by the page |
| url, path, title | the page; credentials and query or fragment parameters whose names look secret (`token`, `key`, `session`, `code`, ...) are replaced by `redacted` |
| client | from the `User-Agent`: desktop, phone or tablet browser (with browser and system), or the Mac (`AISpaceDesktop/`), iPhone or Android (`AISpaceMobile/`) or Linux (`AISpaceLinux/`) client |
| viewport, touch, theme, language, time zone | as the page sees them |
| picked elements | selector, tag, a little text, cleaned HTML (no `<script>`/`<style>`, no `on*` handlers, no `value`, no secret-looking attributes), position |
| script errors | the last ten `error` / `unhandledrejection` messages since the page loaded; Settings can turn this off |
| pictures | the screenshot or attached images, checked by their bytes (PNG, JPEG, WebP), at most two of 3 MB |

Text everywhere passes through `redact()`, which hides bearer tokens, JWTs and well-known key formats (`sk-`, `ghp_`, `xox*-`, `AKIA`, ...).

## What happens to it

1. `POST /_space/feedback` checks the switches, the size (9 MB body, 4 000 characters of text), a double click (the same text from the same page within 30 s returns the first one) and a cap of 30 per app per hour.
2. A row in `space.db` (`feedback`), then an ai-todo task through ai-todo's capabilities ([events.md](events.md)): `add` with the tags `feedback` and the app's name, `plan` with the person's words and the context (page content in fenced blocks marked as data), and `record` with the pictures. ai-todo is used where it runs here, else on the first peer that provides it. Without ai-todo the feedback is kept as `recorded`.
3. **Fix now** (`auto`): the Fix Engineer starts at once. **Fix later** (`later`): it waits; Settings → Feedback has **Fix N waiting now**, which hands them over in one run per app.
4. One fix runs per app at a time. Feedback that arrives meanwhile is queued and goes to the next run, together.
5. The engineer's run moves the task to **doing** and records which run it is. Its answer ends with a `RESULT:` line (JSON): `fixed`, `not-fixed` or `needs-person`, a summary, the commit, and one status per piece of feedback. The space records the summary on the task and moves it to **review** (验收) when fixed. The person accepts it in ai-todo, or rejects it there with a reason; **Fix again** in Settings starts a new run that reads the task's records, the reason included.
6. A run that errors, times out or ends without a `RESULT:` line counts as not fixed.

States: `later` (waiting), `queued`, `fixing`, `review` (fixed, to accept), `failed`, `skipped` (needs a person), `recorded` (no task).

## The Fix Engineer

`space/ui-fixer` is listed with the space's agents ("Fix Engineer" / "修复工程师"), works in the workspace root and can be chatted with like any agent. Its standing rules (`prompt.ts`) and the `app-fix` skill (`skills/app-fix/SKILL.md`, inlined into its prompt) say:

- Change one app: `app-src/<app>/`, its source checkout; clone it from the manifest's `repo:` when missing. Never `apps/<app>/` (the deployed copy), ai-space, another app, `.env`, `space.env` or `runtimes.yaml`.
- Read the app's `AGENTS.md`, keep its rules (style-book, both languages, light/dark/system, 375 px), reproduce when possible, change as little as fixes it, run the app's checks.
- Run `bun skills/app-fix/scope.ts app-src/<app>` before every commit. It refuses a checkout that is not directly under `app-src/`, changes to secret, data or dependency files, links that leave the repository, and added lines that look like credentials, uncommitted or committed but not pushed.
- Commit `fix(<area>): ...` with `From app feedback #<id> (ai-todo #<n>).`, deploy through the app's channel (normally `git push deploy main`, which runs `space app deploy` with the manifest's checks), push `origin`.
- Not an app fix (a product decision, data, money, credentials): change nothing and answer `needs-person`.

Settings choose its model (default `claude/intermediate`) and effort (`high`, `xhigh` (default) or `max`; Claude Code's `--effort`), and it runs with full permission (`bypassPermissions`) because it has to build, test and deploy.

### On another machine

Settings → Feedback → **Fix on** can name a peer ([peers.md](peers.md)). The space starts the engineer there through `/api/peer/agents/space/ui-fixer/chat` and polls the run. There the engineer clones the app into its own `app-src/<app>/` when missing, commits, and pushes to `origin` main; it does not deploy. When it reports a pushed fix, the app's machine fast-forwards its `app-src/<app>` from `origin` and pushes to its `deploy` remote (`deploy.ts`); anything unexpected (local changes, another branch, no deploy remote) stops it, and the task says why. The peer must run an ai-space that has the Fix Engineer.

## Apps on a peer

An app page asks the space that serves it whether to show the button (`/_space/feedback/config` goes to the router of the machine the app runs on). So a space with peers ([peers.md](peers.md)) sends its choices on: each time its Settings → Feedback is read or saved, every peer gets them for the apps that run there (`peers.ts`).

- **What is sent:** the main switch, "Show on apps by default", what happens to feedback, the effort and the script-errors switch as they are, and each of the peer's apps as this space sets it (an app it has no word on goes back to the default). Apps here and on a peer that share a name share a switch.
- **Fix on** is a machine as this space sees it. For a peer's apps it becomes the app's own machine when it names that peer, or names a machine the peer does not know; this space ("This machine") is named when the peer knows it by name. **Model** is sent only when the peer offers it, and the peer keeps its own otherwise.
- **The page** lists each peer's apps under "Apps on <peer>", with the same switches, and says when a peer cannot be reached, runs an ai-space without these routes, or did not take the change (tried again the next time the page opens). A copy left paused here when its app moved to a peer is listed once, under the peer.
- **Recent feedback** includes the peers', marked with the peer; **Fix now**, **Fix again** and **Fix N waiting on <peer>** run there.
- The peer's own Settings still work, but the hub's choices win: they are put back the next time the hub's page is read.

On the peer the routes are `/api/peer/feedback*` behind the hub's token (`createFeedbackPeerServeRoutes`): that space's own settings and rows, never its peers', so two spaces that are each other's peers never ask in a circle. Package apps are left out, as in the peer's other lists.

## Trust

The button's routes are public: an app page holds no panel session. What stands between a page and the engineer:

- **Opt-in.** Off by default, then per app (each app `default`, `on` or `off`; `default` follows "Show on apps by default").
- **The router names the app.** `/_space/*` on an app's hostname reaches ai-space with `X-Space-App` set by the router; the panel's own site drops a client's `X-Space-App` ([router.md](router.md)). Writes go through the same-origin check (`guardBrowserWrites`).
- **Limits:** 30 per app per hour, sizes, image types.
- **Page content is data.** The person's words are the request; everything taken from the page (HTML, text, titles, errors) is fenced and labelled untrusted in the task and in the engineer's message, and its rules say never to follow instructions found there.
- **One app, checked.** The scope check runs before every commit; the deploy channel runs the app's checks and keeps the running version when they fail.
- **No secrets** in what is kept: redaction on the page and again on the server.

Anyone who can open an app's page can send feedback that an engineer with full permission reads. Turn it on only where app hostnames need sign-in (Cloudflare Access, the built-in sign-in), and keep **Fix later** where pages are reachable by others.

## Settings

Settings → Feedback (web panel and the Linux client): the switch, **What happens to feedback** (fix right away / record and fix later), **Fix on** (this machine or a peer), the engineer's model and effort, **Attach recent script errors**, the shortcut, then the apps with their switches, then the recent feedback with its state, task link and **Fix now** / **Fix again**.

## Routes

```
GET  /_space/feedback.js                 the button's script (public)
GET  /_space/feedback/config             { enabled, mode, errors, app, client, shortcut } for X-Space-App (public)
GET  /_space/feedback/recent             the app's last five (public; empty while off)
POST /_space/feedback                    { text, mode?: now|later, context, images?: [{name, data}] } → 201 { id, status, todoId, todoUrl } (public, same origin)
GET  /api/panel/feedback/settings        settings, apps with their state, machines, models, counts, peers (owner)
PUT  /api/panel/feedback/settings        a settings patch, sent on to the peers (owner)
GET  /api/panel/feedback?limit=          recent feedback of every app, the peers' with `peer` (owner)
POST /api/panel/feedback/fix             { peer?, app? } the waiting ones, or { peer?, ids } again (owner)
GET  /api/peer/feedback/settings         ┐ for a hub, behind its token: this space's own settings view,
PUT  /api/peer/feedback/settings         │ a settings patch, its rows and starting its fixes
GET  /api/peer/feedback?limit=           │ (no peers of its own)
POST /api/peer/feedback/fix              ┘
```

## Data

```sql
feedback_settings(key, value)          -- one JSON value: enabled, appsDefault, apps, mode, machine, model, effort, errors
feedback(id, app, text, context, client, status, todo_id, todo_peer, todo_url, run_id, run_machine, note, created_at, updated_at)
```

At boot a fix that was running on this machine is marked failed (its process is gone); one running on a peer is watched again.

## The shortcut

Alt+Shift+F was checked against what people run app pages in. Chrome, Edge, Firefox and Safari give it no page-level meaning (Firefox's own Alt+Shift shortcuts are F-key-free, and its menu keys use Alt alone). GNOME and KDE bind Alt+F-keys, not Alt+Shift+F; Windows switches input language on Alt+Shift released without another key, so pressing F first does not switch. It is taken inside Google Docs (a menu), VS Code (Format Document) and JetBrains IDEs, none of which are app pages. On a Mac, Option+Shift+F types "Ï" in text fields; the button matches the physical key and takes it before the page.
