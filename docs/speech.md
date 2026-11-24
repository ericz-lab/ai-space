# Speech: one capability, several providers

Status: implemented in `src/space/speech/` for file transcription, speech synthesis and live dictation, with two provider kinds: `voice-studio` (the self-hosted app, here or on a peer) and `openai-compatible` (OpenAI's audio API or any server that speaks it). `dashscope` is named in the configuration but not built yet ([Later](#later)).

It follows the model layer's shape ([runtimes.md](runtimes.md), [model.md](model.md), [model-machines.md](model-machines.md)): a Space contract that names no provider, providers registered by kind in a file, one adapter per kind that declares what it can do, a fallback list for account and link failures only, a ledger and a status table.

## Why a Space layer

Before this layer, speech came from one app's bus capabilities (`voice-studio/transcribe`, `voice-studio/speak`) and its live socket. Every caller depended on that app on one machine: the panel's voice input asked the bus for `voice-studio/transcribe` and bridged a socket to `voice-studio`'s `/api/asr/realtime`, here or on the one peer that has it. There was nowhere to say "use a cloud API when the GPU machine is off", nowhere to count what speech cost, and a voice name that `voice-studio` did not know was replaced by its first voice without a word.

Now callers use `/api/speech/*`. Which provider answers, where it runs, what happens when it fails and what it cost are the Space's business, as for model calls (app-spec rule 5, *declare, do not integrate*).

## Contract

| Route | Body | Answer |
| --- | --- | --- |
| `GET /api/speech` | | `{ ok, configured, source, configError?, warnings, default: { asr, tts, live }, fallback, voices, providers: [cell], usage24h }`: what this space can do, and each provider's [status cell](#status). |
| `POST /api/speech/transcribe` | multipart: `file` (required, at most 25 MB), `language` (`zh`, `en`, …; empty lets the provider detect it), `context` (at most 300 characters: terms the speech may contain), `tag`, `provider` | `200 { ok: true, text, language, segments: [{ start, end, text }], provider, call }`. `segments` is empty when the provider gives no timing. |
| `POST /api/speech/speak` | JSON: `text` (required, at most 20,000 characters), `voice` or `voices` (a list, for a provider that reads `Speaker N:` scripts), `tag`, `provider` | `200 audio/wav`, with `x-speech-provider`, `x-speech-voice` and `x-speech-call-id`. |
| `GET /api/speech/voices` | | `{ ok, providers: [{ provider, voices?, error? }], mapped }`: each provider's own voices (`voice-studio` from its `/api/voices`, an API provider from its configuration) and the [voice table](#voices). |
| `WS /api/speech/live` | the [live protocol](#live-protocol) | the same |
| `GET /api/speech/calls?app&limit` | | the ledger's recent rows, newest first |
| `GET /api/speech/usage?window=5h\|24h\|7d\|30d&app` | | totals, by provider and by app |

A failure is `{ ok: false, error, call? }` with a status: 400 a bad request or a capability the provider lacks, 403 a [local-only](#privacy) app sent to a cloud provider, 404 an unknown provider, 413 a file or text over a limit, 502 the provider failed (with `call`, the ledger row), 503 no provider can be reached or the configuration does not load.

**Callers.** The routes take the `app` policy ([auth.md](auth.md)): an app's `SPACE_APP_TOKEN` calls as that app, the operator token and the panel (no token, writes held to the panel's origin by `guardBrowserWrites`) call as `space`. A token that names nobody is a 401.

**`provider`** pins the call to one provider, by its name in [the file](#configuration): no fallback, as a model naming its runtime. A `voice` written `provider/voice` does the same for speech. An app names one only when the call cannot work on another.

**`tag`** is the purpose inside the app (`voice-input`, `dictation`, `narration`), the grain the ledger groups by; default `other`.

### Compatibility

The panel's older routes stay and now go through the same layer, so the native clients keep working against a newer Space and gain its fallback and ledger:

| Older route | Now |
| --- | --- |
| `GET /api/voice` | `{ ok, transcribe }`: whether the default ASR provider (or one of its fallbacks) can be reached |
| `POST /api/voice/transcribe` | `POST /api/speech/transcribe` with the tag `voice-input` |
| `WS /api/voice/realtime` | `WS /api/speech/live` with the tag `voice-input` |

`voice-studio` keeps its `provides:` (`transcribe`, `speak`) for the apps that still call it through the bus; they move to `/api/speech/*` one by one ([Migration](#migration)).

## Configuration

`<workspace>/providers.yaml` holds one section per capability; today only `speech:`. It is a file of its own, not a section of `runtimes.yaml`: an older ai-space refuses an unknown key in `runtimes.yaml` and would then lose every runtime on a rollback, and a space without `runtimes.yaml` (its runtimes from `.env`) can still configure speech.

```yaml
speech:
  default: { asr: gpu, tts: gpu }              # live: defaults to the asr provider
  providers:
    gpu:
      kind: voice-studio                       # self-hosted: the app, here or on a peer
      machine: gpu-box                         # optional: the peer it runs on; default: here, else the one peer that has it
    openai:
      kind: openai-compatible
      url: https://api.openai.com/v1           # optional: default shown; /audio/transcriptions and /audio/speech under it
      apiKeyEnv: OPENAI_API_KEY                # the variable that holds the key; never the key itself
      asrModel: whisper-1                      # optional: default shown
      ttsModel: tts-1                          # optional: default shown
      voice: alloy                             # optional: the voice when a request names none
  fallback:
    asr: [openai]                              # tried after the first choice, in order, on account or link failures only
    tts: [openai]
  voices:
    narrator: { gpu: en-Frank_man, openai: onyx }      # one name, each provider's own voice
```

Without the file, or without its `speech:` section, the space has the one provider every space had before: `voice-studio` of kind `voice-studio`, the default for all three, no fallback. Nothing changes for a space that writes no file.

- **Names**: providers follow the app-name rule (`[a-z0-9][a-z0-9._-]*`). `default` is required when there is more than one provider; with one, it is the default for everything it can do.
- **Checked at load**: unknown keys, a default or fallback entry that names no provider or one whose kind lacks the capability, an entry listed twice, a voice mapped onto an unknown provider. A file that breaks a rule does not load: every speech call then answers 503 with the reason, and `GET /api/speech` shows it as `configError`. The space itself keeps running.
- **Keys** stay in the environment (the workspace `.env` is loaded into it). A provider whose `apiKeyEnv` is empty is kept but off, with a warning at boot; a call to it says so, and a fallback list skips it.
- **`live`** uses `default.live` and `fallback.live` when given, else `asr`'s.

### From Settings

Settings → Gateway → **Speech** ([model-gateway.md](model-gateway.md#speech-group)) shows every speech provider in one list: the built-in model gateway's providers that can transcribe or speak, and every other provider of this file, marked **custom** with what it serves (ASR, TTS, live) and, for a `voice-studio` one, where it is (this machine, a peer, or not found). For ASR and for TTS it edits an order: the first answers (`default`), the rest are its `fallback`, in order. A gateway provider joins an order with its model and, for TTS, a default voice; a custom one can be moved within an order or taken out of it, and its own definition is never rewritten. Live is shown read-only, only when a provider can do it, and never changes here. The running service reloads the file at once, no restart. Each provider has a TTS test that plays in the page and an ASR test that transcribes that clip, on click only.

**Nothing changes unless the owner changes an order.** An upgrade writes nothing. Saving the orders as they are writes nothing either, and a save rewrites only what changed: an untouched `default:` or `fallback:`, or an untouched provider, keeps its lines and comments.

**Without this file** the built-in default is `voice-studio` for everything, and it counts only while it is really there: the voice-studio app on this machine, or its capability on a peer, as the speech service locates it for its status (no probe on page load). Then it is listed as custom and first, and a save writes it out with the built-in defaults, live included, before the gateway's providers (so writing the file never drops it). When it is not there the space has no speech provider: a call answers 503 `no_provider` ("no speech provider is set up on this space"), status lists none, and the default is back by itself once the app is installed or a peer lists it. The page then names none of it, shows "nothing answers speech yet", and a save writes a file with only the providers chosen.

The entries the page writes are named `gateway-<provider>` with `kind: openai-compatible`, `gateway: space`, `provider:` and the models; one no order uses is removed, unless `voices:` names it. A hand-written file keeps its comments, other providers and `voices:`; a file the page cannot edit is shown read-only. These entries are cloud providers, so a [local-only](#privacy) app never reaches them.

## Kinds

Each kind is one adapter (`src/space/speech/voice-studio.ts`, `openai.ts`) and declares its capabilities: `transcribe` (a file), `live` (a microphone), `speak` (text to WAV), `clone` (a new voice from a sample; no adapter offers it through the Space yet). A call for a capability the chosen provider lacks is a 400 that names the provider and the capability, never a quiet move to another one.

| kind | capabilities | where it runs | limits |
| --- | --- | --- | --- |
| `voice-studio` | transcribe, live, speak | the `voice-studio` app on this machine, else on `machine:`, else the one peer that provides it; reached through the bus (`/api/call`, `/api/peer/call`) and, for live, the peer's WebSocket bridge to the app ([peers.md](peers.md)). Self-hosted. | 4 MB per file (the bus's call limit), at most 4 voices per script |
| `openai-compatible` | transcribe, speak | `POST {url}/audio/transcriptions` (multipart: `file`, `model`, `language`, `prompt` from `context`, `response_format`) and `POST {url}/audio/speech` (`model`, `input`, `voice`, `response_format: wav`) with the key as a bearer. A cloud API unless `selfHosted: true` (a server the operator runs, such as a Whisper server on the LAN). | 25 MB per file, 4,096 characters per text, one voice |
| `dashscope` | — | not built yet: the provider loads as off with a warning ([Later](#later)) | |

`openai-compatible` may instead point at a model gateway, `gateway: space` (the built-in one) or `gateway: magpie`, with `provider:` naming the gateway's provider; it then has no `url` or key of its own, and its models are sent as `<provider>/<model>` ([model-gateway.md](model-gateway.md#speech)). `openai-compatible` further takes `voices` (the voices it accepts: an unknown one is refused before the call), `selfHosted`, `responseFormat` (`verbose_json`, which carries segments and the duration, is the default for `whisper*` models; `json` for the others, which do not support it) and `price` ([Ledger](#ledger)). Whisper names the language in full (`chinese`); the adapter answers its code (`zh`).

## Choosing a provider

For one call, in order:

1. **The first choice**: the request's `provider` (or a `provider/voice`), else the default for the capability (`asr` for transcribe, `live` for live, `tts` for speak).
2. **The candidates**: the first choice, then the capability's fallback list without it (a pinned call has no fallback). A candidate that cannot take this call is skipped and the trace says why: off (no key), no such capability, the file or text over its limit, no mapping for the voice, a cloud provider for a [local-only](#privacy) app. When it is the first choice that cannot take the call, the call is refused with that reason instead.
3. **The order**: a candidate that rests ([Status](#status)) or cannot be reached moves after the others and is still tried last.
4. **When it moves on**: only after a `credit`, `quota`, `rate` or `transport` failure, read from the error as for model calls (`src/space/model/failure.ts`): a provider out of money, a used-up quota, a rate limit, an unreachable machine or a 5xx. A refused key, a bad request or a timeout ends the call. A busy GPU answers 503, which counts as a link failure: the call moves on.
5. **Never silent**: the ledger row names the provider that answered, `fallbackFrom` the first choice, `tries` how many ran, and `trace` every candidate and try; the answer carries the row as `call`.

### Voices

A voice belongs to one provider: a cloned voice exists only in the `voice-studio` that cloned it. So a voice is never carried to another provider under the same name.

- `provider/voice` pins the provider and uses its own voice name.
- A name in `voices:` is one voice under each provider's own name; a candidate without a mapping for it is skipped.
- Any other name is the first choice's own voice; the fallback candidates are skipped for it (`voice is <provider>'s own`).
- No voice: each provider's default (`voice:` for an API provider, `voice-studio`'s first installed voice).

Before a call, the voice is checked against the provider's list: `voice-studio`'s `/api/voices` (read here or through the peer's app proxy, kept for a minute) and an API provider's `voices:`. An unknown voice is a 400 with the list, because `voice-studio` would otherwise answer in its first voice. An API provider without a `voices:` list passes the name on, and the API refuses an unknown one itself.

## Live protocol

`WS /api/speech/live` speaks the Space's own stream protocol. Version 1 is the protocol `voice-studio` defined for `/api/asr/realtime`, so the self-hosted adapter passes it through and an API adapter translates its vendor's frames into it.

1. The client sends `{"type":"start","format":"pcm_s16le","sample_rate":16000,"channels":1,"language":"zh"}`, optionally with `tag` and `provider`. Format, rate and channels are fixed in version 1; `language` empty lets the provider detect it.
2. The Space picks the provider ([Choosing a provider](#choosing-a-provider)) and opens its stream. A provider whose socket cannot be opened (the machine is off, the peer is down) is a link failure: the next candidate is tried before anything reached the client. Once a provider answered, the session stays with it.
3. The provider answers `loading` while its model loads, then `ready` (`sample_rate`, `max_seconds`, `max_frame_bytes`), to which the Space adds `provider`. The client may record from the start and send what it held after `ready`.
4. The client sends **binary** signed 16-bit little-endian mono PCM at 16 kHz, at most 100 ms (3,200 bytes) per frame.
5. Events: `{"type":"partial","segment_id":0,"text":…}` replaces the current segment's draft; `{"type":"final",…}` commits it once, even when empty.
6. `{"type":"stop"}` ends the session: the remaining finals, then `{"type":"done"}` and the close. `{"type":"cancel"}` abandons it.
7. Errors are `{"type":"error","code":…,"message":…}` and close the socket. Codes from the Space: `invalid_request`, `no_provider`, `local_only`, `unavailable`; from the provider: `busy` (close code 1013), `transcription_failed` and its own `invalid_request`.

The Space holds at most 640 frames (about a minute of speech) while the provider's socket opens. Each session is one ledger row: the seconds of audio the client sent, the characters of final text, how it ended.

A browser socket must come from the panel's origin, as for `/api/voice/realtime`; an app's backend connects with its token in the `Authorization` header.

## Ledger

`speech_calls` in `space.db`, one row per call, also for a failure:

| field | meaning |
| --- | --- |
| `app`, `tag`, `capability` | who, why, which capability (`transcribe`, `speak`, `live`) |
| `provider`, `kind`, `machine` | what answered, and the peer it ran on (empty for this machine and for an API) |
| `status`, `error` | `ok` or `error` with the reason |
| `startedAt`, `durationMs` | wall clock of the whole call, every try included |
| `inputBytes` | the size of the file (transcribe) |
| `audioSeconds` | ASR: the input's length as the provider reported it (`duration`, or `voice-studio`'s last segment end), or the PCM a live session sent; TTS: the length of the WAV it answered |
| `chars` | TTS: the characters of text spoken; ASR: the characters of text heard |
| `voice`, `language` | the voice used, the language heard |
| `costUsd` | from the [price table](#prices), when the provider has a price; absent otherwise |
| `fallbackFrom`, `tries`, `trace` | as for model calls ([model.md](model.md#trace)) |

Audio and text are not stored, only their sizes.

### Prices

ASR is priced per minute of audio, TTS per million characters, in USD. An `openai-compatible` provider's `price: { transcribePerMinute, speakPerMillionChars }` wins; else, for a provider whose `url` is OpenAI's own, `src/space/speech/prices.json` gives OpenAI's list prices (verified 2026-11-19: `whisper-1` and `gpt-4o-transcribe` $0.006 a minute, `gpt-4o-mini-transcribe` $0.003, `gpt-transcribe` $0.0045, `tts-1` $15 and `tts-1-hd` $30 per million characters). A model priced by tokens (`gpt-4o-mini-tts`), a call whose length the provider did not report, and a self-hosted provider have no cost. A provider with `gateway: space` is priced by the built-in model gateway's prices first ([model-gateway.md](model-gateway.md#prices)), and its rows follow a later change of them.

## Status

`GET /api/speech` has one cell per provider: kind, capabilities, where it runs (this machine, a peer, or the API's host), `selfHosted`, `off` with the reason, `reachable` (for `voice-studio`: the app is here with a service, or on a peer whose snapshot is fresh), `signedIn` (an API provider's key is set), the rest after a failure (`limitedUntil`, `restKind`: the same causes and rests as a runtime's cell, [model-machines.md](model-machines.md#status), kept by the same `RuntimeHealth` class), `lastError`, `lastOkAt` (seeded from the ledger at boot), `used` (a default or in a fallback list) and `problem` (used and off, unreachable, not signed in or resting). Nothing is probed with a paid call: the cells learn from the calls.

Settings → Status shows them under **Speech** (语音), after the runtimes: a row per provider with its state, the defaults and fallback lists under them, and the last day's calls, minutes of audio, characters and cost.

## Privacy

An app that must not send speech to a cloud declares it in `space.yaml`:

```yaml
speech:
  local-only: true
```

Its calls then use only self-hosted providers (`voice-studio`, an `openai-compatible` with `selfHosted: true`): a cloud provider in a fallback list is skipped, and a cloud first choice is a 403 that says so. A provider through a model gateway (`gateway: space` or `magpie`) cannot be marked `selfHosted` and is always a cloud provider here, whatever the gateway's provider is. The panel and the operator are not an app and follow the configuration.

## What does not change

- Without `providers.yaml` the panel's voice input runs exactly as before: `voice-studio` here, else on its one peer, through the bus and the peer's socket bridge. The calls still appear in `bus_calls` too.
- `voice-studio` and its `provides:` stay as they are.
- The model layer is untouched: speech has its own ledger table and status cells, and reuses the model layer's failure reading and rest rules.

## Migration

Core callers, moved in this change: the web panel's voice input (`src/web/voice.ts` → `/api/speech/live`), and the routes the native clients use (`/api/voice`, `/api/voice/transcribe`, `/api/voice/realtime`), which are now the compatibility routes above. The native clients keep calling the older paths, so they work against an older Space too; they move when the oldest Space they support has `/api/speech`.

Callers in apps, each in its own repository and deployed on its own: an app that calls `voice-studio/transcribe` or `voice-studio/speak` through the bus, or bridges `voice-studio`'s live socket through a peer, moves to `/api/speech/transcribe`, `/speak` and `/live` with its app token, and declares `speech: { local-only: true }` when its audio must stay on the operator's machines. The ones known: a notes app's dictation and an idea app's voice input (live, through the peer's app proxy), a live interpreter (live transcription and speech), a video digest that posts files to `voice-studio`'s `/api/asr` directly or runs Whisper itself, and two apps that run a local Whisper command for captions or as a fallback. None of them changes in this step.

## Later

- **`dashscope`**: Bailian's Qwen3-ASR (the same model family `voice-studio` runs) and Qwen TTS. Its request and response shapes, 10 MB / 5 minute file limit and prices need checking against the current documentation before an adapter is written; the kind is reserved so a file that names it loads.
- **Live through an API**: OpenAI's realtime transcription and DashScope's realtime ASR speak other frame formats and voice-activity rules; their adapters translate them into the protocol above.
- **`clone`**: `POST /api/speech/clone` for providers that can (today `voice-studio`'s own page).
- Per-app provider overrides in Settings, like app models; a concurrency cap for API providers; the hub reading its peers' speech ledgers; the native clients' Status pages.
- **The same template for other capabilities**: embeddings, images, OCR and translation each get a Space contract (`/api/<capability>/*`), a section in `providers.yaml`, and one adapter per kind that declares its capabilities, sharing the ledger shape, the status cells and the fallback rule.

## Code

`src/space/speech/`: `types.ts` (capabilities, requests and answers, the adapter interface, `SpeechError`), `config.ts` (`providers.yaml`'s `speech:` section and the built-in default), `spec.ts` (the manifest's `speech:` section), `voice-studio.ts` and `openai.ts` (the adapters), `wav.ts` (a WAV's length), `prices.ts` with `prices.json`, `store.ts` (the `speech_calls` ledger), `service.ts` (choosing, fallback, voices, local-only, status cells, rows), `live.ts` (the live session between the client and the provider's socket), `api.ts` (the routes, the compatibility routes).
