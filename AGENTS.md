# AGENTS.md - AI Agent Coding Guide

This guide is for AI coding agents working in the ai-space repository. Read it before changing code. Human contributors follow the same rules.

## Project Snapshot

ai-space is a workspace for AI-related experiments and tools, written in TypeScript and run with Bun. Bun handles dependency installation, running, testing, and building. The project is at an early stage; the directory layout will evolve as modules are added. Update the Repository Map below whenever you add a directory.

If you were started inside a checkout on a machine where ai-space is not installed yet, or asked to install it on another machine, follow [docs/install-by-agent.md](docs/install-by-agent.md); [docs/install.md](docs/install.md) is the reference it points into.

## Language

English is the default language of this repository. Write code identifiers, comments, documentation, commit messages, issues, and PR descriptions in English. The one translation is `README.zh-CN.md`, a Chinese mirror of `README.md`: when you change the README, change both.

## Work Style

- Keep changes focused on one problem.
- Prefer existing patterns in the file or nearby module over new abstractions.
- Avoid unrelated formatting, renames, dependency changes, or broad rewrites.
- Add or update tests when behavior changes.
- Update docs when setup, commands, or user-facing behavior changes.
- For new features, larger refactors, new dependencies, or runtime changes, open an issue or state the motivation in the PR description before starting.
- Run the local checks in [Validation](#validation) before every push. Do not push unverified code.

## App Development Mode

When the user starts development from the ai-space source checkout and asks to work on an app, establish the app's source directory before editing:

- Use the app source directory specified by the user when one is provided.
- Otherwise, default to `.ai-space/app-src/<app-name>/` relative to the ai-space repository root. State the resolved path and proceed with this default without requiring confirmation.
- Keep app source changes in that directory and follow its own `AGENTS.md` instructions. Run the app's commands and Git operations from its source directory; keep ai-space platform changes in the ai-space checkout.

## Stack And Conventions

- TypeScript with `strict` mode and ESM imports. Local imports include the `.ts` extension (`allowImportingTsExtensions`).
- Bun 1.3+ as runtime and package manager: `bun install`, `bun run`, `bun test`. Do not use npm, yarn, pnpm, node, ts-node, jest, or vitest.
- Prefer Bun built-in APIs (`Bun.serve`, `Bun.file`, `bun:sqlite`, `Bun.$`). See [CLAUDE.md](CLAUDE.md) for Bun-specific conventions.
- Dependencies are locked in `bun.lock`; commit it together with the change that touched it.
- Configuration and secrets go through environment variables or `.env` (ignored by git). Never commit credentials.
- Scripts and commands live in `package.json`, not only in chat history.

## Repository Map

- `.ai-space/app-src/` - ignored, independent app source checkouts used during app development.

- `src/` - source code. Entry point is `src/index.ts` (boots Space services and serves the Space API). Tests sit next to the code they test and are named `*.test.ts`.
- `src/space/` - Space layer services shared by every app. One directory per service. `workspace.ts` defines the `~/.ai-space` layout, creates it, discovers apps and loads the workspace `.env`. `skills.ts` links the shared skills and every app's skills into `<workspace>/.claude/skills/` on boot, `init` and each workspace sync. `guide.ts` generates the workspace `AGENTS.md` (template with a "This machine" section from `SPACE_NAME`, hostname, user and workspace path, plus the operator's `AGENTS.local.md`, written once) and links `CLAUDE.md` to it, on boot, `init` and each workspace sync, for sessions of any agent tool started by hand there.
- `src/space/scheduler/` - scheduled and event-driven tasks: `types.ts` (data model), `schedule.ts` (at/every/cron next-run math), `events.ts` (event names, trigger matching, run payload), `store.ts` (bun:sqlite: tasks, runs, events), `targets.ts` (http/command/agent runners), `manifest.ts` (`space.yaml` parsing), `scheduler.ts` (engine: ticks, publish, pending delivery), `api.ts` (HTTP routes). Design notes in `docs/scheduler.md`.
- `src/space/bus/` - events and calls between apps (docs/events.md): `types.ts` (data model, limits), `spec.ts` (the `events:` and `provides:` manifest sections; `consumes` with `task:` becomes a trigger), `store.ts` (bun:sqlite: deliveries, calls), `bus.ts` (engine: one delivery per matching subscription, http worker with retries, stream push and ack, calls forwarded to the provider), `prompt.ts` (the catalogue as a system-prompt section for agents), `api.ts` (HTTP routes, the SSE stream, calls forwarded to a peer).
- `src/space/storage/` - per-app storage: `types.ts` (data model), `db.ts` (open by URL on Bun's `SQL`, migrations), `spec.ts` (`storage:` manifest section), `storage.ts` (database and blob store provisioning, inventory, `space.env`), `api.ts` (HTTP routes). Design notes in `docs/storage.md`.
- `src/space/storage/backup/` - backups: `types.ts` (spec, snapshot manifest, keys), `spec.ts` (`backup:` manifest section, per-app minute), `snapshot.ts` (staging: `VACUUM INTO`, file copy with excludes), `archive.ts` (tar + zstd, hashing), `target.ts` (file and S3 backends), `catalog.ts` (sidecars in the target), `store.ts` (`backups` index in space.db), `retention.ts` (counted keep), `run.ts` (one backup run + prune), `verify.ts`, `restore.ts`, `tasks.ts` (the scheduler tasks), `api.ts` (HTTP routes), `cli.ts` (`backup`, `backup-verify`, `backups`, `restore` subcommands). Design notes in `docs/backup.md`.
- `src/space/notify/` - chat notifications: `types.ts` (data model), `channels.ts` (`SPACE_NOTIFY_*` URLs and per-kind limits), `render.ts` (text composition, escaping, splitting), `transports.ts` (one sender per chat app), `spec.ts` (`notify:` manifest section and request validation), `store.ts` (bun:sqlite), `engine.ts` (outbox, workers, retries, dedup, caps), `api.ts` (HTTP routes), `tasks.ts` (scheduler hook), `testing.ts` (scripted fetch for tests). Design notes in `docs/notify.md`.
- `src/space/runtimes/` - the AI runtimes a space starts, one layer for the model service, the scheduler and the panel: `types.ts` (the three operations, specs, adapter interface), `process.ts` (spawn and collect with process-group kill), `claude-code.ts`, `codex-cli.ts` (text completions, local or SSH; persistent local chat), `deepseek-harness.ts`, `anthropic-api.ts`, `transcripts.ts` (past chat sessions from each runtime's records), `config.ts` (`runtimes.yaml` and the `.env` fallback), `registry.ts` (by name, `runtime/model` resolution and four capability tiers: basic/基础 = Haiku/Luna, junior/初级 = Sonnet/Terra, intermediate/中级 = Opus/Sol, advanced/高级 = Fable/Astra), `testing.ts` / `testing-dsh.ts` (the CLI stand-ins tests use). Design notes in `docs/runtimes.md`.
- `src/space/model/` - model calls for apps and agent tasks: `types.ts` (data model), `spec.ts` (request validation), `store.ts` (bun:sqlite ledger and sums), `service.ts` (runtime resolution, concurrency cap, recording), `api.ts` (HTTP routes), `tasks.ts` (scheduler hook for agent runs), `import.ts` (an app's own history). Design notes in `docs/model.md`.
- `src/space/chat/` - conversations for apps' pages: `types.ts` (threads, messages, attachments, caps), `store.ts` (bun:sqlite), `spec.ts` (validation), `prompt.ts` (the thread as one prompt), `service.ts` (attachments on disk, one turn through the model service), `api.ts` (HTTP routes and the event stream), `import.ts` (an app's own chats). The widget apps embed is `src/web/chat-widget/` (vanilla TS, bundled at boot by `build.ts`). Design notes in `docs/chat.md`.
- `skills/` - shared skills apps reference as `space:<name>`; one directory per skill with a `SKILL.md`.
- `src/space/panel/` - the panel's server side: `registry.ts` (registered manifests), `layout.ts` (order and hidden set in `space.db`), `health.ts` (service probe), `widgets.ts` (widget feed and cache), `view.ts` (API shapes), `links.ts` (manifest-only apps), `api.ts` (HTTP routes). Design notes in `docs/panel.md`.
- `src/space/peers/` - one panel over several machines: `config.ts` (`SPACE_PEER_*`), `client.ts` (snapshot refresh, forwarding), `store.ts` (last snapshot in `space.db`), `merge.ts` (peer views with the `<peer>/` prefix), `hub.ts` (every peer), `serve.ts` (this space as a peer: `/api/peer/*`, including the GET proxy to a local app's own `/api/*`), `api.ts` (hub routes). Design notes in `docs/peers.md`.
- `src/space/router/` - a hostname for every app without a per-app registration (docs/router.md): `types.ts` (routes, status), `config.ts` (`SPACE_ROUTER`, `SPACE_DOMAIN`, `SPACE_ROUTER_PORT`, `SPACE_PANEL_HOST`), `table.ts` (registry to routes: wildcard / explicit / conflict), `caddyfile.ts` (routes to a Caddyfile, pure), `caddy.ts` (write when changed, reload over the admin socket), `router.ts` (coalesced sync after every registry change, last result), `api.ts` (`GET /api/router`, `POST /api/router/sync`). The manifest's path form of `url` resolves in `src/space/defaults.ts`.
- `src/space/terminal/` - the web terminal (docs/terminal.md): `config.ts` (`SPACE_TERMINAL_*`, the environment strip), `pty.ts` (`Bun.Terminal` and `python3` PTY backends, `pty_helper.py`), `service.ts` (one-time tickets, sessions, cap, idle sweep, passphrase lockout), `store.ts` (audit rows in `space.db`), `api.ts` (routes, same-origin check, the `websocket` handler, the bridge to a peer's terminal).
- `src/space/config.ts` - the workspace `.env` and the environment read into one `Config` (`loadConfig`), plus the openers the entry point and the CLI share (`openStorage`, `openBackups`, `backupTaskDefaults`) and the checkout paths (`SPACE_ROOT`, `SHARED_SKILLS`, `ENTRY`).
- `src/space/logs/` - an app's log through the operator's command template (`SPACE_SERVICE_LOGS`, `journalctl` by default) until ai-space collects logs itself: `logs.ts` (template, the shell wrapper that forwards the kill, line reader), `api.ts` (`GET /api/apps/:app/logs`, text or SSE follow). Design in `docs/cli.md`.
- `src/cli/` - the `space` command (`bin/space`, also `bun src/index.ts <command>`; design in `docs/cli.md`): `main.ts` (nouns, aliases of the older spellings, global flags, help, exit codes), `args.ts` (hand-written flag parser), `client.ts` (URL and token resolution, fetch, JSON and SSE readers), `output.ts` (tables, relative times, formatters), `common.ts` (task lookup, schedule text, JSON bodies, confirmations), one file per noun (`status.ts`, `app.ts` with `newapp.ts`, `task.ts`, `logs.ts`, `model.ts`, `notify.ts`, `backup.ts`, `chat.ts`, `event.ts`, `peer.ts`, `router.ts`, `api.ts`, `lifecycle.ts` for `init`/`setup`/`start`/`install-defaults`, `completion.ts`), `testing.ts` (the scripted-fetch runner the tests use). Every verb calls a route of the running ai-space; only the ones that must work with it down touch the disk.
- `src/space/defaults.ts` - the apps a space comes with (`SPACE_DEFAULT_APPS`: cloned by `init`, their installers run by `install-defaults` once ai-space is up) and the per-machine `SPACE_APP_URL_<NAME>` override of a manifest's `url`.
- `src/space/setup.ts` - the interactive `setup` command: tool checks, section-by-section questions for the workspace `.env`, verification (test message, S3 list, peer snapshot), in-place `.env` update. Procedure in `docs/install.md`.
- `src/space/agents/` - chat with agents: `runtime.ts` (a runtime's chat turn as SSE), `sessions.ts` (recent sessions), `transcript.ts` (re-export of the runtimes' transcript readers), `api.ts` (HTTP routes and the space agent).
- `src/web/` - the web UI, bundled by Bun's HTML import: `index.html`, `main.tsx` (root: owns the page language), `App.tsx` (launcher), `Chat.tsx` (chat panel with Base runtime/model-tier selection), `chat-request.ts` (captures runtime/model and permissions for each queued turn), `Tasks.tsx` (scheduled tasks panel with per-task runtime/tier selection), `Events.tsx` (the bus: catalogue, recent events and their deliveries), `Terminal.tsx` (terminal panel: xterm.js over the terminal routes), `Pet.tsx` (desk pet), `petdex.ts` (pet lookup on petdex.dev), `i18n.ts` (English and Chinese dictionaries, language detection, `useLang`, `localized` for manifest text), `styles.css`, `api.ts` (client types, time helpers that take the language), `routes.ts` (page and public files), `public/` (PWA shell, pet sprite, settings icon). `bun run dev` serves it with hot reload. Every user-visible string goes through `t()`; add the key to both dictionaries (design in `docs/i18n.md`).
- `data/` - runtime data (SQLite), ignored by git.
- `docs/` - project documentation and diagrams. `docs/architecture.svg` is the architecture figure used in the README. Service designs: `scheduler.md`, `events.md` (the bus: http and stream deliveries, calls between apps, the catalogue), `storage.md`, `backup.md` (snapshots, retention, verify, restore), `notify.md` (chat notifications, design only), `model.md` (model calls and the usage ledger), `chat.md` (conversations for apps' pages and the embeddable widget), `runtimes.md` (the runtime adapters and `runtimes.yaml`), `panel.md` (web UI, chat, widgets), `peers.md` (one panel over several machines), `terminal.md` (the web terminal and its trust boundary), `i18n.md` (languages of the panel and the manifest's `i18n:` section), `app-spec.md` (the app contract), `install.md` (first install on a server), `ingress.md` (why the outside reaches a space through a tunnel and not an open port), `router.md` (one wildcard tunnel rule and a proxy on loopback whose configuration ai-space writes: a hostname for every app without a registration), `machines.md` (what a session knows about the machine it is on, the portable-skill rule, the pitfalls), and `install-by-agent.md` (the same install done by a coding agent: order, stops, checklist).
- `package.json` - scripts and dependencies; `bun.lock` is the lockfile.
- `tsconfig.json` - TypeScript configuration (strict, bundler mode, noEmit).
- `AGENTS.md` - this file, the agent working guide.
- `CLAUDE.md` - Bun usage conventions.
- `deploy/` - `ai-space.service` (user-level systemd unit), `install.sh` (installs the unit on a machine), `post-receive` (bare-repo hook for git-push deploys).
- `.env.example` - configuration template for `~/.ai-space/.env`.
- `.gitignore` - global ignore rules.

Add a line here when you add a directory.

## Commit Format

Every commit message follows [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

[optional body]

[optional footer]
```

Rules:

- `type` is required; see the table below.
- `scope` is optional and names the affected module or area, for example `launcher`, `deps`, `release`, `typecheck`. Omit the parentheses when there is no clear scope.
- `subject` is in English, lowercase first letter, imperative mood, no trailing period, at most 72 characters.
- Append `(#123)` to the subject when the commit belongs to a PR or closes an issue.
- The body explains why, not what. Put breaking changes in the footer as `BREAKING CHANGE: ...`.
- Reverts use git's default format: `Revert "<original subject>"`.

| type        | use for                                                       |
| ----------- | ------------------------------------------------------------- |
| `feat`      | a new feature                                                 |
| `fix`       | a bug fix                                                     |
| `docs`      | documentation only                                            |
| `chore`     | build, release, dependency bumps, tooling config, housekeeping |
| `refactor`  | code change that neither fixes a bug nor adds a feature       |
| `perf`      | performance improvement                                       |
| `test`      | adding or updating tests                                      |
| `style`     | formatting only, no logic change                              |
| `ci`        | CI configuration and scripts                                  |
| `build`     | build system or external dependency changes                   |
| `hardening` | security hardening, permission tightening, path isolation     |
| `revert`    | reverting a commit (usually via git's `Revert "..."`)         |

Examples:

```
feat(zai): add GLM-5.3-Flash Coding Plan support (#2185)
fix(launcher): route direct Node launch paths through launcher
fix(deps): ship a zero-warning, minimal install (#1784)
chore(main): release 0.30.0 (#2165)
chore: centralize Bun version and refresh CI tool pins (#1123)
docs: add security policy
docs: tighten PR review expectations in CONTRIBUTING and AGENTS
hardening: isolate third-party paths and clean external-build inputs
Revert "fix(release): synchronize web changelog entries (#2100)"
```

Non-compliant examples:

```
update stuff              # missing type
Fix: Bug                  # capitalized type and subject, no information
feat(api): 添加登录接口。   # subject must be English, no trailing period
```

Agent-generated commits follow the same format and keep any tool-required trailer lines (such as `Co-Authored-By`) at the end of the body.

## Validation

Before every push, the following must pass:

```bash
bun install
bun run typecheck
bun test
```

Or run all of it with `bun run check`. While iterating, narrow the scope with `bun test ./src/path/to/file.test.ts`, but run the full check before pushing. Do not bypass failing checks. If a failure is pre-existing, verify it against the current base and document the evidence in the PR.

## Things To Avoid

- Do not switch the Bun runtime, package manager, or build tooling without prior agreement, and do not introduce Node-only toolchains.
- Do not add dependencies without clear project benefit.
- Do not skip tests for behavior changes.
- Do not commit `.env` files, secrets, tokens, or personal data.
- Do not overwrite remote branches with `git push --force`; use `--force-with-lease` when a rewrite is intended.
- Do not ignore review feedback. Decline out-of-scope suggestions with justification instead of silently dropping them.
- Do not surface-patch recurring review findings; repeated fix requests usually indicate a design issue, so find and fix the root cause.
