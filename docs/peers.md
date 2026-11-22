# Peers: one panel over several machines

Status: implemented (`src/space/peers/`). What is still open is listed under Later.

## Problem

An ai-space owns one machine: its workspace, its `space.db`, its loopback services. Apps live where they are deployed, and some machines are better homes than others (a box with a public IP and sudo, a box behind a tunnel with neither, a laptop). The panel, however, is one page the operator opens, and it should show every app, every agent, every widget and every service the operator has, wherever it runs.

Without peers the panel on the hub machine only knows the apps in its own `apps/`. An app deployed elsewhere reaches the panel as a manifest-only link app: a tile, no health, no chat, no widget unless the source is a public URL. That is a copy of the app's identity, maintained by hand, that drifts.

## Shape

One ai-space per machine, unchanged. One of them is the **hub**: the operator's `.env` on that machine lists the other spaces as **peers** (name, URL, token). The hub asks each peer for what its panel would show, merges it into its own panel under the peer's name, and forwards the requests that need the app's machine (chat, sessions, embed pages, icon files) to that peer. Peers do not know about the hub or about each other. Nothing is shared: no database, no workspace, no files.

```
browser ── hub ai-space ──────────── its own apps, agents, widgets, services
              │
              ├── GET  /api/peer/snapshot ──► peer ai-space ── its own apps …
              └── forwarded chat / embed / icon ──►   (loopback, published on a tunnel hostname)
```

Rules that follow from the existing design and stay true:

- **An app lives on exactly one machine.** Its directory, repository, data, tasks, storage and notifications are on that machine. The hub never provisions, schedules or stores anything for a peer app.
- **Scheduler, storage and notify stay local.** A peer runs its own; the hub's Tasks drawer shows the hub's tasks. Peer tasks are a later addition (see Later).
- **The peer's own panel keeps working.** A peer is a complete ai-space with its own web UI on loopback; being listed by a hub adds nothing to it but one group of routes.
- **One level.** A peer's snapshot contains its local apps only, never the apps of its own peers. Two hubs listing each other see each other's local apps and nothing more; no cycles.
- **Be honest.** A peer that does not answer is shown as down, with the time of the last snapshot; its apps stay on the panel, muted, never silently dropped and never shown as healthy.

## Naming

Names are per machine, so `media` on one machine and `media` on another are different apps (which is also why each machine backs up under its own prefix, see [backup.md](backup.md#several-machines)). On the hub, a peer app is addressed by `<peer>/<app>`, an agent by `<peer>/<app>/<agent>`, a widget by `<peer>/<app>/<widget>`. Local apps keep their bare names; `<peer>` is a reserved first segment. Peer names follow the app-name rule (`[a-z0-9][a-z0-9._-]*`) and may not equal a local app name; the hub refuses to boot on a collision, since a tile called `david` would then be ambiguous.

The prefix is a display and layout key, not a route parameter: app names cannot contain `/` and the panel routes are shaped `/api/apps/:app`, so peer routes get their own prefix (below) and views carry a `peer` field next to the bare `name`. Every app view now has an `id` (the name, or `<peer>/<name>`), which is what the layout order and the hidden set hold. The web UI names the peer in the tile's hover card and uses `peer` to pick the route base.

## Adding a peer

A peer is added over a [package connection](app-packages.md#connected-space-api): the peer opens an outbound authenticated WebSocket to the hub, and every request the hub makes to it (snapshot, events, chat, sockets, model calls) travels over that one channel. The peer needs no public port, no tunnel hostname and no `SPACE_HUB_TOKEN`, and the hub no `SPACE_PEER_*` line. The older way, below under [Configuration](#configuration), keeps working side by side.

1. On the hub: `space connection create incoming <peer's Space ID>`. The token is printed once.
2. On the peer: put the token in its `.env` under a name of your choice (`HUB_ACCESS=…`), restart it, then `space connection create outgoing <hub's Space ID> --endpoint https://<hub> --token-env HUB_ACCESS`. With an access layer in front of the hub, either let `/api/connections/channel` through it or put its service-token headers in another variable (`HUB_HEADERS="CF-Access-Client-Id: …; CF-Access-Client-Secret: …"`) and add `--headers-env HUB_HEADERS`.
3. On the peer, grant the hub what it may do there: `space connection scopes <id> --scopes panel,agents,events,model,tasks,terminal`, or `--full-trust on` for everything, those a later version adds included ([scopes](app-packages.md#peer-scopes)). The Space IDs are in `space connection ls` on each side, or Settings → Application packages.

Within one catalogue round (30 s at most) the peer shows on the hub under its `SPACE_NAME`, lowercased, exactly as a legacy peer does: `GET /api/peers` lists it with `via: "connection"`, its apps, agents, widgets and services are merged under `<name>/`, and every `/api/peers/<name>/…` route, the model adapters, the ledgers, the event mirror, bus calls, the terminal bridge, speech and feedback reach it through its client (`client.ts`), which sends each request as a [`peer` operation](app-packages.md#the-peer-operation) on the channel instead of HTTPS. A scope the peer does not grant answers 403 on the hub as the peer's own words: the panel scope alone lists the machine without letting the hub chat, call or open a shell there; without `events` the mirror simply has nothing to pull.

Scopes are directional, like app grants: each Space grants what the **other** may do on it, whichever side dialed. Two machines that should each see the other grant `panel` both ways, on their own connection rows.

**Naming.** On the hub the peer's name is the connection's label (`connections.ts` `peerLabel`): its `alias` when the hub's operator set one (`space connection alias <id> <name>`), else the name the peer gives itself (`SPACE_NAME`, from its catalogue, kept on the row so a restart keeps it), else the first eight characters of its Space ID. The hub keeps everything under that name as it does for `SPACE_PEER_<NAME>` (`peer_snapshots`, `peer_cursors`, hidden apps, tile order, model ledger rows), and the stable id where a snapshot's `id` is used is the peer's Space ID, which the connection is bound to, whatever the snapshot says. A connection peer is renamed by changing its alias, not with `space peer rename`.

**One machine, one entry.** A legacy peer wins over a connection peer of the same name, and over a connection to the Space whose id its snapshot carries; two connections with one label: the first by connection id wins. A name a local app has is not taken. The connection that loses is listed in `GET /api/connections` with `peer.state` `shadowed` or `reserved` and the reason, and its machine is not shown twice. An app shared both in the snapshot and by an app grant has the same `<name>/<app>` id from both and is listed once.

**Moving a legacy peer onto a connection** is one command on the hub, `space peer migrate`: [below](#moving-a-legacy-peer). While both exist, the legacy peer is the one shown.

## Moving a legacy peer

`space peer migrate NAME` (or `--all`) on the hub turns a `SPACE_PEER_<NAME>` peer into a connection peer of the same name, in the running hub, without a restart on either side. The name is what the hub keeps its state under (`peer_snapshots`, `peer_cursors`, hidden apps, tile order, model ledger rows, model choices that name the machine as `name:runtime/tier`), so all of it carries over; nothing is moved or renamed. The CLI calls `POST /api/peers/:peer/migrate` once per peer (`peers/migrate.ts`); the peer's side is `POST /api/peer/connections/adopt` (`peers/adopt.ts`).

| Step | What happens | Done already (a re-run) |
| --- | --- | --- |
| connection | The hub's connection to the peer's Space id (from its legacy snapshot; `--peer-id` for a peer that sends none), alias = the name. None yet: an incoming one is created and its token kept for the next step. | Reused, the alias set if it differs. Its token is made anew only while the peer is not connected on it (a token is shown once and cannot be read back). |
| peer | **Automatic** (the default): the hub asks the peer, over the legacy channel and with the peer's own `SPACE_HUB_TOKEN`, to open an outgoing connection to the hub's address with that token, granting the hub full trust. **`--manual`**: the hub prints the commands below instead and stops. | The peer finds the connection it made and only writes the new token, or makes it again at a new address; nothing else. |
| verify | Within `--wait` seconds (30 by default): the channel is up, the peer grants this hub the panel scope (full trust does), and a snapshot of the peer's Space answers over the channel. If not, the legacy peer stays in place and the answer says why. | Checked again. |
| legacy | Unless `--keep-legacy`: the `SPACE_PEER_<NAME>`, `_TOKEN`, `_HEADERS` and `_REFRESH` lines are commented out in the hub's `.env` under a note, dropped from the running environment, the legacy client is stopped after its last refresh, and the connection peer takes the name. | Nothing left: the answer is `already`. |

`--dry-run` reports each step as `would` and changes nothing on either machine. `--keep-legacy` stops after the verification: the legacy peer keeps winning over the connection until the command runs again without it. `--json` prints the route's answer.

**The hub's address.** The peer dials the hub, so it needs the hub's public origin: `--hub-url`, else `https://<SPACE_PANEL_HOST>`. With neither the command stops before changing anything and asks for `--hub-url` (with `SPACE_DOMAIN` set it suggests `https://space.<domain>`, the hostname `setup` plans for the panel). It never guesses a loopback address, which on the peer would name the peer itself. HTTPS is required except for a loopback origin (the connection rule).

**Where the peer keeps the token.** In `SPACE_CONNECTION_<ID>_TOKEN`, `<ID>` being the first twelve hex digits of the hub's Space id, uppercased, in the peer's workspace `.env` (written in place, the other lines untouched, mode kept) and in the running service's environment at the same time. The links read a connection's credential from that environment on every dial (`links.ts`), and an outgoing connection that has none retries every 5 s, so the connection comes up without a restart. An access layer's headers for the hub (`--hub-headers`) go into `SPACE_CONNECTION_<ID>_HEADERS` the same way.

**Output.** One block per peer:

```
$ space peer migrate box
box: migrated (connection 3f0c…)
  ✓ connection created incoming connection 3f0c… under the alias box
  ✓ peer       the peer's connection 91aa… to this hub created
  ✓ verify     the connection is up and the peer answers a snapshot over it
  ✓ legacy     commented out SPACE_PEER_BOX, SPACE_PEER_BOX_TOKEN in /home/me/.ai-space/.env; box is now reached over connection 3f0c…
  note: The peer now dials https://space.example.com/api/connections/channel. If an access layer (Cloudflare Access) is in front of the hub's hostname, it must let that path through, or pass its service token with --hub-headers.
  note: On the peer, SPACE_HUB_TOKEN is no longer used by this hub; remove it there once no other hub lists it as SPACE_PEER_* (it keeps /api/peer/* open over HTTPS).
  commented out in .env (to restore them, remove the "# "):
    SPACE_PEER_BOX=https://space-box.example.com
    SPACE_PEER_BOX_TOKEN=9f3a…c2d1
  to go back:
    …
```

The exit code is 0 when every peer is migrated, verified (`--keep-legacy`), planned (`--dry-run`), waiting for its owner (`--manual`) or on a connection already; 1 when one is not (`--all` goes on with the others); 2 for a wrong command line; 3 when ai-space does not answer.

**A peer that cannot be asked.** A peer whose ai-space predates the adopt route answers 404; the command then stops (`needs-manual`) and names `--manual`. So does an owner who does not want the hub to drive the peer. `space peer migrate NAME --manual` does the connection step and prints, for the peer:

```
# On the peer (box), as the owner of its ai-space:
# 1. The token for this hub, in its workspace .env (shown once; running this again makes a new one):
SPACE_CONNECTION_0D8CE9409BC8_TOKEN=<token>
# 2. Restart it, so the running service reads the token:
space service restart
# 3. The connection to this hub, granting it full trust (what SPACE_HUB_TOKEN gave it):
space connection create outgoing <hub's Space id> --endpoint https://space.example.com --token-env SPACE_CONNECTION_0D8CE9409BC8_TOKEN --full-trust --yes
#    (or --scopes panel,agents,events,model,tasks,terminal,apps,manage to grant scopes one by one)
# Then on this hub:
space peer migrate box --finish
```

The restart is needed there because a peer set up by hand reads its `.env` only at start; the automatic mode writes the running environment too. `--finish` skips the peer step and does the verification and the legacy step. When the peer is connected already (or this hub dials it, below), the printed step is only `space connection scopes <id> --full-trust on`.

**Two hubs that list each other.** Migrating one direction leaves the other alone: A's migration of B makes B dial A and grant A full trust, and A's new incoming connection grants B nothing, so B keeps reaching A over its own `SPACE_PEER_A` and does not see A twice. Migrating B's side then finds that same connection (there is one per pair of Spaces, `remoteSpaceId` is unique), sets its alias on B, and asks A to raise what A grants B on it to full trust. One connection then carries both directions. The adopt route changes a connection it did not make only in this case: when the Space that asks is one this Space lists as its own peer.

**What differs after the move**, and the command says so before anything changes:

- `SPACE_PEER_<NAME>_HEADERS` (an access layer's credentials for the **peer's** hostname) is no longer used: the hub stops calling the peer. The **hub's** hostname must now let the peer's WebSocket to `/api/connections/channel` through. Behind Cloudflare Access that is a Bypass policy on that path (the channel checks its own token and the peer's Space id, as `/api/peer/*` checks the hub token), or a service token with a Service Auth policy, whose two headers the peer sends: `--hub-headers "CF-Access-Client-Id: …; CF-Access-Client-Secret: …"` ([cloudflare.md](cloudflare.md)). A connection made by hand takes them by `--headers-env NAME`.
- `SPACE_PEER_<NAME>_REFRESH` is not carried over: a connection peer refreshes every 30 s.
- `SPACE_CHAT_MODEL` and `SPACE_MODEL_DEFAULT` values that name the peer as their machine (`box:codex/basic`) keep working, as does every other use of the name ([model-machines.md](model-machines.md), a speech provider's `machine:`, the Fix Engineer's machine): the name is the same.
- The peer's `SPACE_HUB_TOKEN` is no longer needed by this hub. It still opens `/api/peer/*` over HTTPS until it is removed there, which the command does not do (another hub may still use it).

**Full trust and what stays closed.** The adopt route grants the hub full trust, the equivalent of the hub token. A connection's limits stay on top of any scope, as over HTTPS: the terminal routes exist only while `SPACE_TERMINAL_ENABLED` is on there, `model/run` and `model/image` only for the runtimes `SPACE_PEER_MODEL` names, and installed packages stay out of the peer routes. A peer with its terminal off or a model allow-list is therefore as limited after the move as before (`migrate.test.ts` checks the first two).

**Rollback.** What the command prints under "to go back":

- On the hub: remove the `# ` in front of the `SPACE_PEER_<NAME>*` lines in `.env` (they are under the note `moved to a package connection by space peer migrate …`) and `space service restart`: a legacy peer is read at start, and while both exist it wins over the connection, so nothing else is needed. `space connection rm <id>` drops the connection as well; the stored snapshot and the rest stay under the name.
- On the peer: `space connection rm <its connection to the hub>` and delete `SPACE_CONNECTION_<ID>_TOKEN` (and `_HEADERS`) from its `.env`.

The only step of the whole move that needs a restart is going back: the hub reads `SPACE_PEER_*` at start.

## Configuration

The older way to add a peer, still supported: the hub reaches the peer over HTTPS with the peer's `SPACE_HUB_TOKEN`. Hub side, in `<workspace>/.env`, the same pattern as notify channels (`SPACE_NOTIFY_<NAME>`):

```
# Peers: other ai-space machines whose panel this one merges. NAME lowercased is the peer name.
SPACE_PEER_DAVID=https://space-david.example.com
SPACE_PEER_DAVID_TOKEN=<the peer's SPACE_HUB_TOKEN>
# Optional: extra request headers, for an access layer in front of the peer ("Name: value; Name: value").
# SPACE_PEER_DAVID_HEADERS=CF-Access-Client-Id: …; CF-Access-Client-Secret: …
# Optional: how often the hub refreshes the snapshot; default 30s, minimum 10s.
# SPACE_PEER_DAVID_REFRESH=30s
```

Peer side, in its own `.env`:

```
# Token a hub must present on /api/peer/*. Empty = those routes are absent.
SPACE_HUB_TOKEN=<random, 32+ bytes>
# What this space calls itself in the snapshot; default: the hostname.
SPACE_NAME=david
```

A peer is reachable the way its panel is: ai-space binds loopback, and the operator publishes the port on a hostname of the machine's tunnel. If an access layer sits on that hostname it either exempts `/api/peer/*` (the bearer token is the check there) or the hub sends the layer's credentials through `_HEADERS`. Publishing a peer on a plain public port is not supported: the peer routes are a bearer check, not an access layer.

A malformed peer line is reported at boot and skipped; the others load. A peer named like a local app stops the boot with a message.

## Peer side: `/api/peer/*`

Over HTTPS present only when `SPACE_HUB_TOKEN` is set; every route requires `Authorization: Bearer <token>`, and a wrong or missing token is a bare 401. Over a package connection the same handlers answer a [`peer` operation](app-packages.md#the-peer-operation), each route under the scope `PEER_ROUTES` (`scopes.ts`) gives it, with no token. The routes mirror the panel and agent routes the browser already uses, with the same handlers behind a token check, plus one snapshot:

| Route | Mirrors | Notes |
| --- | --- | --- |
| `GET /api/peer/snapshot` | `/api/apps`, `/api/services`, `/api/widgets`, `/api/agents` | One call: `{ ok, name, id, apps, services, widgets, agents, asOf }`. `id` is the peer's stable id, the one its `/api/space` gives the operator; it survives a rename on either side ([Renaming a peer](#renaming-a-peer)). Apps are the peer's visible ones (its own hidden set and `archived` applied, `manifestOnly` and `url` included; entries the peer itself merged from its own peers are left out, so a hub of hubs lists each app once), agents and widgets likewise, widgets with their current items payload, services with health. The space agent (`space/assistant`) is included: the hub groups it with its own, so the chat can pick the machine ([Agents on several machines](#agents-on-several-machines)). `inventory` is the peer's agent CLIs ([model-machines.md](model-machines.md#inventory)). Every hub reads it every refresh period and it runs to tens of kilobytes, so it is sent gzipped when the request accepts gzip (Bun's fetch does, and unpacks it). |
| `DELETE /api/peer/apps/:app` | `DELETE /api/apps/:app` | Uninstall on the peer: its stop command, its directory, its registry ([panel.md](panel.md#arranging-hiding-and-uninstalling-apps)). The hub refreshes the snapshot right after. |
| `GET /api/peer/events?since&limit` | the scheduler's events | The events published on this machine after an id, oldest first, with `latestId` and `next` (the last id the page covered, hidden apps' events included, so the hub's cursor moves past a page they fill); the hub mirrors them after every snapshot ([events.md](events.md#across-machines-peers)). Mirrored events are not exported again. |
| `POST /api/peer/call/:app/:capability` | `POST /api/call/:app/:capability` | A call from the hub, run on this machine's bus as the caller named in `x-space-caller` (`<hub name>/<app>`). The snapshot carries `capabilities` so the hub knows what to forward. |
| `GET /api/peer/apps/:app/icon` | `/api/apps/:app/icon` | Icon files from the app directory. |
| `GET /api/peer/apps/:app/appcolor` | `/api/panel/appcolor?app=` | |
| `GET /api/peer/agents/:app/:agent/avatar` | `/api/agents/:app/:agent/avatar` | |
| `GET /api/peer/widgets/:app/:name/embed` | `/api/widgets/:app/:name/embed` | The proxied embed page, `?theme=` passed through. |
| `POST /api/peer/agents/:app/:agent/chat` | `/api/agents/:app/:agent/chat` | The same body, the same SSE stream, the run id in `x-run-id`. Sessions and runs are recorded on the peer. |
| `GET /api/peer/agents/runs`, `GET /api/peer/agents/:app/:agent/runs[/:id[/events]]`, `POST /api/peer/agents/:app/:agent/runs/:id/stop`, `…/steer`, `…/approvals/:rid` | the same under `/api/agents/` | The peer's background chat runs: list, replay and follow, stop, add a message, answer an approval ([panel.md](panel.md#background-runs)). |
| `GET /api/peer/agents/:app/:agent/sessions[/:sid]` | `/api/agents/:app/:agent/sessions[/:sid]` | |
| `POST /api/peer/model/run`, `POST /api/peer/model/image` | `/api/model/run`, `/api/model/image` | Only when `SPACE_PEER_MODEL` names runtimes: an answer or pictures run here with this machine's login for `<space>/<app>` in `x-space-caller`, recorded here with `origin: peer`. The snapshot's `model` lists the offered runtimes with their tiers and status cells. The model names no machine, so a forwarded call is never forwarded again ([model-machines.md](model-machines.md)). An answer asked for under a `ref` outlives a dropped link, and the same request again attaches to it; `POST /api/peer/model/runs/:ref/cancel` stops it ([model-machines.md](model-machines.md#resuming)). |
| `GET /api/peer/model/usage?window&skip`, `GET /api/peer/model/calls?limit&skip` | `/api/model/usage`, `/api/model/calls` | This machine's own ledger, for the hub's Settings → Model usage; `skip` names the reading space, whose calls run here its own rows count. Always present, whatever `SPACE_PEER_MODEL` says ([model-machines.md](model-machines.md#the-hubs-usage-page)). |
| `GET /api/peer/model/apps`, `PATCH /api/peer/apps/:app/model` | `GET /api/model/apps`, `PATCH /api/panel/apps/:app/model` | The peer's app-model rows with its own choices, and setting or clearing one override (`{tag?, model}`), for the hub's Settings → Models page. The choices are the peer's, so an override always names a model the peer can run; apps the peer does not share with legacy peers are left out and refused. |
| `GET /api/peer/tasks`, `GET /api/peer/tasks/:id/runs`, `GET /api/peer/tasks/models`, `PATCH /api/peer/tasks/:id/model` | `GET /api/tasks`, `GET /api/tasks/:id/runs`, `GET /api/tasks/models`, `PATCH /api/panel/tasks/:id/model` | The peer's scheduled tasks, one task's runs, the models a task can run on there, and setting or clearing one task's model (`{model}`), for the hub's Tasks page. Nothing else of a task changes from the hub: running, pausing and rescheduling stay on the peer. Tasks of apps the peer does not share with legacy peers are left out and refused. |
| `GET`/`PUT /api/peer/feedback/settings`, `GET /api/peer/feedback`, `POST /api/peer/feedback/fix` | `/api/panel/feedback/settings`, `/api/panel/feedback`, `/api/panel/feedback/fix`, without the peer's own peers | The peer's Fix this settings, rows and fixes, for the hub's Settings → Fix this: the hub sends its choices for the apps that run on the peer each time that page is read or saved ([feedback.md](feedback.md#apps-on-a-peer)). Package apps are left out, as in the peer's other lists. |
| `GET /api/peer/apps/:app/proxy/api/*` | `http://127.0.0.1:<service.port>/api/*` | The peer app's own API, for an app on the hub that reads its counterpart on the peer (the usage app pulls each machine's rows this way). GET only, only paths under the app's `/api/`, only apps with a service; the query string is passed through, the answer streamed back as is, 60 s limit. A WebSocket upgrade on the same path is bridged to the app's own socket there (`ws://127.0.0.1:<service.port>/api/*`), frame by frame in both directions, with the app's close code and reason passed back: an app on the hub relays a live stream of an app that needs the peer's hardware this way (Notes sends microphone audio to Voice Studio's live transcription on the GPU machine). No time limit beyond the app's own; the socket carries none of the hub's headers to the app. |
| `GET /api/peer/terminal`, `POST /api/peer/terminal/sessions`, `DELETE /api/peer/terminal/sessions/:id`, `GET /api/peer/terminal/ws` | `/api/terminal…` | Present only while the terminal is enabled on the peer (`SPACE_TERMINAL_ENABLED`); the snapshot then carries `terminal: true`. A session on the peer, opened and bridged by the hub ([terminal.md](terminal.md#peers)). |
| `POST /api/peer/connections/adopt` | none | Over HTTPS only, behind the token; never over a connection, whatever it grants (`LEGACY_ONLY_ROUTES` in `scopes.ts`). `{ spaceId, url, token?, headers? }`: the hub moving this Space onto a connection, `space peer migrate` ([Moving a legacy peer](#moving-a-legacy-peer), [Trust boundary](#trust-boundary)). |

Nothing under `/api/peer/` mutates the peer's configuration but `connections/adopt`, which makes or widens the one connection to the hub that calls it: no create, no hide, no layout, no tasks, no storage, no notify. A chat turn and a terminal session run on the peer, of course; that is what they are for. The hub's operator changes a peer app on the peer, the same way as today.

`name` in the snapshot is what the peer calls itself (`SPACE_NAME`); the hub ignores it for addressing (the hub's `SPACE_PEER_<NAME>` key is the name) and reports it, so a misconfigured pair is visible.

## Hub side

Module `src/space/peers/`:

| File | Holds |
| --- | --- |
| `config.ts` | `SPACE_PEER_*` parsing: name, URL, token, extra headers, refresh. A connection peer's config names its `connection` and the other Space's id instead. |
| `connection-peers.ts` | The connection peers: every enabled connection whose other Space grants the panel scope, attached to the hub under the connection's label, or listed with the reason it is not (a legacy peer of the same name or Space, another connection of that label, a local app's name). |
| `connection-serve.ts` | The peer side over a connection: a `peer` operation into the `/api/peer/*` handlers, checked against the connection's scopes, with only the headers the routes read and a hub uses. |
| `scopes.ts` | `PEER_SCOPES` and `PEER_ROUTES`: every `/api/peer/*` route with its one scope. |
| `client.ts` | One client per peer: `refresh()` on its own timer with the last good snapshot kept, `health()`, `knownDown()` (down and the last two refreshes failed), `forward(req, path)` for the proxied routes, `request(path)` and `socket(path)`; every one goes over HTTPS with the token, or as a `peer` operation on the peer's connection. Timeouts: 8 s for a snapshot, none for a chat stream (it stays open as long as the peer's does; the browser leaving detaches it, the turn goes on on the peer), 8 s for the other forwards. |
| `store.ts` | The last good snapshot per peer in `space.db` (`peer_snapshots`), so a hub restart while a peer is down still lists its apps, muted. A peer dropped from `.env` loses its row at boot. |
| `rename.ts` | `space peer rename`: the checks, the `.env` rewrite and the move of every row kept under the peer's name, in one transaction ([Renaming a peer](#renaming-a-peer)). |
| `migrate.ts` | `space peer migrate` on the hub: the connection under the legacy name, the adopt call or the manual commands, the bounded verification, the legacy lines commented out and the client swapped in the running hub ([Moving a legacy peer](#moving-a-legacy-peer)). |
| `adopt.ts` | The peer's side of it, `POST /api/peer/connections/adopt`: the outgoing connection to the calling hub with full trust, its token in `SPACE_CONNECTION_<ID>_TOKEN` in the `.env` and the running environment. |
| `merge.ts` | Turns a snapshot into hub views: prefixes ids, sets `peer`, rewrites icon, avatar and embed routes to the hub's proxy, applies the hub's hidden set, marks stale entries. |
| `hub.ts` | Every configured peer and the merged lists the panel appends; connection peers are attached and detached as their connections change. |
| `serve.ts` | The peer side (`/api/peer/*`): `createPeerServeHandlers`, and the HTTPS routes that put them behind the token. |
| `ledgers.ts` | The peers' model ledgers for the hub's usage page: every peer at once, 4 s at most, the last answer when one is late. |
| `api.ts` | `GET /api/peers`, the hub-side hide, the forwarded uninstall, the forwarded app-model list and override change (`GET /api/peers/:peer/model/apps`, `PATCH /api/peers/:peer/apps/:app/model`, same-origin browser requests only, like the local route), the forwarded task list, runs, task models and task model change (`GET /api/peers/:peer/tasks`, `GET /api/peers/:peer/tasks/:id/runs`, `GET /api/peers/:peer/tasks/models`, `PATCH /api/peers/:peer/tasks/:id/model`, the last under the same rule), and the `/api/peers/:peer/*` proxy routes, including `GET /api/peers/:peer/apps/:app/proxy/api/*` for an app on the hub that reads its counterpart's API on the peer (65 s limit, the peer's own 60 s inside it); the same path as a WebSocket is bridged to the peer's (`bridge` in `terminal/api.ts`, the one the terminal uses); a name that is no legacy peer may resolve to a package connection instead ([An app's own API](#an-apps-own-api)). |

What changed in the existing modules:

- **Views** (`panel/view.ts`, `panel/widgets.ts`): `AppView` gained `id`; `AppView`, `AgentView`, `WidgetView` and `ServiceView` gained an optional `peer`, apps and widgets an optional `stale`. Ids of peer entries carry the prefix (`david/media`, `david/media/assistant`, `david/media/latest`); `name` and `app` stay the bare names so the web UI can build peer routes from `peer` plus `name`. `icon`, `avatar` and `appIcon` of peer entries are the hub's proxy routes when they were file routes on the peer, and unchanged when they are emoji or absolute URLs. A peer app is never `manifestOnly` on the hub: it cannot be deleted from there.
- **Lists** (`panel/api.ts`, `agents/api.ts`): `GET /api/apps`, `/api/services`, `/api/widgets`, `/api/agents` append the merged peer entries after the local ones, then apply the hub's layout order (`orderBy` puts unlisted local entries before unlisted peer entries) and hidden set. The hub's `hidden` and `order` lists take the prefixed ids, so the operator can hide or reorder a peer app on the hub without touching the peer; `PATCH /api/peers/:peer/apps/:app { hidden }` does the hiding and only touches `panel_kv`. `?all=1` includes hub-hidden peer apps.
- **`GET /api/services`** carries a second list, `peers`: one entry per peer with `health` (`ok` when the last refresh succeeded within two refresh periods, `down` otherwise), `asOf`, `error`, `stale` and counts. `GET /api/peers` returns the same plus `duplicates` and the peer's `id` from its snapshot (absent until the first snapshot, or from an older peer). Apps read it with their app token: it is the key to keep per-peer data under, since the name can change.
- **Widgets**: items widgets come with their payload in the snapshot, so the hub fetches nothing per widget; the peer's cache and `refresh` apply, the hub's snapshot refresh adds at most one period of delay. Embed widgets load through `/api/peers/:peer/widgets/:app/:name/embed`, which streams the peer's proxied page; the iframe sandbox is the same.
- **Chat** (`web/Chat.tsx`): the route base becomes `/api/peers/<peer>/agents/<app>/<agent>` when the agent has a `peer`, else the local one. Everything else is identical: the SSE events, `sessionId`, model and permission mode are the peer's. The hub records nothing in its `chat_sessions` for peer agents; the sessions list is forwarded.
- **App models** (`web/AppModels.tsx`): Settings → Models lists this machine's apps, then each peer's under its name, read from the peer through the hub. An app's page on a peer offers the peer's own choices and saves on the peer, where its calls run. A peer whose core has no such route reads "older core"; one that does not answer shows the error.
- **Create and delete**: unchanged and local. A peer app cannot be created or deleted from the hub.

Proxy routes on the hub, all under `/api/peers/:peer/`, forward to the peer's `/api/peer/` with the bearer and extra headers added and the response streamed back as is (status, `content-type`, body). They accept only the paths in the table above; anything else under `/api/peers/` is 404 on the hub without a call to the peer.

### An app's own API

`GET /api/peers/:peer/apps/:app/proxy/api/*` resolves `:peer` in three steps. A legacy peer of that name (`SPACE_PEER_<NAME>`) wins and is forwarded as above. Otherwise the hub looks for an enabled [package connection](app-packages.md#connection-and-directional-grants) whose Space carries that label, its `SPACE_NAME` or, when it sends none, the first eight characters of its UUID (the `peer` field of its tiles in `GET /api/apps`), and whose last catalogue shares `:app`; the call then travels over that connection's channel as a `fetch` operation, and the owning Space checks its own grant. Otherwise a connection peer of that name ([Adding a peer](#adding-a-peer)) is forwarded like a legacy one, as a `peer` operation that needs the other Space's `apps` scope. This is how ai-usage on a hub pulls a machine that opened a connection to it: it reads `GET /api/apps?all=1`, takes every `ai-usage` entry with a `peer`, and calls this path with its `SPACE_APP_TOKEN`, the same for both kinds of peer.

Over a connection the route keeps the legacy limits (GET only, only the app's `/api/`, 65 s at most, a WebSocket on the same path from the panel's own origin only, bridged over the channel's `socket` operation) and adds a caller rule: the owner may call it, and an app with its own token may reach only the app of the same name on the other side (`ai-usage` to `ai-usage`); any other app's token is 403. The legacy route's caller rule is unchanged. Nothing of the caller's credentials travels: the owning side receives the path, `accept` and a socket's subprotocol, never the caller's `Authorization` or the Space's cookies, and the hub passes back the status, `content-type` and body. A connection that is down or stale answers 502 `{ ok: false, error: "peer <label> unreachable: …" }`; an app the other side no longer grants answers its 403.

## Renaming a peer

A peer's name is only its `SPACE_PEER_<NAME>` line in the hub's `.env`, but the hub keeps its own state under that name. Editing the line by hand makes a new peer: the old name's snapshot and cursor are pruned at the next start, and hidden apps, tile order and ledger rows stay behind under the old name. Rename instead:

```bash
space peer rename OLD NEW         # POST /api/peers/OLD/rename { "to": "NEW" } with the operator token
```

The running hub does it in one step, without a restart: it checks the new name (a peer name that survives the round trip through an env key, not a local app's or another peer's, not `model`), stops the peer's client, and in one `space.db` transaction moves everything it keeps under the name and rewrites the `.env` lines; if any part fails, nothing changes. What moves (`peers/rename.ts`):

| Where | What |
| --- | --- |
| `.env` | `SPACE_PEER_<OLD>` and its `_TOKEN`, `_HEADERS`, `_REFRESH`, renamed in place; `SPACE_CHAT_MODEL` and `SPACE_MODEL_DEFAULT` values that name the peer as their machine (`old:codex/basic`) |
| `peer_snapshots`, `peer_cursors` | the cached snapshot (the apps stay listed while the peer is down) and the event cursor (nothing is mirrored twice) |
| `events.peer` | the origin of the events mirrored from the peer |
| `panel_kv` layout | hidden apps, tile order, widget sizes, hidden widgets and screens: every `old/<id>` |
| `model_calls` | `machine`, backend `peer:old`, and the rows the peer sent here (`old/<app>`) |
| model choices | `old:runtime/tier` in app overrides, chat model choices and the default model preference |
| `bus_calls` | calls forwarded to the peer's apps and the ones it made here (`old/<app>`) |
| `shortcut_patterns`, `shortcut_runs` | rows keyed by the peer |
| `feedback` | the to-do's peer, the run and fix machines, and the fix machine in the settings |
| `usage_*` | opens and time of the peer's entries (`old/<id>`) |

Then a new client starts under the new name from the moved snapshot, and the hub publishes `space/peer.renamed` `{ from, to, id }` ([events.md](events.md#peerrenamed)). `id` is the peer's stable id from its snapshot, `null` for an older peer that sends none.

Not moved: the peer's own `SPACE_NAME` (the name it gives itself, which other hubs and its forwarded callers use), a peer set in the service's environment rather than the workspace `.env` (refused: rename it where it is set), `runtimes.yaml` (it names ssh machines, not peers), and what apps keep under the name: they follow the event.

## Failure and staleness

| Situation | What the panel shows |
| --- | --- |
| Peer answers | Its entries, live health, widget items with the peer's `asOf`. |
| Peer times out or errors | The last good snapshot, apps and widgets muted (`stale`), services `unknown`, the peer `down` with the last `asOf` and the error text; chat, embed and icons on those entries fail with 502 and the error, not a hub guess. Once two refreshes in a row have failed, a bus call to it is answered 503 `peer <name> is down (snapshot N min old)` at once, without forwarding, and `GET /api/capabilities` marks its apps `health: "down"` ([events.md](events.md#across-machines-peers)). |
| No good snapshot ever (new peer, wrong token) | The peer only, `down`, with the error (`token rejected` for a 401). Nothing invented. |
| Peer's tunnel has no connector (the machine asleep or offline, its `cloudflared` stopped) | As for an error; Cloudflare answers 530 with its own code, and the error names it: `tunnel not connected (Cloudflare 1033)`. The hub asks peers with `Accept: application/json`, so Cloudflare answers that 530 as JSON and the 1033 code is kept (for Bun's default `*/*` it sends an HTML page instead). A 502 instead is the tunnel up and the peer's service not answering. |
| Peer removed from `.env` | Its entries disappear on the next boot; its layout keys stay in `panel_kv` harmlessly, like a deleted app's. Its `peer_snapshots` row is deleted at boot. |
| Hub restarted while a peer is down | The stored snapshot, `stale` and `down`, until the first refresh succeeds. Until two refreshes have failed, a bus call is still forwarded: the hub does not yet know the peer is down. |

A snapshot is refreshed in the background on its own timer, never on a browser request, so a slow peer costs the panel nothing; a request always reads the cache.

## Trust boundary

A connection peer does not hold that credential. The peer grants the hub [scopes](app-packages.md#peer-scopes) on its own connection row, each `/api/peer/*` route needs exactly one, and the hub's requests carry no credential of the hub's callers (no `Authorization`, no cookie) and bring back no cookie of the peer's. Full trust is the equivalent of handing the hub `SPACE_HUB_TOKEN`; the panel scope alone is a read-only listing. What follows describes the token, and full trust.

The hub's panel routes carry no token (see [panel.md](panel.md)); the peer routes are the first bearer-guarded read surface, because they are meant to cross machines. What the token grants is exactly what the peer's own panel grants through its tunnel: read the app list, load pages and icons, and open a chat, including with `bypassPermissions`, which is a shell on the peer as the peer's user. The hub therefore holds, in its `.env`, a credential worth a shell on every peer; treat the hub's workspace accordingly. A peer that wants to limit this sets no `SPACE_HUB_TOKEN` and is listed on the hub as a link app instead.

**The adopt route** (`POST /api/peer/connections/adopt`, [Moving a legacy peer](#moving-a-legacy-peer)) is the one thing the token can do that it could not before, and it is kept to what the token is already worth. A holder of `SPACE_HUB_TOKEN` can make this Space open an outgoing connection to an origin of its choice (HTTPS, or HTTP on loopback) and grant the Space there full trust. The channel's handshake binds that grant to one Space id, the one the caller names: the server at that origin must answer with it and accept the token the caller gave, or no channel opens. The route touches only the connection to that Space id: it creates one, or, for one it made itself (its credential variable is the route's), writes a new token, makes it again at a new address and raises it back to full trust. A connection it did not make is changed only when this Space lists the caller as a peer of its own (two hubs that list each other), and then only raised to full trust; any other is refused with 409, and nothing is ever disabled, enabled, removed or renamed. Over a connection the route does not exist. What full trust gives is what the token gives (a chat with `bypassPermissions` is already a shell), so nothing is widened in kind; what differs is **lifetime**: a connection outlives the token. Rotating or removing `SPACE_HUB_TOKEN` does not end a connection made through it, so after rotating it check `space connection ls` on this machine and remove the connections you did not make (each adopt is logged: `[peers] adopt: hub <id> at <url>: connection <id> created`).

Chat forwarding passes the request body through unchanged, so the hub's access layer decides who may chat, and the peer's token check decides which machine may ask. Neither side logs message text.

The app proxy reaches a peer app's `/api/` paths without the app's own login, GET and WebSocket only. On the hub it carries no token, like the panel routes: an app's server calls it over loopback, and a WebSocket from a browser is accepted from the panel's own origin only (a socket is not covered by the cross-site write guard, and a page on another site could otherwise open one through the operator's browser). What an app exposes under `/api/` to GET and to sockets is therefore readable by every app on the hub; an app that needs more than that checks a credential of its own. Over a package connection it is readable only by the owner and the hub's app of the same name, and only while the other Space grants the app ([An app's own API](#an-apps-own-api)).

A peer that enables its terminal ([terminal.md](terminal.md)) offers it to the hub under the same token: the hub's browser opens a session with two forwarded requests and the hub bridges the socket. The peer keeps every rule of its own terminal (same-origin is satisfied by the hub's forward, the ticket is the peer's, the passphrase is the peer's and is typed on the hub's page, the idle limit and cap are the peer's, the audit row is written on the peer). A peer that wants a hub to list it but not to open a shell leaves the terminal off; the hub then shows the machine as off in the picker and nothing else changes.

## Web UI

- Tile: looks like a local one; the hover card says "On <peer>", and while the peer is down the tile is muted and the card says so.
- Agents list: peer agents after local ones, same hover-card line; an agent that runs on several machines is one tile ([below](#agents-on-several-machines)).
- Widgets: a peer chip in the card head; muted while stale.
- Settings: a Peers section above Services when at least one peer is configured, one row per peer (name, health, snapshot age when down; the tooltip has the URL, counts and the error), then the Services rows with a peer chip on remote ones.
- Edit mode: hide works on peer entries (hub-side), delete is not offered.

## Agents on several machines

An app deployed on this machine and on peers declares the same agents under the same `app/name` on each, and `GET /api/agents` lists every machine's (`space-ops/engineer`, `david/space-ops/engineer`, …). The panel groups them (`src/web/agent-groups.ts`): one tile, library entry, chat-sidebar entry and phone avatar per `app/name`, under the local variant (else the first peer's), with the hover card listing the machines ("On this machine, david, eric"). The chat header gets a Machine menu when there is more than one; it switches to that machine's variant, and each machine keeps its own conversation, sessions and runs under its own id, since a chat turn runs where the app lives. The choice is remembered per agent in the browser and is where the tile opens next time. A layout pinned before (one `agent:` key per machine) is pointed at the group's key and stored on load, so it shows the agent once; the layout ids themselves do not change, and the Mac and phone clients still list every machine's entry until they group too.

The space agent is one of these: every peer's `space/assistant` is in its snapshot, so Space Assistant gets the same Machine menu and can be asked on any machine; it then runs there, in that machine's workspace, with that machine's runtimes and the permission mode picked in the chat. This adds nothing the peer token did not already allow (it reaches every agent's chat). A peer agent carries `stale: true` while its machine does not answer: the menu shows the machine as offline and it cannot be picked, the hover card says so, a remembered offline machine is not where the tile opens (the choice is kept for when it answers again), and an open chat on it shows a note and does not send. Each machine in the menu names the agent CLIs it has, installed and signed in, from the inventory ([model-machines.md](model-machines.md#inventory)).

## Migration from link apps

A peer app whose `url` is already on the panel (a local app's, or an earlier peer's) is not listed: it opens the same page, so one tile is enough, and the same holds for a widget card whose `link` is already there. This is how an app deployed on several machines that share their data (the usage dashboard) shows once wherever the panel is: every machine sets `SPACE_APP_URL_<NAME>` to the one hostname. A link app on the hub whose `url` equals a peer app's `url` is likewise the one listed, and `GET /api/peers` reports these under `duplicates`; the operator deletes the link apps from the panel. The hub does not delete them itself: a link app may be there on purpose (a different title, a public page of an app whose service is elsewhere).

## Deploying a peer

Over a connection, the steps are those of [Adding a peer](#adding-a-peer), after step 1 below; steps 3 and 4 are not needed. The legacy way:

1. Install ai-space on the second machine as a user unit (`deploy/install.sh`), workspace `~/.ai-space`, apps under `apps/` as on any machine.
2. In its `.env`: `SPACE_HUB_TOKEN` (random) and `SPACE_NAME`.
3. Publish its port on a hostname of the machine's tunnel; exempt `/api/peer/*` from the access layer or note the layer's service credentials. A machine with no tunnel can keep an SSH reverse tunnel to the hub's machine instead (`ssh -N -R 127.0.0.1:8711:127.0.0.1:8700 hub`), and the hub uses `http://127.0.0.1:8711`; the Linux app sets this up, with steps 2 and 4, in Settings › Peer ([linux-desktop.md](linux-desktop.md#peer)). A Mac runs `cloudflared` from a LaunchAgent that restarts it, and sleeps unless told not to: [install.md](install.md#5-cloudflare-tunnel-and-dns), *On a Mac*.
4. In the hub's `.env`: `SPACE_PEER_<NAME>`, `_TOKEN` and, if needed, `_HEADERS`; restart the hub. `GET /api/peers` shows `ok` and the counts, or the error.
5. Delete the link apps listed under `duplicates`.
6. Backups: give the peer the same `SPACE_S3_*` credentials (or its own bucket). Its snapshots land under `backups/<SPACE_NAME>/`, apart from the hub's; never point two machines at one prefix, since both have a `space` app and may share app names. See [backup.md](backup.md#several-machines).

## Later

- **Peer tasks**: `GET /api/peer/tasks` and `/api/peer/tasks/:id/runs`, read-only, so the Tasks drawer groups tasks by machine. Running or toggling a task stays on the machine that owns it.
- **Peer storage inventory** in the settings, read-only.
- **Peer deliveries**: a peer's http or stream subscription to an event that only reaches the hub. Today each machine subscribes to what reaches its own bus; events flow peer → hub only.
- **Peer notifications**: none needed; each machine notifies through its own channels. Backups likewise: each machine snapshots its own data under its own prefix; the hub's Backups list shows local apps only.
- **Retiring `SPACE_PEER_*`**: a peer behind no tunnel is now a [connection peer](#adding-a-peer), and `space peer migrate` moves a legacy one onto a connection ([Moving a legacy peer](#moving-a-legacy-peer)). Once every machine has moved: removing the HTTPS peer routes, `SPACE_HUB_TOKEN`, the adopt route with them, and what `setup peers` configures.

## Without a peer

An app that runs on a machine with no ai-space, or on a peer that sets no `SPACE_HUB_TOKEN`, is registered on the hub as a manifest-only link app (`apps/<name>/space.yaml` with identity fields and `url`; see [panel.md](panel.md) and the `link` mode of the `space-app` skill). It gets a tile and, with a public `source` URL, widgets; no health and no chat.
