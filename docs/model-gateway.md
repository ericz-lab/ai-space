# Model gateway

Status: implemented in `src/space/gateway/` (the built-in model gateway: Anthropic Messages, OpenAI audio and OpenAI Images, passthrough only). [magpie](#magpie), an external model gateway, is supported as before.

## Terms

| term | what it is | here |
| --- | --- | --- |
| **AI runtime** | an agent CLI with its own loop and tools | Claude Code, Codex CLI, Gemini CLI, DeepSeek Harness ([runtimes.md](runtimes.md)) |
| **model gateway** | sits between a runtime (or a direct call) and the model vendors: holds the keys, picks the vendor, fails over, records what answered | the built-in one (this page), or [magpie](#magpie) |
| **model provider** | the vendor behind a gateway | DeepSeek, Zhipu, Kimi, MiniMax, OpenAI, … |

Three different things have "gateway" in their name, so this page always writes "model gateway". The package gateway (`src/space/packages/gateway.ts`, [app-packages.md](app-packages.md)) opens app origins. The Space Router (`src/space/router/`, [router.md](router.md)) gives apps hostnames. Neither of them has anything to do with models.

## Why one is built in

A space whose operator holds API keys for several vendors had to install magpie to point Claude Code at them, or else write one `anthropic-api` runtime per vendor with no failover. A Claude Code process also could not report which vendor answered its calls. The built-in model gateway covers the part of magpie that a space needs most: the keys live in one file, a group of models is tried in order, and what answered is kept per run. It does this with no global configuration. Every Claude Code process that uses it gets the gateway's address and a token of its own in its environment and its `--settings`. `~/.claude`, `~/.codex`, the shell profile and the environment of the service are never written.

## Passthrough, and what that means

The built-in model gateway forwards a request in the protocol it arrived in. It rewrites only the `model` field (a group or `provider/model` becomes the provider's own model name) and the auth header (the caller's token becomes the provider's key). The vendor's answer goes back unchanged: status, headers (minus hop-by-hop ones), body, and an SSE stream byte for byte. It never translates between Anthropic Messages, OpenAI Chat, OpenAI Responses or Gemini.

What follows from that:

- **Text works only with vendors that have an Anthropic Messages endpoint.** Claude Code speaks only Messages. A vendor that offers only OpenAI Chat cannot answer Claude Code through the built-in gateway. [magpie](#magpie) translates protocols, the built-in gateway does not.
- **No Codex.** Codex speaks only OpenAI Responses. The built-in gateway serves Claude Code and direct API calls only.
- **Claude Code's server-side tools are the vendor's.** WebSearch and WebFetch in Claude Code are server tools that Anthropic's API runs. On another vendor's Messages endpoint they work only if that vendor implements them, and most do not.
- **Experimental betas are off.** A Claude Code process on the built-in gateway gets `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`, Claude Code's own switch for gateways whose upstream refuses pre-release fields (its [LLM gateway documentation](https://code.claude.com/docs/en/llm-gateway-protocol.md) names it as the fix for "Extra inputs are not permitted"). `anthropic-beta` and `anthropic-version` are still forwarded verbatim, as that documentation requires.
- **No token counting where the vendor has none.** `count_tokens` is forwarded like any other request. A vendor without the endpoint answers with its own error, which goes back unchanged. Claude Code then "falls back to a character-based estimate of context usage" (same documentation), so nothing breaks; `/context` shows approximate counts.
- **No subscription accounts.** The gateway uses API keys. It never bridges a Claude, ChatGPT or other subscription sign-in.

## Configuration

`<workspace>/gateway.yaml`. It is a file of its own, not a key of `runtimes.yaml` or `providers.yaml`: both parsers refuse unknown keys, so an older ai-space rolled back onto the workspace would lose its runtimes or its speech. With no file there is no built-in gateway, and nothing changes for the space.

```yaml
providers:
  deepseek:
    preset: deepseek              # optional: the bases of a vendor checked against its docs (below)
    apiKeyEnv: DEEPSEEK_API_KEY   # the variable that holds the key, never the key itself
    models: [deepseek-chat]       # optional: listed in /v1/models; any deepseek/<model> is forwarded
  mine:                           # example: a vendor without a preset, its bases written out
    messages: https://llm.example.com/anthropic   # base that speaks Anthropic Messages
    auth: x-api-key               # optional: x-api-key or bearer (default) on the messages base
    apiKeyEnv: MINE_API_KEY
  openai:
    preset: openai                # openai: https://api.openai.com/v1 (audio, images)
    apiKeyEnv: OPENAI_API_KEY
groups:
  fast: [deepseek/deepseek-chat, mine/mine-small]   # tried in order
```

- A provider declares which bases it has. `messages` is the base Claude Code's `ANTHROPIC_BASE_URL` would be: `/v1/messages` is appended. `openai` is an OpenAI-style base: `/audio/speech`, `/audio/transcriptions`, `/images/generations` and `/images/edits` are appended. The bases decide what the gateway can forward to that provider.
- `auth` says how the key travels on the `messages` base. The default is `Authorization: Bearer`, which is what Claude Code sends for `ANTHROPIC_AUTH_TOKEN` and what the vendors below document. The `openai` base always uses a bearer.
- `apiKeyEnv` names a variable from the environment or the workspace `.env`. A provider whose variable is empty stays listed but is off, with a warning at boot, as a speech provider is. A provider without `apiKeyEnv` gets no auth header, for a local server.
- Model ids are `provider/model` or a group's name, the same convention as magpie. A group's members are `provider/model` each. A group may not be named like a provider.
- Validation is strict. An unknown key, a URL with a query or credentials, a group member naming a provider the file lacks, or a key written in place of a variable name stops the file from loading. The gateway then answers 503 with the reason, and the space keeps running.

### Presets

A preset fills in the bases only. The key always comes from `apiKeyEnv`, and a base written in the file wins over the preset. Each one was checked against the vendor's own documentation on 2026-11-23:

| preset | base | auth | source |
| --- | --- | --- | --- |
| `anthropic` | messages `https://api.anthropic.com` | `x-api-key` | https://platform.claude.com/docs/en/api/overview |
| `deepseek` | messages `https://api.deepseek.com/anthropic` | bearer (either is accepted) | https://api-docs.deepseek.com/guides/anthropic_api |
| `zai` | messages `https://api.z.ai/api/anthropic` | bearer | https://docs.z.ai/scenario-example/develop-tools/claude |
| `zhipu` | messages `https://open.bigmodel.cn/api/anthropic` | bearer | https://docs.bigmodel.cn/cn/guide/develop/claude |
| `kimi` | messages `https://api.moonshot.ai/anthropic` | bearer | https://platform.kimi.ai/docs/guide/claude-code-kimi.md |
| `minimax` | messages `https://api.minimax.io/anthropic` | bearer | https://platform.minimax.io/docs/token-plan/claude-code.md |
| `dashscope` | messages `https://dashscope.aliyuncs.com/apps/anthropic` (pay-as-you-go) | bearer | https://help.aliyun.com/zh/model-studio/claude-code |
| `openai` | openai `https://api.openai.com/v1` | bearer | https://developers.openai.com/api/reference/resources/audio |
| `groq` | openai `https://api.groq.com/openai/v1` (audio) | bearer | https://console.groq.com/docs/speech-to-text |

Not covered by a preset, so the base must be written out: Kimi's and MiniMax's China hosts, DashScope's workspace and plan hosts, and any other vendor. For the Z.ai, Zhipu, Kimi, MiniMax and DashScope endpoints, none of those pages say whether `x-api-key` is accepted or whether `count_tokens` exists. The bearer default is what they document.

## Routes

Under `/api/model-gateway`, which is the base a child process gets. Claude Code appends `/v1/messages?beta=true`; the query string is passed on.

| route | forwards to | notes |
| --- | --- | --- |
| `POST /api/model-gateway/v1/messages` | `{messages}/v1/messages` | JSON or SSE back as the provider sent it; usage read from `message_start` and `message_delta` on the side |
| `POST /api/model-gateway/v1/messages/count_tokens` | `{messages}/v1/messages/count_tokens` | a provider without it answers its own error, unchanged |
| `GET /api/model-gateway/v1/models` | (answered here) | `{ object: "list", data: [...] }`: groups first (`kind: "group"`, `members`), then each provider's listed models and group members as `provider/model`. The same shape magpie's `/v1/models` answers; `readCatalog` in `runtimes/magpie.ts` reads it and tells the groups apart |
| `POST /api/model-gateway/v1/audio/speech` | `{openai}/audio/speech` | JSON body as sent; the audio comes back unchanged |
| `POST /api/model-gateway/v1/audio/transcriptions` | `{openai}/audio/transcriptions` | multipart as sent, only `model` rewritten |
| `POST /api/model-gateway/v1/images/generations` | `{openai}/images/generations` | OpenAI Images |
| `POST /api/model-gateway/v1/images/edits` | `{openai}/images/edits` | multipart (`image[]`) or JSON, as sent |

The gateway's own errors use the caller's protocol: `{ type: "error", error: { type, message } }` on the Messages routes, `{ error: { message, type } }` on the others. An unknown model is a 400. A provider that is off is a 503. A provider that lacks the needed base is a 400 naming it. The answer carries `x-space-gateway-served: provider/model`.

## Who may call it

Apps do not call the model gateway. They keep using `/api/model/*` and `/api/speech/*`, which choose the model, keep the ledgers and enforce the app's settings. This is the app spec's rule: declare, do not integrate.

The routes have the policy `self` ([auth.md](auth.md#access-policy)): they check their own credential, whatever `SPACE_AUTH` is.

- **A token ai-space issued.** The form is `sgw-<run>.<mac>`. The run id is random per process or call. The mac is an HMAC of the run id under a secret made at each boot, so no token is stored and every token dies with the process that issued it. Tokens are issued only to the Claude Code processes ai-space starts for a `gateway: space` runtime and to its own callers: the `anthropic-api` runtime and the speech adapter, one per call. The token is accepted as `Authorization: Bearer` or `x-api-key`. The operator token, a session, an app's `SPACE_APP_TOKEN` and a consumer key are all refused with a 401.
- **From loopback, directly.** The peer address must be a loopback address, and a request that carries `X-Forwarded-For`, `Forwarded`, `CF-Connecting-IP` or `X-Real-IP` is refused with a 403. Such a request came through the router or a tunnel, whose requests also arrive from loopback. A space bound by `SPACE_HOST` to one non-loopback address has no built-in gateway; the boot log says so.

A Claude Code process holds its token in its environment, so commands that process runs (its Bash tool) can read it, as they can read any variable ai-space gives an agent run. What they send is traced under that run.

## Failover

- Only within a group, walking its members in order. A direct `provider/model` never moves.
- Only before the first byte of the answer is sent back. A failure in the middle of a stream ends that stream.
- Only for the failure kinds in `REST_KINDS` (`credit`, `quota`, `rate`, `transport`), classified by `classifyFailure` (`src/space/model/failure.ts`) from `API <status>: <the vendor's message>`. A refused `Retry-After` is read as there (`(retry after 30s)`). An unreachable provider is a transport failure. Any other refusal, a 400 about the request say, goes back to the caller as the provider wrote it.
- A provider that failed for one of those kinds rests, for as long as `restFor` says (the times in [model-machines.md](model-machines.md#status), or what the error named). While it rests it goes after the others in every group, never dropped. A success ends its rest. Rests live in memory.
- When every member has failed, the last refusal goes back unchanged.
- **One conversation, one vendor.** Within a run token, a group keeps the member that first answered it, and that member is tried first afterwards. A request whose messages carry `thinking` or `redacted_thinking` blocks goes to that member only and never fails over, since another vendor would refuse a thinking block whose signature it did not make. Without such blocks the run may move on when its member fails.

## Trace, not a second ledger

The gateway stores no prompt or reply content. Per run token it keeps how many requests it forwarded, every `provider/model` it tried, the last one that answered (`served`), the token counts the answers reported (summed), and the last error. The trace is held in memory, at most 2,000 runs (oldest dropped first) and none older than a day. The model service and the speech service stay the owners of the ledgers.

- A `claude-code` runtime with `gateway: space` reads its run's trace after an answer and sets the outcome's `served`. The call's [trace](model.md#trace) then names what answered, which a call through Claude Code could not do before. The CLI's own cost figure is dropped: it prices another vendor's model at Claude's list prices. Its token counts are kept.
- An `anthropic-api` runtime with `gateway: space` does the same per call. For pictures, what served is named in the call's `text`.

## Runtimes

### Claude Code: `gateway:`

```yaml
runtimes:
  glm:
    kind: claude-code
    gateway: space                 # space (built in), magpie, or a gateway's address; `magpie: <url>` still works
    models:                        # the gateway's ids: provider/model, or a group
      basic: fast
      intermediate: zhipu/glm-4.6
```

- `gateway: space`: each process gets `ANTHROPIC_BASE_URL` set to the built-in gateway's loopback address and `ANTHROPIC_AUTH_TOKEN` set to a token issued for that process. It also gets each tier's pin behind Claude Code's alias for it, the basic pin as `ANTHROPIC_SMALL_FAST_MODEL`, and `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`. The same variables go as `--settings '{"env":{…}}'`, the mechanism magpie runtimes use ([below](#magpie)). `ANTHROPIC_API_KEY` is left out of the process. The gateway knows no Claude alias, so a tier left unpinned takes the nearest pinned one, a lower one first, and the CLI's background calls on `haiku` still name a model the gateway can route. A live chat's process is matched without its token, so a conversation keeps its process, and with it its run token and its vendor.
- `gateway: magpie`: magpie's address found as `space setup` finds it (`MAGPIE_ADDR`, its `gateway.json`, the default port), then exactly the `magpie:` behaviour below. `gateway: <url>`: another gateway at that address, set up the same way.
- `magpie:` and `gateway:` together are refused. So is `ssh:`, and a `machines:` fallback entry on such a runtime: the gateway is on this machine's loopback.
- Status: a `gateway: space` runtime counts as signed in while the built-in gateway can answer: a `gateway.yaml` that loaded, at least one provider on, ai-space listening on loopback.

### The Messages API: `anthropic-api` with `gateway: space`

```yaml
runtimes:
  gw:
    kind: anthropic-api
    gateway: space                 # no apiKeyEnv, no url: the gateway issues a token per call
    models:
      basic: fast
      junior: openai/gpt-image-1   # a tier /api/model/image can name (below)
```

Answers go to the built-in gateway's `/v1/messages` with a token issued for the call, and `served` comes from that token's trace. A literal `url:` pointing at the gateway would need the port and a token, and only ai-space can issue one, so the runtime names the gateway instead. The runtime takes images (`CompleteInput.files`) as base64 image blocks, as every `anthropic-api` runtime now does, and still refuses tools.

### Images

An `anthropic-api` runtime with `gateway: space` has the `image` operation when one of the gateway's providers is on and has an `openai` base. `POST /api/model/image` can then resolve to it as it resolves to `codex-cli` ([model.md](model.md#images)): the route's contract, its model resolution and `model.tags.image` do not change. Without input images it calls `images/generations`. With them it calls `images/edits`, multipart, with one `image[]` per input image. The system text goes before the prompt. The pictures must come back as `b64_json`; an answer that only names URLs is refused, since ai-space does not fetch what an answer names. `response_format: b64_json` is sent to every model except OpenAI's GPT image models, which always answer base64 and refuse the parameter (OpenAI's [Images reference](https://developers.openai.com/api/reference/resources/images)).

Which vendors accept the OpenAI Images shape as is was checked on 2026-11-23. OpenAI accepts both endpoints. Together's generations ask for `response_format: base64`, not `b64_json`. Zhipu's and Z.ai's CogView generations answer with URLs only. DashScope's compatible mode gives `b64_json` for two Qwen image models only and has no `/images/edits`. xAI's edits take JSON, not multipart. So OpenAI is the one vendor known to work for both operations here. Others may work for generations once the answer shape fits, and none of the others accepts OpenAI's multipart edits.

## Speech

The speech contract does not change ([speech.md](speech.md)). An `openai-compatible` speech provider can point at a model gateway instead of a vendor, so the key is configured once:

```yaml
# providers.yaml
speech:
  providers:
    cloud:
      kind: openai-compatible
      gateway: space              # or magpie
      provider: openai            # a provider of gateway.yaml (or of magpie) with an openai base
      asrModel: gpt-4o-transcribe # the provider's own names; sent as openai/gpt-4o-transcribe
      voice: alloy
```

With `gateway:` the provider takes no `url`, `apiKeyEnv` or `selfHosted`. Through the built-in gateway each call carries a token issued for it, and the address is read when the call is made. A provider that names a `gateway.yaml` provider that is missing, has no `openai` base or is off is turned off at boot with the reason, as one with a missing key is. Through magpie the address is magpie's and the key is magpie's caller key, so magpie's `/v1/audio/*` works the same way. OpenAI's list prices apply when the gateway provider's `openai` base is OpenAI's own host. Live dictation (`WS /api/speech/live`) does not go through a model gateway.

## magpie

[magpie](https://github.com/yetone/magpie) is an external model gateway on the same machine: one Anthropic Messages endpoint in front of many providers (GLM, Kimi, MiniMax, DeepSeek and the rest), with its own keys, accounts, protocol translation and failover. ai-space does not install magpie or change its settings. It is supported exactly as before the built-in gateway existed, and a space where magpie runs uses it in one of two forms.

**Claude Code through magpie** (the usual one: chat, agent tasks and answers, with Claude Code's tools):

```yaml
runtimes:
  claude:
    kind: claude-code
  magpie:
    kind: claude-code
    magpie: http://127.0.0.1:3425  # the gateway's address, no path; also `gateway: magpie`
    models:                        # magpie's ids: provider/model, or one of its groups
      basic: zhipu/glm-4.5-air
      intermediate: zhipu/glm-4.6
```

Each process of that runtime gets `ANTHROPIC_BASE_URL` set to the gateway and `ANTHROPIC_AUTH_TOKEN=magpie-ai-space`. magpie needs no key from loopback; this one names the caller, so magpie's usage page counts these calls as ai-space's. Each pinned tier becomes the model behind Claude Code's alias for it (`ANTHROPIC_DEFAULT_HAIKU_MODEL` for basic, `_SONNET_` junior, `_OPUS_` intermediate, `_FABLE_` advanced), and the basic pin becomes `ANTHROPIC_SMALL_FAST_MODEL`, so the CLI's background calls go there too. `ANTHROPIC_API_KEY` is left out of that process. Only that process sees this: `~/.claude` is not touched, and the plain `claude` runtime keeps the CLI's own sign-in.

**ai-space's pins override magpie's Agents page.** When magpie wires Claude Code from its Agents page, it writes an `env` block with these same variables into `~/.claude/settings.json`, and Claude Code lets that block win over the process environment. So the same variables also go to each process of the runtime as `--settings '{"env":{…}}'`, which Claude Code ranks above the user's settings file. A tier pinned in ai-space answers with that model whatever the file says. A tier left unpinned is not in `--settings`, so it is Claude Code's own: its alias (`haiku`, `sonnet`, …), or whatever the user's settings file (magpie's Agents page included) maps that alias to.

- **Its tiers**: a pinned tier is magpie's id (`provider/model`, or a routing group such as `group/fast`); an unpinned one is Claude Code's alias for it, as for a plain `claude` runtime. `magpie/<provider>/<model>` sends magpie's own id. Pins may contain `/` for that reason.
- **Picking them in Settings**: Settings → Models shows, for each runtime through magpie, a picker per tier filled from the gateway's `/v1/models`, with its routing groups (an id under `group/` or `auto/`, or an entry magpie labels as one) listed apart from its plain models. **Save** writes the runtime's `models:` in `runtimes.yaml`, the same pins the file and `space setup` use, editing the text so comments stay (`PUT /api/model/runtimes/models {"runtime","models":{"basic":"group/fast","junior":""}}`, operator only; `""` clears a tier). A running runtime uses the new pins from its next call (an open live chat keeps its process until it ends); one added since the last start needs a restart. A new pin must be one magpie lists now. A saved one it no longer lists stays, shown with a warning. While the gateway does not answer, the saved pins are shown and kept, and only clearing or keeping them is accepted.
- **Local only**: `ssh:` and a `machine:` fallback entry on it are refused, since the gateway listens on this machine's loopback.
- **Status**: the CLI's own login is not asked. The cell counts as signed in while the gateway answers its model list with at least one model ([model-machines.md](model-machines.md#status)).

**The API form**, for a machine without Claude Code (answers only: no tools, no full mode; a fallback entry on it is skipped for such a call):

```yaml
runtimes:
  magpie:
    kind: anthropic-api
    url: http://127.0.0.1:3425/v1/messages
    apiKeyEnv: MAGPIE_API_KEY     # in .env: MAGPIE_API_KEY=magpie-ai-space
    models:
      basic: deepseek/deepseek-chat
fallback:
  codex/basic: [magpie/basic]     # magpie answers when the Codex login is out of quota
```

- **Finding it**: `MAGPIE_ADDR` when set, else the address the running gateway wrote to `gateway.json` in magpie's settings folder (`$XDG_CONFIG_HOME/magpie` or `~/.config/magpie`), else `127.0.0.1:3425`; then one `GET /v1/models` (no tokens spent). `src/space/runtimes/magpie.ts`.
- **Adding it**: `space setup` offers it when the gateway answers and no runtime uses it yet. It asks for a model per tier and offers a routing group named for the tier (`basic`, `group/basic` or `ai-space-basic`, any case) as the default. Otherwise the tier is left empty, which means Claude Code's own model; the API form needs a model for at least one tier and fills the rest from the tier before. It then writes the runtime to `runtimes.yaml`: the Claude Code form when `claude` is installed, else the API form and `MAGPIE_API_KEY` in `.env`. Settings → Models shows the same four pickers, with the same suggested groups, and **Add as a runtime** (`POST /api/model/runtimes {"kind":"magpie","models":{...}}`). After adding, the runtime's own pickers are shown at once. Either way, a restart loads it.
- **What answered**: magpie names the model that served a call in `X-Magpie-Model`, and an API call's [trace](model.md#trace) keeps it as `served`, so a group or magpie's own failover is visible in the ledger. A refused call's `Retry-After` is appended to the error (`(retry after 30s)`) and sets how long the cell rests.
- **Cost**: priced like any API call when the model it names has a list price here, else left without one; magpie's own Usage page has its figures.
- **Not done here**: the Codex CLI through magpie (its provider settings), and `served` for calls made through Claude Code via magpie (the CLI does not pass magpie's headers on; the built-in gateway's trace does this for `gateway: space`).

## Code

`src/space/gateway/`: `types.ts` (providers, groups, the trace, `GatewayLink`, what runtimes and speech hold of it), `config.ts` (`gateway.yaml`, the presets), `tokens.ts` (issued tokens), `trace.ts` (the per-run trace and the group member a run keeps), `forward.ts` (headers each way, usage read on the side of an SSE stream), `service.ts` (`ModelGateway`: the order of candidates, failover, rests, the answer), `api.ts` (the routes, the token and loopback check, the base a child process gets). The runtimes' side is in `runtimes/claude-code.ts`, `runtimes/anthropic-api.ts` and `runtimes/magpie.ts` (`gatewayClaudeEnv`); the speech side in `speech/config.ts` and `speech/openai.ts`. Boot wiring is in `src/index.ts`.

## Not done

- Protocol translation, a native agent loop, subscription-account bridging, and Codex through the built-in gateway: out of scope by design.
- Settings → Models pickers for a `gateway: space` runtime. `/v1/models` answers in the shape the magpie pickers read, but the panel only shows the magpie section; pins are written in `runtimes.yaml` by hand for now.
- `served` for agent tasks and chat turns through the built-in gateway: their records have no field for it yet; the trace has it.
- Rests and traces are in memory and start over at a restart.
- Live dictation through a model gateway.
