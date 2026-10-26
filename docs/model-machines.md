# Model calls by machine

Status: proposal. Nothing here is implemented yet. It builds on [runtimes.md](runtimes.md) (the adapters and `runtimes.yaml`), [model.md](model.md) (the model service and its ledger) and [peers.md](peers.md) (one panel over several machines). The [migration](#migration) at the end lists the order of the work.

## Problem

A space can use another machine in two different ways today, and the two do not know about each other.

| | a runtime's `ssh:` | a peer |
| --- | --- | --- |
| transport | `ssh <alias>` that runs the CLI on the far side, often through an access proxy | HTTP to the peer's `/api/peer/*` with the peer token |
| operations | `complete` only | agent chat (one-shot and live), background runs, app pages, the app proxy, the terminal |
| who records usage | only the calling space; the machine whose account pays has no row | the machine that ran it |
| configuration | an ssh alias in `runtimes.yaml` and the operator's `~/.ssh/config` | `SPACE_PEER_<NAME>` in `.env` |
| model tiers | the calling space reads the far CLI's catalogue over ssh | the peer's own registry |

The runtime name hides which machine runs a call. `codex/basic` may run on this machine or on another one, depending on a line in `runtimes.yaml` that nobody reads while looking at a failure. One deployment showed what that costs:

- Over seven days, 12,195 app answers went over `ssh:` to another machine's Codex login, and 379 of them failed. 317 of the failures were that account's quota (`usage limit`, `429`). The quota belonged to the other machine, but no ledger on that machine showed the load, and nothing on the calling machine said whose account it was.
- On the same space, the comment in `runtimes.yaml` said "agent tasks and chat run here on this machine's claude". Claude Code was not signed in on that machine, and the service's `PATH` did not contain the CLI at all. Nothing failed only because every agent fell back to the Codex default. The first agent set to `claude` would have failed, and no status page would have warned before that.

## Two layers, and which one holds a long connection

A call has two independent parts:

- **Runtime**: the process that talks to the model. A live chat keeps one CLI process per conversation (`claude -p --input-format stream-json`, `codex app-server`, `dsh --profile acp`) and talks to it over stdio. Approvals, steering and stop go to that process (`src/space/runtimes/live.ts`). A runtime process always runs on one machine.
- **Peer**: forwarding between machines. For a peer agent, the hub forwards `/api/peers/<peer>/agents/<app>/<agent>/chat` and the run routes (`stop`, `steer`, `approvals`) to the peer and streams the SSE back unchanged. The peer holds no process for the hub; it only carries requests and event streams.

So the long connection of an agent chat belongs to the runtime, on the machine where the app lives. The peer only carries the browser's requests to that machine. This proposal keeps that split and gives `complete` the same shape.

## The rule

Every operation is handed to a machine: this one, or a peer.

| operation | where it may run | why |
| --- | --- | --- |
| `complete`, `image` | any machine that offers the runtime | one prompt in, one answer out; it needs no files of the app |
| `agent` (scheduler task) | the machine where the app lives | it works in the app directory |
| `chat` (one-shot and live) | the machine where the app lives | same; a chat with an app on a peer already goes to that peer |

Choosing a machine for `agent` and `chat` therefore means choosing the app's machine, which [peers.md](peers.md#agents-on-several-machines) already does (the Machine menu of the chat header). Only `complete` and `image` need a new way to name a machine.

## Naming a machine in a model

A model string may start with a machine:

```
codex/basic             this machine's codex runtime, tier basic (unchanged)
box:codex/basic         the codex runtime of peer "box"
box:dsh/deepseek-official:deepseek-flash
                        the part before the first "/" names machine and runtime;
                        a colon after it stays the runtime's own (DeepSeek's provider:model)
```

- The machine is a peer name from `SPACE_PEER_<NAME>`, or a name from the [`machines:`](#machines-without-ai-space) section. No prefix means this machine.
- The model service, `SPACE_MODEL_DEFAULT`, the space's default model, the manifest's `model:` section and the panel's per-app and per-tag overrides (`model_overrides`) all accept the prefix. An operator can then move one app's answers to another machine without touching the others: the busy news app on `box:codex/basic`, the rest here.
- A chat or an agent task that names a machine prefix is refused with a 400 that names the peer agent to use instead (`box/<app>/<agent>`). Nothing switches machines silently.
- The registry resolves the prefix before the runtime. An unknown machine is an error, like an unknown runtime today.

## Answers through the peer

A peer that agrees to serve answers gets one more route:

| peer route | local equivalent | notes |
| --- | --- | --- |
| `POST /api/peer/model/run` | `POST /api/model/run` | The same body with the machine prefix removed, and the same answer including `call`. Streaming answers keep the same SSE. |
| `POST /api/peer/model/image` | `POST /api/model/image` | Same rule. |
| `GET /api/peer/model/status` | `GET /api/model/status` | Feeds the hub's [status table](#status). |

The peer runs the call with its own registry: its own runtimes, its own tier catalogue, its own concurrency cap. This has several effects:

- One transport and one credential (the peer token) for every cross-machine call. The ssh alias, the access proxy in `~/.ssh/config` and the shell quoting of [model.md](model.md) are no longer on this path.
- The machine that owns a login limits how hard it is used. Today, the hub's concurrency cap knows nothing about the other callers of the same account.
- Tiers resolve where the CLI is installed. The hub no longer needs to read another machine's catalogue at boot.
- Usage is recorded on the machine that paid for it (see [Ledger](#ledger)).

The peer serves answers only when its operator turns it on: `SPACE_PEER_MODEL=codex,dsh` lists the runtimes a hub may use, and the default is none. The peer token can already open a chat with `bypassPermissions`, so the route gives no new power over the machine. It does spend the machine's accounts, though, and that should be a choice the operator makes on purpose.

## Machines without ai-space

A machine that only has a signed-in CLI and an ssh login keeps today's path, but under a machine name instead of a hidden runtime option:

```yaml
machines:
  bare: { ssh: bare-alias }     # an ssh alias from the operator's ~/.ssh/config
default: codex
runtimes:
  codex: { kind: codex-cli }
  claude: { kind: claude-code }
```

`bare:codex/basic` runs this space's `codex` adapter over `ssh bare-alias`, exactly as `ssh:` does now. A runtime's own `ssh:` key keeps working during the migration: at boot it is read as an anonymous machine, and the boot log tells the operator to move it into `machines:`. When a name exists both as a peer and under `machines:`, boot fails. A machine is either a space or an ssh login, never both.

## Ledger

`model_calls` gains a `machine` column. It holds the machine that ran the call: empty for this machine, otherwise the peer or `machines:` name. `backend` keeps describing the path: `local`, `ssh:<alias>`, `api`, and a new value `peer:<name>`.

A call forwarded to a peer writes two rows:

| where | app | origin | backend | figures |
| --- | --- | --- | --- | --- |
| hub | the calling app | `run` | `peer:box` | the tokens and cost the peer returned in `call` |
| peer | `<hub>/<app>` | `peer` | the peer's own (`local`) | the same figures |

The hub row keeps per-app views correct where the app lives. The peer row makes each login's load visible on the machine that owns it. A view that sums several machines (the usage app reads each machine's rows through the peer proxy) counts a call once: it skips hub rows whose `backend` is `peer:<name>` when it also reads that peer.

## Status

`GET /api/model/status` adds a table with one row per machine and one column per runtime. The hub merges the rows of every peer from `GET /api/peer/model/status`. Each cell says:

- **installed**: the CLI is found on the `PATH` the service actually runs with, not the operator's login shell.
- **signed in**: a cheap probe per kind, at boot and every hour. The CLI's own status command where one exists; otherwise a one-token prompt.
- **limited until**: set when a call fails with a quota or rate error (`usage limit`, `429`, `at capacity`), from the retry time the error gives or one hour. It is cleared by the next successful call.
- **last success**: the time of the last call that succeeded.

The Settings page shows the table. A cell that is not installed or not signed in, but is named by a default, an override or an agent, is shown as a problem. On the deployment above, this check would have flagged the Claude runtime long before the first agent used it.

## Fallback

Without a fallback, behaviour does not change: a call goes to the machine and runtime it names, and fails there. A fallback is always written out explicitly:

```yaml
fallback:
  codex/basic: [box:codex/basic, dsh/basic]
```

A call whose resolved model has a fallback list tries the entries in order. It skips an entry whose status cell is `limited` or not signed in, and moves to the next entry only on a quota, rate or transport error, never on a model error. The ledger row records the entry that answered and has a `fallback_from` column naming the first choice. An entry that resolves to a more expensive tier is refused when the configuration is loaded, so a fallback never raises cost silently.

## What does not change

- `runtimes.yaml` without `machines:`, a prefix or `fallback:` behaves exactly as today.
- Chat, live chat and agent tasks keep running on the app's machine through their runtime. Peer agents keep their routes.
- The three operations of a runtime adapter stay the same. Forwarding is a step in the model service before the registry, not a new adapter kind.

## Migration

1. **See it.** Add the `machine` column, and the status table on this machine only: installed, signed in, limited, last success. This needs no peer change and shows today's problems at once.
2. **Peer answers.** Add `SPACE_PEER_MODEL`, the `/api/peer/model/*` routes, the `machine:` prefix in the registry and in model validation, the hub's `peer:<name>` backend and the two-row ledger. Merge the peers' status rows on the hub.
3. **Move overrides.** On a space that borrows a peer's login over ssh, set the app overrides and the default to `<peer>:codex/...`, then remove `ssh:` from those runtimes so that a bare `codex/...` means this machine.
4. **Machines without ai-space.** Add `machines:`, and read a runtime's `ssh:` as an anonymous machine with a boot warning.
5. **Fallback.** Add explicit fallback lists, which use the status cells.

## Open questions

- Should a hub be able to set a per-app budget on a peer's account (calls or cost per day), or does the peer's own cap and `SPACE_PEER_MODEL` list suffice?
- The `signed in` probe for each kind: which CLI commands answer without spending tokens, and how often a one-token prompt is acceptable where none does.
- Whether `image` should be forwarded in step 2 or later. Only `codex-cli` has it, and its files travel in the request body.
