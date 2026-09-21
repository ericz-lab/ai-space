# Runtimes

Status: implemented for Claude Code (`claude-code`), DeepSeek Harness (`deepseek-harness`) and the Anthropic Messages API (`anthropic-api`). Other coding agents and model APIs are added as further kinds; the interface below is what they implement.

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
