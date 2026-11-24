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

The usual way is Settings → Gateway ([Settings](#settings)): add a provider with its key, tick its models, test it, set the tiers. That writes `<workspace>/gateway.yaml` and, for a key typed there, the workspace `.env` ([Keys](#keys)); nothing has to be edited by hand and nothing needs a restart. The file stays the source of truth, and hand edits are kept.

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
tiers:                            # optional: what answers each ai-space tier ([below](#tiers))
  basic: fast
  advanced: mine/mine-large
  image: openai/gpt-image-1
```

- A provider declares which bases it has. `messages` is the base Claude Code's `ANTHROPIC_BASE_URL` would be: `/v1/messages` is appended. `openai` is an OpenAI-style base: `/audio/speech`, `/audio/transcriptions`, `/images/generations` and `/images/edits` are appended. The bases decide what the gateway can forward to that provider.
- `auth` says how the key travels on the `messages` base. The default is `Authorization: Bearer`, which is what Claude Code sends for `ANTHROPIC_AUTH_TOKEN` and what the vendors below document. The `openai` base always uses a bearer.
- `apiKeyEnv` names a variable from the environment or the workspace `.env`. A provider whose variable is empty stays listed but is off, with a warning at boot, as a speech provider is. A provider without `apiKeyEnv` gets no auth header, for a local server.
- `disabled: true` turns a provider off and keeps it in the file (Settings → Gateway's **Turn off**). It is listed, off, with the reason "turned off".
- `providers:` may be empty or absent: the file loads, and the gateway answers that it has no provider yet.
- Model ids are `provider/model` or a group's name, the same convention as magpie. A group's members are `provider/model` each. A group may not be named like a provider.
- Validation is strict. An unknown key, a URL with a query or credentials, a group member naming a provider the file lacks, or a key written in place of a variable name stops the file from loading. The gateway then answers 503 with the reason, and the space keeps running. A tier is the exception ([below](#tiers)).

### Tiers

`tiers:` says which model or group answers each ai-space tier through this gateway, for every runtime with `gateway: space`. Each of the four tiers (`basic`, `junior`, `intermediate`, `advanced`) is any provider's model or a group, so one gateway can serve advanced from GLM and intermediate from DeepSeek. `image` is the model or group that makes pictures ([Images](#images)). It is a tier of its own because a text model cannot draw.

- **Resolution order**, for a runtime with `gateway: space`: the runtime's own `models:` pin in `runtimes.yaml`, else the gateway's tier, else (Claude Code only) the nearest of those, a lower one first ([Claude Code](#claude-code-gateway)). An `anthropic-api` runtime with neither answers "no model for tier" as before. A request for pictures on such a runtime (`POST /api/model/image` naming any tier) goes to `image` when it is set, whatever the runtime pins for text; an explicit `provider/model` is sent as named.
- **Checks**: a text tier needs a provider with a `messages` base, `image` one with an `openai` base (a group: at least one member that has it), and a `provider/model` must name a provider of the file. A tier that fails this, for example after its provider was removed, does not stop the file from loading. It stays, with a warning at boot, and its calls fail with the gateway's reason. A tier that is not a string, or an unknown tier name, does stop the file from loading.
- **Read per call**: runtimes read the gateway's tiers on each call (Claude Code: each process), so a tier saved in Settings applies from the next call without a restart. The same holds for every change Settings → Gateway makes: the running gateway reads the file again after each save. An open live chat keeps its process, and its tiers, until it ends.

magpie keeps its tiers where they were: each magpie runtime's `models:` in `runtimes.yaml`. magpie has no file of ai-space's to hold them; its block in Settings → Gateway uses the same pickers ([Settings](#settings)).

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

Not covered by a preset, so the base must be written out: DashScope's workspace and plan hosts, and any other vendor. For the Z.ai, Zhipu, Kimi, MiniMax and DashScope endpoints, none of those pages say whether `x-api-key` is accepted or whether `count_tokens` exists. The bearer default is what they document.

#### China and international sites

MiniMax, Kimi and DashScope each run a China site and an international site, and an account (with its key) works on one of them only: a key made on platform.minimaxi.com gets `401 invalid api key` at `api.minimax.io`. Settings → Gateway shows a **Site** switch (International / China) for these presets when adding or editing a provider. Picking the preset's own site leaves the base alone; picking the other writes its base as the provider's `messages` override, so `gateway.yaml` stays `preset:` plus a base. Z.ai and Zhipu are the same pair, kept as two presets.

| preset | international | China |
| --- | --- | --- |
| `minimax` | `https://api.minimax.io/anthropic` (the preset's) | `https://api.minimaxi.com/anthropic` |
| `kimi` | `https://api.moonshot.ai/anthropic` (the preset's) | `https://api.moonshot.cn/anthropic` |
| `dashscope` | `https://dashscope-intl.aliyuncs.com/apps/anthropic` | `https://dashscope.aliyuncs.com/apps/anthropic` (the preset's) |

Each base answered an unauthenticated Messages call with 401 or 403 on 2026-11-24. The list is `GATEWAY_SITES` in `src/space/gateway/config.ts`.

## Prices

What a call through the built-in gateway costs is worked out by the gateway itself, per answer: the tokens the vendor's `usage` reported, at the price of the model that answered, at that provider. A run's answers are summed in its [trace](#trace-not-a-second-ledger) (`costUsd`), and the `claude-code` and `anthropic-api` runtimes put that figure on the ledger row. An answer from a model without a price makes the whole run unpriced (the trace lists it under `unpriced`), so the row has no cost rather than a low one. A price is one provider's tariff for one model, in USD per million tokens, and is looked for in this order:

1. `<workspace>/gateway-prices.yaml`, the owner's price for `provider/model`;
2. the same file's `provider/*`, for every model of that provider (a relay's discount, a plan);
3. [models.dev](https://models.dev)'s catalogue, for the models.dev provider that matches the provider: by preset and [site](#china-and-international-sites) (`minimax` → `minimax` or `minimax-cn`, `kimi` → `moonshotai` or `moonshotai-cn`, `dashscope` → `alibaba` or `alibaba-cn`, `zhipu` → `zhipuai`, `zai`, `deepseek`, `anthropic`, `openai`, `groq`), or, for a provider written out with its URL, the one models.dev lists at that host when exactly one does. The model id is matched exactly, then ignoring case; a variant is never priced from a similar name.

```yaml
# gateway-prices.yaml: input, output[, cache read, cache write], USD per million tokens
deepseek/deepseek-v4-pro: [1.32, 3.96, 0.044, 1.32]
relay/*: [0.5, 2]        # every model of provider "relay"
```

A missing cache price is the input price. models.dev's long-context tiers apply: once a call's prompt (input, cache reads and writes) is over a tier's size, the whole call is at that tier's prices. The file is its own, not a key of `gateway.yaml`, whose parser refuses unknown keys, so an older ai-space keeps its gateway on a rollback. It is re-read when it changes; a file that does not parse keeps the prices read before, and Settings shows why. models.dev is fetched at boot when the cached copy (`run/models-dev-prices.json`, only the prices) is missing or a day old; a failed fetch keeps the copy. Settings → Gateway lists each provider's models with their price (input / output) and source, and names the ones without a price.

Not done: a price is applied when the call is made, so changing one does not restate earlier rows (magpie re-prices when it reads); speech and pictures through the gateway are not costed here; the price file is edited by hand.

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

- A `claude-code` runtime with `gateway: space` reads its run's trace after an answer and sets the outcome's `served`. The call's [trace](model.md#trace) then names what answered, which a call through Claude Code could not do before. The CLI's own cost figure is dropped: it prices another vendor's model at Claude's list prices. Its token counts are kept, and the cost is the gateway's own, at the price of each model that answered ([Prices](#prices)).
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

- `gateway: space`: each process gets `ANTHROPIC_BASE_URL` set to the built-in gateway's loopback address and `ANTHROPIC_AUTH_TOKEN` set to a token issued for that process. It also gets each tier's pin behind Claude Code's alias for it, the basic pin as `ANTHROPIC_SMALL_FAST_MODEL`, and `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`. The same variables go as `--settings '{"env":{…}}'`, the mechanism magpie runtimes use ([below](#magpie)). `ANTHROPIC_API_KEY` is left out of the process. Each tier is the runtime's own pin, else the gateway's [tier](#tiers). The gateway knows no Claude alias, so a tier with neither takes the nearest of those, a lower one first, and the CLI's background calls on `haiku` still name a model the gateway can route. A live chat's process is matched without its token, so a conversation keeps its process, and with it its run token and its vendor.
- `gateway: magpie`: magpie's address found as `space setup` finds it (`MAGPIE_ADDR`, its `gateway.json`, the default port), then exactly the `magpie:` behaviour below. `gateway: <url>`: another gateway at that address, set up the same way.
- `magpie:` and `gateway:` together are refused. So is `ssh:`, and a `machines:` fallback entry on such a runtime: the gateway is on this machine's loopback.
- Status: a `gateway: space` runtime counts as signed in while the built-in gateway can answer: a `gateway.yaml` that loaded, at least one provider on, ai-space listening on loopback.

### The Messages API: `anthropic-api` with `gateway: space`

```yaml
runtimes:
  gw:
    kind: anthropic-api
    gateway: space                 # no apiKeyEnv, no url: the gateway issues a token per call
    models:                        # optional: over the gateway's tiers (above)
      basic: fast
```

Answers go to the built-in gateway's `/v1/messages` with a token issued for the call, and `served` comes from that token's trace. A literal `url:` pointing at the gateway would need the port and a token, and only ai-space can issue one, so the runtime names the gateway instead. The runtime takes images (`CompleteInput.files`) as base64 image blocks, as every `anthropic-api` runtime now does, and still refuses tools.

### Images

An `anthropic-api` runtime with `gateway: space` has the `image` operation when one of the gateway's providers is on and has an `openai` base. `POST /api/model/image` can then resolve to it as it resolves to `codex-cli` ([model.md](model.md#images)): the route's contract, its model resolution and `model.tags.image` do not change. Which model draws: the gateway's `image` [tier](#tiers) when the request names a tier, else the `provider/model` it names. Without input images it calls `images/generations`. With them it calls `images/edits`, multipart, with one `image[]` per input image. The system text goes before the prompt. The pictures must come back as `b64_json`; an answer that only names URLs is refused, since ai-space does not fetch what an answer names. `response_format: b64_json` is sent to every model except OpenAI's GPT image models, which always answer base64 and refuse the parameter (OpenAI's [Images reference](https://developers.openai.com/api/reference/resources/images)).

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

## Settings

Settings → Gateway is a section of its own, apart from Models. Settings → Models keeps the runtimes and the CLIs on each machine, and under its table names the runtimes whose tiers come from a model gateway, with a button that opens this section. The section has, in order:

- **Status**: whether the built-in gateway answers and with how many models and groups, or why not (no provider yet, a file that did not load, every provider off). When the gateway cannot exist on this space (`SPACE_HOST` is not a loopback address, [Who may call it](#who-may-call-it)) it says so and offers nothing to edit. The path of `gateway.yaml` is shown.
- **Providers**: each one with its name and vendor, on, off or resting and why, its bases, its key (set, by the page or by hand in `.env`, or set by the environment, with at most its last four characters; [Keys](#keys)), its models, and **Test**, **Edit**, **Replace key**, **Turn off**/**Turn on** and **Remove**.
- **Add provider**: a vendor of the [presets](#presets) needs only its key; **Use another address** overrides a base. **Custom** asks for a name, a messages and/or OpenAI-style base, the key header and an optional key (a local server needs none). Then the models: **Load the vendor's list** reads the vendor's model list where it documents one ([Model lists](#model-lists)) and each model gets a tick box; ids can be typed by hand; **Refresh** reads the list again. A preset without a list shows the ids its docs name, ticked, and the same field for others. **Add** writes the provider, and the gateway uses it at once: the first provider creates `gateway.yaml`.
- **Groups**: each group with its members in order, **↑ ↓** to reorder, **✕** to drop a member, a picker to add one, a field for a new group, and **Save**. A group a tier names cannot be removed here.
- **Tiers**: the four tier pickers and **Pictures** (when a provider can draw or `image` is set), filled from the gateway's models with its groups apart. A value can be typed by hand (**Type an id…**), and a saved value the gateway does not list now stays selected with a warning.
- **Runtimes through it**: the runtimes with `gateway: space`, **Add a Claude Code runtime** (when `claude` is installed here) and **Add an API runtime**. Either is written to `runtimes.yaml` the same comment-keeping way, named `gateway` or `gateway-api` (then `-2`, …), and answers at once: no restart.
- **magpie**: magpie's row, as it was under Models ([below](#magpie)).

**Test** sends one minimal request per base and shows each one's result, the vendor's error text when it failed, and the time it took. On `messages` it is `POST /v1/messages` with `max_tokens: 1` and a one-word prompt, to the first model the provider lists (a few tokens are billed). On `openai` it reads the model list, which is free; it never makes a picture or speech. It runs only when clicked.

**Remove** says which groups and tiers name the provider. Its members leave those groups, a group left empty goes, and the tiers naming it or an emptied group are cleared. It asks whether to delete the stored key: ticked by default only for a key this page wrote; a key set by the environment is never touched.

Every change edits the text of `gateway.yaml` rather than re-serializing it: comments and order elsewhere stay, an entry keeps its place, a line whose value is unchanged keeps its trailing comment, and a new block goes at the end (groups after providers). The result must parse back with the change asked and everything else unchanged, or nothing is written. A file the page cannot edit this way (a flow-style `providers:` or `groups:` on one line, a provider written as a flow mapping) is shown as it is, read-only, with the reason. A file that does not load is shown the same way, read-only with its error, until it is fixed by hand. The gateway reads the file again after each save.

### Keys

A key typed in Settings goes to the workspace `.env`, the file the space already keeps its secrets in, under a variable the page names `SPACE_GATEWAY_<NAME>_KEY` (the provider's name upper-cased, `-` as `_`), and `gateway.yaml` gets `apiKeyEnv:` with that name, never the key. This is how a hub's token is stored when a peer is adopted (`src/space/peers/adopt.ts`): the file is rewritten atomically, keeps its mode (0600 when the page creates it, as `src/space/workspace.ts` creates it), and the value is also set in the running process, so the next call uses it with no restart. Page keys sit under their own comment line at the end of `.env`; other lines are kept as they are.

- **Write-only**: no route answers a key, and no log line, error or trace carries one. A vendor's error that echoes the key is shown with `[key]` in its place. The page shows whether a key is set, where from, and its last four characters when the key is at least 12 long.
- **From the environment**: a variable set in the real environment of the service (not only in the workspace `.env`) is shown as "set by the environment". The page does not overwrite it: **Replace key** is refused (409), and adding a provider whose page variable is set that way is refused too. Change it where it is set.
- **Hand-written variables**: a provider whose `apiKeyEnv` was written by hand keeps it. **Replace key** writes that variable in `.env`.
- **Removing**: `DELETE … ?key=delete` deletes the variable from `.env` and the process; `keep` leaves it; the default deletes only a page variable (`SPACE_GATEWAY_…`) no other provider names.
- Like every `.env` value, a key is in the service's environment, so the processes it starts inherit it, as they already inherit the other keys there.

### Model lists

Where a vendor documents a list of models, **Load the vendor's list** reads it with the key being added (or the provider's stored key), from the base configured (a base override is followed). Checked against each vendor's docs on 2026-11-24:

| preset | list | auth | source |
| --- | --- | --- | --- |
| `anthropic` | `GET {messages}/v1/models` | `x-api-key`, `anthropic-version` | https://platform.claude.com/docs/en/api/models-list |
| `deepseek` | `GET https://api.deepseek.com/models` (the messages base without `/anthropic`) | bearer | https://api-docs.deepseek.com/api/list-models |
| `kimi` | `GET https://api.moonshot.ai/v1/models` (likewise) | bearer | https://platform.kimi.ai/docs/api/list-models |
| `minimax` | `GET {messages}/v1/models` | `x-api-key` | https://platform.minimax.io/docs/api-reference/models/anthropic/list-models.md |
| `openai` | `GET {openai}/models` | bearer | https://developers.openai.com/api/reference/resources/models/methods/list |
| `groq` | `GET {openai}/models` | bearer | https://console.groq.com/docs/models |
| `zai`, `zhipu`, `dashscope` | none documented for the Anthropic-compatible base | | https://docs.z.ai/api-reference/introduction, https://docs.bigmodel.cn/cn/guide/develop/claude/introduction, https://www.alibabacloud.com/help/en/model-studio/anthropic-api-messages |

Without a list, or when reading it fails, the page offers the ids the vendor's docs name (the preset's defaults) and says why, and ids can always be typed. A custom provider is asked `GET {openai}/models` when it has an OpenAI-style base, else `GET {messages}/v1/models`. Each list answers `data[].id`.

### Routes

Every route is the operator's: the owner's session, a device credential or the operator token, behind the browser-write guard, in every `SPACE_AUTH` mode. An app's or a consumer's credential is refused (403) even where `SPACE_AUTH=external` without a token would otherwise let any caller act as the operator, since tunnel traffic arrives from loopback too. Apps reach none of this ([docs/auth.md](auth.md)).

| route | does |
| --- | --- |
| `GET /api/model/gateway` | the section: the file, whether it can be edited, providers with their key state, groups, tiers, models, presets, runtimes |
| `POST /api/model/gateway/providers` | `{name, preset?, messages?, openai?, auth?, key?, apiKeyEnv?, models}`: add one |
| `PUT /api/model/gateway/providers/:name` | `{messages?, openai?, auth?, models?, disabled?}`; `""` removes a base override |
| `PUT /api/model/gateway/providers/:name/key` | `{key}`: set or replace its key |
| `DELETE /api/model/gateway/providers/:name?key=delete\|keep` | remove it, with groups and tiers as above |
| `POST /api/model/gateway/providers/:name/test` | `{model?}`: the test above; `{results: [{base, ok, ms, status?, error?, detail?}]}` |
| `POST /api/model/gateway/models` | `{provider}` or `{preset\|messages\|openai, auth?, key?}`: `{source: "vendor"\|"defaults", models, defaults, error?}` |
| `PUT /api/model/gateway/groups` | `{groups: {name: [provider/model, …]}}`: the whole set |
| `PUT /api/model/gateway/tiers` | `{tiers: {basic, …, image}}`; `""` clears a tier |
| `POST /api/model/gateway/runtimes` | `{kind: "claude-code"\|"anthropic-api"}`: a runtime through it, in `runtimes.yaml`, loaded at once |

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
- **Picking them in Settings**: Settings → Gateway shows, in magpie's block ([Settings](#settings)), for each runtime through magpie, a picker per tier filled from the gateway's `/v1/models`, with its routing groups (an id under `group/` or `auto/`, or an entry magpie labels as one) listed apart from its plain models. **Save** writes the runtime's `models:` in `runtimes.yaml`, the same pins the file and `space setup` use, editing the text so comments stay (`PUT /api/model/runtimes/models {"runtime","models":{"basic":"group/fast","junior":""}}`, operator only; `""` clears a tier). A running runtime uses the new pins from its next call (an open live chat keeps its process until it ends); one added since the last start needs a restart. A new pin must be one magpie lists now. A saved one it no longer lists stays, shown with a warning. While the gateway does not answer, the saved pins are shown and kept, and only clearing or keeping them is accepted.
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
- **Adding it**: `space setup` offers it when the gateway answers and no runtime uses it yet. It asks for a model per tier and offers a routing group named for the tier (`basic`, `group/basic` or `ai-space-basic`, any case) as the default. Otherwise the tier is left empty, which means Claude Code's own model; the API form needs a model for at least one tier and fills the rest from the tier before. It then writes the runtime to `runtimes.yaml`: the Claude Code form when `claude` is installed, else the API form and `MAGPIE_API_KEY` in `.env`. Settings → Gateway shows the same four pickers, with the same suggested groups, and **Add as a runtime** (`POST /api/model/runtimes {"kind":"magpie","models":{...}}`). After adding, the runtime's own pickers are shown at once. Either way, a restart loads it.
- **What answered**: magpie names the model that served a call in `X-Magpie-Model`, and an API call's [trace](model.md#trace) keeps it as `served`, so a group or magpie's own failover is visible in the ledger. A refused call's `Retry-After` is appended to the error (`(retry after 30s)`) and sets how long the cell rests.
- **Cost**: priced like any API call when the model it names has a list price here, else left without one; magpie's own Usage page has its figures. The built-in gateway's [prices](#prices) do not apply to magpie.
- **Not done here**: the Codex CLI through magpie (its provider settings), and `served` for calls made through Claude Code via magpie (the CLI does not pass magpie's headers on; the built-in gateway's trace does this for `gateway: space`).

## Code

`src/space/gateway/`: `types.ts` (providers, groups, the trace, `GatewayLink`, what runtimes and speech hold of it), `config.ts` (`gateway.yaml`, the presets, `tiers:` and its text edit), `tokens.ts` (issued tokens), `trace.ts` (the per-run trace and the group member a run keeps), `forward.ts` (headers each way, usage read on the side of an SSE stream), `service.ts` (`ModelGateway`: the order of candidates, failover, rests, the answer), `api.ts` (the routes, the token and loopback check, the base a child process gets). Settings → Gateway is `src/web/GatewaySettings.tsx` (the tier pickers and magpie's row come from `src/web/MachineClis.tsx`) with its routes in `gateway/settings.ts`, the text edits of `gateway.yaml` and `.env` in `gateway/edit.ts`, and the vendors' model lists and the test in `gateway/vendors.ts`. The runtimes' side is in `runtimes/claude-code.ts`, `runtimes/anthropic-api.ts` and `runtimes/magpie.ts` (`gatewayClaudeEnv`); the speech side in `speech/config.ts` and `speech/openai.ts`. Boot wiring is in `src/index.ts`.

## Not done

- Protocol translation, a native agent loop, subscription-account bridging, and Codex through the built-in gateway: out of scope by design.
- Per-runtime pickers for a `gateway: space` runtime in Settings: the section sets the gateway's tiers, which every such runtime uses; a runtime's own `models:` pins are edited in `runtimes.yaml`.
- Removing a runtime from Settings; and a speech provider through the gateway is still written in `providers.yaml`.
- `served` for agent tasks and chat turns through the built-in gateway: their records have no field for it yet; the trace has it.
- Rests and traces are in memory and start over at a restart.
- Live dictation through a model gateway.
