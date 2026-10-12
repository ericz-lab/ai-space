# Chat service design

The chat service is the Space-layer answer to "put an AI conversation on this page". An app's page mounts one widget; the space keeps the conversation (threads, messages, the images the person put in), replays it on every turn, runs the turn through the model service, streams the answer back and hands the images to wherever the model runs. The app contributes what only it knows: what the model should read first, the presets it wants above the box, the actions it wants under an answer, and the colours.

Status: implemented in `src/space/chat/` (store, prompt, service, routes, import) and `src/web/chat-widget/` (the widget); used by ai-notes and ai-calendar.

## Why a Space service

Before this service each app with an AI box had written its own: ai-notes a full chat with its own two tables, SSE route and panel; ai-calendar a one-shot box that forgot everything on reload. Neither could show the model an image, because the model runs on another machine reached over ssh and the images were on the app's disk. A third app would have copied one of the two. The loop is the same everywhere: store the person's message, replay the thread, run it, store the answer, stream it. The parts that differ per app are small and declarative, so they became options of one widget, and the loop moved down into ai-space, next to the model service that already runs the calls.

## Goals and non-goals

Goals:

- One conversation store per space, by app and by an app-defined `scope`, so a note's chats stay with the note and a calendar's with the calendar.
- Images in a message that the model actually looks at, whichever machine it runs on.
- The answer shown as it is written.
- One widget, styled by the app through CSS tokens and extended through presets, actions and a custom renderer, never forked.
- Every turn in the model ledger under the app, tagged `chat`.

Non-goals, for now:

- Tools that touch the machine. A page reaches the turn route through its app's proxy, so a turn may ask for `Read`, `WebSearch` and `WebFetch` and nothing else. Agents with tools in an app directory are the panel's agent chat (`docs/panel.md`).
- Files other than images.
- Peers: an app talks to the ai-space on its own machine.
- A panel view over every app's threads; the data is there for it.
- Carrying a turn across a restart of ai-space: the runtime's process dies with it, so the turn is closed as interrupted with the text it had, and the person retries.

## Model

### Thread, message, attachment

A **thread** belongs to an app and a `scope` (`^[a-z0-9][a-z0-9:._/-]{0,127}$`, the app's own key: `note:12`, `calendar`), has a title (the first line of the first message unless the app set one) and is ordered by its last activity. A **message** is one side of a turn: `user` or `assistant`, its text, and for an answer the id of the ledger row that produced it (backend, cost and tokens are read from there, never copied) or the error when it failed. An **attachment** is one image (png, jpeg, gif or webp, sniffed from the bytes, at most 5 MB) uploaded to a thread; it belongs to no message until a turn sends it, and one that is never sent is removed after an hour. Files live under `<workspace>/data/<app>/chat/<thread>/a<id>.<ext>`, inside the app's data directory so the app's backup covers them.

| cap | value |
| --- | --- |
| attachment size | 5 MB |
| attachments per message | 4 |
| attachments per thread | 24 |
| files shipped per turn | 8, 20 MB |
| message | 40,000 characters |
| context text | 500,000 characters |
| replayed messages | the last 40, then trimmed to fit the prompt limit |

### Turn

`POST /api/chat/threads/:id/turn` with:

| field | type | meaning |
| --- | --- | --- |
| `message` | string | The person's text. Required. |
| `context` | object? | `system` (replaces the runtime's system prompt), `text` (what the model reads before the conversation: the note, the calendar) and `ack` (the assistant's acknowledgement that follows it). Rebuilt by the app on every turn, so the model never argues from a stale copy. |
| `attachments` | number[]? | Ids of uploads to this thread not yet sent. |
| `model`, `thinking`, `timeoutMs` | as `/api/model/run` | The app's model; the person's pick in the widget overrides it and the space's default fills in when both are absent ([Model choice](#model-choice)). Timeout defaults to 5 minutes. |
| `tools` | string[]? | From `Read`, `WebSearch`, `WebFetch`; `Read` is added by the runtime when files travel. |
| `requestId` | string? | The client's name for this turn, 8 to 80 of `A-Z a-z 0-9 . _ : -`, unique per thread. With it the turn is durable and idempotent (below). The widget always sends one. |

One turn at a time per thread (`409` otherwise). The person's message is stored before the model runs and the attachments are bound to it; the thread's title is set from it when empty. The prompt is then built and run through `ModelService.run` with tag `chat`, so the ledger, the concurrency cap and the runtime choice are the model service's. The answer is stored on success; on failure the assistant message holds whatever text streamed and the error, and later turns leave that pair out of the replay. The response is `text/event-stream`: `start {turn, user}` (the turn's id and status, and the person's message as stored), `delta {text}` as the text is produced, then `done {ok: true, user, assistant, thread, call}` or `error {ok: false, error, user, assistant, thread, call?}`, with a `: keepalive` comment every 15 s; `?stream=0` gives the same as one JSON answer (`502` on a model failure). Every stream of a turn carries the answer from its first character: a reader that joins late gets the text so far as its first `delta`.

#### A turn outlives its connection

A turn belongs to its thread, not to the request that started it. Each has a row in `chat_turns` (`running`, then `done`, `failed`, `stopped` or `interrupted`), and it runs in the background of the service: `ChatService.begin` starts it and returns, and any number of readers follow it.

- **The reader goes away** (a closed tab, a dropped network, a page that turned to another thread): the turn carries on and its answer is stored. `GET /api/chat/threads/:id` says `running: true` with `turn: {id, status, requestId, userMessageId, text}` (the answer so far), and `GET /api/chat/threads/:id/turn` is the same event stream again, for as long as the turn runs (`404` once it is over; the thread then has the answer).
- **The same `requestId` again** on the same thread is the same turn: no second message is stored and no second model call is made. While it runs the response joins it; once it is over the response is `start` and the stored `done` or `error`. A client whose connection broke before it knew whether the request arrived posts it again without a risk.
- **Stop** is its own request, `POST /api/chat/threads/:id/stop` → `{stopped}`: the run is ended, and the answer is stored with what arrived, the error `stopped` and `state: "stopped"`. Nothing else ends a turn but its own end and its `timeoutMs`.
- **ai-space restarts** under a turn: the text so far is saved with the turn's row as it is written (the first text at once, then at most once a second), and at boot `ChatService.settleInterrupted` closes every row still `running` with an answer holding that text, an error that starts with `interrupted` and `state: "interrupted"`. The same `requestId` then gets that answer back.

`stopped` and `interrupted` answers are failed answers in every other respect: later turns leave the pair out of the replay. A message's `state` is absent on an ordinary failure (a timeout, a runtime error).

A turn posted **without** `requestId` keeps the older contract, for callers that never asked for more: it ends when its connection does and is stored with the error `aborted`.

Not covered: the answer is not resumed inside the runtime after a restart (its process is gone), and only the text is kept while a turn runs, not the tool calls the runtime is in the middle of.

### Model choice

The widget has a model chip under the box (`⚙ claude/opus`, the model in use). It opens a picker: "Default (follow the app / space)" and every runtime/tier pair of a runtime that answers requests (`claude/basic` … `codex/advanced`, the list `GET /api/tasks/models` shows), each with the concrete model it maps to. The pick is stored in ai-space per app (`chat_model_choices` in `space.db`, keyed by the app the token maps to), so it holds across reloads and devices, and every scope and thread of that app uses it.

A turn runs on the first of:

1. the person's pick for the app, when it still resolves (a pick whose runtime was removed from `runtimes.yaml` is skipped, and the picker says so, rather than failing every turn);
2. the `model` of the turn, which is `context().model` or the mount option `model`;
3. the space's app default: Settings → Default model, else `SPACE_MODEL_DEFAULT`.

The server applies the order, so a page with an older cached widget gets the pick too. The ledger row, and the `model`/`backend` a message shows, are the model the turn really ran on.

Per app, not per scope or thread: scopes are the app's own keys and often short-lived (`note:12`), so a pick per scope would reset on every new note and a pick per thread on every new conversation; what the person means by the choice is "the model this app's chat uses". An app that wants a different model for one kind of page still sets `model`, which applies whenever the person has left the pick on default.

### The prompt

A runtime takes one prompt, so the thread becomes one text with the roles marked:

```
<context.text>

---

[assistant]
<context.ack>

[user]
<earlier message>
(attached: a17.png)

[assistant]
<earlier answer>

[user]
<message>
(attached earlier: photo.png — no longer visible)
```

Failed answers and the message that caused them are skipped; neighbours with the same role are merged; the history is the last 40 messages, then dropped from the oldest pair until the whole prompt is under the model service's limit. A long thread never fails outright.

### Which images travel

Every image shipped is read again by the runtime on every turn (a `Read` call plus the image's tokens), so a thread with many images would grow linearly in cost. A turn ships the new message's attachments, then the newest earlier ones, up to 8 files and 20 MB (`MAX_FILES_PER_TURN` in `src/space/chat/types.ts`, the knob to tune from ledger data); the rest are named in the prompt as no longer visible, so the model can still say "the photo you sent earlier". The person is told as well: the message of that turn carries `omitted`, the number of earlier images that did not travel, and the widget says so under it, so the page never implies the model saw an image it was not given. How the files reach the runtime, locally or over ssh, is in `docs/model.md`.

## API

```
GET    /api/chat/threads?scope=&limit=      threads of the app in a scope, newest first
POST   /api/chat/threads                    { scope, title? } → 201 thread
DELETE /api/chat/threads?scope=             every thread of a scope (an app deleting a note); 409, nothing deleted, while one answers
GET    /api/chat/threads/:id                thread, messages with attachments and (from the ledger) backend, model, cost; `running`, and `turn` with the text so far while it answers
PATCH  /api/chat/threads/:id                { title }
DELETE /api/chat/threads/:id                rows and files; 409 while it answers
POST   /api/chat/threads/:id/attachments    multipart field `file` → 201 attachment (413 too large, 415 not an image)
GET    /api/chat/attachments/:id            the image bytes
POST   /api/chat/threads/:id/turn           one turn, streamed (above); with `requestId` durable and idempotent
GET    /api/chat/threads/:id/turn           the turn in flight as the same stream, from its first character; 404 when the thread is not answering
POST   /api/chat/threads/:id/stop           the person's stop → { stopped }
GET    /api/chat/models?model=              the picker: options, choice, appModel, defaultModel, effective and fallback (what "default" means now); `model` = what the app asks for
PUT    /api/chat/model                      { model: "runtime/tier" | model | null } the person's pick for the app's chat (null = default) → the same view; 400 when the model does not resolve (unknown runtime, tier without a model)
GET    /api/chat/widget.js | widget.css     the widget, no token
```

The caller is identified like the model service's: an app's `SPACE_APP_TOKEN` maps to the app; the operator token needs `app` in the body or query. An app only ever sees its own threads and images.

## The widget

`src/web/chat-widget/` is vanilla TypeScript bundled once at boot (`build.ts`, a few milliseconds; `SPACE_DEV=1` rebuilds per request) and served with an etag. It renders inside a shadow root of the element it is mounted in, so the app's stylesheet and its own never collide; CSS custom properties and the font inherit through, which is how the app styles it.

```js
const chat = SpaceChat.mount(el, {
  base: "/space/chat",                 // the app's proxy prefix (default)
  scope: "note:12",                    // which conversations this widget shows
  context: ({ scope, thread, signal }) => ({ system, text, ack, tools, model, thinking, timeoutMs }),   // called on every turn; may be async; may throw
  model, tools, thinking, timeoutMs,   // defaults when context() gives none
  presets: [{ label: "总结", prompt: "…", send: true }],   // chips; send: false only fills the box
  actions: [{ label: "追加到笔记", run: (message, thread) => … }],   // under every answer; copy is built in
  renderAssistant: (message) => html | node | undefined,   // undefined = the default Markdown
  onReply: (message, thread) => …, onError: (error, message) => …,
  threads: true, attachments: true, modelPicker: true, drafts: true, theme: "auto", lang: "zh", placeholder, emptyText,
});
chat.send(text, files?) · chat.fill(text) · chat.newThread() · chat.openThread(id) · chat.setScope(scope) · chat.setTheme(t) · chat.stop() · chat.destroy() · chat.scope · chat.thread · chat.messages · chat.busy
```

Behaviour: `modelPicker: false` hides the model chip (the person's stored pick still applies). On mount the threads of the scope are listed and the newest opened; the first message creates a thread when there is none. A send shows the message at once, the answer as it streams (Markdown re-rendered on a short timer), then swaps both for the stored rows; a failure keeps the partial text with the reason. Images: paste, drop on the box, or the `＋` button; each is uploaded at once and previewed, and its id travels with the message. `Enter` sends, `Shift+Enter` breaks a line, `Esc` stops; `Enter` that confirms an input method's candidate does not send (`isComposing`, and key code 229 for Safari). Theme `auto` follows the page's `data-theme` when set (both apps set it), else the system. Its words are in `i18n.ts`, Chinese and English, chosen by `lang` or `<html lang>`.

### The contract with the app

What every app's chat needs lives in the widget and the service; an app adds only what it alone knows. The parts an app can rely on:

- **`context(turn)` is per turn and may refuse it.** It is called with `{ scope, thread, signal }`: the scope and thread the message was sent in, which stay the same however the page moves on while it runs. An app that keeps one widget over many things (a note per scope) reads its context by `turn.scope`, never by "what is open now". Everything it returns applies to this turn only and wins over the mount option of the same name, `timeoutMs` included. If it **throws**, the turn is not sent and nothing is stored: the message leaves the log, its text and images go back into the box, the reason is shown (`Not sent: …`) and `onError(reason)` is called. That is how an app blocks a turn it cannot give a true context for, such as a document whose save just failed. `signal` aborts when the turn is given up before it was sent.
- **A turn is followed, not owned.** `setScope`, `openThread`, `newThread` and `destroy` only stop following the turn in flight; it carries on in the service ([A turn outlives its connection](#a-turn-outlives-its-connection)). Opening a thread that is answering shows the answer so far and follows the rest. A message still waiting for `context()` when the widget turns away was never sent: its text is kept as that thread's draft. Every asynchronous step checks that the widget still shows what it was started for, so a late response is dropped instead of landing in another scope or thread; on `setScope` the log is emptied at once, before the new scope's threads arrive.
- **Stop is explicit.** The send button is Stop while a turn runs (`Stopping…` until the service confirms), and `chat.stop()` is the same request. A stopped answer keeps its text and is marked stopped.
- **States of an answer.** Being written (a placeholder until the first text, then the text with a caret); stopped; interrupted (ai-space restarted); failed with the reason. The last three offer **Retry**, which asks the question again as a new turn. When the connection is lost the widget reopens the stream on its own, a few times with growing pauses, by posting the same `requestId`; if that fails too the answer says the connection was lost and Retry asks the service again under the same id, so a turn that did finish is shown rather than run twice.
- **`onReply` and `onError`** fire for a turn this widget saw end, whether it started it or found it running. An answer that finished while the widget showed something else is in the thread when it is opened again, but is not announced; an app that acts on answers should treat the thread as the record.
- **`actions[].run(message, thread)`** gets the thread the answer was rendered in; `thread.scope` says what it belongs to, which is what an app should write into, not "what is open now". The button is disabled until `run` settles. A string it returns is shown as the confirmation and an error it throws as the failure, so an app reports "saved" by returning it after the save, not by its own toast before it.
- **Drafts.** The unsent text of each thread (and of a scope before its first thread) is kept while the person looks at another thread or scope and across reloads (`localStorage` of the app's origin, removed when sent); `drafts: false` keeps one box for the whole widget, as before. Images waiting in the box belong to one thread and are dropped when the widget turns away.
- **Reading back.** When the person scrolls up, new text no longer pulls the log down and a button returns to the latest.
- **What the model was given.** A message whose turn did not ship some earlier images says how many ([Which images travel](#which-images-travel)). What an app puts in `context().text` is the app's to describe truthfully on its own page.

Older embedders keep working: a `context()` that takes no argument, an action that returns nothing and a mount without the new options behave as they did, except that leaving a turn no longer cancels it and drafts are on.

Tokens, all with defaults in `widget.css` and dark values under `:host([data-theme="dark"])`: `--sc-font`, `--sc-font-size`, `--sc-radius`, `--sc-bg`, `--sc-fg`, `--sc-muted`, `--sc-surface`, `--sc-surface-strong`, `--sc-border`, `--sc-accent`, `--sc-on-accent`, `--sc-user-bg`, `--sc-user-fg`, `--sc-assistant-bg`, `--sc-code-bg`, `--sc-danger`, `--sc-chip-bg`, `--sc-shadow`, `--sc-focus`, `--sc-menu-bg` (the model picker's background, opaque). An app sets them on the mount element, mapping its own palette (`--sc-accent: var(--ink)`).

## Adopting it in an app

A page cannot call ai-space: the API is loopback and the app token is the server's. The app's server proxies one prefix:

```
/space/chat/*  →  ${SPACE_API_URL}/api/chat/*   with  authorization: Bearer ${SPACE_APP_TOKEN}
```

forwarding every method (the widget uses GET, POST, PUT and DELETE; PATCH renames a thread) and only `content-type`, `accept`, `content-length` and `if-none-match` (never cookies), returning only `content-type`, `cache-control`, `etag` and `content-length`, streaming both ways (the turn is an event stream, an upload is multipart). A Bun proxy passes `timeout: false` to `fetch`, since Bun drops a connection idle for five minutes and the model may think longer; a Node proxy uses `http.request` with `setTimeout(0)` and pipes. The page loads `/space/chat/widget.js` with a script element created at runtime (`document.createElement("script")`, `onload` → mount): a static `<script src>` would be resolved at build time by a bundler that builds the page, such as Bun's HTML import, and fail. Then it mounts the widget with its scope and `context()`.

An app that kept its own chat table brings it along once: `bun src/index.ts chat-import <app> <file.jsonl>`, one thread per line (`{ scope, title, createdAt, updatedAt, messages: [{ role, content, error?, createdAt }] }`); a thread already present (same app, scope, creation time) is skipped, so the command can be run again.

## Failure modes

| situation | behaviour |
| --- | --- |
| A second message while the thread answers | `409`; the widget says so and keeps the text in the box. |
| The app's `context()` throws | The turn is not sent; the text and images go back into the box with the reason. |
| The client goes away mid-answer | With a `requestId` (the widget): the turn finishes and is stored; the page that comes back finds it running or done. Without one: the run is stopped and the answer keeps what arrived with the error `aborted`. |
| The connection drops mid-answer | The widget reopens the stream under the same `requestId`; after a few failed attempts the answer says so and offers Retry. |
| The person presses Stop | The answer keeps what arrived and is marked stopped; the next turn replays without that pair. |
| An upload that is not an image, or too large | `415` / `413`, a toast on the page; nothing stored. |
| The runtime cannot open files | The turn fails with the runtime's reason (the API and dsh runtimes refuse files); the message is stored with the error. |
| ai-space restarts mid-turn | The turn's process dies with it. At boot the turn is closed as interrupted with the text saved so far; the widget, reconnecting under the same `requestId`, shows it with Retry. |

## Follow-ups

- Retry that reuses the failed message and its images instead of asking again as a new message.
- Widget tests in a DOM: its turn, draft and key logic is tested apart from the page (`turn.ts`, `compose.ts`), the wiring to the page is not.
- Retention for old threads; today everything is kept.
- Native image blocks on the API runtime, so a space on `SPACE_MODEL_API_KEY` can see images too.
- A panel window over every app's threads.
