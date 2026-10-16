# Shortcuts and universal search

Status: phase 1, backend-configured sentence patterns, and skill-equipped agent intent routing are implemented (Web). Phases 2 and 3 below are still a plan.

Frequent operations run straight from the home screen's command box ([panel.md](panel.md#omnibox)) and from the built-in Shortcuts window: calculate, convert currencies, query financial news and calendars, create todos and run scheduler tasks, without opening each app. Every entry point shares one action catalogue, one validation, one executor and one set of result cards.

## User experience

| Typed in the command box | What happens |
| --- | --- |
| `128 * 3 + 56` | `= 440` under the field at once; Enter copies it. No server call. |
| `100 USD to CNY`, `100美元换人民币`, `$100 in eur` | The conversion with the rate, its source and quote time (a cached quote says so); Enter opens the full card. |
| `新闻`, `新闻 美联储`, `news fed` | Enter shows today's important financial news with source, link and publication time; text after the keyword is the topic. |
| `日历 本周`, `calendar next week` | The calendar of that period; financial and personal entries can be filtered apart. |
| `待办 明天下午3点 写周报` | A todo form with title, date (shown resolved, e.g. 2026-10-17), time, time zone and destination; Create (or Enter again) adds it. |
| A task's name, e.g. `daily-report` | "Run task" with that task; Run starts it and the card follows its status, output and run number. |
| Anything else | The library's entries and "Ask Space Assistant", as before. |

Direct results (arithmetic, a conversion) and an action named at the start of the text, or whose name the text equals or starts, rank first and take Enter; looser name matches follow the library's entries. Reads with their required inputs filled run on Enter; writes wait for Create, tasks for Run: one clear button, no second confirmation. Arrow keys move the highlight, Escape closes an open form, then clears, then leaves. Enter that ends an IME composition never submits. Relative words in the text are read deterministically (今天/明天/后天, today/tomorrow, 本周/下周/本月, `15:00`, `3点`, `下午3点`, `3pm`, `YYYY-MM-DD`); nothing calls a model.

The Shortcuts window (a built-in tile, `builtin:shortcuts`) lists the catalogue with a search, opens any action's form, and lists recent runs with their status and result. A run executes on the server: closing the box or the window does not stop it, and the window (or the "N running" hint in the empty, focused box) shows it again.

## Model

- **Action**: id (`space/<name>` for a built-in, `<app>/<capability>` for an app's), optional `peer`, title and description with translations, keywords, `effect` (`read`, `write`, or `run` for the task runner), `result` kind, typed `inputs`, `available` and the `reason` when not.
- **Run**: the request id of one submission, the action, the arguments as typed and as resolved, the time zone, status (`running`, `ok`, `error`, `unknown`), the result or error, attempts, the bus call id, and for a task run the task and the start of its run. Runs live in `space.db` (`shortcut_runs`, newest 500 kept).
- **Templates**: six phase-1 slots: `calc`, `convert`, `run-task` (built in), `news`, `calendar`, `todo` (filled by app actions that name them with `template:`). A slot no provider fills is listed, unavailable, with the dependency it misses; a missing provider is a configuration state, never an empty result.

Saved shortcuts with default arguments, favorites and pinning are phase 2; phase 1 has the catalogue and the runs.

## App actions

A capability opts in with an `action:` block under `provides:` ([app-spec.md](app-spec.md#events-and-provides)); the rest of the capability is unchanged and other apps can still call it. Parsing is strict.

```yaml
provides:
  create:
    description: Add one task from an action form.
    http: { method: POST, path: /api/capabilities/create }
    timeout: 30s
    action:
      title: Create todo
      description: Add a task to the todo list.
      keywords: [todo, task]
      template: todo            # news | calendar | todo; the result kind must match (list, list, receipt)
      effect: write             # read (default) | write
      idempotent: true          # write only: a repeated idempotencyKey answers the first result
      result: receipt           # list | receipt | value
      inputs:
        - { name: title, type: text, label: Title, required: true, query: true }
        - { name: dueDate, type: date, label: Date }
        - { name: dueTime, type: time, label: Time }
        - { name: source, type: choice, label: Calendar, default: all, options: [{ value: all, label: All }, financial] }
      i18n:
        zh: { title: 新建待办, keywords: [待办], inputs: { title: 标题 }, options: { all: 全部 } }
```

Input types: `text`, `number` (`min`, `max`), `date` (`YYYY-MM-DD`, or `today`, `tomorrow`, `yesterday`), `time` (`HH:MM`, needs a date input with a value), `period` (`today`, `tomorrow`, `this-week`, `next-week`, `this-month`, `last-7-days`, or `YYYY-MM-DD..YYYY-MM-DD`), `choice` (`options`). `query: true` marks the one text input the command box fills with the text after the keyword. Input names cannot be `timezone`, `now` or `idempotencyKey`. When `callers` is set it must include `space`.

What the provider receives (a POST through the bus as caller `space`): the validated arguments with dates resolved (a `period` becomes `{ from, to }`, inclusive dates), plus `timezone` (the operator's IANA zone), `now` (the run's instant) and, for a write, `idempotencyKey`. What it answers, `{ ok: true, ... }`:

| `result` | Body | Card |
| --- | --- | --- |
| `list` | `items: [{ title, url?, source?, at? (instant with Z/offset), date?, time?, timezone?, tag?, detail? }]`, `asOf?`, `total?` | Rows with time, link, source; a wall clock from another zone is labelled with it. |
| `receipt` | `items: [{ id, title, url?, detail? }]` (at least one) | "Created" with links to the new items. |
| `value` | `value`, `text?`, `unit?`, `detail?`, `source?`, `asOf?`, `stale?` | One big value with Copy. |

Space keeps at most 100 items, drops links that are not http(s) and instants without a zone, and treats `ok: false`, a non-2xx status or a missing shape as a failed run with the provider's words.

Providers on this space today:

| Slot | Capability | Notes |
| --- | --- | --- |
| news | `finance-news-feed/news` | Stored news of the period in the operator's day, AI importance ≥ 2 unless "all", optional market and topic. Read-only, never fetches. |
| calendar | `ai-calendar/events` | `source`: financial (macro, central banks, earnings, exchange closures) or personal (metrics, custom entries). Times are the calendar's wall clock (`CAL_TZ`, Beijing) and say so. |
| todo | `ai-todo/create` | Idempotent; a time in another zone is moved to the list's `TODO_TZ` wall clock; the receipt shows the stored due and links the todo. |
| rates (for `convert`) | `fx-desk/rates` | Every currency open.er-api.com quotes, USD-based, with the quote time and `stale` when the upstream failed. |

## Sentence patterns

Pattern matching is a small tagged finite-state machine inspired by
`interpreter/pattern_machine`: literal transitions, optional/alternative branches,
and named slots. It runs locally without a model. It does not port the Python
implementation, its data files, NER, or DFA minimization.

App authors can declare `action.patterns` next to `keywords`:

```yaml
patterns:
  - "[帮我][查|查询|看看|看一下][{period}[的]](金融新闻|财经新闻|新闻)[ {q}]"
  - "[please ](news|financial news)[ about {q}]"
```

- Literal text matches case-insensitively. Whitespace is collapsed to a single
  space and outer whitespace is trimmed; spaces inside patterns still matter.
- `(a|b)` selects an alternative. `[text]` is optional; `[a|b]` is an optional
  alternative. Groups may nest up to four levels.
- `{inputName}` captures a nonempty value into a declared action input. Number,
  date, time, period, and choice/task inputs must recognize the entire captured
  value. Choice labels in all declared languages are accepted when unambiguous.
  Dates remain relative until execution in the browser's zone. A query text slot
  also uses the existing date extraction; explicit typed slots take precedence.
- Escape a special character with a backslash. Regex, scripts, unnamed wildcards,
  empty alternatives, repeated slot names, and slot-only catch-all patterns are
  unsupported. Every accepting path must include non-whitespace literal text.

Examples: `金融新闻`, `帮我看看今天的金融新闻`, `查本周财经新闻 美联储`,
`金融新闻 本周 美联储`, and `please financial news about Fed`.

Custom patterns are managed in the backend only; there is no pattern editor in
any client. `POST /api/shortcuts/patterns` replaces one action's custom list:

```json
{
  "action": "finance-news-feed/news",
  "patterns": ["[帮我]看看金融新闻[ {q}]", "查{period}的财经新闻[ {q}]"]
}
```

Include `peer` to target that peer's action. Omit it for a local action. The
server validates the syntax and slot names against the current catalogue before
saving in `shortcut_patterns` in `space.db`; invalid updates leave the previous
list intact. An empty list removes custom patterns. Unknown targets return 404,
invalid syntax or inputs return 400. Like other panel routes, browser writes are
subject to the same-origin guard. The response and `GET /api/shortcuts/actions`
include `patterns` (provider defaults) and `customPatterns` (local additions).
Custom patterns survive restart and are scoped to the action and peer; removing
an app does not retarget its patterns to another provider. After an API update,
the command box resolves the next query against current definitions. No action
runs when patterns are saved.

Arithmetic and currency syntax keep priority. A complete sentence pattern comes
next, followed by the existing keyword/name rules if no pattern matches.
Equivalent action/argument matches collapse into one candidate. Distinct matches,
including different peers or different captures, remain visible with parameters;
none is selected automatically. Use the arrow keys or click to choose one. Reads
run on selection/Enter as before; writes and tasks still require submission in
the editable form, and all arguments remain subject to server validation.

Limits: 16 provider and 16 custom patterns per action, 256 characters and 512
states per pattern, four named slots, 512 input characters, 4,096 active/queued
configurations, 50,000 matching operations per pattern and 100,000 across the
catalogue. At most eight distinct capture sets per pattern are retained. Hitting
any matching bound discards the pattern pass, leaving keyword/name matching
available; partial results never decide an action. Compiled patterns are cached
in a bounded cache. This is a deliberately small syntax, not a general natural
language interpreter.

## Skill-equipped agent intents

Sentence recognition can route the original request to an agent rather than a
fixed app capability. These are separate from read/write API actions. The command
box lists matching agent intents below the input; selecting a row opens that
agent's existing chat and submits the original sentence once. Typing does not
start a model call. Results stream in the agent conversation, with the existing
history, background execution, reconnect and stop controls. Multiple matching
intents require a choice. A matching unavailable agent stays unavailable; the
command box does not silently replace it with an API query or another agent.

Routes are configured only in the backend and stored in `shortcut_agent_intents`
in `space.db`. There is no configuration UI. Use
`GET /api/shortcuts/agent-intents` to read definitions and availability;
`POST /api/shortcuts/agent-intents` creates or replaces a definition by id:

```json
{
  "id": "financial-news",
  "title": "金融新闻",
  "agent": "whymove/curator",
  "skills": ["curate-news"],
  "patterns": ["[帮我][查|查询|看看|看一下][{period}](金融新闻|财经新闻|新闻)[ {topic}]"],
  "enabled": true
}
```

This recognizes `查今天金融新闻`, `金融新闻`, `帮我看看今天的金融新闻`, and
`查本周财经新闻 美联储`. `{period}` accepts known relative periods (including
Chinese labels and an optional trailing 的); other named slots capture text.
Captures classify the intent only: they do not replace, summarize or rewrite the
user's message. Multiple capture splits of the same intent produce one candidate.
The resolver applies precedence on the server: a matching agent makes `intents`
an empty array, even when that agent is unavailable. Clients render the returned
candidates and use the server's `ambiguous` flag; they do not select between competing
agent and API results. Agent matches take precedence over API action patterns and keywords; direct
arithmetic and currency conversion retain their existing precedence.

The initial scope is a local app agent, named `app/agent`, with 1–4 app-owned
skills under `skills/<name>/SKILL.md`; peer routing and shared-skill aliases are
not supported here. Each definition has 1–16 patterns; at most 128 definitions
are stored per Space. Set `enabled: false` to disable one, including when its app
has been removed. Invalid updates preserve the previous configuration. Change
the query to resolve it against the updated definitions.

The client submits `{ message, intentId, timezone }` to the selected agent's
existing chat route. The server resolves the stored intent, checks its target,
and loads the canonical skill file contents into the turn's system context.
It rejects missing skills, paths outside the app (including symlinks), a skill
larger than 64 KiB, or total skill content over 128 KiB. Skills do not grant extra
permissions. A request to query news is not permission to create or publish an
article, even if the skill also describes those workflows. The browser's IANA
zone and request instant accompany relative dates. The selected intent and zone
are retained with the chat session, including runtime session-id rotation, so
follow-up turns reload the same skills. A disabled/missing or retargeted intent
fails explicitly on resume.

In the financial-news configuration, `whymove/curator` loads `curate-news` and
handles the whole request. `finance-news-feed/news` remains a standalone read API
action for callers that explicitly choose it; it is not the handler for a matching
financial-news agent intent.

## Built-ins

- **Calculator** (`space/calc`, `src/space/shortcuts/calc.ts`, shared with the page): numbers (decimals, `1,234.5` grouping, full-width digits), `+ - * / × ÷`, `^` or `**` (right-associative; `-2^2` is −4), postfix `%` (÷100), parentheses. A recursive-descent parser, never `eval`. Results are rounded to 12 significant digits and shown with up to 10 decimals; division by zero and non-finite results are errors. The box treats text as arithmetic only when it parses and holds an operator.
- **Convert** (`space/convert`): amount, from, to (ISO codes; the box also reads 美元, 人民币, 港币, 欧元, 日元, 韩元, 英镑, $, ¥, €, £, ₩ …). Rates come from the rates capability (default `fx-desk/rates`, here or on one peer) and are reused for ten minutes; the cross rate is `to/from` against the base. The value is rounded to the target currency's minor units (2 for CNY, 0 for JPY and KRW). The card shows the rate, source, quote time and a stale mark. The box's live preview is cached a minute per input.
- **Run task** (`space/run-task`): starts a scheduler task now (`Scheduler.runNow`, so a task already running is refused, not started twice) and reads its status from the scheduler's run record: running until the run that started then is recorded, then its status, error and output.

## Runs and execution rules

- **Validation** happens on the server for every entry point: unknown inputs, missing required ones, bad numbers, dates (checked component by component), times, choices and zones are 400s before anything runs. A run of any app action, and of any action with date, time or period inputs, needs `timezone`; the server never uses its own zone ([time.md](time.md)). A wall clock that a clock change skips is refused.
- **Duplicates**: each submission carries a `requestId`; a second POST with it answers the first run (`duplicate: true`) and runs nothing. A finished write's form hides Create until "New" is pressed.
- **Uncertain writes**: a write whose call timed out or whose answer was cut off after it went out is `unknown`, not `error` ("may have been created"). Retry is offered only when the provider is `idempotent`, and resends the same `idempotencyKey`, so the provider answers its first result if the write happened; otherwise the card says to check the app. A refused connection is a certain failure.
- **Background**: the POST answers when the run ends or after 8 seconds (status `running`); the page polls the run. Shutdown waits for runs in flight.
- **Peers**: an action on a peer carries `peer` in the catalogue and in the run, and is called on that peer only (`/api/peer/call/...`); a failure is reported, never retried on another machine.

## API

The panel's routes, like `/api/voice`: no token, browser writes held to the panel's origin (`guardBrowserWrites`); runs call as `space`.

| Route | |
| --- | --- |
| `POST /api/shortcuts/resolve` | `{ text, timezone }` → `{ intents, agentIntents, ambiguous }`; deterministic resolution only, never executes. Text is bounded to 4000 characters; timezone is a required valid IANA name. |
| `GET /api/shortcuts/actions` | The catalogue: built-ins, app actions here and on peers, unfilled slots, each with `available` / `reason`. |
| `POST /api/shortcuts/patterns` | `{ action, peer?, patterns }` → updated catalogue; backend-managed custom sentence patterns. |
| `POST /api/shortcuts/runs` | `{ action, peer?, args, timezone, requestId }` → `{ run, duplicate }` (201, or 200 for a repeat). |
| `GET /api/shortcuts/runs?limit` | Recent runs, newest first. |
| `GET /api/shortcuts/runs/:id` | One run; a task run's status is read from the scheduler. |
| `POST /api/shortcuts/runs/:id/retry` | A failed run again; an `unknown` write only for an idempotent provider. |
| `POST /api/shortcuts/preview` | `{ action, args, timezone }` → `{ result }` for a read, not recorded (the box's live conversion). |

## Delivery phases

### Phase 1 Core execution in universal search and Shortcuts (implemented)

The catalogue and executor, the six templates with their providers, the command box's action rows, argument forms and result cards, the Shortcuts window with recent runs, reconnectable runs. AI summaries (an action that calls the model after submission) are not in phase 1: model-assisted actions start with phase 2's parameter filling. The iPhone Panel 1 search shows native action rows, forms and result cards. An empty search shows no history shortcut. macOS does not show action rows yet.

### Phase 2 Personalization and native access

Add saved defaults, editing, favorites, ordering, save-from-search, screen pinning,
and recent-action ranking. Extend the iPhone's shared search and action experience
to macOS. Add model-assisted parameter filling for complex natural language,
with editable previews and explicit handling of ambiguity. Avoid conflicts with
the Mac client's existing Quick Chat shortcut when selecting a keyboard entry.

Acceptance:

- A configured search action can be saved, found by name, edited, and pinned.
- Web, macOS, and iPhone use the same action definitions and execution records.
- Native clients display the supported structured result types.
- Natural-language parsing cannot silently choose an ambiguous write target or time.

### Phase 3 Composition and automation

Add ordered multi-step shortcuts, typed output-to-input mapping, and explicit
step failure/retry policies. Example: query news, summarize it, and save the summary.
Integrate recurring execution through the existing scheduler and optional completion
notifications through the inbox. Persist timezone and arguments for headless runs.

Acceptance:

- Users can inspect each step's inputs, outputs, and execution status.
- Partial success remains visible and retries do not repeat completed writes blindly.
- Scheduled shortcuts use the existing scheduler with explicit timezone semantics.
- User-enabled notifications link to the resulting run or artifact.

General workflow graphs, arbitrary scripts, and a new scheduling engine are outside
the initial scope. Establish the single-action experience before composition.

General workflow graphs, arbitrary scripts, and a new scheduling engine are outside the initial scope.

## Native search and shared resolution

The web command box and iPhone call `POST /api/shortcuts/resolve` after a short typing pause. `src/space/shortcuts/resolve.ts` owns keyword, currency, sentence-pattern and calendar-input parsing; `ranking.ts` owns name scoring. The route is assembled with the agent routes so skill availability uses the same app-owned skill validation as chat. Resolution does not call a model, preview a provider, create a run, or send a message. Agent candidates take precedence over ordinary actions; arithmetic and currency conversions take precedence over agents. Multiple interpretations require an explicit selection.

The response contains the existing intent union (`calc` with `expression`; `convert` or `action` with an action descriptor and `args`), available or unavailable `agentIntents`, and `ambiguous`. Input labels and translations remain in the action descriptor. Clients keep catalogue search local, ignore superseded responses, and use the existing preview/run/chat endpoints only after resolution. A request must supply the device/browser IANA timezone; calendar dates and local times remain strings, and execution validates and resolves them in that zone.

The iPhone places universal search at the top of its first Panel; Home retains ordinary catalogue filtering. The two inputs are independent. The iPhone uses the shared Mac `OmniboxRules` for catalogue ranking. Native forms support text, number, date, time, period, choice and task inputs. Selecting a complete read action runs it; writes and task runs require Create/Run. An uncertain transport failure preserves the exact submission body and request ID. Accepted runs continue on the Space after the sheet or app closes. List, receipt, value and task results render natively. Skill-agent selection opens a fresh native chat with the original sentence, `intentId` and timezone; an already-running chat is left intact.

The microphone records at most 90 seconds and uses `POST /api/voice/transcribe`. Leaving the search cancels capture; a late transcript cannot fill a different Space's input. Transcription fills the field without submitting. Catalogue matching still works if the resolver cannot be reached; command errors are shown and an explicit Ask Space Assistant remains available.
