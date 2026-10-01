# Events and calls between apps (the bus)

Status: implemented in `src/space/bus/` (spec, store, engine, routes, the agents' prompt section, external consumers) on top of the scheduler's events (`docs/scheduler.md`); peers mirror events and forward calls (`src/space/peers/`); the panel has an Events window (`src/web/Events.tsx`).

The bus is the Space-layer service that carries what one app has to tell another. An app publishes an event and never learns who listens; other apps declare what they consume and how they want it delivered. An app that needs an answer from another app calls a capability the other app declared, through ai-space, which forwards the request and records it. Both directions go through one process on loopback, so no app holds another app's address or token.

## Why

Before the bus, every link between two apps was a private contract: the producer knew the consumer's URL and carried a push token for it, the consumer validated that token, both retried in their own way, and nothing in the space could say whether a message had arrived. Adding a third consumer meant changing the producer. `POST /api/events` already existed, but its events had one purpose, starting a task, and a task that failed lost them.

What an operating system offers here is a bus (D-Bus, Binder, XPC): named services, signals anyone can subscribe to, methods anyone allowed can call, an introspectable catalogue, and a policy layer. The bus is that shape on HTTP, plus two things those buses lack and this space needs: deliveries are persisted and retried, because apps restart and pause, and the same model will extend across machines through peers.

## Model

Three kinds of traffic:

| Traffic | Direction | Waits for an answer | Declared by |
| --- | --- | --- | --- |
| Event | producer → every subscriber | no | the consumer, under `events.consumes` |
| Call | caller → one provider | yes | the provider, under `provides` |
| Catalogue | anyone → ai-space | yes | derived from the two above |

An event is what the scheduler already stores: `<app>/<name>`, a JSON `data` object of at most 64 KB, and a time. It is kept for `SPACE_EVENTS_RETENTION_DAYS` (default 30; at most 50 000 rows) rather than the previous 2000-row window, so a delivery or a run can always be read next to the event it carried.

A delivery is one event on its way to one app by one method. It has a status (`pending`, `sent`, `ok`, `dead`, `skipped`), an attempt count, the next moment it needs attention, and the last error. Deliveries are the truth about "did app X get event Y"; the panel and the replay route read them.

A capability is one HTTP entry point on an app's service that other apps may call by name: `<app>/<capability>`.

## Declaring

```yaml
events:
  publishes:                                    # documentation; the catalogue and agents read it
    - name: digest.added
      description: A video got its transcript and digest.
      example: { id: abc123, channel: Weekly Review, title: "…" }
  consumes:
    - event: video-digest/digest.added          # task: the scheduler's triggers (coalesced, debounced)
      filter: { channel: Weekly Review }
      task: import-weekly
      debounce: 5m
      maxWait: 30m                              # default 2 x debounce
    - event: feed/item.added                    # http: one POST per event to the app's own service
      http: { method: POST, path: /api/ingest }
    - event: portfolio/*                        # stream: the app reads GET /api/events/stream

provides:
  research:
    description: Research a symbol and return a verdict with a report link.
    http: { method: POST, path: /api/research }
    timeout: 2m                                 # default 60s, at most 15m
    callers: [portfolio, thesis]                # default: every app on this space
```

`consumes[].task` is the same thing as `tasks[].triggers`, written next to the other subscriptions; ai-space merges it into that task's triggers. `debounce` and `maxWait` are only for tasks: http and stream deliver every event. Event names and filters follow the scheduler's rules (exact name or `<app>/*`, string equality on top-level `data` fields, no expressions).

## Delivery

Every stored event passes through the bus once. For each app whose `consumes` matches it (http and stream kinds; task kinds are the scheduler's) one delivery row is written. Two subscriptions of one app landing on the same target deliver once.

**http.** A worker POSTs to `http://127.0.0.1:<port><path>` on the app's declared service, with headers `x-space-event`, `x-space-event-id`, `x-space-delivery-id`, `x-space-delivery-attempt` and this body:

```json
{ "delivery": { "id": 12, "attempt": 1 },
  "event": { "id": 8, "name": "video-digest/digest.added", "app": "video-digest", "at": "2026-09-22T10:00:00.000Z", "data": { "id": "abc123" } },
  "events": [ { "…the same event…" } ] }
```

A 2xx ends the delivery (`ok`). A 5xx, 408, 425, 429 or a connection error retries after 3 s, 10 s, 30 s, 1 min, 5 min, 10 min, 10 min; the eighth failure makes it `dead`. Any other 4xx is final at once: a 400 will not fix itself by retrying. One attempt times out after 30 s. Deliveries to one app go in order, one at a time: one waiting for its retry holds back the app's later ones, so a delivery that keeps failing holds the app's queue for about 27 minutes before it goes `dead`. Different apps go in parallel.

**stream.** The app holds `GET /api/events/stream` open with its `SPACE_APP_TOKEN`. Each delivery arrives as one server-sent event (`event: delivery`, `id: <delivery id>`, `data: <the body above>`); the app answers `POST /api/events/ack { "delivery": 12 }`. Deliveries for an app that is not connected wait as `pending` and are pushed when it connects, oldest first. A pushed delivery not acked within 5 minutes goes back to `pending` and is pushed again on the next connection; after eight such rounds it is `dead`. Keepalive comments go out every 20 s.

**task.** The scheduler's triggers, unchanged in shape: matching events queue on the task, the task runs once for the batch after the debounce. New with the bus: a run that fails with events aboard puts them back in front of the queue, due after the task's error backoff (30 s, 1 min, 5 min, 15 min, 1 h), up to five failed runs; then they are dropped and the drop is logged. A task that also keeps a clock schedule takes the redelivered events along on its next clock run if that comes first.

**dead.** When the bus gives up on a delivery, the app's notify channel gets one alert (keyed per app and event name, one per hour), the same way a failing task does. The operator can queue it again with `POST /api/deliveries/:id/retry`.

**skipped.** The event was pruned before delivery, the app left the space, or it has no service port: recorded, not retried.

Guarantees: at-least-once, in order per app and kind, none across apps. Consumers dedupe on the event id or on an id inside `data`; the `x-space-delivery-attempt` header (and `delivery.attempt` in the body) says when a request is a retry.

## Calls

```
POST /api/call/insight/research
Authorization: Bearer ${SPACE_APP_TOKEN}          # the caller's own token
Content-Type: application/json

{ "symbol": "BTC", "question": "…" }
```

ai-space identifies the caller from the token, checks that `insight` provides `research` and that the caller is allowed, forwards the request to `http://127.0.0.1:<insight's port>/api/research` with the method the capability declared, the caller's `content-type` and `accept`, and two headers the provider trusts: `x-space-caller: portfolio` and `x-space-capability: research`. Whatever the provider answers, status, content type and body, comes back unchanged, with `x-space-call-id` and `x-space-call-ms` added. Every call lands in the `bus_calls` table (caller, app, capability, status, duration, error) and in `GET /api/calls`.

Errors the bus itself answers: 401 no valid token, 404 unknown app or capability, 403 the caller is not in `callers`, 503 the provider has no service port, 504 no answer within the capability's timeout, 502 unreachable or an answer cut off mid-body (recorded as a failed call either way), 413 a body over 4 MB.

A provider only has to trust requests that come from loopback and carry `x-space-caller`; it no longer hands out push tokens. The operator token calls as `space`.

## Catalogue

`GET /api/capabilities` lists, per app, what it provides (with description, method, path, timeout, callers), what it publishes (with description and example) and what it consumes, plus call counts, failures and mean duration per capability. Peers' apps follow under `<peer>/<app>` with a `peer` field. This is what an agent reads to learn that "save this link" is `keep/save-link`, and what a new app reads to find which events exist.

Every agent chat session gets a condensed copy as the last section of its system prompt (`src/space/bus/prompt.ts`): one line per capability and per published event, with the `curl` for a call and for publishing, capped at 6 000 characters. An app's agent calls with its `SPACE_APP_TOKEN`, the space agent with the operator's `SPACE_API_TOKEN`.

## Storage

Three tables in `space.db` next to the scheduler's: `bus_deliveries` (event id and name, app, kind, method and path, status, attempts, next due time, last error and status, sent and ended times), `bus_calls`, and `bus_consumers` (external consumers: name, subscriptions and calls as JSON, the credential's hash and hint, created, rotated and last-seen times). Finished deliveries beyond 20 000 rows and calls beyond 5 000 are dropped on insert; a pending delivery is never dropped by the cap. A delivery keeps its target on the row, so it is still attempted after a restart or after the app changed its manifest; what it needs from the event it reads by id, and an event pruned by the retention makes the delivery `skipped`.

What an app publishes, consumes and provides is not stored: it comes from the manifest on every sync, like tasks. External consumers are stored, since no manifest declares them, and loaded into the bus on boot.

## API

```
POST /api/events                          publish (scheduler; unchanged)
GET  /api/events?limit&name&app           recent events (unchanged)
GET  /api/events/:id                      one event with its deliveries
GET  /api/events/stream                   the app's stream deliveries as SSE (app token, or an external consumer's)
POST /api/events/ack                      { delivery } (app token, or an external consumer's)
GET  /api/deliveries?app&status&limit     deliveries, newest first
POST /api/deliveries/:id/retry            queue a dead or skipped delivery again (operator token)
GET  /api/capabilities                    the catalogue
POST /api/call/:app/:capability           forward as the calling app
GET  /api/calls?app&caller&limit          call history
GET  /api/consumers                       external consumers (operator token; below)
POST /api/consumers                       create one; the credential is in the answer, once
GET  /api/consumers/:name                 one, with delivery counts
POST /api/consumers/:name/rotate          a new credential
DELETE /api/consumers/:name               revoke
```

## Migrating a point-to-point link

Before: Pulse holds Insight's URL and a push token, POSTs each clue to `insight/api/leads`, retries by itself; Insight validates the token.

After:

```yaml
# pulse/space.yaml
events:
  publishes: [{ name: clue.found, description: A clue distilled from the news feed. }]
# insight/space.yaml
events:
  consumes: [{ event: pulse/clue.found, http: { path: /api/leads } }]
```

Pulse's code changes from "call Insight" to `POST ${SPACE_API_URL}/api/events`; Insight's `/api/leads` replaces the token check with "loopback and `x-space-event-id` present" and dedupes on that id. A third app that wants the clues adds one `consumes` line; Pulse does not know.

When Portfolio needs Insight to research a symbol and wants the verdict back, that is a call, not an event: Insight declares `provides.research`, Portfolio POSTs `/api/call/insight/research` and reads the answer.

## Across machines (peers)

A hub ([peers.md](peers.md)) mirrors every event its peers publish: after each snapshot refresh it asks `GET /api/peer/events?since=<cursor>` for what is new, publishes each one here under the same app name with `peer: <name>` and the original time, and advances the cursor (kept in `peer_cursors` in `space.db`). Subscriptions on the hub then match a peer app's events exactly as a local app's: `consumes: [{ event: pulse/clue.found }]` works whether Pulse runs here or on a peer. Only events published on the peer itself are exported (mirrored ones are not), so a hub that is also someone's peer never passes events on twice, and a peer whose ids went backwards (a rebuilt database) restarts the cursor at its newest id. Latency is the peer's refresh period (30 s by default).

A call to an app the hub does not hold is forwarded to the one peer whose snapshot lists that capability, through `POST /api/peer/call/<app>/<capability>`; the peer's bus runs it as the caller `<hub name>/<app>` (a provider that restricts `callers` must list that form to accept remote callers). Two peers holding the same app is an ambiguity the hub refuses (409); `POST /api/call/<peer>/<app>/<capability>` names the peer. Both sides record the call. Deliveries stay on the machine that made them: a peer's http subscription to a hub event is not a thing, the peer subscribes to what reaches its own bus.

## The panel

The settings' Events window lists the catalogue (what each app, and each peer's app, provides, publishes and consumes, with call counts) and the last hundred events; a row opens to its http and stream deliveries with their status, attempts and last error. It is read-only like the Tasks window: replaying a dead delivery needs the operator token.

## External consumers

An external consumer is a program that is not a Space app, usually on another device, that needs to hear about some events and read a little data in answer. The first case: a machine elsewhere keeps a copy of asset groups and wants to know when one changes. asset-center publishes `asset-center/group.changed` with `{ groupId }`, coalesced over about two seconds; the event is a hint to re-read, not the change itself, and the consumer answers it by calling `asset-center/group-members` with `{ groupId, detail: true }`.

Apps cannot serve this: a subscription exists only in an installed app's `space.yaml`, its identity is that app's `SPACE_APP_TOKEN`, and that token is not read-only (it publishes, calls every capability, runs models), so it must never leave the machine. An external consumer is therefore its own resource, made by the operator, independent of any app's installation.

### What one is

| Field | Meaning |
| --- | --- |
| `name` | 1-63 letters, digits, dots, dashes, underscores. Its deliveries and calls appear as `consumer:<name>`, a form no app name can take. |
| `subscriptions` | Events it receives: `{ event, filter? }`, the same rules as `events.consumes` (exact name or `<app>/*`, string equality on top-level `data` fields). At most 50. |
| `calls` | Capabilities it may call: `{ capability: "<app>/<capability>", filter? }`. The filter is checked against the top-level fields of the JSON request body, the way an event filter is checked against `data`: `{ groupId: [g1, g2] }` lets it read those groups and refuses any other. At most 20. |
| credential | `sec_` + 32 random bytes, shown once when created and once on each rotation. Only its SHA-256 is stored, with the first characters as a hint (`sec_AbC12x…`). |

The credential is accepted by exactly three routes, and by nothing else in the API (every other route answers 401 to it):

- `GET /api/events/stream`: the consumer's own deliveries.
- `POST /api/events/ack`: acks of its own deliveries (another consumer's or an app's delivery is a 404).
- `POST /api/call/<app>/<capability>`: only the capabilities on its list, only with a body the entry's filter accepts; anything else is a 403 before the provider sees the request. The provider gets `x-space-caller: consumer:<name>`; a capability that restricts `callers` must list that form. A call naming a peer (`/api/call/<peer>/...`) is refused; an unprefixed call still reaches a capability that only a peer provides, as for apps.

The operator decides what a consumer may call and must list only read-only capabilities: the bus cannot tell a read from a write. Subscriptions and calls are fixed at creation; to change them, remove the consumer and add it again.

### Managing

```
space consumer add hub-sync --event asset-center/group.changed --filter groupId=g1,g2 \
  --call asset-center/group-members --description "office NAS mirror"
space consumer ls
space consumer show hub-sync          # subscriptions, calls, delivery counts, open streams, last seen
space consumer rotate hub-sync --yes  # new credential; the old one and its streams end at once
space consumer rm hub-sync --yes      # revoke
```

`--filter` applies to every `--event` and every `--call` of the command, so the groups a consumer hears about are the groups it may read. Other shapes go as JSON: `space consumer add '{"name": …, "subscriptions": […], "calls": […]}'`, `-` or `--json-file`. The routes (operator token):

```
GET    /api/consumers                 list (never the credential)
POST   /api/consumers                 { name, description?, subscriptions, calls } → 201 { consumer, token }
GET    /api/consumers/:name           one, with delivery counts and open streams
POST   /api/consumers/:name/rotate    → { consumer, token }
DELETE /api/consumers/:name           revoke
```

Removing and rotating take effect at once: the bus closes the consumer's open streams, and the next request with the old credential is a 401. Removing also ends what still waited for the consumer as `skipped` ("consumer removed").

### Delivery

A consumer's deliveries are ordinary stream deliveries in `bus_deliveries` with `app = consumer:<name>`, so they have the same semantics as an app's stream: written when the event is stored, persistent across restarts, pushed when the consumer connects (oldest first, at most 500 per connection) and live while it is connected, back to `pending` when not acked within 5 minutes, `dead` after eight rounds, `skipped` when the event was pruned by `SPACE_EVENTS_RETENTION_DAYS` before the consumer came for it. A dead delivery raises one alert on the space's own notify channel. At most 4 streams per consumer at once (the fifth is a 429), and at most 5 000 deliveries waiting for one consumer: beyond that the oldest are skipped, so an abandoned consumer cannot grow the table.

What a consumer must do itself:

- **Dedupe.** Delivery is at-least-once. The same delivery comes again (same `delivery.id`, higher `delivery.attempt`) when an ack was lost or late. Key on `event.id` (one event, one delivery per consumer) or on `delivery.id`.
- **Ack after the work.** Ack once the re-read is done; a consumer that crashes before acking gets the delivery again.
- **Reconcile.** There is no exactly-once and no `Last-Event-ID` replay: the SSE `id:` is the delivery id, informational only, and a reconnect is served from the delivery rows, not from an offset. Events pruned before the consumer came back are gone. So the consumer re-reads everything it mirrors when it starts, after every reconnect, and periodically (an hour is plenty), and treats events as hints that make a re-read sooner. A `404` from `group-members` means the group was deleted: drop the local copy.

### Reaching it from another device

From outside, the API is behind the operator's tunnel and access layer ([ingress.md](ingress.md)). Give the device an Access service token (the same kind a hub uses for a peer, [cloudflare.md](cloudflare.md)) and send its headers with every request, in addition to the consumer credential. The access layer admits the device to the API host as a whole, and the read routes that carry no token (the panel's) are open to anyone past it; scope that Access application or policy as narrowly as the operator's setup allows. On a space without `SPACE_API_TOKEN` (loopback only) the operator routes need no token, so anything that can reach the API can manage consumers: set the token before exposing the API.

### A minimal client

```sh
API=https://space.example.com
AUTH=(-H "Authorization: Bearer $SEC_TOKEN" -H "CF-Access-Client-Id: $CF_ID" -H "CF-Access-Client-Secret: $CF_SECRET")

# Re-read everything on start (and after each reconnect)
for g in g1 g2; do
  curl -s "${AUTH[@]}" -H 'content-type: application/json' \
    -d "{\"groupId\":\"$g\",\"detail\":true}" "$API/api/call/asset-center/group-members"
done

# Then follow the stream: one `data:` line per delivery
curl -sN "${AUTH[@]}" "$API/api/events/stream" | while IFS= read -r line; do
  case "$line" in
    data:*)
      body=${line#data: }
      group=$(jq -r '.event.data.groupId' <<<"$body")
      delivery=$(jq -r '.delivery.id' <<<"$body")
      curl -s "${AUTH[@]}" -H 'content-type: application/json' \
        -d "{\"groupId\":\"$group\",\"detail\":true}" "$API/api/call/asset-center/group-members" >"group-$group.json"
      curl -s "${AUTH[@]}" -H 'content-type: application/json' -d "{\"delivery\":$delivery}" "$API/api/events/ack" >/dev/null
      ;;
  esac
done
```

A real client wraps the stream in a reconnect loop with backoff, re-reads on every reconnect, keeps the processed event ids for a while, and handles the 404 of a deleted group.

### Not yet

- **Webhooks.** Pushing to a URL on the consumer's side (signed, retried) would spare it a long-lived connection; it needs outbound reachability, signing and per-URL retry state, and is a follow-up.
- **Editing in place.** Changing a consumer's subscriptions or calls means removing and adding it (a new credential).
- **Per-consumer rate limits on calls.** Calls are recorded in `bus_calls` under `consumer:<name>` and the consumer's last contact is kept, which is the audit; there is no call quota yet.

## When not to use it

A high-frequency feed with one consumer that may drop ticks (one-second candles to a trading signal) belongs on a WebSocket between the two apps. The bus is for events that must arrive, to consumers that come and go, and for calls that should not require every provider to manage its own callers.

## Failure modes considered

| Situation | Behaviour |
| --- | --- |
| Consumer's service is down when the event arrives | http: retried over about 27 minutes, then dead and one alert. stream: waits as pending until the app connects. task: the scheduler's rules. |
| Consumer answers 400 | Dead at once, alert; the operator fixes the consumer and retries the delivery. |
| ai-space restarts with deliveries in flight | Rows are `pending` with their next due time; the worker picks them up on start. A request that was answered 2xx just before the crash is attempted again: at-least-once. |
| Event pruned before a stream consumer connected | `skipped` with the reason; the consumer that connects after 30 days missed it. |
| One app subscribes twice to the same event with the same target | One delivery. |
| A capability's timeout passes | 504 to the caller, the call recorded as failed; the provider's own request is aborted. |
| Provider answers 500 | Passed through as 500; recorded as failed; the bus never retries a call, the caller decides. |
| Manifest names a `consumes.task` that does not exist | Whole app rejected at sync, like any manifest error. |
