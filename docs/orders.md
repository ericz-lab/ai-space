# Orders: a spoken order handled by a built-in Director, who may delegate

Status: proposal. Nothing here is implemented. It builds on [panel.md](panel.md) (agent runs, sessions, approvals, steering), [runtimes.md](runtimes.md) (what a live turn can do per runtime), [events.md](events.md#capture) (capture targets), [macos-desktop.md](macos-desktop.md#voice-input) (the capture key and its screenshot) and [peers.md](peers.md) (agents on other machines). It replaces a path that today runs through three apps: `decree`, `hive` and `agent-org`.

## Problem

The person holds a key, says one sentence, and expects someone to deal with it. Today that sentence crosses seven steps:

1. The Mac client posts the words (and a screenshot) to the Space's capture route.
2. The Space forwards them to the `decree` app, which stores them and publishes `decree.issued`.
3. The hub mirrors the event from the Mac to the machine where `hive` lives.
4. `hive` asks a model which topic the order belongs to, then calls back to the Mac to fetch the screenshot.
5. `hive` reads `agent-org`'s roster to find the Director.
6. `hive` calls the Director's agent route, which is forwarded back to the Mac because the Director runs there.
7. `hive` reports each status change to `decree` through a bus call.

Steps 2 to 5 and step 7 only pass the order along. Each one is a place to fail (an event not mirrored, a picture not fetched, a report not delivered), each app keeps its own copy of the order, and a second `hive` had to be installed on the Mac only so that the Director could run there. What the person sees is split over two pages: the order's state in `decree`, the conversation in `hive`.

The parts that do real work already belong to the platform: the agent run, its session, approvals, steering, stop, images in a turn, and the run events the panel draws. This proposal moves the remaining parts into the platform as well, so that an order is two steps: the client posts it, and a turn starts.

## Shape

```
Mac client (hold right ⌥)
   │  POST /api/capture/image|text?to=space/order      words + screenshot
   ▼
ai-space on that machine
   ├─ orders: store the order, pick or open its topic        (one model call)
   ├─ a turn of the built-in agent space/director on the topic's session
   │     ├─ answers itself, or asks the person, or
   │     └─ delegates: starts a run of another agent, may add to it or stop it
   └─ panel page "Orders": topics, state, screenshot, approvals, delegations
```

Two features, specified below in this order:

- **Orders**: a built-in capture target, the order store, topics, the built-in Director, the panel page.
- **Delegation**: an agent starts a run of another agent, may add a message to it while it runs, may stop it, and gets the result back in its own session. The Director is its first user, but it is a platform feature of its own.

## What stays where it is

- A chat turn still runs on the machine where its agent lives ([model-machines.md](model-machines.md#the-rule)). The Director lives on the machine that receives the order.
- Adding a message to a running turn and stopping a turn are the runtimes' own functions (Claude Code's stdin message and `interrupt`, Codex's `turn/steer` and `turn/interrupt`); the platform already wraps them as `POST …/runs/:id/steer` and `…/stop` ([panel.md](panel.md)). Delegation calls those. It adds no mechanism of its own for either.
- `hive` and `agent-org` remain ordinary apps (a group chat of agents, an organisation chart). They are no longer on an order's path.

## Orders

### The capture target

`GET /api/capture` lists one more target on every Space, in both `targets` and `textTargets`:

```json
{ "id": "space/order", "app": "space", "capability": "order", "title": "Orders", "i18n": { "zh": { "title": "口谕" } }, "kinds": ["text", "image"] }
```

Today a target is always an app's capability (`captureTargets` in `src/space/bus/api.ts` reads `bus.capabilities()`), and the app name `space` is reserved. The platform's own target is added beside that list, and `forwardToTarget` hands a request for `space/order` to the orders service in process instead of to the bus. A peer's `space/order` is offered as `<peer>/space/order` and forwarded like any other target.

The request is the existing one, unchanged: JSON `{ text, via?, id }` on the text route, or multipart `file`, `text`, `via`, `id` on the image route (a picture without words is refused with 400, as `decree` does today). `id` is the client's UUID; a repeated `id` answers the first order. The answer is `{ ok, url, label }` with `url` the order's place in the panel and `label` "Order #12".

**The client needs no code change.** It already lists targets, sends through the image route when the target takes both kinds, and falls back to the text route. The only difference is which target the person picks in Settings; `space/order` becomes the default when the Space offers it and nothing was chosen.

The Orders page also takes a typed order (and a pasted picture), through the same service.

### Data

Tables in `space.db`, in a new `src/space/orders/store.ts`, following the existing pattern (shared handle, `CREATE TABLE IF NOT EXISTS`, additive `ALTER TABLE` migrations):

| table | holds |
| --- | --- |
| `order_topics` | `id`, `title`, `session_id` (the Director's session), `created_at`, `last_active_at`, `state` (see below), `archived` |
| `orders` | `id`, `client_id` (the UUID, unique), `topic_id` (null until sorted), `text`, `via`, `image_path`, `image_mime`, `image_bytes`, `created_at`, `run_id` (the turn that took it), `routed_by` (`model`, `fallback`, `person`) |

The screenshot is a file under `<workspace>/data/orders/images/`, never a blob in SQLite; deleting an order deletes its file.

Two existing limits must make room:

- `chat_sessions` keeps the last 10 sessions per agent (`sessions.ts`). A session that an unarchived topic points at is exempt.
- `agent_runs` keeps 200 finished rows. That is enough for the page (the transcript is read from the runtime's own store), so it is unchanged.

### Topics

One topic is one session of the Director, so each topic has its own context. For every order the service decides: continue a topic, or open one.

- **Candidates**: unarchived topics active within the last N days, most recent first, at most 20. N is a setting (`orders.topicDays`, whole days 1 to 30, default 3), editable on the Orders page.
- **Decision**: one plain model call through the model service (a new tag `orders.topic`, default tier `basic`, no tools). The input is the order's words, whether it has a screenshot, and per candidate: title, last activity, whether it is waiting for the person, its last three orders and last three messages, trimmed (the whole prompt at most about 7,000 characters). The answer is one line of JSON: `{"continue": <topic id>}` or `{"new": "<title>"}`.
- **Rules given to the model**: continue only when it is clearly the same matter (a follow-up, a correction, an answer to what the Director asked there); when unsure it is a new topic; a short answer-like utterance goes to the topic that is waiting for the person, the most recent if several.
- **No order is lost**: a failed call, a timeout (60 s), unusable output or an unknown topic id opens a new topic titled from the order's first words (`routed_by: fallback`). An order stored but not yet sorted when the service stops is sorted at start.
- **Correction**: the person can move an order to another topic or to a new one from the page (`routed_by: person`), and rename a topic.

These are the rules `hive` runs today; they move unchanged.

### The built-in Director

A third built-in agent, `space/director`, next to `space/assistant` and `space/ui-fixer`. The precedent is the Fix Engineer: a view function, a branch in `resolveAgent`, and the two places that list built-in agents (`src/space/agents/api.ts`, `src/index.ts`).

- **Prompt**: in `src/space/orders/prompt.ts`, with the capability catalogue appended (`withCatalogue`, as for Space Assistant). It carries the rules the person set:
  - Restate the order in one line, then take exactly one path: handle it (answer a question, research, record a to-do through a capability), delegate it, or ask first.
  - Small things are done or delegated without asking. Ask first when the order touches the platform itself, more than one app, deleting or moving data, a deploy or anything sent outside, spending money, or when the words do not make sense (speech recognition mishears).
  - A screenshot shows what was on the person's screen when they spoke. Use it when the words point at the screen ("this", "here") or it clearly settles the meaning; otherwise ignore it and do not describe it. If the words depend on the screen and the picture does not settle it, ask.
  - A brief for a delegate is self-contained: goal, where, what counts as done, what not to touch, and anything read from the screenshot written out in words.
  - When a delegate's result comes back, check it against the brief and tell the person what was done and what is left. Say only what the record shows.
- **Working directory**: the workspace root (as Space Assistant), so it can read `app-src/` and the platform docs.
- **Runtime and model**: the Space's chat default, changeable on the Orders page.
- **Permission**: no `permissionMode` (the read-only tier). Anything beyond it becomes an approval the person answers on the page.
- **Turns are interactive** (`interactive: true`), which is what makes approvals and steering possible.

The orders service starts a turn in process, the way the feedback service starts the Fix Engineer (`localFixer` in `src/space/feedback/fixer.ts`): it builds the chat request with the order's words, the screenshot as a chat image, and the topic's session id.

**An order for a topic whose turn is still running.** The chat route answers 409 for a busy conversation. The service then adds the order to the running turn with `steer` (the person is adding to what they said, which is what the panel does for a typed message). If the runtime cannot take a message (DeepSeek Harness) or the turn has just ended, the order waits and starts the next turn when this one ends.

### State

A topic's state is computed, not reported by a callback:

| state | when |
| --- | --- |
| `sorting` | an order of it is stored but has no topic yet |
| `working` | a turn of the Director or of a delegate of this topic is running |
| `needs-you` | a run of this topic waits for an approval or an answer, or the Director's last turn ended with a question to the person |
| `done` | the last turn ended and nothing is running or waiting |
| `failed` | the last turn ended in `error`, `timeout` or `interrupted` |

"The Director's last turn ended with a question" is the one thing run state cannot tell. The Director ends each turn with a status line, as it does in `hive` today (`〔状态: needs-you〕`, hidden from the page); the service reads it. A missing line counts as `done`.

### The page

A new built-in page `orders` (the places a built-in page touches: `src/web/screens.ts`, `panel-link.ts`, `App.tsx`, `Library.tsx`, `i18n.ts`):

- Left: topics, most recently active first, each with title, last activity and a mark for `needs-you` or `working`; a count of orders being sorted.
- Right: the topic's conversation, drawn by the existing chat view (`src/web/Chat.tsx`) on the Director's session, so approvals, questions, steering and stop work as in any chat. Each order shows its label, time and screenshot thumbnail.
- A box to type an order; settings for the look-back days, the Director's model, and the team (below).

Opening `url` from the client's confirmation lands on the order.

## Delegation

An agent hands a piece of work to another agent, may add to it or stop it, and hears back when it ends. It has only these two controls over a running delegate, by the person's decision: **stop** and **add a message**. A change of direction is a stop followed by a new delegation.

### What a delegate may be

A setting lists who may be delegated to (`orders.team`, edited on the Orders page):

```json
[
  { "role": "engineer", "agent": "product-desk/developer", "permissionMode": "acceptEdits" },
  { "role": "designer", "agent": "ai-design/designer" }
]
```

Each entry names an agent of this Space (phase 2: or `<peer>/<app>/<agent>`), an optional model, and the permission mode its delegated runs get. The roles and their agents' descriptions are written into the Director's prompt. An agent not on the list cannot be delegated to. This replaces the roster `hive` reads from `agent-org`.

### Who may call

Delegation is offered to an agent's run, not to an app token and not to the browser. When the platform starts a turn of an agent that may delegate (today only `space/director`), it puts `SPACE_RUN_TOKEN` in the turn's environment: a secret tied to the agent and its session. The delegation routes accept only that token.

- It can create delegations, and read, add to or stop the delegations of its own session. Nothing else.
- A delegated run gets no such token: a delegate cannot delegate further.
- The owner (the panel) can read every delegation and stop one; it adds a message to a delegate through the delegate's own chat, as today.

This is narrower than `SPACE_AGENT_CALLERS`, which lets a whole app reach every agent.

### Routes and commands

| route | body | answer |
| --- | --- | --- |
| `POST /api/delegations` | `{ to: "<role or agent>", brief, continue?: <delegation id>, images?: [order id] }` | `{ ok, delegation }` |
| `POST /api/delegations/:id/steer` | `{ message }` | `{ ok: true }` or `{ ok: false, reason }` |
| `POST /api/delegations/:id/stop` | | `{ ok, stopped, last }` |
| `GET /api/delegations/:id` | | `{ ok, delegation, notes }` |
| `GET /api/delegations?session=<sid>` | | `{ ok, delegations }` |

The agent uses them through the CLI, which reads `SPACE_API_URL` and `SPACE_RUN_TOKEN` from its environment:

```
space delegate start <role> --brief-file <path>   [--continue <id>]
space delegate say   <id> "<message>"
space delegate stop  <id>
space delegate show  <id>
```

- **start** opens an interactive turn of the delegate with the brief as its message and the team entry's model and permission mode. `continue` starts it on the session of an earlier delegation of the same delegator (the delegate remembers what it did); without it the delegate starts a fresh session. `images` passes an order's screenshot along as a chat image. It answers at once with the delegation's id; it does not wait for the work.
- **say** calls the run's `steer`. What that does is the runtime's:

  | runtime | a message added to the running turn | when the turn has ended |
  | --- | --- | --- |
  | Claude Code | read once the running tool call ends | refused (409) |
  | Codex | `turn/steer` into the running turn | refused (409) |
  | DeepSeek Harness | not supported (409) | |

  The route turns each refusal into `{ ok: false, reason: "ended" }` or `{ ok: false, reason: "unsupported" }`. It never resends or queues on its own: the delegator is told the message was not taken and decides (start again with `continue`, or leave it).
- **stop** calls the run's `stop` and answers with `last`, the delegate's final output up to that point. Files the delegate already changed are not restored; the delegator reads `last` and decides.
- **show** answers the delegation's state and the tail of the delegate's steps, for a delegator that wants to look before it adds or stops.

### The result comes back

When a delegated run ends (`done`, `error`, `stopped`, `timeout`, `interrupted`), the platform delivers its result to the delegator's session. Nothing does this today (`RunRegistry.onRunEnd` and `subscribe` exist; the Fix Engineer's port is the only in-process waiter, and it does not write into a session).

- The message is the delegation's id, how it ended, and the delegate's final reply (trimmed to 8,000 characters, with the delegate's session named for the full text).
- If the delegator's turn on that session is running, the message is added to it with `steer`. If it is idle, or the runtime refuses, a new turn starts on that session with a new trigger `delegation` (next to `user` and `background` in `RunTrigger`).
- A delegator that starts a delegation normally ends its turn ("assigned to the engineer") and is woken by the result.
- **Limit**: at most 4 result-triggered turns in a row on one session without a message from the person. The fifth result is recorded and shown, and the topic becomes `needs-you`. This is the bound `hive` uses for the same loop.

### Record

Two tables in `space.db` (`src/space/agents/delegations.ts`):

| table | holds |
| --- | --- |
| `delegations` | `id`, `from_agent`, `from_session`, `to_agent`, `to_machine` (empty = this Space), `to_session`, `run_id`, `state` (`running`, `waiting` for an approval, `done`, `error`, `stopped`, `timeout`, `interrupted`), `order_id` (when it came from an order), `created_at`, `ended_at` |
| `delegation_notes` | `delegation_id`, `seq`, `at`, `kind` (`brief`, `say`, `stop`, `result`), `text`, `taken` (for `say`: accepted by the runtime), `read_at` (for `say`: when the runtime reported the agent read it, from the run's `{"type":"steer"}` event) |

The brief is never overwritten. Every later message and the stop are appended, so the record shows how the request changed and what the delegate had been told at each point. The delegate's own steps (files read, commands run) stay in its session, where they already are; the record points at it.

### In the chat view

A delegation appears in the delegator's conversation as a step of a new run event `{"type":"delegation","delegation":{…}}`: who it went to, its state, each added message with whether it was read, and the result. It links to the delegate's conversation. Chat cards ([chat-cards.md](chat-cards.md)) are not reused: they belong to an app's CLI output and Space agents get none.

An approval the delegate asks for is shown on the Orders page under its delegation and answered by the person through the delegate's own approval route. The Director does not answer approvals for others.

### On another machine (phase 2)

`to` may name `<peer>/<app>/<agent>`. Start, steer, stop and events then go through the peer routes the hub already has (`/api/peers/:peer/agents/…`); the record keeps `to_machine` and the remote run id, and the result is fetched from the peer's run events.

This needs the delegator's machine to list the delegate's machine as a peer. Peering is directional: in today's setup the hub lists the Mac, and the Mac does not list the hub. For a Director on the Mac to delegate to an agent on the hub, the two must list each other (each grants the other the `agents` scope), which also merges their panels. Phase 1 therefore keeps the team on the Director's machine.

## Trust

- A screenshot holds whatever was on the screen. It is stored on the machine that took the order and sent to the model provider of the Director's runtime, and to a delegate's when the Director passes it on. The client's setting and mark ([macos-desktop.md](macos-desktop.md#voice-input)) stay the person's control.
- The Director is read-only by default. Every write goes through an approval or through a delegate whose permission mode the person set in the team.
- The run token reaches only its own session's delegations. A delegate cannot delegate.
- No event is published for orders or delegations in phase 1. Other apps cannot observe them. (See open questions.)

## Failure modes considered

| what | result |
| --- | --- |
| the same order posted twice (client retry) | the first order is answered; no second turn |
| the topic model is down or slow | the order opens a new topic after 60 s at most |
| the Space restarts while a turn runs | the run is marked `interrupted` (existing behaviour); the topic shows `failed` with the order intact, and the person can send it again from the page |
| the Space restarts while a delegate runs | the delegation is marked `interrupted` at start, and the result (interrupted) is delivered to the delegator |
| a message is added just as the delegate ends | `reason: "ended"`; nothing is lost silently, nothing is sent twice |
| the delegator's runtime cannot take a message while it runs | the result starts a new turn when the current one ends |
| a delegate and its delegator hand work back and forth | stops at 4 result-triggered turns; the person is asked |
| the delegate's agent was removed or is not on the team | `start` is refused with the reason |

## What goes away

| today | after |
| --- | --- |
| `decree` app (store, page, `issue`, `report`, `image`) | the orders store and page; the app is retired after its orders are imported |
| `hive`: decree inbox, topic rooms, screenshot fetch, status reports, the lead's hand-back logic | removed from `hive`; it stays a group chat |
| `hive` installed on the Mac as an agent host (`HIVE_MAIN_URL`) | removed |
| `agent-org` roster and bindings on the order path | the team setting |
| event mirroring and bus calls between two machines for one order | none: one machine |

## Phases

1. **Orders, one machine.** The capture target, the store, topics, `space/director`, the page. An order reaches a Director turn in two steps. The Director can answer, research, record a to-do and ask; it cannot delegate yet.
2. **Delegation, one machine.** The run token, routes, CLI, the record, result delivery, the chat step, the team setting.
3. **Retire the old path.** Import `decree`'s orders and `hive`'s topic rooms (text and pictures; not the agents' sessions), switch the client's default target, remove the pieces listed above.
4. **Delegation across machines**, once two Spaces that list each other is a supported setup for this.

Each phase is usable alone and is tested before the next: unit tests for the stores, the topic decision (with a stand-in model) and the delegation rules; route tests with the stand-in runtimes in `src/space/runtimes/testing-live.ts`; and steering and stop checked against the real Claude Code and Codex CLIs, as [runtimes.md](runtimes.md) records for the existing routes.

## Open questions

1. **Events.** Should `order.issued`, `order.finished` and `delegation.ended` be published on the bus so that apps can react (a to-do, statistics)? Proposed: not until an app needs one.
2. **Where the engineer works.** The app sources and deploy channels the engineer needs are on the Mac, so an engineer agent on the Mac covers phase 2. Which agent that is (an existing app's, or a second built-in agent) is not decided here.
3. **One Director per Space, or per person.** This proposal has one. A Space with several users under `SPACE_AUTH=builtin` would need orders and topics per user.
4. **The status line.** Reading `needs-you` from the Director's last line is the one convention left from `hive`. A `space order ask` command would be stricter; it costs a tool call per question.
5. **Notifications.** When a topic becomes `needs-you` or `done` while the page is closed, should the Space notify ([notify.md](notify.md))? Proposed: yes for `needs-you`, as a setting.
