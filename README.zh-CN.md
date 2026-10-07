<div align="center">

<img src="docs/logo.png" alt="ai-space 标志" width="140">

<h1>ai-space<br/><sub>自托管的 AI 之家：agent、app 和它们的数据都在这里。</sub></h1>

<p>
  <a href="#-快速开始">快速开始</a> ·
  <a href="#-核心特性">特性</a> ·
  <a href="#%EF%B8%8F-架构">架构</a> ·
  <a href="#-文档">文档</a> ·
  <a href="docs/roadmap.md">路线图</a>
</p>

<p>
  <img alt="status: early stage" src="https://img.shields.io/badge/status-early_stage-orange">
  <img alt="runtime: Bun" src="https://img.shields.io/badge/runtime-Bun-black?logo=bun">
  <img alt="language: TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white">
  <img alt="self-hosted" src="https://img.shields.io/badge/self--hosted-one_server-2ea44f">
  <img alt="agents: Claude Code and Codex" src="https://img.shields.io/badge/agents-Claude_Code_·_Codex-d97757">
</p>

<p><a href="README.md">English</a> | 中文</p>

</div>

---

**ai-space 把一台服务器变成 AI 长期运行的家。** 你的 agent、它们工作所在的 app，以及两者产生的数据，都放进同一个系统、通过同一个 web 面板使用，而不是散落在十几个互不相识的工具里。

你通过三样东西使用它：

- 🧩 **Apps** 承载结构化的信息和工作场景，同时为 AI 提供持续的上下文。
- 🤖 **Agents** 负责理解和处理复杂、非结构化的需求，并执行具体任务。
- 📊 **Widgets** 把重要的状态和结果直观地呈现出来，随时可见。

在底层，核心为每个 app 提供一个 AI 系统运行所需、又没人想重复造的能力：定时与事件驱动任务、通知、带用量账本的模型调用、存储、每日备份，以及多台机器共用一个面板。

> [!NOTE]
> ai-space 还在早期阶段。下面列出的服务都已可用；app 契约和 API 仍可能变化。见[状态](#-状态)。

## ✨ 实际用起来是什么样

| 你想要…… | ai-space 怎么做 |
| --- | --- |
| 一个看板，统计每台机器上 Claude Code 花了多少 | 默认应用 [ai-usage](https://github.com/ericz-lab/ai-usage)，以 widget 显示在面板上 |
| 一个每天早上自动运行、发现情况就在 Telegram 上提醒你的 agent | 在 app 的 `space.yaml` 里声明一个 `agent` 目标的 `cron` 任务，再加一次 `POST /api/notify` |
| 一个 app 在另一个 app 变化时做出反应 | 一个 app 发布事件，另一个把它当作任务触发器或 http 投递来消费 |
| 在手机上向任意 app 的 agent 提问 | 面板里的聊天，放在你自己的域名和 Cloudflare Access 登录之后 |
| 不写胶水代码就搭一个新 app | 交给你的 coding agent；共享 skill [`space-app`](skills/space-app/SKILL.md) 按 [app 规范](docs/app-spec.md) 生成骨架 |

## 🌟 核心特性

- 🏠 **一切归你。** 一台服务器、一个目录（`~/.ai-space`）、普通文件和 SQLite。数据只会发往你配置的模型运行时、存储桶和聊天软件。
- 🤖 **用你已经在用的 agent。** Agent 以 [Claude Code](https://claude.com/claude-code) 或 Codex 会话运行，带着它们的 skills、MCP 工具和记忆；Anthropic API 和 DeepSeek Harness 也可作为运行时。→ [runtimes](docs/runtimes.md)
- 🗓️ **调度器。** `at` / `every` / `cron` 时间表和事件触发，`http`、`command`、`agent` 三种目标。→ [scheduler](docs/scheduler.md)
- 🔌 **总线。** App 之间的事件与调用，至少一次投递，带目录和历史。→ [events](docs/events.md)
- 🔔 **通知。** 一次调用即可发到 Telegram、Discord、Slack、飞书、钉钉、企业微信、Bark、ntfy 或 webhook；有队列、限速、重试，并汇总到面板的收件箱。→ [notify](docs/notify.md)
- 🧠 **模型调用。** 所有 app 共用一个 `POST /api/model/run`，有并发上限，token 按 app、用途和模型记账。→ [model](docs/model.md)
- 💬 **对话。** 带图片附件的会话线程，以及可嵌入 app 页面的聊天组件。→ [chat](docs/chat.md)
- 💾 **存储与备份。** 每个 app 一个 SQLite 或 PostgreSQL 数据库加一个对象存储；每日快照到任意 S3 桶，每周校验，可恢复。→ [storage](docs/storage.md) · [backup](docs/backup.md)
- 🛠️ **服务托管。** ai-space 可以把每个 app 的服务作为 systemd 用户单元（macOS 上是 LaunchAgent）运行，并与 manifest 保持一致。→ [supervision](docs/supervision.md)
- 🖥️ **面板。** App 启动器、agent 聊天、widget、任务历史、收件箱，支持中英文。→ [panel](docs/panel.md)
- 🌐 **Peers。** 多台机器共用一个面板。→ [peers](docs/peers.md)
- ⌨️ **Web 终端**（默认关闭），以及覆盖全部 API 能力的 **`space` 命令行**。→ [terminal](docs/terminal.md) · [cli](docs/cli.md)

## 🚀 快速开始

推荐的安装方式是**让 coding agent 来装**。它按一份写好的流程执行，遇到浏览器登录会停下来，告诉你该点什么。

```text
# 在你笔记本上的 checkout 里，用 Claude Code 或 Codex：
> 按 docs/install-by-agent.md 把 ai-space 装到 <host> 上

# 或者直接在服务器上：
git clone <本仓库> ~/.ai-space/core && cd ~/.ai-space/core
claude   # 然后说："在这台机器上安装 ai-space"
```

流程：[docs/install-by-agent.md](docs/install-by-agent.md)。参考：[docs/install.md](docs/install.md)。

<details>
<summary><b>手工安装</b>（用户级 systemd，不需要 sudo）</summary>
<br/>

目标机器上装好 Bun（在 `~/.bun` 下）之后：

```bash
ssh <host> "git init --bare ~/ai-space.git"
scp deploy/post-receive <host>:~/ai-space.git/hooks/post-receive && ssh <host> chmod +x ~/ai-space.git/hooks/post-receive
git remote add <host> <host>:~/ai-space.git
git push <host> main      # 检出到 ~/.ai-space/core，运行 deploy/install.sh，重启单元
```

`deploy/install.sh` 把 `deploy/ai-space.service` 装进 `~/.config/systemd/user/`，开启 linger，重启服务。日志：`journalctl --user -u ai-space -f`。

然后在 `~/.ai-space/core` 里运行 `bun run setup`。它会检查 ai-space 要调用的工具（claude、gh、cloudflared，以及可选的 `cf` CLI），逐节询问工作区 `.env` 的每个值，发一条测试通知，探测存储桶，并以 `cf` 命令的形式打印 Cloudflare 上还需要做的事（[docs/cloudflare.md](docs/cloudflare.md)）。

</details>

### 运行前提

五样东西，按使用顺序排列。前两项必须有，其余的让结果随处可用、可以长期保留。

| # | 是什么 | 为什么 |
| --- | --- | --- |
| 1 | **一个 coding agent**（[Claude Code](https://claude.com/claude-code)、Codex 等）及其登录 | 它安装 ai-space，面板里的 agent 以它运行，你也用它构建 app |
| 2 | **一台常开的 Linux 服务器**（Debian/Ubuntu，systemd，密钥 SSH） | 1 核 2G 加 swap 能跑核心；多个 app 同时运行时 2 核 4G 更从容（每个 agent 会话约 150 MB） |
| 3 | **一个 Cloudflare 账号**（免费套餐） | Tunnel 发布面板、不开端口，Access 在前面加登录，R2（免费 10 GB）存备份 |
| 4 | **GitHub CLI**（`gh`），在服务器上登录 | agent 一次登录即可 clone、提交和推送 app 仓库，不用配 deploy key |
| 5 | **一个托管在 Cloudflare 的域名** | 每个 app 一个主机名，面板用 `space.example.com` |

没有第 3、5 项时，面板只在本机回环地址上，通过 SSH 端口转发访问，备份需要另找一个 S3 桶。

## 🏗️ 架构

![ai-space 架构](docs/architecture.svg)

- **应用层。** 统一的 web UI 是唯一入口：已安装的 app、与任意 agent 对话、app 的 widget、通知和设置。每个 app 拥有一个或多个 agent，可以贡献 widget。
- **空间层（ai-space 核心）。** 每个 app 和 agent 都通过同一个 Space API 调用的共享服务，不必各自造轮子。核心还维护 app 注册表，把请求路由到正确的 agent，并处理鉴权。
- **运行时层。** Agent 以 Claude Code 或 Codex 会话运行；skills、MCP 工具、记忆和模型访问来自运行时，agent 把 Space API 当作工具调用。
- **基础设施层。** 一台专用 Linux 服务器，上面是 Bun、SQLite 和文件系统，外加一个公开域名。

## 📁 你的数据

ai-space 在一台机器上拥有的一切都放在一个目录里，默认 `~/.ai-space`（用 `SPACE_HOME` 覆盖）。没有锁定：都是普通文件和 SQLite，不运行 ai-space 也能读，并且每天备份。

```
~/.ai-space/
├── core/    ai-space 本身（本仓库），用 deploy/ 部署时放在这里
├── apps/    一个 app 一个目录；任何带 space.yaml 的 app 自动进入调度
├── data/    运行时状态（SQLite）和每个 app 的数据目录
├── logs/
└── .env     ai-space 配置，以及 app manifest 通过 ${VAR} 引用的密钥
```

`bun run init` 创建这个目录，并装上默认应用：每个都是一个公开仓库，克隆到 `apps/` 后由它自己的安装脚本启动。目前是 [ai-usage](https://github.com/ericz-lab/ai-usage)。在 `.env` 里设 `SPACE_DEFAULT_APPS=none` 跳过；给一串克隆地址则替换这个列表。

## ⌨️ 使用

日常入口是面板。脚本、任务和 SSH 场景下，`PATH` 上有一个 `space` 命令：

```bash
space status                          # 健康、服务、任务、备份、模型负载、peers
space app ls                          # 工作区里的所有 app
space task run <app>/<task> --wait    # 立即运行一个任务并等待结果
space logs <app> -f                   # 跟踪某个 app 的日志
space model usage                     # 按 app 和模型统计 token
space notify send "hello"             # 测试通知渠道
space backup ls                       # 每个 app 数据的快照
```

默认表格输出，`--json` 给脚本用。`space <command> help` 列出子命令；设计见 [docs/cli.md](docs/cli.md)。

## 🔒 安全

一个有 shell 权限的 AI 系统需要清晰的边界。简要来说：

- **不开端口。** 面板和 app 通过 Cloudflare Tunnel 发布，从不监听公网接口。→ [ingress](docs/ingress.md)
- **前面有登录。** Cloudflare Access 保护面板和每个 app 的主机名。没有它时，让面板只留在回环地址上。
- **App 用令牌。** 每个 app 用自己的令牌调用 Space API；来自其他站点页面、不带令牌的写请求一律拒绝。→ [面板信任边界](docs/panel.md#trust-boundary)
- **Web 终端默认关闭。** 开启后使用一次性票据、同源检查、可选口令、空闲超时、会话数上限，每个会话一条审计记录。→ [terminal](docs/terminal.md)
- **Agent 以你的账号行事。** 它们以你的用户身份、用你的 coding agent 登录运行。模型调用有并发上限并记入账本，成本始终可见。

## 🤔 为什么是 ai-space

服务器上的 coding agent 本身已经能做很多事。它缺的是一个能持续运转的地方：按时唤醒它、记住它做过什么、把它的结果交给另一个程序、在要紧时通知你。ai-space 就是这个地方。它不是工作流编排器，也不是聊天前端，而是你已经在用的 agent 和你用它们搭出来的小 app 之间的共享层。

<details>
<summary><b>与其他工具对比</b></summary>
<br/>

| | ai-space | 服务器上直接跑 agent | 工作流编排工具 | 聊天前端 |
| --- | --- | --- | --- | --- |
| Agent | 带自身工具的 Claude Code / Codex 会话 | 同左 | 多为流程里的模型 API 调用 | 多为模型 API 调用 |
| 定时与事件 | 内置，按 app 声明 | 手写 cron | 内置 | 不一定 |
| 有自己界面和数据的 app | 有，通过 `space.yaml` | 临时拼凑 | 不一定 | 不一定 |
| 通知、备份、用量账本 | 共享服务 | 自己动手 | 部分 | 部分 |
| 运行在哪 | 你的服务器，普通文件 | 你的服务器 | 自托管或云端 | 自托管或云端 |

如果你主要想要拖拽式流水线，或基于模型 API 的多人聊天界面，专门的工具会更合适。当干活的是 agent、而你希望它们一直运转下去时，ai-space 正合适。

</details>

## 📈 状态

已就位：调度器（时间表和事件触发）、总线、存储（数据库和对象存储交接）、备份、通知与收件箱、带用量账本的模型调用、带图片和可嵌入组件的对话、面板、peers、web 终端、`space` 命令行、服务托管和交互式 `setup`。

后续工作，大致按顺序：

- [ ] **托管交接**：`space app supervise <app>`，带健康检查和失败回滚；unit 里的资源上限。
- [ ] **Skills 挂载**：把 manifest 里的 `skills:` 和 `memory:` 提供给 agent 会话。共享 skill 和各 app 的 skill 已经链接到 `<workspace>/.claude/skills/`。
- [ ] **托管 blob API**：在已经开通的对象存储之上加索引表、流式路由和预签名。
- [ ] **App 工具链**：`schema/space.schema.json`、`validate` 和 `/api/spec`。

分区状态表见 [docs/app-spec.md](docs/app-spec.md#implementation-status)。更长远的视角——对照操作系统给程序的东西，一个空间还欠它的 app 什么——见 [docs/roadmap.md](docs/roadmap.md)。

## 📚 文档

| 入门 | 构建 app | 运维一个空间 | 内部机制 |
| --- | --- | --- | --- |
| [让 agent 安装](docs/install-by-agent.md) | [App 规范](docs/app-spec.md) | [命令行](docs/cli.md) | [运行时](docs/runtimes.md) |
| [手工安装](docs/install.md) | [`space-app` skill](skills/space-app/SKILL.md) | [备份](docs/backup.md) | [路由](docs/router.md) |
| [Cloudflare](docs/cloudflare.md) | [调度器](docs/scheduler.md) | [服务托管](docs/supervision.md) | [入口](docs/ingress.md) |
| [机器](docs/machines.md) | [事件与调用](docs/events.md) | [Peers](docs/peers.md) | [时间字段](docs/time.md) |
| | [存储](docs/storage.md) | [终端](docs/terminal.md) | [多语言](docs/i18n.md) |
| | [通知](docs/notify.md) · [模型](docs/model.md) · [对话](docs/chat.md) | [面板](docs/panel.md) | [路线图](docs/roadmap.md) |

## 🧑‍💻 开发

```bash
bun install
bun run init           # 创建 ~/.ai-space（幂等）
bun run start          # 在 127.0.0.1:8700 启动 Space API 和面板
bun run dev            # 热重载，包括 web UI
bun run check          # 类型检查 + 测试
bun run hooks          # 每个 clone 一次：push 前自动运行检查
```

本地配置放在 `~/.ai-space/.env`（见 `.env.example`）；进程环境变量优先于它。贡献之前先读 [AGENTS.md](AGENTS.md)（工作方式、仓库地图、提交格式），Bun 约定见 [CLAUDE.md](CLAUDE.md)。
