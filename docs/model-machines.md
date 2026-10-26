# Model calls by machine

Status: implemented, except [fallback](#fallback) and per-caller budgets, which stay proposals. It builds on [runtimes.md](runtimes.md) (the adapters and `runtimes.yaml`), [model.md](model.md) (the model service and its ledger) and [peers.md](peers.md) (one panel over several machines). Code: `src/space/runtimes/registry.ts` (the machine prefix, `machines:`), `src/space/peers/model.ts` (the peer runtime), `src/space/model/api.ts` (`createPeerModelRoutes`), `src/space/model/health.ts` and `machines.ts` (the status table), `src/web/SettingsStatus.tsx` (its rows in Settings → Status). The [migration](#migration) at the end says what an operator does on an existing space.

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
| `complete`, `image` | any machine that offers the runtime, when the call is [portable](#placement) | one prompt in, one answer out; it needs no files of the app |
| `agent` (scheduler task) | the machine where the app lives | it works in the app directory |
| `chat` (one-shot and live) | the machine where the app lives | same; a chat with an app on a peer already goes to that peer |

Choosing a machine for `agent` and `chat` therefore means choosing the app's machine, which [peers.md](peers.md#agents-on-several-machines) already does (the Machine menu of the chat header). Only `complete` and `image` need a new way to name a machine.

## Placement

A call either needs the environment of the machine that runs it, or it does not. Sending one that does to another machine reads or changes the wrong machine, or fails there, so it is refused.

| the call | needs this machine | may run elsewhere |
| --- | --- | --- |
| slim mode, no tools | no | yes |
| slim mode, only `WebSearch` / `WebFetch` | no (the network is the same everywhere) | yes |
| files or input images | no: they travel with the request | yes |
| `mode: "full"` | yes: the CLI's own context and tools (working directory, `CLAUDE.md`, MCP servers) | no |
| any other tool (`Read`, `Bash`, `Grep`, an MCP tool, ...) | yes: it acts on the machine | no |
| `agent`, `chat` | yes | only on the app's machine ([the rule](#the-rule)) |

A tool is judged by its name before any `(...)` pattern. "Another machine" is anything the runtime's `machine` names: a peer, a `machines:` login, or a runtime's own `ssh:`.

Where it is checked:

- **Model service**: `/api/model/run` answers 400, and a call through the service records an error row under that runtime and machine. Nothing moves the call back to this machine silently: a model name that points elsewhere is the operator's choice, and the fix is in the app or the override.
- **The peer**: `/api/peer/model/run` refuses full mode and non-web tools in a forwarded call, so an older or misconfigured space cannot make it read the peer's files.

An app whose work needs a machine's data does one of two things:

1. **Collect, then ask.** The app reads the data itself on its own machine and puts it in the prompt (or as files); the model call is plain reasoning and may run anywhere.
2. **Hand the task over.** The work goes to an agent on the machine that has the data (an `agent` task or a chat with the app there), which uses that machine's own runtime.

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
| `POST /api/peer/model/image` | `POST /api/model/image` | Same rule. Input images travel under the caller's file names, because the prompt refers to them by name. |

The peer's snapshot (`GET /api/peer/snapshot`) gains `model`: the runtimes it offers, each with its kind, whether it makes pictures, its concrete model per tier (the hub's model choices show them), and the peer's own status cells. The hub reads them from the cached snapshot, so a status page never waits on a peer. A runtime the peer does not list is refused on the hub before any request is sent, with the list of runtimes the peer does offer.

The peer runs the call with its own registry: its own runtimes, its own tier catalogue, its own concurrency cap. This has several effects:

- One transport and one credential (the peer token) for every cross-machine call. The ssh alias, the access proxy in `~/.ssh/config` and the shell quoting of [model.md](model.md) are no longer on this path.
- The machine that owns a login limits how hard it is used. Today, the hub's concurrency cap knows nothing about the other callers of the same account.
- Tiers resolve where the CLI is installed. The hub no longer needs to read another machine's catalogue at boot.
- Usage is recorded on the machine that paid for it (see [Ledger](#ledger)).

The peer serves answers only when its operator turns it on: `SPACE_PEER_MODEL=codex,dsh` lists the runtimes a hub may use, and the default is none. The peer token can already open a chat with `bypassPermissions`, so the route gives no new power over the machine. It does spend the machine's accounts, though, and that should be a choice the operator makes on purpose. A runtime whose answers run on yet another machine (one with its own `ssh:`) is never offered: a forwarded call stays on the machine it was sent to.

### Both directions

Hub and peer are roles of one link, not kinds of machine. Two spaces that list each other (`SPACE_PEER_<NAME>` with the other's `SPACE_HUB_TOKEN`) and each set `SPACE_PEER_MODEL` use each other's runtimes: the laptop sends `server:codex/basic` to the server, the server sends `laptop:claude/opus` to the laptop. Nothing loops: a forwarded call names no machine, the snapshot passes on only a space's own apps, and mirrored events are not exported again. Listing each other also merges each other's panels; that is what a peer is.

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

`bare:codex/basic` runs this space's `codex` adapter over `ssh bare-alias`, exactly as `ssh:` does now. A runtime's own `ssh:` key keeps working: its answers run on that host, the ledger names the host as their machine, and the boot log tells the operator to move it into `machines:`. When a name exists both as a peer and under `machines:`, boot fails. A machine is either a space or an ssh login, never both.

## Ledger

`model_calls` gains a `machine` column. It holds the machine that ran the call: empty for this machine, otherwise the peer, the `machines:` name, or a runtime's own ssh host. `backend` keeps describing the path: `local`, `ssh:<alias>`, `api`, and a new value `peer:<name>`.

A call forwarded to a peer writes two rows:

| where | app | origin | backend | figures |
| --- | --- | --- | --- | --- |
| hub | the calling app | `run` | `peer:box` | the tokens and cost the peer returned in `call` |
| peer | `<hub>/<app>` | `peer` | the peer's own (`local`) | the same figures |

The hub row keeps per-app views correct where the app lives. The peer row makes each login's load visible on the machine that owns it. A view that sums several machines (the usage app reads each machine's rows through the peer proxy) must count a call once: it skips hub rows whose `backend` is `peer:<name>` when it also reads that peer. That rule belongs to such a view; the core ledger keeps both rows.

## Status

`GET /api/model/status` adds a table with one cell per machine and runtime. The hub merges each peer's own cells from the peer's snapshot with what it saw of the calls it forwarded there (the later success, the longer limit). Each cell says:

- **reachable**: false when ssh to a `machines:` login (or a runtime's own ssh host) fails; installed and signed in are then unknown.
- **installed**: the CLI is found on the `PATH` the service actually runs with, not the operator's login shell. Over ssh, on that machine's login `PATH`, as the adapters run it.
- **signed in**: probes that spend no tokens, at boot and every hour: `claude auth status` (its `loggedIn`), `codex login status` (exit 0), and for DeepSeek Harness the API key in the harness home's `.env` or, with `provider: deepseek-account`, its `.credentials.yaml`. An API runtime is signed in when its key is set.
- **limited until**: set for one hour when a call fails with a quota or rate error (`usage limit`, `429`, `rate limit`, `at capacity`, `quota`, `overloaded`). It is cleared by the next successful call.
- **last success**: the time of the last call that succeeded.

For a runtime with its own `ssh:`, both machines get a cell: this one, where its chats and agent tasks run, and the ssh host, where its answers go. On the deployment above, that is exactly the pair that differed.

Settings → Status shows the table. A cell is **used** when a default (the space's, `SPACE_MODEL_DEFAULT`, the runtimes.yaml default), an app override, a manifest's `model:` or an agent's declared runtime points at it. A used cell that is unreachable, not installed, not signed in or limited is a problem: red (limited is amber) and counted in the section's issues. An unused one with the same state is grey. `GET /api/model/status` returns the cells as `machines`, each with `used` and `problem`, and `servesPeers`, the runtimes this space offers. `GET /api/model/usage` adds `byMachine`.

## Fallback

Not built yet; this is the intended shape. Without a fallback, behaviour does not change: a call goes to the machine and runtime it names, and fails there. A fallback is always written out explicitly:

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

What is in the code: the `machine` column and `peer` origin, the status table, `SPACE_PEER_MODEL` with the `/api/peer/model/*` routes, the `machine:` prefix (model service, panel overrides, `SPACE_MODEL_DEFAULT`), `machines:`, and the boot warning for a runtime's own `ssh:`. Codex tiers read the catalogue of every `machines:` login too, so a tier names a model all of them list.

What an operator does on a space that borrows another space's login over a runtime's `ssh:`:

1. **Look.** Settings → Status shows both cells of that runtime. Fix what is red first (a missing local login).
2. **Offer.** On the other space, set `SPACE_PEER_MODEL` to the runtimes to share and restart it; its snapshot now lists them.
3. **Move overrides.** On this space, set the default and the app overrides to `<peer>:codex/...`, check that calls arrive (the ledger's `machine` column, the peer's own rows), then remove `ssh:` from the runtime so that a bare `codex/...` means this machine.
4. **Machines without ai-space** move from a runtime's `ssh:` to `machines:`.

Not built: **fallback** lists and per-caller budgets ([open questions](#open-questions)).

### Apps

The goal for app code: call `/api/model/run` and `/api/model/image` only, start no CLI, name no model, send a `tag` (its default tier in `space.yaml` under `model.tags`), and keep every call [portable](#placement). The space then picks the runtime and the machine, and moving machines changes no app code.

1. **Clean the apps** (one commit and deploy per app), before the core is deployed:
   - **Calls that need a machine but only want the web**: `finance-writer` drafts with `mode: "full"` only for web search. It sends `tools: ["WebSearch", "WebFetch"]` instead, and its `ModelRequest` type drops `mode`. Do this first: once the core is deployed, its full-mode calls over a runtime's `ssh:` are refused.
   - **Fallbacks to a local CLI**: apps that try the model service and run `claude -p` when they have no token drop the CLI branch and fail with a clear error instead. The CLI path was never recorded in the ledger.
   - **Local CLI only**: an app that runs `claude -p` itself moves to the model service with its own tag.
   - **Model names in code**: apps that send `codex/...` drop it and declare their tags in `space.yaml`. A model a person picks by hand (a command-line choice) stays.
2. **Deploy the core** on every space.
3. **Offer and switch** as in the operator steps above.
4. **Keep it so**: the app check warns when app source runs `claude -p` or `codex exec`, reads `CLAUDE_BIN`, or calls a vendor API host.

## Open questions

- Should a peer be able to set a budget per calling space (calls or cost per day), or do its own cap and the `SPACE_PEER_MODEL` list suffice? Deferred: the list and the cap for now.
- Fallback as described above: deferred until the status table has run for a while and shows how often a cell is limited.
