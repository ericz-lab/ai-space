# Runtimes

Status: implemented for Claude Code (`claude-code`), DeepSeek Harness (`deepseek-harness`), the Anthropic Messages API (`anthropic-api`), and Codex CLI text completions (`codex-cli`). Other coding agents and model APIs are added as further kinds; the interface below is what they implement.

## Why one layer

ai-space starts an AI runtime in three places: the model service answers an app's request (`POST /api/model/run`), the scheduler runs an agent task (a prompt file in the app directory), and the panel runs a chat turn. Before this layer each place spawned `claude` its own way and knew nothing of any other runtime. Now each asks a runtime adapter for one of three operations, the adapter knows its CLI or API, and a registry says which runtimes this space has. Adding a runtime means adding one adapter; the three callers do not change.

## Operations

| operation | caller | what it is |
| --- | --- | --- |
| `complete` | model service | One answer to one prompt with the request's own system prompt, model, tools and thinking cap. No agent behaviour: the runtime is started lean (see [model.md](model.md#backends)). May run on another machine over ssh, borrowing its login. |
| `agent` | scheduler | A coding agent at work: the runtime's own system prompt and tools, the prompt file on stdin, inside the app directory. Always local: it needs the directory. |
| `chat` | panel | One turn of a conversation, streamed as the runtime's own events; a session id gives continuity. Always local, for the same reason. |

An adapter declares which of the three it supports (`capabilities`). A caller asking for one it lacks gets a clear error (a 400 from the model API, a 501 from chat, a failed run from the scheduler), never a silent fallback to another runtime.

Every operation reports what the runtime said about the model call, token counts and cost when it gave them, and the model service or the scheduler hook writes the ledger row (`runtime`, `backend`, `model`, usage). Nothing is estimated: a runtime that reports no usage leaves the row without figures.

## Kinds

| kind | complete | agent | chat | login | notes |
| --- | --- | --- | --- | --- | --- |
| `claude-code` | yes, local or ssh | yes | yes | the CLI's own (`claude login`) | `claude -p --output-format json` for answers and agent runs, `stream-json` for chat, `--resume` for continuity. Answers over ssh: every argument validated, the system prompt base64-encoded. Files (chat attachments) are opened with `Read`; over ssh they travel with the prompt as one tar archive unpacked into a temporary directory. |
| `deepseek-harness` | yes, local or ssh | yes | yes | a DeepSeek API key in the harness home | `dsh --profile headless --json` for everything, the task on stdin; `--session-id` for continuity. A `--patch` overlay per run sets the system prompt, model, thinking (`reasoningEffort`) and tool rows: an answer runs with the harness identity, runtime context and every tool off (6,872 input tokens as shipped → 32), a chat keeps them and adds the agent's prompt as persona. Usage from the `step_end` events, cost from DeepSeek's list prices at peak (off-peak is half). Chat events are translated into Claude Code's `stream-json`; transcripts read from the harness's session log. Files refused. |
| `codex-cli` | yes, local or ssh | no | no | the CLI’s own Codex login | Isolated text completions with per-request instructions; see below. |
| `anthropic-api` | yes | no | no | an API key | `POST /v1/messages`. Tools and files refused. Cost from list prices for known models. |

## Configuration

`<workspace>/runtimes.yaml` names the runtimes. Keys never go in the file; `apiKeyEnv` names the environment variable that holds one (the workspace `.env` is loaded into the environment).

```yaml
default: claude                  # runtime a bare model name goes to
runtimes:
  claude:
    kind: claude-code
    ssh: box                     # optional: answers borrow that machine's login
    bin: /usr/local/bin/claude   # optional: the CLI command (string or list); default claude
    chatArgs: [--foo]            # optional: appended to every chat turn
  api:
    kind: anthropic-api
    apiKeyEnv: ANTHROPIC_API_KEY # default shown
    url: https://…               # optional
  dsh:
    kind: deepseek-harness
    ssh: box                     # optional: answers run on that machine's harness
    bin: /home/me/.npm-global/bin/dsh   # optional; default dsh (must be on the login shell's PATH over ssh)
    home: /home/me/.dsh          # optional: DSH_HOME, where session logs are read; default the CLI's own
    profile: headless            # optional; default shown
```

### Preparing a DeepSeek Harness

On the machine that runs it (Node 22.19 or newer):

```sh
npm i -g @deepseek-ai/dsh@alpha            # the alpha channel has --json and --session-id
dsh --profile headless --help              # initialises ~/.dsh/profiles/headless
```

Put the key in `~/.dsh/.env` as `DEEPSEEK_API_KEY=…` (mode 600). Then, in `~/.dsh/cordis.patch.yml`, keep session logs on the machine and readable by ai-space: the harness otherwise sends them to DeepSeek with each request, exports telemetry after feedback, and compresses them.

```yaml
- id: session-log-deepseek
  config: { enabled: false }
- id: session-telemetry-otel
  disabled: true
- id: session-persistence-jsonl
  config: { root: !!js dshHomePath("sessions"), compression: none }
```

`dsh --profile headless --dump-config` shows the composed rows. Models are named as the harness names them (`deepseek-flash`, `deepseek-v4-pro`); `provider:model` selects another provider the harness has configured.

A runtime whose key variable is empty is skipped with a warning at boot rather than failing it, so a space keeps running when one login is missing. `default` must name a runtime that remains.

Without the file, the space has the one Claude Code runtime the `SPACE_MODEL_*` and `SPACE_CHAT_*` variables describe, as every space had before the file existed: `SPACE_MODEL_SSH_HOST` is its `ssh`, `SPACE_MODEL_BIN` (or `SPACE_CHAT_BIN`) its `bin`, `SPACE_CHAT_ARGS` its `chatArgs`; `SPACE_MODEL_API_KEY` adds an `api` runtime and makes it the default for answers. Chat and agent tasks always use the `claude` runtime in that shape.

## Naming a runtime

- A model request's `model` may carry the runtime as a prefix: `api/claude-haiku-4-5`, `claude/sonnet`. A bare name (`haiku`) goes to the default runtime. The ledger stores the bare model and the runtime name in separate columns.
- An agent in `space.yaml` (`agents[].runtime`) and an agent task (`run.agent.runtime`) name a runtime; `claude` when omitted. The manifest accepts any well-formed name; whether the space has it is checked when the agent is used, so a manifest written for one machine parses on another.

`GET /api/model/status` lists the configured runtimes with their kind, backend and capabilities. The boot log line names them: `runtimes claude (claude-code, ssh:box)*, api (anthropic-api, api) (file)`, the asterisk marking the default and the parenthesis whether the file or the environment described them.

## Code

`src/space/runtimes/`: `types.ts` (operations, specs, adapter interface), `process.ts` (spawn, collect, kill the process group on timeout), `claude-code.ts`, `deepseek-harness.ts`, `anthropic-api.ts`, `transcripts.ts` (past sessions from each runtime's records), `config.ts` (`runtimes.yaml` and the environment fallback), `registry.ts` (by name, `runtime/model` resolution), `testing.ts` and `testing-dsh.ts` (the fake CLIs tests use).

## Follow-ups

- Further kinds: another coding agent's CLI (its one-shot mode for answers and agent runs, its event stream for chat, usage read from where it records it), model APIs of other vendors.
- Chat events normalised across runtimes, with ai-space keeping its own transcripts; today the browser reads Claude Code's `stream-json` (other runtimes' adapters translate into it) and past sessions are read from each runtime's own files.
- DeepSeek off-peak pricing in the ledger (the price table takes the peak rate), and a price table in `runtimes.yaml` for models the adapters do not know.
- Per-app default runtime and routing by tag, fallback chains, budgets; a runtime picker in the chat panel.

## Capability tiers

Use these four names consistently when discussing models or selecting them in requests:

| Tier | Request alias | Claude Code | Codex CLI default |
| --- | --- | --- | --- |
| Basic (基础) | `basic` | Haiku (`haiku`) | Luna (`gpt-6-luna`) |
| Junior (初级) | `junior` | Sonnet (`sonnet`) | Terra (`gpt-5.6-terra`) |
| Intermediate (中级) | `intermediate` | Opus (`opus`) | Sol (`gpt-6-sol`) |
| Advanced (高级) | `advanced` | Fable (`fable`) | Astra (`gpt-6-astra`) |

These are operator-defined tiers, not a claim that two providers' models perform identically. Availability depends on the CLI and account. `codex/basic` selects Codex Luna; `claude/advanced` selects Claude Fable. A bare `advanced` uses the default runtime. Concrete model IDs still work. Unknown or unavailable models fail without silently switching provider or using a more expensive model. Other runtime kinds need explicit tier mappings.

Each runtime may override versions with a `models` mapping. The ledger records the resolved concrete model, not the alias:

```yaml
default: claude
runtimes:
  claude:
    kind: claude-code
  codex:
    kind: codex-cli
    ssh: box                         # omit for local execution
    bin: /home/operator/.local/bin/codex
    models:
      basic: gpt-6-luna
      junior: gpt-5.6-terra
      intermediate: gpt-6-sol
      advanced: gpt-6-astra
```

To default only application model calls to Codex, set `SPACE_MODEL_DEFAULT=codex/basic`. Keep the runtime default on a chat-capable runtime when the panel still needs it. Explicit application model settings take precedence; change those individually.

## Codex CLI completions

Motivation: applications must be able to use a Codex login independently of a failed Claude login, with inexpensive models and their own instructions. `codex-cli` implements `complete` only, locally or through SSH; agent tasks and panel chat return unsupported. Requires a Codex CLI with `--ignore-user-config`, `--ignore-rules` and `--ephemeral` (validated with 0.156.1); the SSH host needs Bash, tar and GNU timeout. Authenticate on the machine that actually runs Codex, using `codex login`. Credentials remain in that machine's Codex home.

In the default slim mode, the adapter runs `codex exec --json` in a fresh temporary directory. The request's `system` becomes `model_instructions_file`, replacing Codex's built-in model instructions; `prompt` arrives on stdin separately. Quotes, Unicode, newlines and large instructions travel as file bytes, never interpolated shell code. Over SSH both files arrive in one tar stream before the CLI starts. Request files are removed afterwards. A remote timeout bounds execution if the SSH connection drops; cancellation kills the local process group immediately, while a disconnected remote call can remain until its timeout.

In slim mode, user configuration and exec rules are skipped, project instructions and skill instructions disabled, and shell, browser, apps, plugins, memories and subagents disabled. Execution uses a read-only sandbox. This is a text-completion adapter: requested tools and file attachments are rejected, not silently ignored. Machine-wide managed policies still apply.

In slim mode, reasoning effort is fixed to `low` to control usage. Full mode uses the CLI default. The existing `thinking` field is accepted for compatibility but does not impose a numeric budget or disable reasoning (including `thinking: 0`). As with other CLI adapters, `maxTokens` is not a hard output cap. Requests are single-turn and ephemeral; no automatic model fallback or adapter retry is performed. The CLI itself may retry transient transport failures.

Only a complete successful JSON event stream with a nonempty final message is accepted. A zero exit code with `turn.failed`, malformed output or an incomplete stream is a failure. Streaming callers receive one final text chunk after validation. Usage is recorded from Codex's actual counters; cached input is separated from total input, and no dollar cost is invented for subscription usage.

Example request (sent with the app's bearer token):

```json
{
  "model": "codex/basic",
  "system": "Translate financial news into Chinese. Return only JSON with key translation.",
  "prompt": "The Federal Reserve held interest rates steady.",
  "tag": "translate"
}
```

References: [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference), [Codex pricing](https://learn.chatgpt.com/docs/pricing). Standard mode is used; no fast service tier is requested.

## Completion modes

The model API and `space model run --mode slim|full` share two modes for both
`claude-code` and `codex-cli`. The model tier and the completion mode are independent.

| Behavior | `slim` | `full` |
| --- | --- | --- |
| Context | Isolated application request; optional CLI context disabled | Native CLI configuration, project instructions, skills, MCP and available tools |
| System prompt | Custom `system`, or the application default | Custom `system` replaces the native base instructions; omit it to keep the native base instructions |
| Tools | Explicit tool lists and attachments rejected | Native tool set; Claude also accepts a selective `tools` list and internal attachments |
| Working directory | Codex uses a temporary directory; Claude uses safe mode | Local service working directory, or the SSH login directory on the execution host |
| History | One request | One request with native context, not an automatic resume of earlier conversations |

The default for existing text-only calls is slim. For compatibility, requests that
omit `mode` may still request the legacy selective tool/attachment behavior. Other
runtime kinds reject explicit `full` instead of silently treating it as slim.
The ledger records the mode for new mode-aware and text-only model calls; older,
imported and legacy selective-tool records may have no mode.

Claude slim uses `--safe-mode --strict-mcp-config --tools "" --system-prompt ...`.
Safe mode requires a CLI version that supports that flag; it disables project
customizations, skills, plugins and hooks. Full omits those context restrictions.
Codex slim skips user configuration and rules, disables optional context messages,
sets `agents.enabled=false`, and disables execution, code-mode host, integrations
and discovery features. Full retains native configuration and tools. Both Codex
modes retain the read-only sandbox and never-approve policy: full context does not
authorize unrestricted writes. Full uses the CLI's reasoning default; slim uses
low reasoning. Codex custom tool lists and file attachments remain unsupported;
full exposes its native tools instead.

**Codex 0.156.1 limitation:** even with tool execution disabled, this CLI still sends
`exec`, `wait` and asynchronous-input definitions. Slim disables optional tool facilities, but cannot promise a completely empty
tool surface or zero tool-schema tokens in this CLI version. A measured
single-line translation dropped from 4,097 to 1,688 input tokens with optional context
disabled; these are example measurements, not a fixed budget.

```json
{"model":"codex/basic","mode":"slim","system":"Translate to Chinese. Return JSON only.","prompt":"Hello"}
```

```json
{"model":"claude/intermediate","mode":"full","system":"You are a code reviewer. Report concrete defects with file references.","prompt":"Review this workspace without changing files."}
```

These modes apply to model completions. Scheduler agent execution and persistent
panel chat keep their existing contracts.
