# Model service design

The model service is the Space-layer answer to "run this prompt through a model". An app hands ai-space a prompt and a purpose; ai-space runs it on the backend the workspace is configured for, returns the answer with the usage the runtime reported, and writes one row to a ledger. Agent tasks the scheduler runs land in the same ledger. The panel shows the ledger by app, purpose, model and backend over a rolling window.

Status: implemented in `src/space/model/` (runner with three backends, ledger, service, API, scheduler hook, panel view).

## Why a Space service

Before this service every app carried its own copy of the same runner: pick a backend (an API key, an ssh host whose `claude` login to borrow, or the local `claude`), spawn `claude -p --output-format json`, feed the prompt on stdin, parse the envelope, time out, and keep a private table of calls if the author remembered to. The copies drifted the way the notification copies did (`docs/notify.md`): some recorded usage, most did not; the ssh host was configured in every app's `.env`; and the question "which calls are eating the subscription" could only be answered by reading the CLI's own session logs on every machine.

The lesson from those logs is worth stating because it shapes the design: a `claude -p` call carries the CLI's system prompt and tool definitions as cached input on every call, on the order of twenty thousand tokens, whatever the prompt. An app that translates one headline per call spends nearly all of its tokens on that fixed overhead. The ledger records the four token kinds separately so this shows up as it is: a large cache-read column next to a small input column.

Moving the function down into ai-space follows app-spec rule 5, *declare, do not integrate*: an app sends one loopback HTTP call and gets an answer; where it ran, how many run at once, and what it cost are the workspace's business.

## Goals and non-goals

Goals:

- One backend configuration per workspace. Apps never hold an API key or an ssh host.
- One ledger for every model call on the machine, whether an app asked for it or the scheduler ran an agent task.
- Honest figures: token counts and cost are what the runtime reported. A call whose runtime reported nothing is recorded with the count of calls and no token figures; nothing is estimated from prompt length.
- A concurrency cap, so an app in a loop cannot start fifty runtimes at once.
- Apps in any language can participate. The contract is one HTTP request.

Non-goals, for now:

- Prompt design and batching. Whether to translate one headline per call or twenty is the app's decision; the ledger makes the cost of that decision visible.
- Conversations. One call is one prompt and one answer; there is no session or history.
- Images and files in the prompt. Text only.
- Switches and budgets (turning an app's calls off from the panel, refusing calls past a daily budget). The ledger is the prerequisite; the controls come after there is data to set them from.
- Merging the ledgers of peer machines into the hub's view.

## Backends

The backend is chosen once for the workspace from `<workspace>/.env`, in this order:

| variable | backend | how a call runs |
| --- | --- | --- |
| `SPACE_MODEL_API_KEY` | `api` | `POST /v1/messages` on the Anthropic API. Aliases `haiku`, `sonnet`, `opus` map to the current model ids; any other model name is passed through. Cost is computed from list prices for the models the service knows. Tools are refused: the API backend has none. |
| `SPACE_MODEL_SSH_HOST` | `ssh:<host>` | `ssh <host> bash -lc 'claude -p --output-format json --model … [--allowedTools …]'` with the prompt on stdin, borrowing that machine's `claude` login. Every argument is validated against a safe character set before it becomes part of the remote command. |
| neither | `local` | This machine's `claude -p …`, same arguments, same stdin. |

`SPACE_MODEL_BIN` replaces the `claude` command (a wrapper script, the test stand-in). `SPACE_MODEL_MAX_CONCURRENCY` (default 4) caps the calls running at once; the rest wait in order. `SPACE_MODEL_DEFAULT` (default `sonnet`) is the model when a request names none. `SPACE_MODEL_RETENTION_DAYS` (default 90) is how much ledger is kept; older rows are pruned on insert.

The CLI answers with one JSON envelope (`type: result`): the text under `result`, token counts under `usage`, and its own cost figure under `total_cost_usd`. `is_error` in the envelope is a failure even though the process exited 0. A CLI that answers in plain text (an older one, or one started without the json flag) still works: the text is the answer and no usage is recorded.

## Model

### Call

What an app sends to `POST /api/model/run`:

| field | type | meaning |
| --- | --- | --- |
| `prompt` | string | The whole prompt. Required; at most 2 MB. |
| `model` | string? | A model alias or id as `claude --model` accepts it. Default `SPACE_MODEL_DEFAULT`. |
| `tag` | string? | The purpose of the call inside the app: `translate`, `story`, `digest`. Default `other`. This is the grain the panel groups by. |
| `tools` | string[]? | Tools the CLI may use, as `--allowedTools` takes them (`WebSearch`, `Bash(git:*)`). None by default; refused on the API backend. |
| `timeoutMs` | number? | Default 120 s, at most 30 min. |
| `maxTokens` | number? | Output cap on the API backend; the CLI has none. Default 4096. |

The caller is identified by its bearer token, the same way as notify: an app's own `SPACE_APP_TOKEN` (handed over in its `space.env`) maps to that app; the operator's `SPACE_API_TOKEN` requires an explicit `app` in the body.

The answer is `200 { ok: true, text, call }` where `call` is the ledger row (id, app, tag, model, backend, status, usage, costUsd, durationMs). A failed call is `502 { ok: false, error, call }`, still with its ledger row: a failure is a call that cost something and must be counted. A malformed request is `400` with the reason and leaves no row.

### Ledger row

| field | meaning |
| --- | --- |
| `app`, `tag`, `model` | Who, why, what was asked for. |
| `backend` | `local`, `ssh:<host>`, `api`, or `agent:<runtime>` for scheduler tasks. |
| `origin` | `run` (an app's request) or `task` (an agent task the scheduler ran). |
| `status`, `error` | `ok` or `error` with the reason. |
| `startedAt`, `durationMs` | Wall clock of the whole call including any wait for a slot. |
| `promptChars`, `outputChars` | Sizes only; prompts and answers are not stored. |
| `usage` | `inputTokens`, `cacheWriteTokens`, `cacheReadTokens`, `outputTokens`, as reported; absent when the runtime reported none. |
| `costUsd` | The CLI's own figure (an equivalent API price, informational under a subscription), or the list price on the API backend; absent otherwise. |

### Agent tasks

A task with an `agent` target (`docs/scheduler.md`) spawns the runtime itself, inside the app directory with the prompt file on stdin. The target runner now reads the same json envelope: the answer becomes the run's output, `is_error` fails the run, and the usage and cost travel on the run result to a scheduler hook that writes the ledger row with `tag` = the task name and `origin: task`. The row exists even when no usage came back (a timeout, a `codex` runtime), so the count of calls stays honest.

## API

```
POST /api/model/run                       run one call (app token, or operator token + app)
GET  /api/model/status                    backend, concurrency cap, calls running and waiting
GET  /api/model/usage?window=24h&app=x    totals and sums by app, by app/tag/model, by model, by backend/origin over 5h | 24h | 7d | 30d, plus per-day sums for 30 days
GET  /api/model/calls?app&tag&limit       recent calls, newest first
```

The read routes carry no token, like the scheduler's: the panel runs in a browser that never holds the operator token (`docs/panel.md`).

## Panel

Settings → Scheduler → Model usage opens a floating window: the window selector (5 h matches a subscription's rolling quota), four cards (calls, tokens, cost, model time), a table by app, purpose and model with the four token kinds side by side, a table by model and backend, and the last thirty calls with their outcome. The panel refreshes every 30 s while open.

## Adopting it in an app

An app that has its own runner keeps it and adds one more backend, tried first when `SPACE_MODEL_URL` (ai-space's loopback address) and `SPACE_APP_TOKEN` are set:

```ts
const res = await fetch(`${process.env.SPACE_MODEL_URL}/api/model/run`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${process.env.SPACE_APP_TOKEN}` },
  body: JSON.stringify({ prompt, model: "haiku", tag: "translate", timeoutMs: 120_000 }),
  signal: AbortSignal.timeout(130_000),
});
const body = await res.json();
if (!body.ok) return null;   // body.error says why; the call is already in the ledger
return body.text;
```

The app's own accounting can go once every call it makes goes through the service. Its `CLAUDE_SSH_HOST` and `ANTHROPIC_API_KEY` move to the workspace `.env` as `SPACE_MODEL_SSH_HOST` and `SPACE_MODEL_API_KEY`.

## Failure modes

| situation | behaviour |
| --- | --- |
| The runtime is not installed or not logged in | Every call fails with the runtime's message; each failure is a ledger row, so the panel shows a column of errors rather than silence. |
| ssh host unreachable | Same: `ssh` exits non-zero, the call fails with its stderr. |
| Call longer than `timeoutMs` | The process is killed; the call fails with `timed out`. |
| More calls than the cap | They wait in order; `GET /api/model/status` shows how many. A waiting call's `durationMs` includes the wait. |
| ai-space restarts mid-call | The process dies with it; the app sees a connection error and no row is written for that call. |
| An app sends the operator token | It must name `app` in the body; without it, 400. |
| A prompt over 2 MB | 400. |

## Follow-ups

- Per-app and per-tag switches, with the panel able to flip them once it holds a credential for mutating routes.
- Daily budgets that turn a call into `429 budget exceeded`, which an app treats as skipped.
- Peer ledgers in the hub's view (`docs/peers.md`).
- Batch hints: the service could tell an app, from its own ledger, that its calls are mostly fixed overhead.
