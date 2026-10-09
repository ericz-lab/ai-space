<div align="center">

<img src="docs/logo.png" alt="ai-space logo" width="140">

<h1>ai-space<br/><sub>A self-hosted home for your AI agents, apps and their data.</sub></h1>

<p>
  <a href="#-quickstart">Quickstart</a> ·
  <a href="#-key-features">Features</a> ·
  <a href="#%EF%B8%8F-architecture">Architecture</a> ·
  <a href="#-documentation">Docs</a> ·
  <a href="docs/roadmap.md">Roadmap</a>
</p>

<p>
  <img alt="status: early stage" src="https://img.shields.io/badge/status-early_stage-orange">
  <img alt="runtime: Bun" src="https://img.shields.io/badge/runtime-Bun-black?logo=bun">
  <img alt="language: TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white">
  <img alt="self-hosted" src="https://img.shields.io/badge/self--hosted-one_server-2ea44f">
  <img alt="agents: Claude Code and Codex" src="https://img.shields.io/badge/agents-Claude_Code_·_Codex-d97757">
</p>

<p>English | <a href="README.zh-CN.md">中文</a></p>

</div>

---

**ai-space turns one server into a long-running home for your AI.** Your agents, the apps they work in, and the data both produce live in one system behind one web panel, instead of in a dozen tools that do not know about each other.

You use it through three things:

- 🧩 **Apps** hold structured information and the scenarios you work in, and give the AI lasting context.
- 🤖 **Agents** take on complex, unstructured requests and carry out the work.
- 📊 **Widgets** keep the important state and results visible at a glance.

Underneath, the core gives every app what a running AI system needs and nobody wants to build twice: scheduled and event-driven tasks, notifications, model calls with a usage ledger, storage, daily backups, and one panel over several machines.

> [!NOTE]
> ai-space is at an early stage. The services listed below work today; the app contract and APIs may still change. See [Status](#-status).

## ✨ What it looks like in practice

| You want… | ai-space does it with |
| --- | --- |
| A dashboard of what Claude Code spent on every machine | The default app [ai-usage](https://github.com/ericz-lab/ai-usage), shown as a widget on the panel |
| An agent that runs every morning and pings you on Telegram when it finds something | A `cron` task with an `agent` target in the app's `space.yaml`, plus one `POST /api/notify` |
| One app reacting when another one changes | The app publishes an event; the other consumes it as a task trigger or an http delivery |
| To ask any app's agent a question from your phone | The panel's chat, behind your own domain and a Cloudflare Access login |
| To build a new app without writing glue | Ask your coding agent; the shared [`space-app`](skills/space-app/SKILL.md) skill scaffolds it to the [app spec](docs/app-spec.md) |

## 🌟 Key features

- 🏠 **Own everything.** One server, one directory (`~/.ai-space`), plain files and SQLite. Data leaves it only for the model runtimes, bucket and chat apps you configure.
- 🤖 **Agents you already use.** Agents run as [Claude Code](https://claude.com/claude-code) or Codex sessions, with their skills, MCP tools and memory; the Anthropic API and DeepSeek Harness are runtimes too. → [runtimes](docs/runtimes.md)
- 🗓️ **Scheduler.** `at` / `every` / `cron` schedules and event triggers, with `http`, `command` and `agent` targets. → [scheduler](docs/scheduler.md)
- 🔌 **Bus.** Events and calls between apps, delivered at least once, with a catalogue and a history. → [events](docs/events.md)
- 🔔 **Notify.** One call reaches Telegram, Discord, Slack, Feishu, DingTalk, WeCom, Bark, ntfy or a webhook; queued, rate limited, retried, and gathered in a panel inbox. → [notify](docs/notify.md)
- 🧠 **Model calls.** One `POST /api/model/run` for every app, a concurrency cap, and a ledger of tokens by app, purpose and model. → [model](docs/model.md)
- 💬 **Chat.** Threads with image attachments and an embeddable widget for apps' own pages. → [chat](docs/chat.md)
- 💾 **Storage & backup.** Per-app SQLite or PostgreSQL and a blob store; daily snapshots to any S3 bucket, weekly verification, restore. → [storage](docs/storage.md) · [backup](docs/backup.md)
- 🛠️ **Supervision.** ai-space can run each app's service as a systemd user unit (a LaunchAgent on macOS) and keep it in step with the manifest. → [supervision](docs/supervision.md)
- 🖥️ **Panel.** App launcher, agent chat, widgets, task history, inbox, in English or Chinese; it counts how often each app and agent is opened and for how long. → [panel](docs/panel.md) · [usage](docs/usage.md)
- 🌐 **Peers.** One panel over several machines. → [peers](docs/peers.md)
- ⌨️ **Web terminal** (off by default) and a **`space` CLI** for everything the API does. → [terminal](docs/terminal.md) · [cli](docs/cli.md)

## 🚀 Quickstart

The recommended install is to **let a coding agent do it**. It follows a written procedure, stops at the browser logins, and tells you what to click.

```text
# From a checkout on your laptop, in Claude Code or Codex:
> Install ai-space on <host> following docs/install-by-agent.md

# Or on the server itself:
git clone <this repository> ~/.ai-space/core && cd ~/.ai-space/core
claude   # then: "install ai-space on this machine"
```

Procedure: [docs/install-by-agent.md](docs/install-by-agent.md). Reference: [docs/install.md](docs/install.md).

<details>
<summary><b>Install by hand</b> (user-level systemd, no sudo)</summary>
<br/>

On the target machine, with Bun installed under `~/.bun`:

```bash
ssh <host> "git init --bare ~/ai-space.git"
scp deploy/post-receive <host>:~/ai-space.git/hooks/post-receive && ssh <host> chmod +x ~/ai-space.git/hooks/post-receive
git remote add <host> <host>:~/ai-space.git
git push <host> main      # checks out into ~/.ai-space/core, runs deploy/install.sh, restarts the unit
```

`deploy/install.sh` installs `deploy/ai-space.service` into `~/.config/systemd/user/`, enables linger, and restarts the service. Logs: `journalctl --user -u ai-space -f`.

Then run `bun run setup` in `~/.ai-space/core`. It checks the tools ai-space spawns (claude, gh, cloudflared, and the optional `cf` CLI), asks for every workspace `.env` value section by section, sends a test notification, probes the bucket, and prints what is left to do on Cloudflare as `cf` commands ([docs/cloudflare.md](docs/cloudflare.md)).

</details>

### What you need

Five things, in the order you will use them. The first two are required; the rest make the result usable from anywhere and safe to keep.

| # | What | Why |
| --- | --- | --- |
| 1 | **A coding agent** ([Claude Code](https://claude.com/claude-code), Codex, …) with its login | It installs ai-space, the panel's agents run as it, and you build apps with it |
| 2 | **A Linux server** (Debian/Ubuntu, systemd, SSH key) that stays on | 1 vCPU / 2 GB runs the core with swap; 2 vCPU / 4 GB is comfortable with several apps (each agent session is about 150 MB) |
| 3 | **A Cloudflare account** (free tier) | Tunnel publishes the panel with no open port, Access puts a login in front, R2 (10 GB free) holds backups |
| 4 | **GitHub CLI** (`gh`), logged in on the server | The agent clones, commits and pushes app repositories with one login and no deploy keys |
| 5 | **A domain on Cloudflare** | One hostname per app, `space.example.com` for the panel |

Without 3 and 5 the panel stays on loopback, reachable through an SSH port forward, and backups need another S3 bucket.

## 🏗️ Architecture

![ai-space architecture](docs/architecture.svg)

- **Application layer.** One web UI is the only entry: installed apps, chat with any agent, app widgets, notifications and settings. Each app owns one or more agents and may contribute widgets.
- **Space layer (ai-space core).** Shared services every app and agent calls through one Space API instead of building their own. The core also keeps the app registry, routes requests to the right agent, and handles auth.
- **Runtime layer.** Agents run as Claude Code or Codex sessions; skills, MCP tools, memory and LLM access come from the runtime, and agents reach the Space API as tools.
- **Infrastructure layer.** One dedicated Linux server with Bun, SQLite and the filesystem, and a public domain.

## 📁 Your data

Everything ai-space owns on a machine lives in one directory, `~/.ai-space` by default (override with `SPACE_HOME`). No lock-in: it is plain files and SQLite, readable without ai-space running, and backed up daily.

```
~/.ai-space/
├── core/    ai-space itself (this repository) when deployed with deploy/
├── apps/    one directory per app; any app with a space.yaml is scheduled automatically
├── data/    runtime state (SQLite) and per-app data directories
├── logs/
└── .env     ai-space configuration plus the secrets app manifests reference via ${VAR}
```

`bun run init` creates it and installs the default apps, each a public repository cloned into `apps/` and started by its own installer. Today that is [ai-usage](https://github.com/ericz-lab/ai-usage). `SPACE_DEFAULT_APPS=none` in `.env` skips them; a list of clone URLs replaces them.

## ⌨️ Usage

The panel is the everyday entry. For scripts, tasks and SSH there is one `space` command on `PATH`:

```bash
space status                          # health, services, tasks, backups, model load, peers
space app ls                          # every app in the workspace
space task run <app>/<task> --wait    # run a task now and wait for the result
space logs <app> -f                   # follow an app's log
space model usage                     # tokens by app and model
space usage --window 7d               # opens and time in use by app and agent
space notify send "hello"             # test the notification channels
space backup ls                       # snapshots of every app's data
```

Tables by default, `--json` for scripts. `space <command> help` lists the verbs; [docs/cli.md](docs/cli.md) is the design.

## 🔒 Security

An AI system with shell access deserves a clear boundary. In short:

- **No open port.** The panel and apps are published through a Cloudflare Tunnel, never by listening on the public interface. → [ingress](docs/ingress.md)
- **A login in front.** Cloudflare Access guards the panel and every app hostname. Without it, keep the panel on loopback.
- **Tokens for apps.** Every app calls the Space API with its own token; tokenless writes from another site's page are refused. → [panel trust boundary](docs/panel.md#trust-boundary)
- **The web terminal is off by default.** When enabled it uses one-time tickets, same-origin checks, an optional passphrase, idle limits, a session cap and an audit row per session. → [terminal](docs/terminal.md)
- **Agents act with your account.** They run as your user, with your coding agent's login. Model calls run under a concurrency cap and are recorded in the ledger, so cost stays visible.

## 🤔 Why ai-space

A coding agent on a server can already do a lot. What it lacks is a place to keep going: something that wakes it on a schedule, remembers what it did, hands its result to another program, and tells you when it matters. ai-space is that place. It is not a workflow builder or a chat front-end. It is the shared layer between the agents you already use and the small apps you build with them.

<details>
<summary><b>Compared with other tools</b></summary>
<br/>

| | ai-space | A bare agent on a server | Workflow builders | Chat front-ends |
| --- | --- | --- | --- | --- |
| Agents | Claude Code / Codex sessions with their own tools | Same | Mostly model API calls inside a flow | Mostly model API calls |
| Schedules & events | Built in, declared per app | cron by hand | Built in | Varies |
| Apps with their own UI and data | Yes, via `space.yaml` | Ad hoc | Varies | Varies |
| Notifications, backups, usage ledger | Shared services | By hand | Partial | Partial |
| Where it runs | Your server, plain files | Your server | Self-hosted or cloud | Self-hosted or cloud |

If you mostly want a drag-and-drop pipeline or a multi-user chat UI over model APIs, a dedicated tool will serve you better. ai-space fits when the agents do the work and you want them to keep running.

</details>

## 📈 Status

In place: the scheduler (schedules and event triggers), the bus, storage (databases and blob hand-over), backups, notifications and the inbox, model calls with a usage ledger, chat with images and an embeddable widget, the panel, peers, the web terminal, the `space` CLI, service supervision and the interactive `setup`.

Next, roughly in order:

- [ ] **Supervision hand-over**: `space app supervise <app>` with a health check and a rollback; resource limits in the unit.
- [ ] **Skills mounting**: make `skills:` and `memory:` from the manifest available to agent sessions. Shared and app skills are already linked into `<workspace>/.claude/skills/`.
- [ ] **Managed blob API**: index table, streaming routes and presigning on top of the blob stores that are already provisioned.
- [ ] **App tooling**: `schema/space.schema.json`, `validate` and `/api/spec`.

The per-area table is in [docs/app-spec.md](docs/app-spec.md#implementation-status). The longer view, measured against what an operating system gives its programs, is in [docs/roadmap.md](docs/roadmap.md).

## 📚 Documentation

| Getting started | Building apps | Running a space | Internals |
| --- | --- | --- | --- |
| [Install by agent](docs/install-by-agent.md) | [App spec](docs/app-spec.md) | [CLI](docs/cli.md) | [Runtimes](docs/runtimes.md) |
| [Install by hand](docs/install.md) | [`space-app` skill](skills/space-app/SKILL.md) | [Backup](docs/backup.md) | [Router](docs/router.md) |
| [Cloudflare](docs/cloudflare.md) | [Scheduler](docs/scheduler.md) | [Supervision](docs/supervision.md) | [Ingress](docs/ingress.md) |
| [Machines](docs/machines.md) | [Events & calls](docs/events.md) | [Peers](docs/peers.md) | [Time fields](docs/time.md) |
| | [Storage](docs/storage.md) | [Terminal](docs/terminal.md) | [i18n](docs/i18n.md) |
| | [Notify](docs/notify.md) · [Model](docs/model.md) · [Chat](docs/chat.md) | [Panel](docs/panel.md) · [Usage](docs/usage.md) | [Roadmap](docs/roadmap.md) |

## 🧑‍💻 Development

```bash
bun install
bun run init           # create ~/.ai-space (idempotent)
bun run start          # boot the Space API and the panel on 127.0.0.1:8700
bun run dev            # hot reload, including the web UI
bun run check          # typecheck + tests
bun run hooks          # once per clone: run the checks before every push
```

Local configuration goes in `~/.ai-space/.env` (see `.env.example`); process environment variables win over it. Read [AGENTS.md](AGENTS.md) before contributing (work style, repository map, commit format) and [CLAUDE.md](CLAUDE.md) for Bun conventions.
