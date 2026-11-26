# CLI: one `space` command for the whole space

Status: implemented (`src/cli/`, `bin/space`, `src/space/logs/`). `bun src/index.ts <command>` is the same program, and its older subcommand spellings are aliases.

## Problem

Everything a space does is reachable from the shell today, but in three different spellings:

- `bun src/index.ts <command>` from inside `~/.ai-space/core`, for the handful of commands that grew there one by one: `init`, `setup`, `env`, `notify`, `backup`, `backup-verify`, `backups`, `restore`, `model-import`, `chat-import`. Each parses its own arguments, prints its own usage line, and exits with its own codes.
- `curl -s http://127.0.0.1:8700/api/...` with a bearer token for everything else: tasks, apps, services, model usage, notifications, backups' status, peers, the router. The generated workspace `AGENTS.md` teaches agents these routes one by one.
- `journalctl --user -u <app>` and `systemctl --user ...` for the parts ai-space does not cover yet (an app's log, a restart).

The web terminal ([terminal.md](terminal.md)) removed the need for an SSH client, but what one types into it is still this mix. An operator has to remember which spelling covers which verb, an agent has to be taught all three, and a skill that wants to be portable across machines ([machines.md](machines.md)) has to spell out `cd ~/.ai-space/core && bun src/index.ts ...` because there is no command on `PATH`.

## Shape

One executable, `space`, on `PATH` on every machine that runs ai-space, and on the laptop. Nouns then verbs, `gh`-style, one screen of help per level:

```
space status                          the machine at a glance
space auth    status | init | reset-password | revoke-sessions | device-add | devices | device-revoke
space app     ls | show | sync | deploy | service | start | stop | restart | supervise | hide | unhide | uninstall | env | new
              create | build | catalog | release | keygen | pack | inspect-package | install | upgrade | packages | open | rollback | remove-package
space task    ls | show | run | runs | enable | disable | create | rm
space logs    <app> [-n 100] [-f]     an app's log, or `space logs space` for ai-space itself
space model   usage | calls | status | run | import
space usage   [--window 30d] [--kind app|agent|builtin]
space notify  send | ls | channels | test
space backup  run | ls | verify | restore
space chat    ls | import
space event   ls | emit
space consumer ls | show | add | rotate | rm
space peer    ls | rename | migrate
space connection ls | create | grant | enable | disable | rm
space router  show | sync
space api     <METHOD> <path> [body]  the escape hatch: one raw call with the token added
space service status | install | start | stop | restart | remove | workspace
space upgrade | uninstall | open
space init | setup | start | install-defaults | codex-upgrade
space completion zsh | bash
```

The CLI is a client of the running ai-space, not a second implementation of it:

```
space task run x ──── HTTP + token ────▶ 127.0.0.1:8700 /api/tasks/x/run
                                              │
                                        the same code the panel uses
```

Rules:

- **One implementation per operation, in the service.** A verb that has a route calls the route; a verb that has none gets the route first, then the verb. The CLI never opens `space.db` for something the API can answer. The exceptions are the commands that must work with ai-space down or before it exists: `init`, `setup`, `start`, `install-defaults`, `codex-upgrade`, `app env` (reads the storage inventory), `app new`, `backup run`, `backup verify`, `backup restore`, `model import`, `chat import`. They stay disk-bound, as they were. `backup run` is disk-bound on purpose: it is the command the daily task spawns, and an operator typing it wants the synchronous result, not a 202.
- **Same command anywhere.** On the machine it talks to loopback. From a task's `command:` it inherits `SPACE_API_URL` and `SPACE_APP_TOKEN` from `space.env`, so `space notify send` and `space event emit` need no `--app`. From the laptop it reaches a machine through a forwarded port (`SPACE_API_URL=http://127.0.0.1:8701`) or, simpler, `ssh <host> space ...`, since the binary is there. Peers are not addressed through the hub: a peer exposes `/api/peer/*` only, and its tasks, logs and backups stay on that machine ([peers.md](peers.md)).
- **Readable by default, parseable on request.** Human output is a table with fixed columns, relative times and no color. `--json` prints exactly what the route returned, so an agent or a script gets the API's own shape and nothing invented by the CLI. Errors go to stderr as `space: <what>`; stdout carries only the result, so `eval "$(space app env x)"` and `space task ls --json | jq` stay clean.
- **stdin only when asked.** A body or a prompt comes from the argument, from `--json-file`, or from stdin when the argument is `-`. The CLI never reads stdin on its own: inside a task or a hook, stdin may be a pipe nobody closes, and a command that waits on it hangs the run.
- **Questions only on a terminal.** `app uninstall`, `task rm`, `consumer rotate`/`rm`, `connection rm` (and full trust), `app rollback`/`remove-package`, `auth revoke-sessions` and `auth device-revoke` ask before acting; `--yes` (or `-y`) skips the question, and without a terminal the question is a usage error rather than a silent default. Answering no prints `nothing done` and exits `1`.
- **Say what happens.** A verb that changes something prints one sentence saying what it did (`connection ID removed`), not the route's JSON, unless `--json`. A request that takes a while (an install, a build, a restart) prints one progress line on stderr first; `-q` drops it. A mistyped command or verb names the nearest one (`did you mean: space status?`). When nothing answers, the error names the next step: `space service status`/`start` for this machine, `--url`/`SPACE_API_URL` for another; a `401` names `--token`/`SPACE_API_TOKEN`, and `space status` stops on it rather than showing an empty machine.
- **Honest exit codes.** `0` done; `1` the operation failed (the server said no, a run failed, a delivery errored under `--wait`); `2` usage; `3` ai-space not reachable. The older `notify` returned `1` for both failure and unreachable; the scheduler's hooks only test for non-zero, so the split is safe.
- **No new dependency.** Argument parsing is by hand, as `parseNotifyArgs` does today; there are two dozen nouns, not a hundred flags.
- **The old spellings keep working.** `bun src/index.ts backup <app>` is what the backup task spawns and what the older docs say. `main.ts` keeps them as aliases (`env` → `app env`, `backup` → `backup run`, `backup-verify` → `backup verify`, `backups` → `backup ls`, `restore` → `backup restore`, `model-import` → `model import`, `chat-import` → `chat import`; `notify …` is `notify send …` because `send` is that noun's default verb). Nothing outside the checkout changed on the day the CLI landed.

## Commands

`APP` and `TASK` are names as the API knows them; a task is `<app>/<task>` or its id.

| Command | Does | Route or file |
| --- | --- | --- |
| `space auth status` / `init [--password-stdin]` / `reset-password [--password-stdin]` / `revoke-sessions [--yes]` / `device-add <name>` / `devices` / `device-revoke <id> [--yes]` | the owner's password, sessions and device credentials of the built-in sign-in ([auth.md](auth.md)); the password is asked without echo or read from stdin, never an argument | disk (`space.db`), works without ai-space |
| `space app create NAME [--title T] [--description D]` / `space app build NAME` | apps made inside the Space: the source in `app-src/NAME` from the template, packed and installed or upgraded ([app-studio.md](app-studio.md)) | `/api/studio/*` |
| `space service status` / `install [--root DIR] [--bun PATH]` / `start` / `stop` / `restart` / `remove` / `workspace` | ai-space's own background service on this machine: the systemd user unit on Linux, the LaunchAgent on a Mac; `install` is what `deploy/install.sh` runs, `restart` is for after an `.env` edit ([release.md](release.md#the-background-service)) | disk and systemd or launchd, works without ai-space |
| `space upgrade [--version X] [--check] [--force]` / `space uninstall [--workspace] [--yes] [--dry-run]` | a release installation: install the newest release over it (rollback when it does not answer), or remove the services, the `space` command and the program; the workspace stays unless `--workspace` ([release.md](release.md#one-command-install)) | the release's files, disk, the service manager |
| `space open [--print]` | open the panel in the browser, or print its address | none |
| `space status` | health, app services with their health, tasks failing or overdue, last backup per app, model calls in flight, peers up or down, how long the Space has run this time and in all; one screen | `/healthz`, `/api/services`, `/api/tasks`, `/api/backups`, `/api/model/status`, `/api/peers`, `/api/space/uptime` |
| `space app ls [--panel]` | every app: title, status, service health, url, hidden (`--panel`: only what the panel shows) | `GET /api/apps?all=1` |
| `space app catalog [--refresh]` / `space app install NAME [--source [--ref REF]] [--no-source] [--trust]` / `space app upgrade NAME [--source\|--package] [--replace-source] [--trust]` | apps of the app catalog: what is listed, installed and updatable; install the signed package or build from source in `app-src/NAME` ([app-catalog.md](app-catalog.md)) | `/api/app-catalog/*` |
| `space app release [DIR] [--output-dir D] [--variant bundle\|source\|both] [--sign-key FILE]` / `space app keygen --out FILE` | build a checkout by its `build:` section into the packages to publish; make a publisher's signing key ([app-catalog.md](app-catalog.md#publishing-an-app)) | disk, works without ai-space |
| `space app pack DIR --output FILE [--include PATH,...] [--manifest FILE] [--target OS/ARCH] [--source-included] [--sign-key FILE]` | build a package from explicitly selected prepared files, without network or build hooks ([app-packages.md](app-packages.md)) | disk, works without ai-space |
| `space app inspect-package FILE [--trusted-key FILE] [--check-host]` | verify every file and inspect signature/compatibility without executing code | disk, works without ai-space |
| `space app show APP` | the manifest as synced, storage, tasks, agents, widgets, last backup | `GET /api/apps/:app`, `.../storage`, `.../backups` |
| `space app sync [APP]` | re-read one `space.yaml` or every app directory | `POST /api/apps/sync`, `POST /api/apps/:app/sync` |
| `space app deploy APP [--rev REV] [--git-dir DIR] [--no-restart]` | on the host: check out `REV`, run the manifest's `deploy` install, check and build commands, then sync and restart; a failure restores the previous tree and leaves the service running, exit 1 ([app-spec.md](app-spec.md#deploy)) | disk (`src/space/deploy/`), then `POST /api/apps/:app/sync`, `GET`/`POST /api/apps/:app/service` |
| `space app service APP` | a package app: its process state, pid, port, since when, mode, last error. A spec-1 app: who runs the service (`SPACE_SUPERVISOR`), the unit, its state, restarts, since when, the last sync's outcome ([supervision.md](supervision.md)) | `GET /api/packages/apps/:app/runtime`, `GET /api/apps/:app/service` |
| `space app start` / `stop` / `restart APP` | a package app: its process, by hand; a stop holds until the next start ([app-packages.md](app-packages.md#the-owners-control-of-a-process)). A spec-1 app: the space's unit; under `operator` the answer names the `systemctl` command instead | `POST /api/packages/apps/:app/runtime`, `POST /api/apps/:app/service` |
| `space app mode APP on-demand\|background\|standalone\|default` | how this Space runs a package app's process: started when used and stopped when idle, kept running, as a system service of its own that outlives a restart or stop of the Space ([app-packages.md](app-packages.md#running-on-its-own)), or as the app declares | `POST /api/packages/apps/:app/runtime` |
| `space app supervise APP [space\|operator]` | hand the app from the operator's unit to the space's (or back), waiting for health and rolling back on failure; exit 1 when rolled back ([supervision.md](supervision.md#hand-over)) | `POST /api/apps/:app/service` `{ action: "supervise" }` |
| `space app hide APP` / `unhide` | the panel's hidden flag | `PATCH /api/apps/:app` |
| `space app uninstall APP [--yes] [--force]` | stop, remove, forget; asks unless `--yes`; refuses while a task of the app runs unless `--force` | `DELETE /api/apps/:app` |
| `space app env APP` | `export` lines of the provisioned variables | disk (`storage.envFor`) |
| `space app new NAME [--dir D] [--title T] [--port N] [--no-github]` | the `new-app` command of [app-spec.md](app-spec.md): the `space-app` template filled in, `git init`, first commit, a private repository under `SPACE_GITHUB_OWNER` when set and `gh` is on PATH (otherwise a warning, and the app stays local) | disk (`newapp.ts`) |
| `space task ls [--app APP] [--failing] [--all]` | task, schedule, enabled, last run, next run (`--all`: orphaned tasks too) | `GET /api/tasks` |
| `space task show TASK` | effective view, state, last runs | `GET /api/tasks/:id`, `/runs?limit=5` |
| `space task run TASK [--wait] [--timeout D]` | force a run; `--wait` polls the run history to its end, prints the output and exits with its status | `POST /api/tasks/:id/run`, then `GET .../runs` |
| `space task runs TASK [-n 20] [--output]` | history, newest first (`--output`: each run's captured output) | `GET /api/tasks/:id/runs` |
| `space task enable` / `disable TASK [--reset]` | `{ enabled }` override; `--reset` clears it | `PATCH /api/tasks/:id` |
| `space task create` / `rm TASK [--yes]` | an API task from flags (`--app --name --cron [--tz]\|--every\|--at --http [--method]\|--command [--cwd]`, optional `--timeout --description`), a JSON argument, `-` or `--json-file`; delete an API task or an orphaned manifest task with its history (a live manifest task is removed in `space.yaml`) | `POST`, `DELETE /api/tasks` |
| `space logs APP [-n N] [-f]` | the app's log, tail or follow; `space logs space` for ai-space | `GET /api/apps/:app/logs` (new, below) |
| `space model usage [--window 5h\|24h\|7d\|30d] [--app APP] [--by app\|tag\|model\|runtime]` | sums by app, tag, model, runtime; the same numbers as the panel's Model usage | `GET /api/model/usage` |
| `space model calls [--app] [--tag] [-n]` | recent calls | `GET /api/model/calls` |
| `space model status` | runtimes, concurrency, in flight | `GET /api/model/status` |
| `space model run [--app] [--model\|-m] [--tag] [--mode slim\|full] [--system] [--timeout D] PROMPT\|-` | one call, the answer streamed to stdout (`stream: true`); `--timeout` takes `90s`, `10m`, `1h` or plain milliseconds; `--json` for the whole answer with the ledger row | `POST /api/model/run` |
| `space model import APP FILE` | today's `model-import` | disk |
| `space usage [--window 7d\|30d\|90d\|all] [--kind app\|agent\|builtin]` | opens and time in use per app, agent and built-in, by time and then opens; the panel's App usage ([usage.md](usage.md)) | `GET /api/usage` |
| `space notify send [--app] [--level] [--title] [--url LINK] [--channel C] [--key K [--window D]] [--wait] TEXT` | today's `notify`, same flags; `--channel` sends to one channel only, `--key` dedups within `--window` (default from the manifest's `notify.window`) | `POST /api/notify` |
| `space notify ls [--app] [-n]` | history with deliveries | `GET /api/notifications` |
| `space notify channels` / `test NAME` | channels and their state; a test message | `GET /api/notify/channels`, `POST .../test` |
| `space backup run APP` | snapshot now, synchronously: the same code the daily task spawns | disk (`backup/cli.ts`) |
| `space backup ls [APP] [--target]` | every app's last snapshot, or one app's list; `--target` lists the bucket itself, no ai-space needed | `GET /api/backups`, `GET /api/apps/:app/backups` |
| `space backup verify [APP…]` / `restore APP [--at TIME] (--to DIR \| --in-place [--stopped])` | today's `backup-verify` and `restore`, unchanged | disk |
| `space chat ls --app APP --scope S [-n 30]` / `import APP FILE` | threads of one scope; the older `chat-import` | `GET /api/chat/threads`, disk |
| `space event ls [--name] [--app] [-n 30]` / `emit NAME [--data JSON] [--app APP]` | recent events; publish one | `GET`, `POST /api/events` |
| `space consumer ls` / `show NAME` | external consumers of the bus: events, calls, token hint, last contact; one with its delivery counts ([events.md](events.md#external-consumers)) | `GET /api/consumers`, `GET /api/consumers/:name` |
| `space consumer add NAME --event E [--filter k=v1,v2] [--call APP/CAP] [--description D]` | create one; `--filter` applies to every event and call; or a JSON body, `-`, `--json-file`; prints the token once | `POST /api/consumers` |
| `space consumer rotate NAME [--yes]` / `rm NAME [--yes]` | a new token, or revoke; both end the old token and its open streams at once | `POST /api/consumers/:name/rotate`, `DELETE /api/consumers/:name` |
| `space peer ls` | how each peer is reached (`connection`, or `legacy` for `SPACE_PEER_*`, with a line naming `space peer migrate` while any is left), health, snapshot age, app counts | `GET /api/peers` |
| `space peer rename OLD NEW` | rename a peer: its `.env` lines and everything the hub keeps under its name; publishes `space/peer.renamed` ([peers.md](peers.md#renaming-a-peer)) | `POST /api/peers/:peer/rename` |
| `space peer migrate NAME \| --all [--manual \| --finish] [--dry-run] [--keep-legacy] [--hub-url URL] [--hub-headers H] [--peer-id ID] [--wait S]` | move a `SPACE_PEER_*` peer onto a package connection under the same name, keeping what the hub stores for it: the connection, the peer asked to dial back with full trust (or the commands to run there, `--manual`, then `--finish`), a bounded check, the `.env` lines commented out; no restart; exit 1 when a peer is not moved ([peers.md](peers.md#moving-a-legacy-peer)) | `GET /api/peers`, `POST /api/peers/:peer/migrate` |
| `space router show` / `sync` | routes with status; write and reload | `GET /api/router`, `POST /api/router/sync` |
| `space api METHOD PATH [BODY\|-] [--app]` | one call with the operator token (`--app`: the app's own); JSON pretty-printed, SSE one line per event | any |
| `space init` / `setup` / `start` / `install-defaults` | the lifecycle commands, unchanged; `setup` is the basic configuration, `setup github` / `ingress` / `backup` / `notifications` / `peers` one optional extension each ([install.md](install.md)) | disk |
| `space codex-upgrade run [--dry-run] [--no-update] [--no-restart]` | update the Codex CLI, check each codex tier's model, restart so the catalogue gives the tiers ([runtimes.md](runtimes.md#keeping-codex-tiers-current)) | disk, ssh |
| `space completion zsh\|bash` | a completion script from the same command table the help prints | |

Global flags, before or after the noun: `--json`, `--url <api url>`, `--token <token>`, `-q` (no table header), `--help` at every level. One exception: after `notify send`, `--url` is the notification's link, so the API's address goes before `notify` there. `space` alone and `space <noun>` alone print the help of that level; a noun whose only verb takes no argument (`status`, `init`, `setup`, `start`) runs it.

Two aggregate views deserve one line each. `space status` is composed in the CLI from six existing routes rather than from a new `/api/status`, because it is the only reader and the routes already answer in milliseconds from the health cache. `space model usage` prints the same table the panel does; the CLI is the place to check a bill from a task or a cron mail without opening a browser.

## The one new route: logs

`space logs` was the one verb the API could not answer: where an app's log lives depends on who runs it: the operator's command under `SPACE_SUPERVISOR=operator`, the unit's journal or log file under `space` ([supervision.md](supervision.md)).

Rather than have the CLI shell out to `journalctl` itself (which would tie it to systemd and to the machine it runs on), the route went in first and hides where the log lives (`src/space/logs/`):

```
GET /api/apps/:app/logs?lines=100          the last N lines, text/plain, the command's exit code in x-exit-code
GET /api/apps/:app/logs?follow=1           the same, then new lines as they come: SSE, one `line` event each,
                                           a comment every 15 s, `end` {code} when the command exits
GET /api/apps/space/logs                   ai-space's own log (the `ai-space` unit)
```

The backend is a per-machine command template, like `SPACE_SERVICE_STOP`: `SPACE_SERVICE_LOGS` in the workspace `.env`, with `{app}` (the unit), `{lines}` and `{follow}` (`-f` or nothing) substituted, default `journalctl --user -u {app} -n {lines} --no-pager {follow}`; on a machine without journald, `tail -n {lines} {follow} <dir>/{app}.log` does. Only those three words are substituted, only for a plain app name, and only for an app the space knows (or `space`), so the request cannot smuggle a shell word into the operator's template. The command runs under a shell wrapper that forwards the kill to its child: when the reader leaves, `journalctl -f` dies with it instead of living on under init. Operator token required: a log is not panel data. Under `SPACE_SUPERVISOR=space` ([supervision.md](supervision.md)) the template is not set and `{app}` is the space's unit, `space-<app>.service`, so the default reads its journal; on macOS the route reads the app's `<workspace>/logs/<app>/service.log` with `tail` instead (supervision.md#macos). The CLI does not change.

## Where it lives

```
bin/space                 exec bun <checkout>/src/index.ts "$@"
src/index.ts              boot() and the services; every command word goes to src/cli/main.ts with boot injected
src/space/config.ts       loadConfig, openStorage, openBackups: what the entry point and the CLI share
src/cli/main.ts           global flags, nouns, aliases, help at every level, errors → exit codes
src/cli/args.ts           the flag parser (declared flags, `--k v`, `--k=v`, `-k v`, `--`)
src/cli/client.ts         url + token resolution (flags, then env, then <workspace>/.env), fetch with timeout,
                          JSON and SSE readers, `ApiError` for exit 1 and `Unreachable` for exit 3
src/cli/output.ts         tables (widths from the rows, right-aligned numbers), relative times, sizes, tokens, money
src/cli/common.ts         task lookup (<app>/<name>, bare name, id), schedule text, JSON bodies, confirmations
src/cli/status.ts, app.ts (+ newapp.ts), task.ts, logs.ts, model.ts, notify.ts, backup.ts, chat.ts, event.ts, consumer.ts,
        peer.ts, router.ts, api.ts, lifecycle.ts (init, setup, start, install-defaults, codex-upgrade), completion.ts
src/cli/testing.ts        runCli(): the CLI against a scripted fetch, stdout and stderr collected
src/cli/*.test.ts         every verb: the call it makes, the table it prints, the code it exits with
```

`bin/space` runs the entry point rather than `main.ts` directly so there is exactly one process shape: `src/index.ts` imports the CLI and hands it `boot`, and the CLI never imports the entry point back. What the entry point and the CLI both need (`loadConfig`, the openers) moved to `src/space/config.ts`; the older exports of `src/index.ts` are re-exported from there.

Install: `deploy/install.sh` links `~/.local/bin/space` to `bin/space` of the checkout (the unit and the profile already put `~/.local/bin` on `PATH`, [install.md](install.md) step 1). `package.json` has `"bin": { "space": "bin/space" }`, so a laptop checkout is `bun link` away, and `bun run space …` works without it. The generated workspace `AGENTS.md` ([guide.ts](../src/space/guide.ts)) shows the `space` spellings, the `notify` and `space-app` skills lead with them, and the older documents that still say `bun src/index.ts …` are not wrong: those words are aliases.

URL and token resolution follows what the process already has. URL: `--url`, then `SPACE_API_URL` (set in a task's command and in every app's `space.env`), then `SPACE_HOST` and `SPACE_PORT` from the workspace `.env`, then `http://127.0.0.1:8700`. Token: `--token`, then `SPACE_API_TOKEN` from the environment or the workspace `.env`, then, for a space on loopback under `SPACE_AUTH=builtin`, `<workspace>/run/operator-token`; `SPACE_APP_TOKEN` (a task's command) is presented only on the routes that take an app's identity. A `--url` that names another machine never gets the workspace `.env`'s token: pass `--token`, or set `SPACE_API_TOKEN` for that call. The CLI reads that `.env` only for these values and only when they are not already set, so a run from anywhere on the machine works without `cd`.

## What shipped

Everything in the table, in one change: the skeleton with help and exit codes, the older commands under their nouns with aliases, every read and write verb, the logs route with `SPACE_SERVICE_LOGS`, `task run --wait`, `app new`, `completion`, the `install.sh` link and the `bin` entry. Service supervision reads the journal of the space's unit through the same route and verbs.

## Not in this design

- **Remote operation through the hub.** `space --on david task ls` would need the peer to expose its whole API to the hub, which [peers.md](peers.md) deliberately does not. `ssh david space task ls` is the same keystrokes and keeps the boundary.
- **A TUI.** Tables and `-f` are enough; the panel is the interactive view.

Model calls accept `space model run --mode slim|full --system "Custom instructions" PROMPT`.
The default text-only mode is slim. Full retains native runtime context and tools;
custom system instructions are supported in either mode. See [completion modes](runtimes.md#completion-modes).

### Package applications and Hub connections

`space app pack DIR --output FILE --include web,dist --target any/any` builds an explicitly selected artifact. Add `--manifest FILE` to use a reviewed spec-2 release manifest without changing the source tree's legacy manifest; see [package-migration.md](package-migration.md). `space app inspect-package FILE --check-host` verifies it without running code. On the selected Space (`--url`, with its operator credential), use:

```sh
space app install notes.spaceapp
space app upgrade notes-v2.spaceapp
space app packages
space app open notes
space app open notes --space-id HUB_UUID --connection CONNECTION_UUID
space app rollback notes RETAINED_OPERATION_ID --yes
space app remove-package notes --yes
space connection ls
space connection create incoming PEER_UUID --apps notes
space connection create outgoing HUB_UUID --endpoint https://hub.example.com --token-env MY_HUB_TOKEN
space connection grant CONNECTION_UUID --apps notes
space connection grant CONNECTION_UUID --apps ''
space connection scopes CONNECTION_UUID --scopes panel,agents,events
space connection scopes CONNECTION_UUID --full-trust on --yes
space connection alias CONNECTION_UUID office
space connection alias CONNECTION_UUID --clear
space connection disable CONNECTION_UUID
space connection enable CONNECTION_UUID
space connection rm CONNECTION_UUID
```

`--allow-unsigned` is an explicit trust decision for a package without a signature. Signed packages use the host's configured publisher keys. Install/upgrade/change commands print an operation UUID before writing; reuse it with `--operation-id UUID` if the response is interrupted. `app open` prints a one-use URL rather than launching a browser on the server. A use-only peer connection cannot install or manage remote apps; `--url` requires a separate operator credential for that Space.

Creating an incoming connection returns its token once. Store it in the outgoing peer's host environment under the selected name; restart that Space to load a new environment variable. `--headers-env NAME` on an outgoing connection names a second variable with `Name: value; Name: value`, headers it sends when it dials, for an access layer in front of the other Space (a Cloudflare Access service token). The `--apps` list always names apps **owned by the machine where the command runs**: installed packages, or spec-1 apps with a `service.port`, which are shared API-only ([app-packages.md](app-packages.md#source-apps-over-a-connection)). On a peer's outgoing connection it controls Hub-to-peer access and starts empty. `grant` replaces the list; an app left off it loses its in-flight requests and sockets, the connection and the other apps' streams stay up.

`scopes` sets what the other Space may do through this machine's peer API ([app-packages.md](app-packages.md#peer-scopes)): `--scopes` replaces the ticked list (`panel`, `agents`, `events`, `model`, `tasks`, `terminal`, `apps`, `manage`; empty grants none), `--full-trust on|off` the switch that grants every scope, present and future. Turning full trust on asks first, or needs `--yes` without a terminal; `create` takes `--scopes`, `--full-trust` and `--alias` too. A removed scope ends only the streams that needed it. `alias` names the other Space here as a peer (default: the name it gives itself); give it a legacy peer's old name to keep that peer's stored state ([peers.md](peers.md#adding-a-peer)). `ls` shows for each connection what this machine grants (`apps here`, `scopes here`) and, under `peer`, whether the other Space is a peer here with what it grants, or why it is not. `space peer ls` lists every peer, legacy and connection ones; a connection peer's `url` reads `connection:<id>`.
