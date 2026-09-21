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
- Finishing a turn the client walked away from: today the run is stopped and stored as failed with whatever arrived, like every other call.

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
| `model`, `thinking`, `timeoutMs` | as `/api/model/run` | Default model is the space's; timeout defaults to 5 minutes. |
| `tools` | string[]? | From `Read`, `WebSearch`, `WebFetch`; `Read` is added by the runtime when files travel. |

One turn at a time per thread (`409` otherwise). The person's message is stored before the model runs and the attachments are bound to it; the thread's title is set from it when empty. The prompt is then built and run through `ModelService.run` with tag `chat`, so the ledger, the concurrency cap and the runtime choice are the model service's. The answer is stored on success; on failure the assistant message holds whatever text streamed and the error, and later turns leave that pair out of the replay. The response is `text/event-stream`: `delta {text}` as the text is produced, then `done {ok: true, user, assistant, thread, call}` or `error {ok: false, error, user, assistant, thread, call?}`, with a `: keepalive` comment every 15 s; `?stream=0` gives the same as one JSON answer (`502` on a model failure).

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

Every image shipped is read again by the runtime on every turn (a `Read` call plus the image's tokens), so a thread with many images would grow linearly in cost. A turn ships the new message's attachments, then the newest earlier ones, up to 8 files and 20 MB (`MAX_FILES_PER_TURN` in `src/space/chat/types.ts`, the knob to tune from ledger data); the rest are named in the prompt as no longer visible, so the model can still say "the photo you sent earlier". How the files reach the runtime, locally or over ssh, is in `docs/model.md`.

## API

```
GET    /api/chat/threads?scope=&limit=      threads of the app in a scope, newest first
POST   /api/chat/threads                    { scope, title? } → 201 thread
DELETE /api/chat/threads?scope=             every thread of a scope (an app deleting a note)
GET    /api/chat/threads/:id                thread, messages with attachments and (from the ledger) backend, model, cost; `running`
PATCH  /api/chat/threads/:id                { title }
DELETE /api/chat/threads/:id                rows and files
POST   /api/chat/threads/:id/attachments    multipart field `file` → 201 attachment (413 too large, 415 not an image)
GET    /api/chat/attachments/:id            the image bytes
POST   /api/chat/threads/:id/turn           one turn, streamed (above)
GET    /api/chat/widget.js | widget.css     the widget, no token
```

The caller is identified like the model service's: an app's `SPACE_APP_TOKEN` maps to the app; the operator token needs `app` in the body or query. An app only ever sees its own threads and images.

## The widget

`src/web/chat-widget/` is vanilla TypeScript bundled once at boot (`build.ts`, a few milliseconds; `SPACE_DEV=1` rebuilds per request) and served with an etag. It renders inside a shadow root of the element it is mounted in, so the app's stylesheet and its own never collide; CSS custom properties and the font inherit through, which is how the app styles it.

```js
const chat = SpaceChat.mount(el, {
  base: "/space/chat",                 // the app's proxy prefix (default)
  scope: "note:12",                    // which conversations this widget shows
  context: () => ({ system, text, ack, tools, model, thinking }),   // called on every turn; may be async
  model, tools, thinking, timeoutMs,   // defaults when context() gives none
  presets: [{ label: "总结", prompt: "…", send: true }],   // chips; send: false only fills the box
  actions: [{ label: "追加到笔记", run: (message, thread) => … }],   // under every answer; copy is built in
  renderAssistant: (message) => html | node | undefined,   // undefined = the default Markdown
  onReply: (message, thread) => …, onError: (error, message) => …,
  threads: true, attachments: true, theme: "auto", lang: "zh", placeholder, emptyText,
});
chat.send(text, files?) · chat.fill(text) · chat.newThread() · chat.openThread(id) · chat.setScope(scope) · chat.setTheme(t) · chat.stop() · chat.destroy() · chat.thread · chat.messages
```

Behaviour: on mount the threads of the scope are listed and the newest opened; the first message creates a thread when there is none. A send shows the message at once, the answer as it streams (Markdown re-rendered per animation frame), then swaps both for the stored rows; a failure keeps the partial text with the reason. Images: paste, drop on the box, or the `＋` button; each is uploaded at once and previewed, and its id travels with the message. `Enter` sends, `Shift+Enter` breaks a line, `Esc` stops. Theme `auto` follows the page's `data-theme` when set (both apps set it), else the system.

Tokens, all with defaults in `widget.css` and dark values under `:host([data-theme="dark"])`: `--sc-font`, `--sc-font-size`, `--sc-radius`, `--sc-bg`, `--sc-fg`, `--sc-muted`, `--sc-surface`, `--sc-surface-strong`, `--sc-border`, `--sc-accent`, `--sc-on-accent`, `--sc-user-bg`, `--sc-user-fg`, `--sc-assistant-bg`, `--sc-code-bg`, `--sc-danger`, `--sc-chip-bg`, `--sc-shadow`, `--sc-focus`. An app sets them on the mount element, mapping its own palette (`--sc-accent: var(--ink)`).

## Adopting it in an app

A page cannot call ai-space: the API is loopback and the app token is the server's. The app's server proxies one prefix:

```
/space/chat/*  →  ${SPACE_API_URL}/api/chat/*   with  authorization: Bearer ${SPACE_APP_TOKEN}
```

forwarding only `content-type`, `accept`, `content-length` and `if-none-match` (never cookies), returning only `content-type`, `cache-control`, `etag` and `content-length`, streaming both ways (the turn is an event stream, an upload is multipart). A Bun proxy passes `timeout: false` to `fetch`, since Bun drops a connection idle for five minutes and the model may think longer; a Node proxy uses `http.request` with `setTimeout(0)` and pipes. The page loads `<script src="/space/chat/widget.js">` and mounts the widget with its scope and `context()`.

An app that kept its own chat table brings it along once: `bun src/index.ts chat-import <app> <file.jsonl>`, one thread per line (`{ scope, title, createdAt, updatedAt, messages: [{ role, content, error?, createdAt }] }`); a thread already present (same app, scope, creation time) is skipped, so the command can be run again.

## Failure modes

| situation | behaviour |
| --- | --- |
| A second message while the thread answers | `409`; the widget says so and keeps the text in the box. |
| The client goes away mid-answer | The run is stopped; the assistant message keeps what arrived with the error `aborted`, and the next turn replays without that pair. |
| An upload that is not an image, or too large | `415` / `413`, a toast on the page; nothing stored. |
| The runtime cannot open files | The turn fails with the runtime's reason (the API and dsh runtimes refuse files); the message is stored with the error. |
| ai-space restarts mid-turn | The turn's process dies with it; the person's message is stored, the answer is not; the widget shows the connection error and the thread reloads clean. |

## Follow-ups

- A detached mode that finishes and stores the turn after the client left, and lets the widget pick it up.
- Retention for old threads; today everything is kept.
- Native image blocks on the API runtime, so a space on `SPACE_MODEL_API_KEY` can see images too.
- A panel window over every app's threads.
