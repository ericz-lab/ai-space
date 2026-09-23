# Model Tiers and Request Modes

This guide describes the model selection and completion request contract implemented
by ai-space. It covers Claude Code and Codex CLI, including their shared interface,
configuration, system prompts, task integration, usage accounting, and limitations.

The mappings and behavior below reflect the implementation as of September 23, 2026.
Model identifiers are deployment configuration, not a guarantee of account access or
an assertion that models from different providers have identical capabilities.

## 1. Four independent choices

A model request makes four separate choices:

| Choice | Request field | Meaning | Example |
| --- | --- | --- | --- |
| Runtime | Prefix of `model` | The configured adapter and execution host | `codex/` |
| Capability tier | Suffix of `model` | The operator-defined model capability level | `intermediate` |
| Request mode | `mode` | How much native CLI context and tooling accompanies the request | `slim` |
| System instructions | `system` | The application-specific role and response rules | `Return only valid JSON.` |

For example, `model: "codex/intermediate"` with `mode: "slim"` selects the Codex
intermediate-tier model with a reduced-context request. It does not select a weaker
model merely because the request is slim.

Changing the tier does not change the request mode. Changing the mode does not
change the selected model. Either mode accepts a custom system prompt.

## 2. Capability tiers

ai-space defines four tiers, in ascending order: Basic, Junior, Intermediate, and
Advanced. Use the lowercase aliases in configuration and API requests.

| Tier | Alias | Claude Code default | Codex CLI default |
| --- | --- | --- | --- |
| Basic | `basic` | Haiku: `haiku` | Luna: `gpt-6-luna` |
| Junior | `junior` | Sonnet: `sonnet` | Terra: `gpt-5.6-terra` |
| Intermediate | `intermediate` | Opus: `opus` | Sol: `gpt-6-sol` |
| Advanced | `advanced` | Fable: `fable` | Astra: `gpt-6-astra` |

These are ai-space routing conventions. They are not provider-defined equivalence
classes, benchmark results, or a pricing table. In particular, the Advanced tier
means Fable for the default Claude mapping and Astra for the default Codex mapping.

For existing workloads, preserve the intended capability level when replacing
provider-specific names:

| Previous model family | Tier alias |
| --- | --- |
| Haiku | `basic` |
| Sonnet | `junior` |
| Opus | `intermediate` |
| Fable | `advanced` |

Choosing another provider is a separate decision. A Sonnet workload can become
`claude/junior` or `codex/junior`; renaming the capability level alone does not
require switching providers.

### Selecting a tier or model directly

The preferred form is `<runtime-name>/<tier>`:

```text
claude/basic
claude/junior
claude/intermediate
claude/advanced
codex/basic
codex/junior
codex/intermediate
codex/advanced
```

The prefix is a configured runtime name, not necessarily a provider name. A runtime
named `remote-codex` would be selected with `remote-codex/intermediate`.

Concrete model identifiers also work, for example `codex/gpt-6-sol`. Such requests
bypass the tier mapping. A bare name, such as `intermediate` or `sonnet`, uses the
runtime named by `default` in `runtimes.yaml`. Explicit prefixes make application
behavior easier to preserve when the workspace default changes.

An unknown runtime or missing tier mapping fails explicitly. An unavailable model
can fail when the CLI calls its provider. ai-space does not silently change the
provider, promote the tier, or substitute another model.

### Configuring the mappings

Configure runtimes in `<workspace>/runtimes.yaml`:

```yaml
default: claude
runtimes:
  claude:
    kind: claude-code
    bin: claude
    models:
      basic: haiku
      junior: sonnet
      intermediate: opus
      advanced: fable
  codex:
    kind: codex-cli
    bin: codex
    models:
      basic: gpt-6-luna
      junior: gpt-5.6-terra
      intermediate: gpt-6-sol
      advanced: gpt-6-astra
```

The table above is built into the two CLI runtime kinds. The `models` entries are
optional overrides, so only tiers that need different identifiers must be listed.
A mapping value must name a model; it cannot refer to another tier alias.
Other runtime kinds need explicit mappings if they are to resolve these aliases.

For remote execution, add `ssh: <host-alias>` to the runtime. The CLI executable,
login, and model access must be available on that host. `bin` may be an absolute
path when the remote login environment does not put the executable on `PATH`.

To default application model requests to Basic Codex while keeping Claude as the
workspace's default runtime, set this in the workspace environment:

```dotenv
SPACE_MODEL_DEFAULT=codex/basic
```

This applies when an application omits `model`. An explicit model in a request
continues to take precedence. Changing this variable does not rewrite model choices
already configured by individual applications or tasks.

## 3. Request modes

The completion interface supports `mode: "slim"` and `mode: "full"` for Claude Code
and Codex CLI.

| Behavior | Slim | Full |
| --- | --- | --- |
| Intended workload | Self-contained text processing | Work that needs the CLI's native context or tools |
| Application prompt | Included | Included |
| Custom system prompt | Supported | Supported |
| Native base instructions without custom `system` | Replaced with the application default | Retained |
| Project instructions and optional context | Disabled where supported | Loaded according to native CLI configuration |
| Skills and integrations | Disabled where supported | Available according to native CLI configuration |
| Tools | Optional tooling disabled; explicit tool lists rejected | Native tool set available, subject to permissions |
| Previous conversation | Not automatically resumed | Not automatically resumed |
| Model tier | Unchanged | Unchanged |

### Slim mode

Use slim mode when the request contains all the information needed for its answer,
such as translation, classification, extraction, summarization of supplied text, or
formatting data into a specified schema.

Explicit slim requests reject nonempty `tools` lists. The internal completion
interface also rejects file attachments in this mode, so an attachment cannot
silently activate a file-reading tool.

Claude Code slim requests replace the system prompt, clear the built-in tool list,
skip configured MCP servers, and enable safe mode to suppress customizations.
Codex slim requests use a temporary working directory, skip user configuration and
execution rules, suppress optional context messages, and disable optional tooling.

**Codex limitation:** in CLI version 0.156.1, some built-in tool definitions remain
in the model request even after the relevant feature switches are disabled. The
observed residual definitions include `exec`, `wait`, and asynchronous user input.
Slim mode reduces this overhead but cannot promise a completely empty tool surface
or zero tool-schema tokens with that CLI version.

### Full mode

Use full mode when the runtime needs its native environment: project instructions,
available tools, skills, integrations, and configured developer instructions.
Those resources are retained according to the configuration of the execution host.
They are not guaranteed to exist on every host.

Full mode is still a completion request. It does not automatically resume a previous
session, collect every application in the workspace, or load the caller's project
from another machine.

Locally, the current implementation uses the ai-space service's working directory.
Over SSH, it uses the remote login working directory. A request's app identity is
used for authorization and accounting; it does not select a different project
directory. Context available on the execution host can therefore differ from
context available on the machine making the HTTP request.

For Codex, full mode keeps the read-only sandbox and the never-approve policy. It
does not grant unrestricted write access. Claude Code retains its native permission
behavior; ai-space does not add a permission-bypass flag for full completions.

### Defaults and compatibility

New callers should send an explicit mode. Existing text-only calls that omit it
continue to use slim behavior.

For backward compatibility, requests that omit `mode` can still use the older
selective-tool or attachment contract where the runtime supports it. This legacy
behavior is not a third named mode. An explicit `mode: "slim"` rejects those inputs.

Other runtime kinds, including the Anthropic API and DeepSeek Harness, reject an
explicit full-mode request in the current model service. Their existing completion
behavior remains available; they do not silently emulate full CLI context.

## 4. Custom system prompts

Both runtime kinds accept the same `system` request field in either mode. The
`prompt` field contains the request-specific input; `system` contains the role,
output format, and stable application rules.

A supplied `system` replaces the runtime's native base model instructions. It is
not appended to those base instructions. In full mode, the runtime can still add
separate developer messages, project context, environment information, and tool
definitions. Replacing the base instructions does not erase those other messages.

| Request | System instruction behavior |
| --- | --- |
| Slim with `system` | Use the supplied instructions |
| Slim without `system` | Use the ai-space application default |
| Full with `system` | Replace native base instructions with the supplied instructions |
| Full without `system` | Keep the runtime's native base instructions |

The application default is:

```text
You answer one request from an application. Reply with exactly what it asks for and nothing else.
```

If provided, `system` must be a nonempty string of at most 200,000 characters.
Whitespace-only strings are rejected. Omit the field to retain native instructions
in full mode; an empty string in the HTTP request is not the omission mechanism.
The required `prompt` must be nonempty and is limited to 2,000,000 characters.

Claude Code receives custom instructions through `--system-prompt`. Codex receives
them through a temporary file referenced by `model_instructions_file`. Application
input is supplied separately on standard input. The Codex adapter removes its
request files after the process finishes, including on failure.

## 5. Request examples

### Slim translation with a Basic model

Send the following JSON to `POST /api/model/run`:

```json
{
  "model": "codex/basic",
  "mode": "slim",
  "system": "Translate the supplied text into French. Return only a JSON object with a translation field.",
  "prompt": "The interest rate remains at 4.25%.",
  "tag": "translate",
  "timeoutMs": 90000
}
```

To use Claude for the same tier, change `model` to `claude/basic`. The mode and
application instructions can remain the same.

### Slim summarization with an Intermediate model

```json
{
  "model": "codex/intermediate",
  "mode": "slim",
  "system": "Summarize only the supplied transcript. Separate claims from evidence. Do not invent missing facts. Return JSON with summary and uncertainties fields.",
  "prompt": "Transcript: The speaker proposes expanding the pilot, but gives no budget or completion date.",
  "tag": "digest",
  "timeoutMs": 120000
}
```

This request uses an Intermediate model without loading full CLI context. A more
capable model does not require full mode.

### Full context with custom instructions

```json
{
  "model": "claude/intermediate",
  "mode": "full",
  "system": "Review code in the current workspace. Report concrete defects with file references. Do not modify files.",
  "prompt": "Review the error handling in this workspace.",
  "tag": "review",
  "timeoutMs": 120000
}
```

The same request can select `codex/intermediate`. Remember that the workspace in
this example is the execution host's working directory, not an arbitrary project
chosen by the API caller.

### Full context with native instructions

```json
{
  "model": "codex/advanced",
  "mode": "full",
  "prompt": "Describe the current workspace and its main components without modifying files.",
  "tag": "workspace-overview"
}
```

### HTTP authentication

Applications use the bearer token provided in their generated `space.env`. The
service derives the application identity from that token.

```sh
curl --fail-with-body "$SPACE_API_URL/api/model/run" \
  -H "Authorization: Bearer $SPACE_APP_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"model":"codex/basic","mode":"slim","system":"Reply in one short sentence.","prompt":"Explain what a cache is.","tag":"example"}'
```

An operator-token request supplies the target `app` as well. See
[Model service](model.md) for authentication, streaming, and response details.

### Command-line requests

```sh
space model run --app demo --model codex/basic --mode slim \
  --system "Reply in one short sentence." "Explain what a cache is."

space model run --app demo --model claude/intermediate --mode full \
  --system "Review code without modifying files." "Review the current workspace."

space model run --app demo --model codex/advanced --mode full \
  "Describe the current workspace."
```

Use `--json` to inspect the response and ledger metadata. Use `-` as the prompt to
read request text from standard input. The CLI can use an application's token when
run in the application's configured environment; `--app demo` above illustrates
operator usage.

## 6. Runtime-specific behavior

| Detail | Claude Code | Codex CLI |
| --- | --- | --- |
| Slim tool configuration | Empty built-in tool list; strict MCP configuration; safe mode | Optional tool facilities disabled; residual definitions may remain |
| Full tool configuration | Native tool set; an explicit list can select tools | Native tool set when no list is supplied; explicit WebSearch/WebFetch lists use isolated web-only execution |
| Custom system prompt | `--system-prompt` | `model_instructions_file` |
| Internal file attachments | Supported outside explicit slim mode; may activate `Read` | Unsupported in either mode |
| Reasoning control | Request `thinking` is passed through `MAX_THINKING_TOKENS`; behavior depends on the CLI/model | Slim uses low effort; full uses the CLI default; numeric `thinking` does not control the budget |
| Output limit | `maxTokens` is not a hard CLI output cap | `maxTokens` is not a hard CLI output cap |
| Streaming through the adapter | Text deltas where requested | One final text chunk after successful stream validation |
| Execution location | Local or SSH for completions | Local or SSH for completions |

The `files` field belongs to the internal completion interface, not a general file
upload field accepted by the public model API.

Claude slim requires a CLI version that supports `--safe-mode`. Codex behavior was
validated with version 0.156.1. Managed policies and native account restrictions
remain applicable. Authentication failures are separate from mode or tier selection.
Switching mode does not repair an expired login.

## 7. Task selection and operation boundaries

The task center can select a runtime and tier for tasks that support model
selection. A saved override applies to subsequent runs; restoring the default uses
the task's declared model again.

For integrated HTTP tasks, the scheduler forwards the choice in `x-space-model`.
For command tasks, it uses `SPACE_TASK_MODEL`. The application or command must honor
that value in its own model requests. Merely declaring a task model does not make
an unintegrated application switch models.

The task center's model selector changes the model, not the request mode. The
application chooses `mode` and `system` when it calls the model service. There is
currently no equivalent task-center mode or system-prompt editor.

These modes apply to the `complete` operation. They do not alter scheduler `agent`
execution or persistent panel `chat` sessions. Codex currently supports completion
requests through this adapter, including full completions, but does not implement
the separate scheduler-agent or persistent-chat operations. Selecting full mode
does not add those capabilities.

See [Scheduler](scheduler.md) for task overrides and [Runtimes](runtimes.md) for the
operation and capability contract.

## 8. Usage and accounting

New mode-aware calls record `mode` in the model ledger and API response. Existing
text-only calls without an explicit mode are recorded as slim. Historical,
imported, agent/chat, or legacy selective-tool records may have no mode value.
Absence of a mode on an old record does not mean the call ran in full mode.

The ledger also records the runtime name and resolved model identifier separately.
For example, `codex/intermediate` resolves to runtime `codex` and model `gpt-6-sol`.
A Claude tier can resolve to a CLI alias such as `opus`; that is the identifier sent
to the CLI, not necessarily a provider version independently discovered by ai-space.

For Codex, the CLI's total input count includes cached input. ai-space separates it:

```text
non-cached input = CLI input_tokens - CLI cached_input_tokens
total input = ledger inputTokens + ledger cacheReadTokens
```

Cached tokens are reused input, not a second independent copy to add to the CLI's
total input. A large cache total does not, by itself, identify the size of the
application's system prompt. Runtime instructions, tool definitions, and other
repeated context can contribute to it.

In one validation on September 23, 2026, the same short translation and custom
system prompt used 1,706 input tokens in slim mode and 9,968 input tokens in full
mode, counting both cached and non-cached input. Both returned valid JSON. This is
an example measurement, not a fixed per-request cost or a general quality benchmark.

Compare cached input, non-cached input, output, correctness, and latency together.
A reduction in total tokens is not automatically the same percentage reduction in
cost. ai-space does not invent a monetary cost when the CLI does not report one.

Useful inspection commands and endpoints:

```sh
space model status
space model calls --app demo
space model usage --app demo --by model
```

- `GET /api/model/status`: configured runtimes and operation capabilities.
- `GET /api/tasks/models`: configured tier choices and their mapped models.
- `GET /api/model/calls`: recent ledger records, including mode when available.
- `GET /api/model/usage`: usage aggregates.

## 9. Implementation references

The repository is the source of truth for this contract:

- [Runtime types](../src/space/runtimes/types.ts): modes and completion inputs.
- [Runtime registry](../src/space/runtimes/registry.ts): tier mappings and resolution.
- [Runtime configuration](../src/space/runtimes/config.ts): configuration validation.
- [Model request validation](../src/space/model/spec.ts): accepted request fields and defaults.
- [Claude Code adapter](../src/space/runtimes/claude-code.ts): local and SSH invocation.
- [Codex CLI adapter](../src/space/runtimes/codex-cli.ts): context switches and CLI limitations.
- [Model service](../src/space/model/service.ts): execution and ledger recording.
- [Model CLI](../src/cli/model.ts): command-line request handling.

## Workspace default model

Settings → Default model selects a configured Claude Code or Codex CLI runtime and
one of its four tiers. The preference is persisted in `space.db` and applies immediately
to model-service requests and app chat turns that omit `model`, plus new Base chats.
This includes ai-todo, ai-calendar and ai-notes, which omit app-level model defaults.
Explicit request models take precedence. Base resumes keep their recorded runtime
and model; choose a new conversation to use a changed workspace default.

`GET /api/model/preferences` returns `defaultModel`, `appDefault`, `baseDefault` and
available `options`. `PUT /api/model/preferences` accepts
`{"defaultModel":"codex/intermediate"}`. Passing `null` restores the environment
fallbacks: `SPACE_MODEL_DEFAULT` for apps and `SPACE_CHAT_MODEL` for Base. These
routes use the same access boundary as other panel preferences.

App deployments must also use versions that omit hardcoded model defaults.
The updated ai-todo, ai-calendar and ai-notes ignore legacy `TODO_MODEL`,
`AI_MODEL` and `NOTES_MODEL` environment values so existing deployments also
follow Settings. Scheduled agent tasks retain
the model declared in their task configuration.

### App web tools on Codex

App requests with `WebSearch` and/or `WebFetch` use Codex's native live web tool
(`web_search = "live"`), which combines search and page retrieval. The Code Mode
host is enabled for these calls because current Codex routes web tools through it. This supports
ai-todo execution and the web-enabled Todo/Notes chat contexts while inheriting
the workspace default model. Shell, plugins, apps and other optional tools remain
disabled for explicit web-only requests, including those marked `full`. Other
custom tool names and attachments still return explicit unsupported errors.
Explicit `slim` requests continue to reject tool lists; omitting tools keeps web
access disabled outside native full mode.

See the [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
for the `web_search` setting.
