# Chat cards

When a person talks with an app's agent, what the agent's tools did this turn shows as cards under the reply: the planner of ai-todo adds three tasks, and the three tasks appear under its answer with an Undo. Any app can produce them with the same contract; ai-todo is the first. This page is the contract (version 1) and how ai-space implements it.

## Principles

- **Cards come from the tool's real output, not from the model's text.** An app's CLI or API prints a card after a write succeeded, with the data it just stored. The model writes no card JSON and its prompt says nothing about cards.
- **Act, then offer undo.** The agent writes at once; the card offers to take it back. Draft cards for actions that cannot be undone (sending, publishing) are left for later.
- **ai-space only recognizes, checks, draws and forwards.** The data lives in the app; ai-space stores no card content.
- **A card reaches its own app only.** ai-todo's cards call `ai-todo/*` capabilities, nothing else.

## Producing a card

The tool prints one line on standard output:

```
::space-card {"v":1,"kind":"receipt", ...}
```

- One card per line, the JSON on one line, `::space-card ` at the start of the line.
- A line is at most 16 KB, a card has at most 20 items, a reply carries at most 4 cards.
- A card that breaks a rule is dropped whole, not repaired (as widget blocks are).
- ai-space takes the lines out of tool results in two places: the live run events, and a restored transcript. The cards go on the reply as `cards` and the lines leave the tool output (every copy of it in the event). Clients draw `cards`; none parses tool output itself.

## Format

```json
{
  "v": 1,
  "kind": "receipt",
  "title": "已添加 3 条待办",
  "items": [
    { "id": "128", "title": "写周报", "detail": "明天 15:00 · 高", "url": "/?todo=128", "version": 1 }
  ],
  "state": "card-state",
  "actions": { "undo": "card-undo" }
}
```

| Field | Meaning |
| --- | --- |
| `v` | Contract version, 1 |
| `kind` | `receipt` (what was done), `list` (what was found), `value` (one value, in `text`); the same kinds as the Shortcuts results, drawn the same way. `draft` is reserved |
| `title` | The card's heading, optional, one line of at most 200 characters |
| `items[].id` | The record's id in the app, a string (a number is taken as its string); unique within the card |
| `items[].title` / `detail` | One line each (at most 300 characters); `title` is required |
| `items[].url` | Where a click goes: a path resolved against the app's public URL, or an http(s) URL; anything else drops the card |
| `items[].version` | The record's version when it was written; actions send it back |
| `state` | The capability that answers the items' current state (below); without it the card shows what was printed |
| `actions` | Action name → capability. v1 knows `undo`; other names are left out (a later `edit`). Only a `receipt` may have actions |

Capability names are bare (`card-state`), never `<app>/<name>`: ai-space calls them on the app of the agent that ran the tool.

## What the app provides

In `space.yaml` `provides:`, with `callers: [space]`; ai-space calls them through the bus as `space`.

### State (`card-state` in ai-todo)

- Body `{ ids: [...] }`.
- Answer `{ ok, items: [{ id, title, detail, url, version, status }] }`, `status` one of `active`, `done`, `removed` (undone or deleted; the other fields may be left out).
- Called every time the card is shown, so a card always says the current state.

### Undo (`card-undo` in ai-todo)

- Body `{ items: [{ id, version }] }`.
- An item whose version matches is deleted; one that does not is left alone.
- Answer `{ ok, items: [{ id, status, version?, title?, detail?, changed? }] }`: `status: "removed"` for what was deleted, the current content and `changed: true` for what was changed since.
- Idempotent: an id that no longer exists answers `removed`.

## When a card can act

Only while the reply that made it is the conversation's latest and the data was not changed elsewhere; otherwise it is read-only, still showing the current state and opening the app on a click.

| Case | Result | Enforced by |
| --- | --- | --- |
| The person sent another message (or the agent started a turn by itself) | Earlier cards read-only | ai-space: the token ends when the conversation's next turn starts |
| The conversation is reopened from its record (a session picked from the history, a reload once the run is read back from its stored row, a restart) | Read-only | ai-space: the token comes with the run's events while the run is in memory (it is followed, or reattached to within minutes of its end); the stored row and a transcript carry none |
| The record was changed elsewhere | That item read-only, shown as it is now | The app: the version does not match |

- **Token**: a live cards event with actions carries a `token`. It lives in ai-space's memory (at most 12 hours) and stands for that event's cards, their agent, run and conversation. The client keeps it in memory only.
- **ai-space builds the request**: the client sends the token, the card's index in the event and the chosen item ids; the `id` and `version` sent to the app are the ones ai-space extracted. A forged card cannot reach another app or send an arbitrary body.

## Telling the agent

When the person sends the next message, ai-space puts one line before it if a card of the last turn removed something: `[ai-space card changes] Since your last reply the person undid these from the result cards: 写周报 (#128).` Nothing changed, nothing is added. The run records the person's message without it and a restored transcript drops it again.

## API

- Run events: `{"type":"cards","cards":[...],"token":"..."}` right after the tool result that held the lines (`token` only when a card has actions). The run's stored row keeps the event without the token.
- Restored sessions (`GET /api/agents/:app/:agent/sessions/:sid`): an `ai` message has `cards`, no token.
- `POST /api/agents/cards/state` `{ agent, card }` → `{ ok, items }` from the card's `state` capability on the agent's app (`card` is checked again; the owner's route).
- `POST /api/agents/cards/action` `{ token, card, action, items? }` → `{ ok, items }` from the action's capability; 409 `{ readOnly: true }` once the token is gone. `items` omitted means every item of the card.
- A peer's agent: `POST /api/peers/:peer/agents/cards/state|action`, forwarded to the peer's `/api/peer/agents/cards/*` like the chat itself.

## Runtimes

The lines must reach ai-space whole:

- **Claude Code** (live and headless): the tool result arrives as the CLI printed it.
- **Codex** (live and headless) and **DeepSeek Harness live** (ACP; every client's chat is live): the output is cut at 12 000 characters before it is sent, keeping card lines whole after the cut (`clipOutput` in `src/space/runtimes/tool-text.ts`). Restored transcripts cut the same way.
- **DeepSeek Harness headless** (`interactive: false`, API callers only) sends no successful tool results, and its transcripts record none: no cards there.
- An agent that pipes the CLI's output (`| head`, `| grep`) can lose the line; an app whose agent does that tells it not to in its skill or prompt.

## Clients

The web panel draws cards under the reply (`src/web/ChatCards.tsx`) and shows Undo only on the latest reply with a token. The Mac and iPhone clients follow in a later version, as does `edit` (`card-edit`: `{ id, version, patch }`, 409 with the current content on a stale version).
