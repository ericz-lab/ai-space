# Orders: a spoken order handled by a built-in Director, who may delegate

Status: phases 1 and 2 ([Phases](#phases)) are implemented as [Phase 1 as built](#phase-1-as-built) and [Phase 2 as built](#phase-2-as-built) describe: the capture target, the orders store, topics, the Director, the `space/order.*` events, the notification and the Orders page (phase 1); the team table and its page section, the built-in Engineer, delegation with its run token, routes, CLI, record, result delivery, chat step and `space/delegation.*` events (phase 2); delegation to an agent on another machine (phase 4) and the import of the old path's history (the import half of phase 3), as [Cross-machine and import as built](#cross-machine-and-import-as-built) describes. Retiring the old path (switching the client's default target, removing `decree`, `hive`'s order pieces and `agent-org`) is still a proposal. It builds on [panel.md](panel.md) (agent runs, sessions, approvals, steering), [runtimes.md](runtimes.md) (what a live turn can do per runtime), [events.md](events.md#capture) (capture targets), [macos-desktop.md](macos-desktop.md#voice-input) (the capture key and its screenshot) and [peers.md](peers.md) (agents on other machines). It replaces a path that today runs through three apps: `decree`, `hive` and `agent-org`. The person's decisions of 2026-11-27 are built in: one Director per Space, a built-in Engineer and a built-in team (the roster `agent-org` holds today), events on the bus, a permission setting per team member up to full permission, and a notification when a topic waits for the person.

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

Three parts, specified below in this order:

- **Orders**: a built-in capture target, the order store, topics, the built-in Director, the panel page.
- **Team**: who exists to do the work (built-in Director and Engineer, plus app agents the person adds) and what each may do.
- **Delegation**: an agent starts a run of another agent, may add a message to it while it runs, may stop it, and gets the result back in its own session. The Director is its first user, but it is a platform feature of its own.

## What stays where it is

- A chat turn still runs on the machine where its agent lives ([model-machines.md](model-machines.md#the-rule)). The Director lives on the machine that receives the order.
- Adding a message to a running turn and stopping a turn are the runtimes' own functions (Claude Code's stdin message and `interrupt`, Codex's `turn/steer` and `turn/interrupt`); the platform already wraps them as `POST …/runs/:id/steer` and `…/stop` ([panel.md](panel.md)). Delegation calls those. It adds no mechanism of its own for either.
- `hive` remains an ordinary app (a group chat of agents). It is no longer on an order's path. `agent-org`'s roster moves into the platform as the team; the app is retired with the old path.

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
- **Runtime and model, permission**: from its team entry ([Team](#team)). By default the Space's chat model and the read-only tier, where anything beyond reading becomes an approval the person answers on the page.
- **One per Space.** There is one Director and one set of topics, whoever of the Space's users gives the order.
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

### Notification

When a topic becomes `needs-you` (an approval, a question from a runtime, or the Director asking), the Space sends one notification through the notify service ([notify.md](notify.md)): the topic's title, what is being asked in one line, and the link to the order. A setting on the Orders page (`orders.notify`, default on) chooses the channel or turns it off. A topic that stays `needs-you` is not notified again; `done` and `failed` are not notified.

### Events

The Space publishes these on the bus as its own (`space/…`), so that an app can react (record a to-do, count, mirror to a chat app). Publishing under the reserved name `space` is new: today only apps publish.

| event | when | data |
| --- | --- | --- |
| `space/order.issued` | an order is stored | `{ id, text, via, image?: { mime, bytes }, createdAt, url }` |
| `space/order.sorted` | it has a topic | `{ id, topic: { id, title, new }, by }` |
| `space/order.state` | its topic's state changes | `{ topic, state, order?, summary? }` |
| `space/delegation.started` | a delegation starts | `{ id, order?, topic?, from, to, role }` |
| `space/delegation.noted` | a message is added or it is stopped | `{ id, kind, taken? }` |
| `space/delegation.ended` | it ends | `{ id, state, summary }` |

No event carries the picture or the full text of a brief or result: `summary` is at most 600 characters, and a consumer that needs more reads the routes with the owner's rights. A hub mirrors a peer's events as for any app.

### The page

A new built-in page `orders` (the places a built-in page touches: `src/web/screens.ts`, `panel-link.ts`, `App.tsx`, `Library.tsx`, `i18n.ts`):

- Left: topics, most recently active first, each with title, last activity and a mark for `needs-you` or `working`; a count of orders being sorted.
- Right: the topic's conversation, drawn by the existing chat view (`src/web/Chat.tsx`) on the Director's session, so approvals, questions, steering and stop work as in any chat. Each order shows its label, time and screenshot thumbnail.
- A box to type an order; settings for the look-back days, the Director's model, and the team (below).

Opening `url` from the client's confirmation lands on the order.

## Team

Who can do work, and with what rights. This is what `agent-org` (positions and bindings) and `hive`'s per-member settings hold today; it becomes a platform table and a section of the Orders page.

### Built-in members

| member | agent | what it is |
| --- | --- | --- |
| Director | `space/director` | takes every order; described [above](#the-built-in-director) |
| Engineer | `space/engineer` | a fourth built-in agent: changes an app's source in `app-src/<app>/`, runs its checks and deploys it by the app's own channel. Its prompt is in `src/space/orders/prompt.ts` and reuses the shared skill the Fix Engineer uses for a fix (`skills/app-fix/SKILL.md`); its working directory is the workspace root |

The Fix Engineer (`space/ui-fixer`) stays what it is: the agent behind "Fix this" on a page. Whether the two should become one agent is left open; they differ in who briefs them and how the result is returned.

### Members the person adds

Any agent of this Space (phase 4: or of a peer), for example `ai-design/designer` as the Designer. A member is a row:

| field | meaning |
| --- | --- |
| `role` | a short name the Director uses (`engineer`, `designer`), unique |
| `title`, `i18n` | the name shown |
| `agent` | `<app>/<agent>` |
| `summary` | what to give this member, in one or two lines; goes into the Director's prompt. Defaults to the agent's description |
| `model` | optional; else the agent's default |
| `permission` | see below |
| `enabled` | a disabled member is not offered to the Director |

Table `team_members` in `space.db` (`src/space/team/store.ts`), seeded with the two built-in rows; routes `GET/PUT /api/team` (owner only). Only the Director delegates in this proposal, so the team is flat: no reporting lines are stored. The organisation chart `agent-org` draws is not carried over.

### Permission

Each member, the Director included, has one of the permission modes the runtimes already know (`PERMISSION_MODES` in `src/space/runtimes/types.ts`):

| setting | mode sent | what the member may do without asking |
| --- | --- | --- |
| Ask (default for the Director) | none | read; anything else is an approval |
| Edit (default for the Engineer) | `acceptEdits` | also change files in its working directory |
| Full | `bypassPermissions` | run any command as the service's user, including deploys and deletions, with no approval |

Full is the person's to give, to any member, the Director too. The page says in one line what it means on this machine, and shows a mark on every topic and delegation that runs with it. The Director's own rules (ask first for the platform, several apps, data deletion, deploys, spending) are in its prompt and still apply under Full; they are instructions, not a barrier, and the page says so.

A member has this one permission wherever its turns start. The chat window's permission menu, for an agent that is a team member (the Director, the Engineer, any member the person added, a peer's member as `<peer>/<app>/<agent>`), shows the member's setting (the menu's three tiers are the same three modes), and a change there writes the team (`PUT /api/team`), with the Full warning under the menu. A message typed in that window to a member is sent with the member's mode, so a turn the person starts there and one an order or a delegation starts run with the same rights. For any other agent the menu is the window's own choice, remembered in the browser.

## Delegation

An agent hands a piece of work to another agent, may add to it or stop it, and hears back when it ends. It has only these two controls over a running delegate, by the person's decision: **stop** and **add a message**. A change of direction is a stop followed by a new delegation.

### What a delegate may be

An enabled member of the [team](#team), named by its role. An agent that is not a member cannot be delegated to. The delegated run gets the member's model and permission mode.

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

- **start** opens an interactive turn of the delegate with the brief as its message and the member's model and permission mode. `continue` starts it on the session of an earlier delegation of the same delegator (the delegate remembers what it did); without it the delegate starts a fresh session. `images` passes an order's screenshot along as a chat image. It answers at once with the delegation's id; it does not wait for the work.
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

A chat window that shows the Director's conversation follows the turns orders start on its session as well as its own: when one starts (the `watch` stream's run news), the session's transcript up to that turn's own message is read again, so turns that came and went in between are shown, then the run's message and its events; a turn that started and ended unseen reloads the transcript. Leaving that conversation in the window detaches from such a turn without stopping it.

### On another machine

A member may be `<peer>/<app>/<agent>`: an agent of a peer this Space lists. That is a legacy `SPACE_PEER_<NAME>` peer (its hub token reaches every peer route), or a connection peer whose other Space grants this one `panel` and `agents` (or full trust) on the connection ([peers.md](peers.md#adding-a-peer)). The team routes check the member against the peers' last snapshots; the Team section offers the peers' agents grouped by machine, shows an offline machine's agents but does not let them be added, and leaves out a peer's own Director.

Start, `say`, `stop` and `show` go to the peer's `/api/peer/agents/:app/:agent/…` routes through the hub-side peer client, in process (not over HTTP to this Space itself). The record keeps `to_machine` and the peer's run id. The run is followed on the peer's run events stream: its `system` event gives the delegate's session, `steer` marks a message read, `approval_request` / `approval_resolved` set `waiting` and back, its last text is the result, and its `{"type":"done"}` ends it; the run's status and session then come from `GET …/runs/:id` there. When the stream drops it is read again with `after=<last seq>`; a stream silent for 70 s (the peer's heartbeat is every 20 s) counts as dropped. The brief's screenshot travels in the chat body (at most 4 MiB as stored, well under the peer chat route's 5 MB per image and 15 MB body; over a connection the body is streamed in 32 KiB chunks). The member's permission mode and model apply there: the model is one of that machine's chat models, `runtime/tier` without a machine prefix ([model-machines.md](model-machines.md)).

The person answers the delegate's approvals and questions on the Orders page, through `/api/peers/:peer/agents/…/runs/:id/approvals/:rid`, and stops it there through `POST /api/delegations/:id/stop`.

**Unreachable.** While the peer does not answer, the delegation stays `running` (or `waiting`) with `unreachableSince`, shown as "machine unreachable since …"; it is settled when the peer answers again, with how the run ended there. After **24 h** without an answer it ends `interrupted` and that result is delivered: longer than a run's own 60-minute timeout, so a machine that comes back within the day still reports the real end, and short enough that a lost machine does not hold a delegation for ever. A run the peer no longer knows (404, e.g. pushed out of its last 200 finished runs) ends `interrupted` too. A `say` while it is unreachable is not taken (`reason: "unreachable"`).

**Restart.** After a restart of the delegator's Space a remote delegation in flight is followed again from the start of the peer's stream: the steps are rebuilt, a message already marked read (`to_seq`, the last event whose effect is recorded) is not marked again, and a run that ended while this Space was down is settled at once.

**Direction.** Peering is directional ([peers.md](peers.md#delegation-to-a-peers-agents)): a Director delegates only to agents of machines its own Space lists. In today's setup david (the hub) lists the Mac and the Mac does not list david. For the Mac's Director to delegate to an agent on david, the Mac must list david too (see [Cross-machine and import as built](#cross-machine-and-import-as-built) for the steps). Then each panel also shows the other's apps and agents (the Mac's panel gains david's; david's already has the Mac's). A refusal names what is missing: `machine-unlisted` (this Space lists no such peer: how to add one), `machine-no-agents` (the connection's other side does not grant `agents`: the `space connection scopes` command to run there), `machine-offline` (the peer does not answer: since when).

## Trust

- A screenshot holds whatever was on the screen. It is stored on the machine that took the order and sent to the model provider of the Director's runtime, and to a delegate's when the Director passes it on. The client's setting and mark ([macos-desktop.md](macos-desktop.md#voice-input)) stay the person's control.
- The Director is read-only by default. Every write goes through an approval or through a delegate whose permission mode the person set in the team.
- The run token reaches only its own session's delegations. A delegate cannot delegate.
- Events tell every app on the Space that an order exists, its first words and how it ended. They never carry the picture. An app that should not see them is not subscribed; the bus has no per-event secrecy today.
- Full permission removes the approval step for that member. It is off by default and shown wherever it is in force.
- A member on another machine runs there with the permission its row here says. The peer takes this Space's link (the hub token, or the connection) as its owner, so **a Space that lists a peer can run that peer's agents with any permission mode, Full included**: listing a peer, and granting a connection `agents`, is trusting the listing Space as much as the peer's own owner. The Team section says so when a peer member is given Edit or Full.

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
| the delegate's machine is not listed, does not grant `agents`, or is down | `start` is refused, naming what is missing |
| the delegate's event stream drops | read again after the last seq; nothing twice, nothing lost |
| the delegate's machine is unreachable when its run ends | `running` with "unreachable since"; settled when it answers; `interrupted` after 24 h |
| this Space restarts with a remote delegate in flight | followed again from the peer's stream; settled if it ended meanwhile |

## What goes away

| today | after |
| --- | --- |
| `decree` app (store, page, `issue`, `report`, `image`) | the orders store and page; the app is retired after its orders are imported |
| `hive`: decree inbox, topic rooms, screenshot fetch, status reports, the lead's hand-back logic | removed from `hive`; it stays a group chat |
| `hive` installed on the Mac as an agent host (`HIVE_MAIN_URL`) | removed |
| `agent-org` app (roster, bindings, organisation chart) | the team table; the app is retired, its chart is not carried over |
| event mirroring and bus calls between two machines for one order | none: one machine |

## Phases

1. **Orders, one machine.** The capture target, the store, topics, `space/director` with its permission setting, the page, the `order.*` events, the notification. An order reaches a Director turn in two steps. The Director can answer, research, record a to-do and ask; it cannot delegate yet.
2. **Team and delegation, one machine.** The team table and its page section, `space/engineer`, the run token, routes, CLI, the record, result delivery, the chat step, the `delegation.*` events.
3. **Retire the old path.** Import `decree`'s orders and `hive`'s topic rooms (text and pictures; not the agents' sessions; built, see [Importing the old path](#importing-the-old-path)), switch the client's default target, remove the pieces listed above, `agent-org` included (not built).
4. **Delegation across machines**, once two Spaces that list each other is a supported setup for this.

Each phase is usable alone and is tested before the next: unit tests for the stores, the topic decision (with a stand-in model) and the delegation rules; route tests with the stand-in runtimes in `src/space/runtimes/testing-live.ts`; and steering and stop checked against the real Claude Code and Codex CLIs, as [runtimes.md](runtimes.md) records for the existing routes.

## Phase 1 as built

Code: `src/space/orders/` (store, sorting, prompt, service, routes, status line), `src/space/team/` (the Director's row), `src/space/bus/builtin.ts` (ai-space's own bus entry), `src/web/Orders.tsx` (the page). Where it differs from the sections above, this is what runs:

- **The target is a bus capability.** ai-space registers itself in the bus as the app `space` (`Bus.syncBuiltin`, docs/events.md#events-of-ai-space-itself) with the capability `order`, answered in process. So `captureTargets` and `forwardToTarget` are unchanged: `space/order` is listed because the bus lists it, a peer's snapshot carries it, and a hub forwards `<peer>/space/order` like any target. The handler takes calls only from `space` (this Space's operator) or `<hub>/space` (a hub's operator forwarding); an app calling it gets 403.
- **Events.** `space/peer.renamed` was published before this; what is new is that `space` is in the catalogue (`GET /api/capabilities`) with its four events, so `consumes` can name them. `order.issued` carries the text clipped to 600 characters, like every `summary`. `url` is relative to the Space that keeps the order: `/#order=<id>`.
- **`sorting` is a count, not a topic state.** An order not yet sorted has no topic; the page shows "n being sorted". A topic is `working`, `needs-you`, `done` or `failed`.
- **State.** The service follows each Director run on a topic's session: the ones it starts and the ones the person starts in the chat on that session (`RunRegistry.watch`). `needs-you` comes from an open approval or question of the run, or from the status line `〔状态: needs-you〕` at the end of the reply (also read: `status`, `[]`/`【】`, a full-width colon). A run that ends stopped is `done`; `error`, `timeout`, `interrupted` are `failed` with the reason as the summary. At start, a topic left `working` by a run that is no longer running becomes `failed` ("ai-space restarted during the turn").
- **Busy topic.** If the topic's run is running, the order is steered into it. If the steer fails and the run still runs (DeepSeek Harness, a runtime without steering) the order waits for the turn's end; if the run has just ended, or the chat answers 409 for a turn the person started between the look and the start, the service tries again (three rounds), so the order goes into that turn or starts the next one. A turn that does not start at all (no runtime, a refused request) leaves the order waiting and the topic `failed` with the reason; "Send again" on the page retries.
- **The page did not embed the chat view** (phase 2 changes this: the page now draws the running turn's steps, approvals, questions and stop itself, see [Phase 2 as built](#phase-2-as-built)). `Chat.tsx` is one floating window tied to the panel's agent list; embedding a second one is a larger change than this phase. The Orders window lists topics with their state dot, opens one in place (its orders with time, how they came and the screenshot, then the conversation read from the Director's session with the status line taken out), takes a typed order or a follow-up into the topic (a pasted or picked picture goes with it), and links "Open in chat" to `/?page=chat&agent=space/director&session=<sid>`, where the running turn is attached and its approvals, questions, steering and stop work as in any chat. Rename, archive, move to a new topic, delete and send again are on the page.
- **The team had one row** (phase 2: the full table). `team_members` holds the Director (`role: director`, title Director / 总管, permission `ask`); `GET/PUT /api/team` changes only `model` and `permission` of an existing row. The page shows that row as two settings, with the Full warning. The Director's model applies when its conversation starts: a topic that already has a session keeps its model.
- **Settings.** `orders.topicDays` and `orders.notify` (`off`, `default`, or a notify channel's name) are in `panel_kv`. The sorting call's model is the model service's tag `orders.topic` of the app `space` (default tier `basic`), set on Settings → Models like an app's tags.
- **Sessions.** A session an unarchived topic points at is exempt from the 10-per-agent retention and is listed in the Director's sessions besides the newest ten.
- **Prompt.** In English, as the repository's other built-in prompts; the Director answers in the order's language. In phase 1 it had no delegation: when an order needs code changed it says what and where and asks the person how to proceed.
- **The Linux client** draws the new built-in tile and opens it as the panel's page (`/?page=orders`); the Mac and Windows clients are unchanged and skip a built-in they do not know.

## Phase 2 as built

Code: `src/space/team/` (the full table and its routes), `src/space/agents/delegations.ts` (the record, the run tokens, the service: start, say, stop, follow, result delivery, restart), `src/space/agents/delegations-api.ts` (`/api/delegations*`), `src/space/agents/delegation-view.ts` (the shapes and labels the web shares), `src/space/orders/prompt.ts` (the Director's and the Engineer's prompts, the roster), `src/cli/delegate.ts` (`space delegate`), `src/web/ChatWork.tsx` and `src/web/run-follow.ts` (the chat's approval and question steps, the delegation step, a run follower, shared by the chat and the Orders page). Where it differs from the sections above, this is what runs:

- **The run token is per turn, not per session.** `RunTokens.mint` makes an `srt_…` secret for a turn of an agent in `DELEGATORS` (today only `space/director`), bound to that run: it names the agent and, through the run, its session, and it dies when the run ends. It is kept in memory only, so a restart ends every token (the turns end too). Every other turn has `SPACE_RUN_TOKEN` removed from its environment, also when the service's own environment had one. The chat route also sets `SPACE_API_URL` (`http://<host>:<port>`, `0.0.0.0` read as `127.0.0.1`).
- **The routes' gate.** `/api/delegations*` are under the gate's `self` policy and check the caller themselves: a live run token, or the owner (the panel, the operator token, under `SPACE_AUTH=builtin` the owner's session); an app's token is 403, an `srt_` token whose turn ended is 401. `POST /api/delegations` and `…/steer` take only a run token (the owner adds a message through the delegate's own chat, as the section above says); `GET` and `…/stop` take both. A token reaches only the delegations its own session started; `GET /api/delegations` without `session` gives a token its session's and the owner the recent ones. `GET /api/delegations/:id` also answers `tail`, the delegate's last steps as one line each, which `show` prints.
- **The Director may run `space delegate` without an approval.** Its turns under Claude Code get `--allowedTools Bash(space delegate:*)`, so delegating does not wait for the person under Ask. Under Codex there is no per-command allowance: the command may ask for an approval or be refused by the sandbox's network rule; only a real run tells (see below).
- **The record has two more columns.** `delegations.from_run` (the turn that started it, for the result-turn count) and `delivered` (`steered`, `turn`, `held`; `skipped` when there is nothing to deliver). `to_role` and `to_title` keep the member's name as it was, `permission` the mode the delegate ran with, `continued` the delegation it went on from. A session the delegator's runtime renames (a resumed Codex thread, a forked session) is followed.
- **A stop by the delegator is not delivered again.** `stop` already answers with `last`, so the result of a delegation its delegator stopped is recorded but does not start a turn or steer. A stop by the person (from the page) is delivered like any end. The stop note says who: `reason: delegator | person`.
- **say.** A refusal is `{ ok: false, reason: "ended" | "unsupported", error }`, with a sentence the CLI prints; `unsupported` also when the runtime refuses while the turn still runs (Codex between a turn's items, the stand-in's plain runtime). A message the runtime reports read before `say` has recorded it (Codex answers the steer after its item starts) is still marked read.
- **Result delivery.** Up to three rounds, as for a busy topic: steer into the delegator's running turn on that session; when that turn runs but takes no message, wait for its end; otherwise start a new turn through the chat route with trigger `delegation` and the delegator's member model and permission mode. The fifth result-triggered turn in a row (turns with trigger `background` do not break or count) is held: recorded, shown, `delivered: held`, and the topic becomes `needs-you`. A result whose turn cannot start (no runtime, a refusal) is held the same way.
- **The result message** is `〔Delegation #N · <role> · <state>〕`, a line naming the delegate's agent and session, and the delegate's final reply trimmed to 8,000 characters. The web reads the header back to draw it as a folded result card; a restored transcript turns a `space delegate start` call whose output says `Delegation #N started` into the delegation's step.
- **Refusals on start.** Besides not a member (403 `not-member`), disabled (`disabled`), an agent that left the Space (`removed`) and another machine's agent (400 `other-machine`, "… names an agent on david; delegation stays on this machine in this phase"; the team routes refuse a peer's agent as a member already): the Director cannot delegate to itself (`self`); `continue` must name a delegation of the same session that has ended and has a session (409 while it runs); `images` must be orders of this conversation's topic (400 otherwise); a brief is 1 to 20,000 characters.
- **One delegate per order at a time** is the Director's instruction, not enforced: a turn may start a second delegation, as the page shows (each listed under the topic).
- **A delegate's prompt.** The brief goes as the turn's message under `〔Delegation #N · from the Director〕`, so the delegate knows who asks; with `images`, the order's screenshot goes along as a chat image.
- **The Engineer** (`space/engineer`) is the fourth built-in agent in every list the Director and the Fix Engineer are in (`builtinAgentViews()`: `/api/agents`, the moods, the peer snapshot; title Engineer / 工程师). Its prompt is `engineerSystemPrompt` followed by the Fix Engineer's `skills/app-fix/SKILL.md` (its `RESULT:` line optional here) and the capability catalogue; its working directory is the workspace root. It reads each app's AGENTS.md and deploy channel and deploys only when the brief says so.
- **The Director's prompt** is generated with the team: rules 1–7 (one path per order, when to ask first, never answer a delegate's approval), a Delegating section (delegate vs do vs ask, the brief's Goal / Where / Done when / Do not touch and what the screenshot shows written out, one delegate per order, check the result against Done when, one follow-up at most, say vs stop, `--continue`), the commands, the status lines (`working` while a delegate runs) and the roster (each enabled member's role, title, agent, permission and summary). A change that needs a deploy is delegated only after the person said to deploy.
- **Team routes.** `PUT /api/team` takes `{ members?: [patch or new member], remove?: [role] }` and applies all of it in one transaction or nothing. Refused: disabling the Director, removing a built-in row, changing a built-in row's agent, an agent that is not this Space's (a peer's is named as such), `space/director` as a second member, a role that is not `[a-z][a-z0-9-]{0,31}` or is listed twice, unknown fields, an unknown model, at most 30 members. A new member's summary defaults to the agent's description; a phase 1 Director row whose summary the person never changed gets the one that mentions delegation.
- **State.** A topic is `working` while one of its delegations runs (also after the Director's turn ended), `needs-you` while a delegate waits for an approval or question (the asking line names the member: "Engineer: …"), and after the last delegation ends the Director's woken turn decides. A topic is `done` only when no delegation of its session runs.
- **The Orders page** follows a topic's running Director turn and draws its steps with the chat's components (tool rows, approvals, questions, Stop); its status line is hidden. Each delegation is drawn under the topic by the same `DelegationStep` the chat uses: who, state, the brief, each added message (read, taken, not taken with the reason), the stop, the result, the Full mark and a link to the delegate's conversation; while it runs, the delegate's own steps, approvals and questions (answered on the delegate's run routes) and Stop. The topics list marks "Needs you" and "Working", Full and the number of delegations. `#order=<id>` waits up to 15 s for a pending approval or question of that topic and scrolls to it. Settings has the Team section (edit a member's name, summary, model, permission and switch; add an agent of this Space; remove one the person added; the Full warning, and the note that the Director's ask-first rules are instructions).
- **Usage** does not count a delegation-triggered turn as an open, like a background turn.

Only real Claude Code and Codex runs can confirm (the tests use the stand-ins of `src/space/runtimes/testing-live.ts`):

- that Claude Code under Ask runs `space delegate` from the allowed-tools entry without asking, and that Codex can run it at all (its sandbox, its approval for a command that reaches the local API);
- steering: that a delegate under Claude Code reads an added message once its running tool call ends and the `steer` event arrives (`read_at`), and under Codex that `turn/steer` lands while a command runs; and that a result steered into a running Director turn is read and answered there;
- stop: that stopping a delegate leaves its session resumable for `--continue`, and that `last` is what it had said;
- delivery as a new turn: a resumed Director session that answers a `〔Delegation #N …〕` message and, when it delegates again, gets a fresh token;
- that the Engineer follows an app's AGENTS.md and deploy channel, and the Director the brief format and the one-follow-up rule: prompt behaviour no test can show.

## Importing the old path

`space orders import decree [--from <db path or URL>] [--machine NAME]` and `space orders import hive --from <db path> [--hive-machine NAME]` ([cli.md](cli.md#commands)), both with `--images DIR` and `--dry-run`. The Space reads the source; a path is on the Space's machine. The command only reads the two apps and only adds to the orders store: it deletes, moves and uninstalls nothing there. It prints a count per kind (topics, orders, pictures, transcripts, matched, already imported) and every item it skipped with the reason.

- **decree**: each decree becomes an order (its text, source as `via`, time and screenshot file). By default it reads `<workspace>/data/decree/main.db` and the `images/` beside it; `--from` takes another path, or decree's URL (`GET /api/decrees`, the newest 500, and `POST /api/decrees/image` per picture). The db is copied (with its `-wal` and `-shm`) to a temporary directory and the copy is read, so a running decree is never written to.
- **hive**: each topic room (`rooms.topic_of` set) becomes a topic with the room's decrees as its orders and the room's messages as a read-only **transcript** shown on the topic. The agents' sessions are not imported: the topic has no session, the first new order in it starts a fresh one, and that first turn is given the transcript first (the newest messages within 12,000 characters and what the chat route's 20,000 leave). hive runs on david, so `--from` takes a copy of its db file with `decree-images/` beside it (or `--images`); a URL is refused. Take the copy with SQLite's own backup, so the WAL is included: `ssh david 'sqlite3 <hive data dir>/hive.db ".backup /tmp/hive-copy.db"'`, then `scp david:/tmp/hive-copy.db /tmp/hive/hive.db` and `scp -r david:<hive data dir>/decree-images /tmp/hive/` (the data dir is hive's `SPACE_APP_DATA_DIR`, normally `~/.ai-space/data/hive`).
- **Matching**: an order's import key is `decree/<machine>/<decree id>`, the machine as hive names it (hive's `decrees.peer`; for a decree taken on hive's own machine, `--hive-machine`). decree's own import uses `--machine`, by default this Space's `SPACE_NAME`. A decree in both apps is one order: in hive's topic, with decree's text and picture, whichever import runs first. A topic's key is `hive/<room id>`. Re-running adds nothing.
- Decrees in no topic room (decree-only ones, and hive's inbox) go into one topic, **Imported decrees**. Imported orders are taken already (`run_id` = `imported`, `routed_by` = `import`): nothing dispatches or sorts them. Imported topics are `done`, not archived, as old as their last activity; ones older than the look-back window simply fall outside sorting.

## Cross-machine and import as built

Code: `src/space/agents/delegations.ts` (the remote follower, say, stop, restart), `delegations-remote.ts` (the interface and the event-stream reader), `src/space/peers/delegates.ts` (which machines, over the peer hub), `src/space/team/api.ts` (peer members), `src/web/Orders.tsx` and `ChatWork.tsx` (Team section, step), `src/space/orders/import.ts`, `src/cli/orders.ts`. Tests: `src/space/agents/delegations-peer.test.ts` (two Spaces: start, steer, stop, result, approvals through the peer route, a dropped stream, the peer offline at the end, the 24 h bound, restart, refusals), `src/space/orders/import.test.ts`, `src/cli/orders.test.ts`. Where it differs from the sections above or from what was proposed, this is what runs:

- **Calls go to `/api/peer/…`, not `/api/peers/…`.** The service talks to the peer client directly; the hub's `/api/peers/:peer/agents/…` routes are what the page uses for approvals and following.
- **The model is checked against the peer's snapshot.** A peer member's model must be one of the `modelOptions` the peer's last snapshot gives for that agent; changing a member's agent resets its model to the default.
- **A peer's Director cannot be a member**, and an offline machine's agent cannot be added (one already on the team stays).
- **A start while the peer does not answer** but is not yet known down (fewer than two failed snapshots) is tried and recorded as an `error` delegation (`machine-offline`, 502); a known-down peer is refused before anything is recorded (503).
- **`show` of an ended remote delegation** reads the peer's stream once for the tail; it is empty when the peer does not answer.
- **The stop route answers 502** when the peer does not answer; the delegation then stays as it is.
- **The steered message's label**: in a delegation's followed run, a message the Director added is labelled with the delegator (Director / 总管), not "You".
- **hive is imported from a file only**, not its URL (hive's API has no listing of rooms with their messages). decree's URL mode reads the newest 500 decrees.
- **Inbox decrees** of hive go to the Imported decrees topic, like decree-only ones.
- **The import runs in the Space** (`POST /api/orders/import`, the owner's), so `--from` is a path on the Space's machine.

What the operator configures so that the Mac's Director can delegate to an agent on david (today the Mac is david's connection peer and does not list david): nothing new on the Mac's side of the link. The Mac already has its outgoing connection to david, and there is one connection per pair of Spaces; what is missing is david's grant to the Mac on it. On david, find its connection to the Mac (`space connection ls`) and run `space connection scopes <that id> --scopes panel,agents` (add any scope it already grants the Mac to the list, or `--full-trust on`). Within a catalogue round (30 s) the Mac lists david as a connection peer under david's `SPACE_NAME` (`space peer ls` on the Mac); the Mac's panel then also shows david's apps and agents. On the Mac's Orders page add the member (Team → add → On david → e.g. `david/space/engineer`), pick its model from david's list and its permission; Edit or Full there is trusting the Mac as much as david's owner. Peering itself is unchanged; the legacy alternative is `SPACE_PEER_DAVID=<david's URL>` with `SPACE_PEER_DAVID_TOKEN=<david's SPACE_HUB_TOKEN>` in the Mac's `.env` ([peers.md](peers.md#configuration)).

Only real machines can confirm: a delegate run on another machine under the real CLIs (Claude Code reading a steered message there, Codex's steer), the stream over a package connection's channel dropping and resuming through Cloudflare and the network between them, a peer going away for real (sleep, network loss) while a delegate runs, the Mac's Director's turns choosing a peer member from the roster, and the imports on the real data (decree's 11 orders on the Mac, as a copy shows; hive's rooms on david).

## Decided

| question | decision (2026-11-27) |
| --- | --- |
| one Director per Space, or per person | one per Space |
| which agent is the engineer | a built-in one, `space/engineer`; the roster is built in too |
| events on the bus | published |
| permissions | a setting per member; Full may be given |
| a notification when a topic waits | sent |

## Open questions

1. **The status line.** Reading `needs-you` from the Director's last line is the one convention left from `hive`. A `space order ask` command would be stricter; it costs a tool call per question. Proposed: keep the line.
2. **Fix Engineer and Engineer.** Two built-in agents that change app source. Merge them, or keep one per way of being briefed?
3. **Several users.** With one Director per Space, every signed-in user of a Space under `SPACE_AUTH=builtin` sees and adds to the same topics. Whether orders should record who gave them is not decided.
