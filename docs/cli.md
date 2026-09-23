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
space app     ls | show | sync | hide | unhide | uninstall | env | new
space task    ls | show | run | runs | enable | disable | create | rm
space logs    <app> [-n 100] [-f]     an app's log, or `space logs space` for ai-space itself
space model   usage | calls | status | run | import
space notify  send | ls | channels | test
space backup  run | ls | verify | restore
space chat    ls | import
space event   ls | emit
space peer    ls
space router  show | sync
space api     <METHOD> <path> [body]  the escape hatch: one raw call with the token added
space init | setup | start | install-defaults
```

The CLI is a client of the running ai-space, not a second implementation of it:

```
space task run x ──── HTTP + token ────▶ 127.0.0.1:8700 /api/tasks/x/run
                                              │
                                        the same code the panel uses
```

Rules:

- **One implementation per operation, in the service.** A verb that has a route calls the route; a verb that has none gets the route first, then the verb. The CLI never opens `space.db` for something the API can answer. The exceptions are the commands that must work with ai-space down or before it exists: `init`, `setup`, `start`, `install-defaults`, `app env` (reads the storage inventory), `app new`, `backup run`, `backup verify`, `backup restore`, `model import`, `chat import`. They stay disk-bound, as they were. `backup run` is disk-bound on purpose: it is the command the daily task spawns, and an operator typing it wants the synchronous result, not a 202.
- **Same command anywhere.** On the machine it talks to loopback. From a task's `command:` it inherits `SPACE_API_URL` and `SPACE_APP_TOKEN` from `space.env`, so `space notify send` and `space event emit` need no `--app`. From the laptop it reaches a machine through a forwarded port (`SPACE_API_URL=http://127.0.0.1:8701`) or, simpler, `ssh <host> space ...`, since the binary is there. Peers are not addressed through the hub: a peer exposes `/api/peer/*` only, and its tasks, logs and backups stay on that machine ([peers.md](peers.md)).
- **Readable by default, parseable on request.** Human output is a table with fixed columns, relative times and no color. `--json` prints exactly what the route returned, so an agent or a script gets the API's own shape and nothing invented by the CLI. Errors go to stderr as `space: <what>`; stdout carries only the result, so `eval "$(space app env x)"` and `space task ls --json | jq` stay clean.
- **stdin only when asked.** A body or a prompt comes from the argument, from `--json-file`, or from stdin when the argument is `-`. The CLI never reads stdin on its own: inside a task or a hook, stdin may be a pipe nobody closes, and a command that waits on it hangs the run.
- **Questions only on a terminal.** `app uninstall` and `task rm` ask before acting; `--yes` skips the question, and without a terminal the question is a usage error rather than a silent default.
- **Honest exit codes.** `0` done; `1` the operation failed (the server said no, a run failed, a delivery errored under `--wait`); `2` usage; `3` ai-space not reachable. The older `notify` returned `1` for both failure and unreachable; the scheduler's hooks only test for non-zero, so the split is safe.
- **No new dependency.** Argument parsing is by hand, as `parseNotifyArgs` does today; there are twelve nouns, not a hundred flags.
- **The old spellings keep working.** `bun src/index.ts backup <app>` is what the backup task spawns and what the older docs say. `main.ts` keeps them as aliases (`env` → `app env`, `backup` → `backup run`, `backup-verify` → `backup verify`, `backups` → `backup ls`, `restore` → `backup restore`, `model-import` → `model import`, `chat-import` → `chat import`; `notify …` is `notify send …` because `send` is that noun's default verb). Nothing outside the checkout changed on the day the CLI landed.

## Commands

`APP` and `TASK` are names as the API knows them; a task is `<app>/<task>` or its id.

| Command | Does | Route or file |
| --- | --- | --- |
| `space status` | health, app services with their health, tasks failing or overdue, last backup per app, model calls in flight, peers up or down; one screen | `/healthz`, `/api/services`, `/api/tasks`, `/api/backups`, `/api/model/status`, `/api/peers` |
| `space app ls [--panel]` | every app: title, status, service health, url, hidden (`--panel`: only what the panel shows) | `GET /api/apps?all=1` |
| `space app show APP` | the manifest as synced, storage, tasks, agents, widgets, last backup | `GET /api/apps/:app`, `.../storage`, `.../backups` |
| `space app sync [APP]` | re-read one `space.yaml` or every app directory | `POST /api/apps/sync`, `POST /api/apps/:app/sync` |
| `space app hide APP` / `unhide` | the panel's hidden flag | `PATCH /api/apps/:app` |
| `space app uninstall APP [--yes] [--force]` | stop, remove, forget; asks unless `--yes`; refuses while a task of the app runs unless `--force` | `DELETE /api/apps/:app` |
| `space app env APP` | `export` lines of the provisioned variables | disk (`storage.envFor`) |
| `space app new NAME [--dir D] [--title T] [--port N] [--no-github]` | the `new-app` command of [app-spec.md](app-spec.md): the `space-app` template filled in, `git init`, first commit, a private repository under `SPACE_GITHUB_OWNER` when set | disk (`newapp.ts`) |
| `space task ls [--app APP] [--failing]` | task, schedule, enabled, last run, next run | `GET /api/tasks` |
| `space task show TASK` | effective view, state, last runs | `GET /api/tasks/:id`, `/runs?limit=5` |
| `space task run TASK [--wait] [--timeout D]` | force a run; `--wait` polls the run history to its end, prints the output and exits with its status | `POST /api/tasks/:id/run`, then `GET .../runs` |
| `space task runs TASK [-n 20] [--output]` | history, newest first (`--output`: each run's captured output) | `GET /api/tasks/:id/runs` |
| `space task enable` / `disable TASK` | `{ enabled }` override; `--reset` clears it | `PATCH /api/tasks/:id` |
| `space task create` / `rm TASK [--yes]` | an API task from flags (`--app --name --cron\|--every\|--at --http\|--command`), a JSON argument, `-` or `--json-file`; delete an API task or an orphaned manifest task with its history (a live manifest task is removed in `space.yaml`) | `POST`, `DELETE /api/tasks` |
| `space logs APP [-n N] [-f]` | the app's log, tail or follow; `space logs space` for ai-space | `GET /api/apps/:app/logs` (new, below) |
| `space model usage [--window 24h] [--app APP]` | sums by app, tag, model, runtime; the same numbers as the panel's Model usage | `GET /api/model/usage` |
| `space model calls [--app] [--tag] [-n]` | recent calls | `GET /api/model/calls` |
| `space model status` | runtimes, concurrency, in flight | `GET /api/model/status` |
| `space model run [--app] [--model] [--tag] [--system] PROMPT\|-` | one call, the answer streamed to stdout (`stream: true`); `--json` for the whole answer with the ledger row | `POST /api/model/run` |
| `space model import APP FILE` | today's `model-import` | disk |
| `space notify send [--level] [--title] [--wait] TEXT` | today's `notify`, same flags | `POST /api/notify` |
| `space notify ls [--app] [-n]` | history with deliveries | `GET /api/notifications` |
| `space notify channels` / `test NAME` | channels and their state; a test message | `GET /api/notify/channels`, `POST .../test` |
| `space backup run APP` | snapshot now, synchronously: the same code the daily task spawns | disk (`backup/cli.ts`) |
| `space backup ls [APP] [--target]` | every app's last snapshot, or one app's list; `--target` lists the bucket itself, no ai-space needed | `GET /api/backups`, `GET /api/apps/:app/backups` |
| `space backup verify` / `restore APP ...` | today's `backup-verify` and `restore`, unchanged | disk |
| `space chat ls --app APP --scope S` / `import` | threads of one scope; the older `chat-import` | `GET /api/chat/threads`, disk |
| `space event ls [--name] [--app]` / `emit NAME [--data JSON]` | recent events; publish one | `GET`, `POST /api/events` |
| `space peer ls` | health, snapshot age, app counts | `GET /api/peers` |
| `space router show` / `sync` | routes with status; write and reload | `GET /api/router`, `POST /api/router/sync` |
| `space api METHOD PATH [BODY\|-] [--app]` | one call with the operator token (`--app`: the app's own); JSON pretty-printed, SSE one line per event | any |
| `space init` / `setup` / `start` / `install-defaults` | the lifecycle commands, unchanged | disk |
| `space completion zsh\|bash` | a completion script from the same command table the help prints | |

Global flags, before or after the noun: `--json`, `--url <api url>`, `--token <token>`, `-q` (no table header), `--help` at every level. `space` alone and `space <noun>` alone print the help of that level; a noun whose only verb takes no argument (`status`, `init`, `setup`, `start`) runs it.

Two aggregate views deserve one line each. `space status` is composed in the CLI from six existing routes rather than from a new `/api/status`, because it is the only reader and the routes already answer in milliseconds from the health cache. `space model usage` prints the same table the panel does; the CLI is the place to check a bill from a task or a cron mail without opening a browser.

## The one new route: logs

`space logs` was the one verb the API could not answer: service supervision (start, restart, log collection under `<workspace>/logs/<app>/`) is planned in [app-spec.md](app-spec.md#implementation-status) but not built, and apps run as user units today.

Rather than have the CLI shell out to `journalctl` itself (which would tie it to systemd and to the machine it runs on), the route went in first and hides where the log lives (`src/space/logs/`):

```
GET /api/apps/:app/logs?lines=100          the last N lines, text/plain, the command's exit code in x-exit-code
GET /api/apps/:app/logs?follow=1           the same, then new lines as they come: SSE, one `line` event each,
                                           a comment every 15 s, `end` {code} when the command exits
GET /api/apps/space/logs                   ai-space's own log (the `ai-space` unit)
```

The backend is a per-machine command template, like `SPACE_SERVICE_STOP`: `SPACE_SERVICE_LOGS` in the workspace `.env`, with `{app}` (the unit), `{lines}` and `{follow}` (`-f` or nothing) substituted, default `journalctl --user -u {app} -n {lines} --no-pager {follow}`; on a machine without journald, `tail -n {lines} {follow} <dir>/{app}.log` does. Only those three words are substituted, only for a plain app name, and only for an app the space knows (or `space`), so the request cannot smuggle a shell word into the operator's template. The command runs under a shell wrapper that forwards the kill to its child: when the reader leaves, `journalctl -f` dies with it instead of living on under init. Operator token required: a log is not panel data. When supervision lands and ai-space writes the files itself, the route reads them and the template becomes a fallback; the CLI does not change.

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
src/cli/status.ts, app.ts (+ newapp.ts), task.ts, logs.ts, model.ts, notify.ts, backup.ts, chat.ts, event.ts,
        peer.ts, router.ts, api.ts, lifecycle.ts (init, setup, start, install-defaults), completion.ts
src/cli/testing.ts        runCli(): the CLI against a scripted fetch, stdout and stderr collected
src/cli/*.test.ts         every verb: the call it makes, the table it prints, the code it exits with
```

`bin/space` runs the entry point rather than `main.ts` directly so there is exactly one process shape: `src/index.ts` imports the CLI and hands it `boot`, and the CLI never imports the entry point back. What the entry point and the CLI both need (`loadConfig`, the openers) moved to `src/space/config.ts`; the older exports of `src/index.ts` are re-exported from there.

Install: `deploy/install.sh` links `~/.local/bin/space` to `bin/space` of the checkout (the unit and the profile already put `~/.local/bin` on `PATH`, [install.md](install.md) step 1). `package.json` has `"bin": { "space": "bin/space" }`, so a laptop checkout is `bun link` away, and `bun run space …` works without it. The generated workspace `AGENTS.md` ([guide.ts](../src/space/guide.ts)) shows the `space` spellings, the `notify` and `space-app` skills lead with them, and the older documents that still say `bun src/index.ts …` are not wrong: those words are aliases.

URL and token resolution follows what the process already has. URL: `--url`, then `SPACE_API_URL` (set in a task's command and in every app's `space.env`), then `SPACE_HOST` and `SPACE_PORT` from the workspace `.env`, then `http://127.0.0.1:8700`. Token: `--token`, then `SPACE_APP_TOKEN` (a task's command), then `SPACE_API_TOKEN` from the environment or the workspace `.env`. The CLI reads that `.env` only for these values and only when they are not already set, so a run from anywhere on the machine works without `cd`.

## What shipped

Everything in the table, in one change: the skeleton with help and exit codes, the older commands under their nouns with aliases, every read and write verb, the logs route with `SPACE_SERVICE_LOGS`, `task run --wait`, `app new`, `completion`, the `install.sh` link and the `bin` entry. Still to come, behind the same route and verbs: the supervisor's own log files once service supervision ships.

## Not in this design

- **Remote operation through the hub.** `space --on david task ls` would need the peer to expose its whole API to the hub, which [peers.md](peers.md) deliberately does not. `ssh david space task ls` is the same keystrokes and keeps the boundary.
- **A TUI.** Tables and `-f` are enough; the panel is the interactive view.
- **Service control** (`space app restart`). It belongs to supervision, with logs; until then the unit is the unit.

Model calls accept `space model run --mode slim|full --system "Custom instructions" PROMPT`.
The default text-only mode is slim. Full retains native runtime context and tools;
custom system instructions are supported in either mode. See [completion modes](runtimes.md#completion-modes).
