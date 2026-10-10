# Panel design

For the visual and interaction rules, both implemented and proposed, see the [ai-space Design Guidelines](design-guidelines.md).

The panel is the web entry of an ai-space: a launcher that lists the apps, opens a chat with any agent, shows the widgets apps feed it, and lets the operator add, hide and arrange things. It is served by ai-space itself, on the same loopback port as the Space API, and reads everything it shows from the apps' manifests.

Status: implemented. Service supervision (starting and restarting `service.command`) and skill mounting for agent sessions are not part of this stage; the [app spec](app-spec.md) status table says what is missing.

## Why inside ai-space

The panel started life as a separate process that read a registry of markdown files: one file per app with a name, an icon, a repository, a one-line summary and, for some, a widget endpoint. It worked, and it taught three lessons that shaped this design:

- **The registry drifts from the apps.** A file that lives next to the panel, not next to the app, is edited when someone remembers. Widget endpoints were "hand-written into the registry and lost when the entry was recreated". The app spec already says the manifest is the registration; the panel only had to read it.
- **Private overlays are a workaround for a missing workspace.** Public entries in one directory, private ones in another, tombstones to hide a public entry: all of it existed because the registry was a shared repository. In ai-space the workspace is the operator's own; there is one list.
- **Chat, widgets and layout are Space services.** Spawning a runtime, caching widget payloads, remembering an order: none of it belongs to an app, and a second process next to ai-space would have to duplicate app discovery and the workspace layout.

So the panel is a set of routes in ai-space's `Bun.serve`, a React page bundled from `src/web/` by Bun's HTML import, and two small tables in ai-space's database.

## What the panel shows

The tables below list what the panel knows about. It does not lay all of it out at once: the page is a row of [screens](#screens), and each screen shows only what is pinned to it; the library left of home lists everything.

| Section | Source | Notes |
| --- | --- | --- |
| Apps | every registered manifest that has a `url`, with `status` other than `archived`, minus the hidden set; peer apps follow, minus those whose `url` is already listed ([peers.md](peers.md)) | Tile: `icon` and `title`, nothing else on the icon. Click opens `url`. Hover shows the description, the status (health when the app declares `service.health`) and the repository. |
| Agents | `agents:` of every visible app, plus the space agent | The section is left out when the list is empty (the agents could not be loaded). Tile shows the avatar and title, with the owning app's icon in the corner when it differs from the avatar; click opens the chat in a floating panel over the page, on that agent. |
| Widgets | `widgets:` of every visible app | `items` cards render the list in the house style; `embed` cards load the app's page in a sandboxed iframe through ai-space. |
| Settings | built in | A built-in tile like Inbox and Terminal: pinned, moved and unpinned like any other, never uninstalled, and always in the library. It opens a floating panel near the top of the page with the browser preferences (hover details, desk pet, widgets, appearance ([Appearance](#appearance)), language), the scheduled tasks, and a status line that folds the peers, services and backups into counts and a problem tally (a service or peer down, a stale backup); a click expands it to their rows. |

| Services (in Settings) | every registered manifest with a `service` | One row per service: icon, title, loopback port, health. |
| Language (in Settings) | the browser's preferences | English or Chinese for everything the panel owns; the browser's language is the default. Apps' titles and descriptions follow when their manifest has an `i18n:` section. Design in [i18n.md](i18n.md). |
| Desk pet (in Settings) | the browser's preferences | A sprite walking along the bottom edge. Off by a switch; any pet from [petdex.dev](https://petdex.dev) by name: the name is looked up in petdex's public manifest, the sheet URL is kept in `localStorage` with the other preferences, and the bundled capybara stands in when the sheet no longer loads. Pets are user-submitted fan art; the browser talks to petdex directly and sends no Referer, which its hotlink protection rejects. |
| Terminal (a built-in tile next to Settings; a floating panel) | this machine, and every peer whose snapshot says `terminal: true` | A machine picker, one tab per session, xterm.js over a WebSocket to a pseudo-terminal running the operator's shell in the workspace root. Off unless the machine sets `SPACE_TERMINAL_ENABLED=1`; every session is opened with a same-origin check and a one-time ticket, optionally a passphrase; sessions close when idle. Design and trust boundary in [terminal.md](terminal.md). |
| Tasks (a floating panel opened from Settings) | every task the scheduler knows, grouped by app | One row per task: status dot, name, effective schedule and event triggers (`on <app>/<event>`, filter and debounce on hover), last outcome and duration, next run, queued events, target kind; `api` and `override` badges; disabled and orphaned tasks muted. A row expands to the last twenty runs with error text and captured output; a run started by hand or carrying events says so. Read-only: it uses the scheduler's `GET /api/tasks` and `GET /api/tasks/:id/runs`, which carry no token; running or toggling a task still goes through the token-guarded routes from the machine. |

Two independent axes decide where an app appears. A `url` means a person can open it: that is a tile. A `service` means a process runs: that is a row under Services. An app with both (a web app) has both; a data or background service with no page has a row and no tile, and stays registered, scheduled and probed, its agents and widgets (if any) in their own sections; a link app has a tile and no row; an app with neither (a repository that only runs tasks) appears in neither, and is still listed by `GET /api/apps?all=1`.

The **space agent** (`space/assistant`, shown as "Space Assistant") is the default chat identity: a session in the workspace root with a short built-in prompt. Its model menu groups the configured chat runtimes (including Claude Code and Codex) into basic, junior, intermediate and advanced tiers, using the mappings in `runtimes.yaml`. The selection is remembered in the browser and captured for each message when it is queued, so later control changes cannot reroute an already queued turn. Switching runtimes starts a new conversation; history restores the original runtime and model. App agents have the same menu ([Agent models](#agent-models)). Space Assistant uses full native context, tools and skills; the permission menu independently controls execution access. It is the one exception to "nothing exists outside an app", on the same footing as the Space services themselves.

## Screens

The panel opens on the **home screen**, which holds only what the operator pinned there. Everything else is one screen to the left, in the **library**; the operator's own screens follow home on the right:

```
library  ←  home (default)  →  screen 2  →  …  →  ＋
```

- **Entries.** A screen is `{ id, name, items }`, and `items` are entry keys in order: `app:<id>`, `agent:<id>`, `widget:<id>` (the layout ids, peer prefix included) and `builtin:inbox|terminal|settings`. A screen draws its tiles (apps, agents, built-ins) in one grid and its widget cards below. A key whose entry is gone (an uninstalled app, a peer that left) is skipped and kept, so it comes back with the entry.
- **The library** lists every app, agent, widget and built-in tile, pinned or not, with one search across the three kinds (every word of the query in the title, description or id) and a filter by kind with counts. By default it is a launcher: clicking a card opens the entry (an app or widget link in a new tab, an agent's chat or a built-in window in the page), and Enter in the search opens the only match left. The order menu puts the most used entries first (the last 30 days' time in use, then opens; [usage.md](usage.md)). The "Add to a screen" button switches it to **add mode** ("Done" switches back; leaving the library does too): each card then has an Add button that pins it to the target screen (home unless chosen otherwise when there are several) and turns into "Added" when the entry is already there, so nothing is pinned twice; clicking "Added" (it reads "Remove" under the pointer) takes the entry off the target screen again. The library stays open after an Add, with a short notice and a link to the screen, so several entries can be added in a row; Enter in the search adds the only match left. Widgets are not cards in the list but live previews, the same widget cards a screen draws, after the other entries; in add mode the size menu and the Add button sit in the preview's header, and the preview takes the chosen size, which is the size it is added at (stored like a resize, below). The empty state of a screen opens the library in add mode, pointed at that screen. "Add an app from a link" is here too.
- **Getting around.** Each side edge shows a faint handle; under the pointer it becomes a large round button, without a text label: the left one goes to the previous screen (from home, the library), the right one to the next screen, or a ＋ that creates an empty screen on the last one, at once. A dock at the bottom has the library, home, one monitor icon per screen and a search button; with a mouse it stays hidden until the pointer nears the bottom of the window (or the keyboard focus enters it). In dark mode the dock and the edge buttons are near black (`rgba(18, 20, 27, 0.9)` over the blur). Screens carry no names on the page: no screen shows a title, and the library's target menu and screen readers call them Home, Screen 2, Screen 3… by position (the `name` field of the layout stays, unused). ⌘K / Ctrl+K opens the library with the search focused from any screen; ← and → move between screens and Escape leaves the library when no field or window has the focus. On a touch screen the edges are hidden: the dock and a horizontal swipe do the same. A one-time hint over the dock explains the edges and the shortcut (dismissed per browser).
- **First load.** A panel whose layout has no screens yet (`screens: null`) seeds home from what it showed before: the first eight apps, the three built-in tiles, the first four agents and the first four widgets, in the previous order, and stores it at once. From then on new apps, agents and widgets go to the library only and never crowd the home screen.
- **Edit mode** on a screen: ✕ unpins an entry from that screen only (the app, its agents and widgets stay, and so does the library entry), dragging reorders tiles or widgets within the screen, the "Add" tile adds an app from a link and pins it there, and screens other than home can be deleted (after a second click), their entries staying in the library.

Screens are stored in the layout (`PUT /api/panel/layout { screens }`, the whole list), so they follow the workspace across browsers and survive a reload. The panel always opens on home.

## Manifest-only apps

The launcher must be able to show things that are not ai-space services: a page, a tool on another machine, a repository. Rather than a second kind of entry, these are ordinary apps whose directory holds only a manifest:

```
<workspace>/apps/docs/
└── space.yaml       spec, name, title, description, icon, url
```

ai-space treats them like any app (they can even declare widgets with a full `source` URL, or agents). The panel creates them when the operator adds a link, and uninstalling one just removes the directory. A manifest-only directory is not a git repository; it is restored from a workspace backup, not from a clone.

## Adding an app from a link

Edit mode has an "Add" tile that takes one link. The panel asks the claude runtime to read the page (`claude -p … --allowedTools WebFetch`) and answer with a JSON object of identity fields, validates the answer, writes `apps/<name>/space.yaml`, and syncs the new directory (storage, scheduler, registry) like a boot would. The link itself becomes `url` when the answer names none. Fields can also be posted directly, which is what a script or a skill does.

## Arranging, hiding and uninstalling apps

Everything the operator does to the launcher happens in **edit mode**: long-press (or press and hold the mouse) on the panel background until the tiles start to jiggle; a click on the background leaves it. Edit mode offers four things, none of which need the API token because they come from the browser:

- **Move.** Drag a tile or a widget to a new place on its screen; the screen's order is saved when it is dropped (`PUT /api/panel/layout { screens }`). A peer's entries are keyed on the hub by their prefixed id (`<peer>/<app>`), so moving them never touches the peer. The `order` lists still decide the library's order and the seed of a first home screen.
- **Unpin.** The ✕ on a tile or a card takes it off the current screen ([Screens](#screens)); nothing else changes. Hiding an app on the panel (`PATCH /api/apps/:app { hidden: true }`: its tile, agents and widgets disappear everywhere, the library included, while the app keeps running) remains an API: `?all=1` on `GET /api/apps` lists hidden apps, and `hidden: false` brings one back. For a peer's app the hub hides it only on itself (`PATCH /api/peers/:peer/apps/:app`).
- **Resize a widget.** In edit mode every widget card has a grip in its bottom-right corner; dragging it snaps the card to 1 or 2 columns and 1 or 2 rows (the head shows the size while dragging). The size is stored on release in the layout (`PUT /api/panel/layout { sizes: { "<app>/<widget>": "1x2" } }`) and overrides the manifest's `size` on this panel; `null` returns the widget to the manifest's size. The app's repository is not touched.
- **Removed widgets.** Before screens, the ✕ on a widget card removed it from the whole panel (`PUT /api/panel/layout { hiddenWidgets: { "<app>/<widget>": true } }`); the ✕ now unpins instead. Widgets removed that way stay out of `/api/widgets` and the library; `/api/widgets` returns their ids as `hidden`, and the settings offer to show them again (`false` per id).
- **Add.** The "Add" tile takes a link; see the previous section.
- **Uninstall.** Below the app grid, edit mode shows an uninstall zone. Dropping a tile there opens a confirmation that says what will happen, then sends `DELETE /api/apps/:app` (for a peer's app `DELETE /api/peers/:peer/apps/:app`, which the hub forwards to the peer and then refreshes its snapshot). In order:
  1. A task of the app with a run in flight refuses the uninstall with 409 and names the tasks: stopping the service and moving the directory would pull the ground from under that run. `DELETE /api/apps/:app?force=1` (`space app uninstall APP --force`) goes ahead anyway.
  2. The service is stopped. Under `SPACE_SUPERVISOR=space` the space disables and deletes its own unit and the unit's environment file ([supervision.md](supervision.md#uninstall)); under `operator`, with the operator's stop command (`SPACE_SERVICE_STOP` in the workspace `.env`, `{app}` replaced by the name, e.g. `sudo systemctl disable --now {app}`). A stop that fails aborts the whole uninstall with 502 and the app stays as it was. With no stop command configured the service is left running and the response says `stopped: "unconfigured"`.
  3. The directory leaves the workspace without losing code: a symlink is unlinked and its target left alone, a checkout under `apps/` is moved to `<workspace>/trash/<name>-<stamp>`, a manifest-only directory is deleted, a directory registered through `SPACE_APPS` is left where it is (`dir.kind` in the response: `unlinked`, `moved`, `deleted`, `kept`).
  4. The app is forgotten: its manifest tasks become orphaned (run history kept), its agents and widgets leave the panel, its service leaves the list. The data directory `<workspace>/data/<name>/` is kept; the response names it.

  Uninstalling does not touch the app's repository, an operator's systemd unit file, its tunnel hostname or its data. Those are the operator's, and the [app spec](app-spec.md#lifecycle) lists them under retiring an app. Removing the directory by hand and calling `POST /api/apps/sync` has the same effect on the space, minus the stop command; the sync reports such apps under `gone`.

## Layout and state

Two tables in `space.db`, both panel-owned:

- `panel_kv` holds the layout: `{ order: { apps, agents, widgets }, hidden, sizes, hiddenWidgets, screens }`. `screens` is `null` until the panel stores its first set, then a list of at most twenty `{ id, name, items }`, home (`id: "home"`) first, added in front when a write leaves it out; ids are letters, digits, `-` and `_`, names at most 60 characters, items de-duplicated per screen; a malformed list is refused with 400. Order lists are ids: app names, `app/name` for agents and widgets, and `<peer>/…` for entries from a peer machine; ids missing from a list follow it, local before peer, alphabetically. `hidden` is the set of apps the panel does not show; they stay registered and scheduled. `sizes` maps widget ids to the size the operator chose on the panel, applied over the manifest's `size` when widgets are listed. `hiddenWidgets` is the set of widget ids removed from the panel; `/api/widgets` leaves them out.
- `chat_sessions` keeps the last ten sessions per agent (`agent`, `sid`, `title`, `ts`, `runtime`, `model`). A resumed session gets a new id from the runtime; the previous row is replaced so a conversation stays one entry.
- `agent_runs` keeps the last 200 chat turns (`id`, `agent`, `session_id`, `sid`, `message`, `runtime`, `model`, `status`, `error`, `started_at`, `finished_at`, `last_seq`, and `events` once the turn ends), so a page loaded later can show and follow them ([Background runs](#background-runs)).

Nothing panel-related is written into an app directory. The one panel state kept as files in the workspace is the icon packs (below), because they are images.

## Icon packs

The icons a tile shows come from the app's manifest (`icon`, an agent's `avatar`), so changing them used to mean a commit and a deploy in every app repository, and a link app has no repository at all. An icon pack is the panel's own set of icons over those, chosen per panel and never written into an app.

- **Where.** `<workspace>/icons/<pack>/app/<id>.<ext>` for app tiles and `<workspace>/icons/<pack>/agent/<id>.<ext>` for agents, SVG, PNG or WebP, at most 512 KB each. The id is the tile's layout id with `/` written as `~`: `notes`, `david~media` (an app on peer `david`), `notes~librarian`, `david~media~helper`, `space~assistant` for the space agent, `space` for its corner, and `space~inbox`, `space~terminal`, `space~settings` for the panel's built-in tiles (`/api/apps` returns their icons as `builtins`). A pack holds any subset of the tiles; a tile without a file in it keeps the manifest's icon.
- **Which.** At most one pack is active, recorded in `panel_kv` under `icons.active`. None active is the default: every tile shows its manifest icon.
- **How it applies.** `/api/apps`, `/api/agents`, `/api/services` and `/api/widgets` replace `icon`, `avatar` and `appIcon` (the agent tile's corner) with the active pack's file route, versioned by the file's modification time so a replaced icon is fetched anew. `?icons=manifest` on any of them returns the manifests' own; the [`space:app-icons`](../skills/app-icons/SKILL.md) skill reads them that way.
- **Peers.** A pack belongs to the machine whose panel shows it, and it covers that panel's peer tiles too (by their `<peer>/…` ids). The snapshot a space gives a hub reads the lists with `?icons=manifest`: a peer's pack never reaches a hub, which shows its own.
- **Serving.** Pack files are served with `content-security-policy: default-src 'none'` and `nosniff`, so an SVG opened on its own cannot run script on the panel's origin.

Making a pack is the `space:app-icons` skill's job: the operator describes a style, an agent draws every tile in it, previews the set and uploads it. Writes are panel routes like the layout's: no token, behind the same-origin check (Trust boundary).

## Chat

`POST /api/agents/:app/:agent/chat` runs one turn: ai-space spawns `claude -p <message> --output-format stream-json` in the agent's working directory with the identity from the manifest (`--append-system-prompt` from the prompt file plus the app title, description and `AGENTS.md`; `--allowedTools` from `tools`; `--model` from the request, else as [Agent models](#agent-models) resolves it) and streams the events back as server-sent events. Multi-turn continuity is `--resume <sid>`. The browser can pick a write tier (`acceptEdits`, `bypassPermissions`, `plan`); the default is the headless read-only behaviour. `SPACE_CHAT_ARGS` appends operator-chosen arguments to every run.

### Background runs

A turn is a run owned by the server, not by the request that started it (`src/space/agents/runs.ts`). The chat route creates the run, answers with its id in `x-run-id` and streams it; the browser closing, refreshing or losing its connection only detaches that stream. Three things end a run: the operator's stop (⏹ in the chat, `POST …/runs/:id/stop`), the timeout (`SPACE_CHAT_TIMEOUT_MINUTES`, 60 by default, 0 for none), and the service shutting down, which gives running turns `SPACE_DRAIN_SECONDS` to finish, as it does task runs, and then stops the rest as `interrupted`. A stopped runtime that has not exited 5 s after the kill is closed anyway.

Each event of a run gets a sequence number, sent as the SSE `id:`. The events are kept in memory while the run goes and for ten minutes after it ends (at most 20 finished runs), and written into the run's `agent_runs` row when it ends, so a later replay reads them from there; a row still `running` at boot belongs to a process that died and is marked `interrupted`. The buffer is bounded at 4 MB per run: text deltas that a following assistant message repeats are dropped first (they are dropped from the stored copy in any case), then the oldest events.

| Route | |
| --- | --- |
| `GET /api/agents/runs?recent=<s>&agent=<app/name>&limit=` | runs newest first: every running one and those that ended in the last `recent` seconds (all when absent) |
| `GET /api/agents/:app/:agent/runs` | the same for one agent |
| `GET /api/agents/:app/:agent/runs/:id` | one run |
| `GET /api/agents/:app/:agent/runs/:id/events?after=<seq>` | SSE: the events after `seq` (or `Last-Event-ID`), then live; the stream ends with `{"type":"error","error","status"}` when the run did not end `done`, then `{"type":"done"}` |
| `POST /api/agents/:app/:agent/runs/:id/stop` | stop a running turn: `{ ok, stopped, run }` |

A conversation runs one turn at a time: a chat request that resumes a session with a turn still running is a 409. On load the panel asks for the runs of the last half hour (and each peer's), takes the newest per agent, and restores it as that agent's conversation: the session's earlier turns from its transcript, the run's message, then the run's events from the start, following it live while it goes. A stream that drops mid-turn reattaches after the last `id:` seen, five times at most. Leaving a conversation in the panel (new conversation, a past session) stops its running turn, as the panel did before; messages queued behind a running turn are kept in the page only.

Transcripts are read back from the runtime's own store (Claude Code: `~/.claude/projects/<cwd>/<sid>.jsonl`; Codex: `$CODEX_HOME/sessions/**/rollout-*-<sid>.jsonl`; DeepSeek Harness: its session log), so restoring a past session costs no extra storage. Every agent accepts a `runtime/tier` or `runtime/model` in the request's `model` field ([Agent models](#agent-models)). A resumed session stays on its recorded runtime; changing runtimes requires a new conversation. A requested runtime the space lacks, or one without chat, answers 501. The browser reads Claude Code's `stream-json` events; another runtime's adapter translates its own events into that shape.

### Agent models

The model is the space's choice, not the app's, so every agent's chat menu offers the same configured chat runtimes and tiers as Space Assistant (`modelOptions` in `GET /api/agents`), and the menu's "default model" names the runtime a new chat starts on (`runtime`). The pick is remembered per agent in the browser; switching runtimes starts a new conversation, as for Space Assistant.

A new chat whose request names no model runs on the first of these that this space can chat on:

| layer | set by |
| --- | --- |
| override | Settings → App models, the app-wide row (the same `override-app` that model calls use, [model.md](model.md#app-models)) |
| agent | the agent's own `runtime` / `model` in `space.yaml` |
| manifest | the app's `model.default` in `space.yaml` |
| default | Space Assistant's default: Settings → Default model, else `SPACE_CHAT_MODEL`, at the intermediate tier of its runtime when that names only a runtime |

A bare tier runs on the runtime of the default (`codex/basic` makes `intermediate` mean `codex/intermediate`). A layer naming a runtime this space lacks or that cannot chat is skipped, so a manifest written for a Claude machine (or one that omits `runtime`, which used to mean Claude) runs on the space's own default instead of failing. So on a Codex-only machine an operator does nothing for an app's agents to use Codex; setting the app's override moves its agents and its model calls together.

The manifest's `tools` list is Claude Code's syntax and is passed only to Claude Code. On Codex the permission menu's sandbox bounds the agent instead: read-only by default, with neither writes nor network, so an agent whose commands write data or call a local HTTP service needs the "all permissions" tier there.

## Widgets

`GET /api/widgets` fetches every `kind: items` source through ai-space, caches each payload for the widget's `refresh`, and returns at most twenty items with only the contract fields (`text`, `url`, `time`). When the payload carries [blocks](app-spec.md#blocks-a-state-card-instead-of-a-list), they pass through `src/space/panel/blocks.ts`: only the contract's fields, type-checked, at most twelve; a malformed block is dropped, never repaired, and `asOf`/`staleAfter` come along. Item and block links resolve against the app's public URL and only `http(s)` reaches the page. The card (`src/web/WidgetBlocks.tsx`) then draws the first block as the hero and as many compact rows as the size holds: on a 2x1 the rows sit beside the hero, on a 2x2 the hero's chart widens and the rows take two columns, below 700px everything stacks. The app's title is a quiet link in the head and a block card has no "view all" footer; a missing value reads "No data", and a card whose `asOf` is older than `staleAfter` says it is out of date. A card without blocks is the list, as before. A failing source yields `{ ok: false, error }` and the card shows the error as is. Sources are resolved server-side: a path is joined to `http://127.0.0.1:<service.port>`, a full URL is used unchanged; neither reaches the browser. `kind: embed` widgets are proxied at `GET /api/widgets/:app/:name/embed?theme=&lang=` because the browser cannot reach loopback (both parameters are forwarded to the page, `lang` only when it is a language tag); the page must be self-contained (inline assets or absolute public URLs).

## Appearance

The panel's look is a browser preference, edited in Settings without code changes (`src/web/theme.ts`, `src/web/ThemeSettings.tsx`). It has three parts:

- **Mode**: follow the system, light or dark. Only "follow the system" listens to `prefers-color-scheme`; a fixed mode ignores the OS. `data-theme` on `<html>` is always the resolved `light` or `dark`, and `color-scheme` and `<meta name="theme-color">` follow it.
- **Theme** (a preset): Aurora (the default, the look the panel always had), Simple (opaque surfaces, no glow, small radii), Warm, and four with drawn artwork behind the page: Orbit, Northern Lights, Paper Cut and Prism. A preset is a `ThemeDefinition` (`version`, `id`, `name`, `light` and `dark` tokens, optionally a `backdrop`) and is independent of the mode: each preset has both schemes.
- **Backdrop**: a preset's `backdrop` names a static document under `src/web/public/backdrops/` (inline SVG and CSS, a light and a dark version, its own layout for tall screens). While the glow is on, the page frames it at `/backdrops/<name>.html` in place of the three blobs; the frame keeps the artwork's styles and SVG ids apart from the page, takes no input, and reads `data-theme` from the page. `data-backdrop` on `<html>` gives headings on the open field a halo in the background color and sets tile names in white with a dark shadow where the artwork is deep enough (design-guidelines.md section 3). With the glow off the preset is a plain field in the artwork's ground color. The backdrop is only fetched when its preset is chosen (Northern Lights is the largest, about 480 KB before compression).
- **Adjustments**, per mode: accent color, background color, corner radius, glass blur, surface opacity and the background glow. Light and dark keep their own, and the settings edit the one on screen.

Resolution for the scheme in effect is the default tokens, then the preset's, then the adjustments; a token missing at one layer falls back to the layer below. Tokens are semantic: background, text and secondary text, surfaces (glass, strong glass, panel, solid), borders and hairlines, shadow, accent, link and focus with the color on the accent, success, warning and danger, code and terminal grounds, selection, scrim, radius, blur and the three glow colors. `styles.css` declares the default values (a test keeps them equal to `DEFAULT_THEME`) and derives the rest (shadow, smaller radii, the glass filter) from them; the theme engine sets the resolved values inline on `<html>`. The panel's accent never reaches apps: embedded widgets still receive only `theme=light|dark`, and the chat widget keeps its own `--sc-*` tokens that each app maps to its brand.

The mode is saved at once. The theme and the adjustments are a draft the page previews live; Save stores it, Cancel (or closing the settings) drops it, and "Reset to default" returns the draft to Aurora without adjustments. Switching the theme while adjustments exist asks whether to keep or clear them.

Storage is `localStorage`: `panel-appearance` holds `{ version: 1, mode, presetId, overrides: { light, dark } }`. The light/dark switch of earlier versions (`panel-theme`) becomes a fixed mode on first load and is removed. Data that cannot be read (not JSON, another version, an unknown preset, an invalid color, a number out of range) falls back to the default, part by part, and the settings say so with a one-click reset. Unavailable storage (private mode, blocked site data) keeps the look for the page and says it was not saved. Another tab's save applies here through the `storage` event. To avoid a flash, the engine also writes `panel-appearance-boot` (the resolved variables of both schemes), and a small inline script in `index.html` paints them before the bundle loads.

The terminal takes its ground, text, cursor and selection from the resolved theme and keeps fixed ANSI colors, picked by the ground's brightness so program output stays readable; a theme change recolors open terminals without touching their sessions.

**Import and export.** Export downloads the saved preferences as JSON (`{ format: "ai-space-panel-theme", version: 1, mode, presetId, overrides }`). Import is strict: at most 16 KB, the format tag and version must match, and any unknown field, a color other than hex or `rgb()`/`rgba()`, or a number out of range refuses the whole file and leaves the current look alone. An accepted file is previewed as a draft and applies only when saved. No CSS, scripts or images are accepted.

## Events

The settings open an Events window next to Tasks and Model usage: the bus's catalogue (what every app, local or on a peer, provides, publishes and consumes, with call counts) and the last hundred events, each opening to its http and stream deliveries with status, attempts and last error ([events.md](events.md)). Read-only, like Tasks.

## Inbox

A built-in tile next to Terminal opens the Inbox: every app's notifications as threads, newest first, with a red badge for the unread ones. Filters for all, unread, to handle (`alert` and `warn` not yet done) and done, and one app. Opening a row marks it read and shows the full text, the link the notification carried and, for a repeated thread, how many times since when; it can be marked done, reopened or marked unread. A newer notification in a thread brings it back. The data and its rules are in [notify.md](notify.md#inbox); this machine's notifications only, not a peer's.

## Health

Service supervision is not implemented yet, so the panel probes `GET 127.0.0.1:<port><service.health>` (two-second timeout), caches the result for fifteen seconds, and shows a green or red dot. Apps without `service.health` show no dot.

`GET /api/apps` never waits for a probe: it answers with the cached result, or `unknown` for a service not probed yet, and starts the probe behind the answer, so a service that is down or slow cannot hold the tiles back. The page asks for the list once more a moment later when any dot came back `unknown`. `GET /api/services` (the Settings list) waits for the probes.

## Routes

| Route | Purpose |
| --- | --- |
| `GET /` and the PWA files | the web UI |
| `GET /api/apps`, `GET /api/apps/:app` | app views (`?all=1` lists every app, including hidden ones and those without a url) |
| `GET /api/services` | every app with a `service`: port and health, for Settings; plus `peers`, one entry per peer machine |
| `POST /api/apps` | create a manifest-only app from `{ link }` or identity fields |
| `PATCH /api/apps/:app` | `{ hidden }` |
| `DELETE /api/apps/:app[?force=1]` | uninstall: stop the service, take the directory out of the workspace, forget the app (see above); 409 while a task of the app is running, unless forced |
| `GET /api/apps/:app/icon`, `GET /api/agents/:app/:agent/avatar` | icon files from the app directory; paths cannot escape it |
| `GET /api/widgets`, `GET /api/widgets/:app/:name/embed` | widget payloads and embed pages |
| `GET`/`PUT /api/panel/layout` | order, hidden apps, widget sizes, removed widgets and screens |
| `GET /api/panel/appcolor?app=` | the app page's `theme-color`, for the phone shell |
| `GET`/`PUT /api/panel/icons` | the icon packs with their files, and `{ active: <pack> \| null }` (Icon packs) |
| `GET`/`PUT`/`DELETE /api/panel/icons/:pack/:kind?id=` | one icon of a pack (`kind`: `app` or `agent`): read, upload as the request body (`content-type` `image/svg+xml`, `image/png` or `image/webp`; creates the pack), remove |
| `DELETE /api/panel/icons/:pack` | a whole pack; an active one turns packs off |
| `POST /api/panel/usage/open`, `GET /api/usage` | an open of a tile or library card (a beacon); opens and time in use per entry ([usage.md](usage.md)) |
| `GET /api/agents` | every agent the panel lists |
| `POST /api/agents/:app/:agent/chat` | one chat turn as a background run, SSE |
| `GET /api/agents/runs`, `GET /api/agents/:app/:agent/runs[/:id[/events]]`, `POST /api/agents/:app/:agent/runs/:id/stop` | chat runs: list, one, replay and follow, stop ([Background runs](#background-runs)) |
| `GET /api/agents/:app/:agent/sessions[/:sid]` | recent sessions, restored transcript |
| `GET /api/inbox`, `POST /api/inbox/mark`, `POST /api/inbox/read-all` | the inbox: threads with read and done state, and changing it ([notify.md](notify.md#inbox)) |
| `GET /api/peers`, `PATCH`/`DELETE /api/peers/:peer/apps/:app`, `/api/peers/:peer/…` | peer machines, hub-side hide, forwarded uninstall/icon/embed/chat/sessions ([peers.md](peers.md)) |
| `GET /api/terminal`, `POST /api/terminal/sessions`, `DELETE /api/terminal/sessions/:id`, `GET /api/terminal/ws`, `/api/peers/:peer/terminal/…` | the web terminal: status and machines, open a session (one-time ticket), end one, the session socket; the same on a peer, forwarded and bridged ([terminal.md](terminal.md)) |
| `/api/peer/…` | this space as a peer of a hub, bearer-guarded ([peers.md](peers.md)) |

## Trust boundary

These routes carry no bearer token. The browser cannot hold `SPACE_API_TOKEN`, and the panel is reached the way the previous panel was: through the operator's tunnel and access layer from outside, through loopback on the machine. The machine-side routes (tasks, storage, notify) keep the token. Consequences to be aware of:

- Anyone who passes the access layer can open a chat with `bypassPermissions`, which is a shell on the machine with the operator's runtime login. This is the same exposure as before, now written down.
- Anything on the machine that can reach loopback can add an app from a link, uninstall an app (which runs the stop command) and change the layout. Command tasks run as the same user anyway.
- A page on another site cannot do the same through the operator's browser. Every write (`POST`, `PUT`, `PATCH`, `DELETE`) that comes without an `Authorization` header must pass the same-origin check the terminal uses, or it is a 403 before any handler runs (`guardBrowserWrites` in `src/space/auth.ts`, applied to the whole route table). Without it, a simple cross-site `POST` to loopback could start a chat turn, add an app or stop a service. A request with a bearer token is not checked: a browser cannot send one cross-site without a preflight, which the space never answers. A script on the machine sends neither `Origin` nor `Sec-Fetch-Site` and passes.

- The terminal, when a machine enables it, is the same shell without the agent in between. It adds what the other routes lack because a cross-site page could otherwise open it through the operator's browser: a same-origin check on every request that opens or ends a session, a one-time ticket on the socket, an optional passphrase, an idle limit and a cap. [terminal.md](terminal.md#trust-boundary) states the whole boundary.

An operator who wants a second factor puts it in front of the tunnel, not in ai-space.

## Module layout

```
src/space/panel/    registry.ts (registered manifests), layout.ts (panel_kv), icons.ts (icon packs), health.ts,
                    widgets.ts (feed + cache), view.ts (API shapes), links.ts (manifest-only apps), uninstall.ts (stop + directory),
                    api.ts (routes)
src/space/peers/    other machines' panels merged into this one, and this one served to a hub (peers.md)
src/space/terminal/ the web terminal: PTY backends, tickets and sessions, audit rows, routes and the socket bridge to a peer (terminal.md)
src/space/usage/    store.ts (usage_opens, usage_sessions), service.ts, api.ts, script.ts (the heartbeat script) (usage.md)
src/space/agents/   runtime.ts (a run as SSE), runs.ts (background runs, agent_runs), sessions.ts (chat_sessions),
                    transcript.ts, api.ts (routes, space agent)
src/web/            index.html, main.tsx (language root), App.tsx, screens.ts (screen operations), Library.tsx, ScreenNav.tsx (edges, dock, hint), Activity.tsx (App usage), Chat.tsx, Tasks.tsx, Inbox.tsx, Terminal.tsx, Pet.tsx, petdex.ts (pet lookup),
                    theme.ts (appearance: presets, resolution, storage), ThemeSettings.tsx (its settings rows),
                    i18n.ts (dictionaries, language choice), styles.css, api.ts, routes.ts (HTML import + public files),
                    public/ (PWA shell, pet sprite)
```

`bun run dev` starts ai-space with `SPACE_DEV=1`, which turns on Bun's dev server for the page (hot reload); the default is one bundle at boot.

## Migrating from a registry-based panel

1. For every app that already is an ai-space app, fill in the identity fields (`title`, `description`, `icon`, `url`) and, where the registry had one, the `widgets` entry.
2. For every other registry entry, create `apps/<name>/space.yaml` with the identity fields and copy its icon file next to it as `icon.svg`. When that app later moves into the workspace, the directory is replaced by the clone.
3. Registry agents move into the `agents:` section of the app they belong to, their prompt into `agents/<name>.md`; the generic default agent is the space agent and needs no entry.
4. Import the old order into the layout: `PUT /api/panel/layout` with the names in order.
5. Point the tunnel at ai-space's port and stop the old panel; keep it installed until the new one has been used for a while.

## Failure modes considered

- A manifest fails validation: the app is skipped with a log line and the panel does not list it, same as the scheduler. Nothing partial.
- A widget source is slow or down: eight-second timeout, error shown on the card, next attempt after 30 seconds (or `refresh`, when shorter), so a source restarting for a deploy does not hold the error for a whole `refresh`.
- The runtime is missing or exits non-zero: the SSE stream ends with an `error` event carrying the last lines of stderr, then `done`.
- The browser disconnects mid-turn: the response stream is cancelled and the run goes on; the page reattaches on reload (Background runs).
- A turn never ends: the run timeout stops it. ai-space restarts mid-turn: the turn gets the drain time, then is stopped and recorded as interrupted.
- Two people reorder at once: last write wins; the layout is small enough that this is acceptable.
- An icon path points outside the app directory: 404.
