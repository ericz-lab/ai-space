# Chat cards

When a person talks with an app's agent, what the agent's tools did this turn shows as cards under the reply: the planner of ai-todo adds three tasks, and the three tasks appear under its answer with an Undo. Any app can produce them with the same contract; ai-todo is the first. This page is the contract and how ai-space implements it. Version 2 adds [built-in styles](#styles) a card picks by name and [structured item fields](#item-fields); it keeps `v: 1`, and a card without the new fields is drawn exactly as in version 1.

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
| `style` | How the card is drawn, one of the [built-in styles](#styles); optional, `rows` when absent |
| `title` | The card's heading, optional, one line of at most 200 characters |
| `items[].id` | The record's id in the app, a string (a number is taken as its string); unique within the card |
| `items[].title` / `detail` | One line each (at most 300 characters); `title` is required |
| `items[].url` | Where a click goes: a path resolved against the app's public URL, or an http(s) URL; anything else drops the card |
| `items[].version` | The record's version when it was written; actions send it back |
| `items[].when`, `date`, `tags`, `image`, `icon`, `value`, `progress` | Structured fields, all optional: [Item fields](#item-fields) |
| `state` | The capability that answers the items' current state (below); without it the card shows what was printed |
| `actions` | Action name → capability. v1 knows `undo`; other names are left out (a later `edit`). Only a `receipt` may have actions |

Capability names are bare (`card-state`), never `<app>/<name>`: ai-space calls them on the app of the agent that ran the tool.

## Styles

The styles are built into ai-space and every client; an app picks one by name in the card's `style` and declares only what its items are (a time, tags, a picture, a value). It provides no styling, HTML or markup.

| `style` | Look | Needs on every item | For |
| --- | --- | --- | --- |
| `rows` (default) | Version 1: a state circle, the title, one secondary line | nothing | todos, bookmarks, anything |
| `compact` | One line per item: the title and a short value on the right | nothing | query results with many items |
| `gallery` | A grid of thumbnails, the title under each | `image` | generated images, pages |
| `agenda` | A date block on the left, the title and time on the right | `date` | calendar events, dated todos |
| `stat` | Big numbers side by side with a caption | `value` | figures |

- A `style` that is not a string drops the card. A string that is not in the table is left off the card (drawn as `rows`) and the card is kept, so an older client still shows a card that uses a later style.
- When any item lacks the field its style needs, the client draws the whole card as `rows`; ai-space does not change `style`. The client judges on the items as printed, not on a state answer, so the layout does not change when the state arrives.
- `kind` keeps its meaning and still decides whether a card may have `actions`. `compact` and `stat` have no per-item undo, only the header's. `stat` is for `list` and `value` cards; a `receipt` with `style: "stat"` is drawn as `rows`. A `value` card draws its `text` under the header and then its items in its style.

## Item fields

| Field | Type | Rule | Drawn |
| --- | --- | --- | --- |
| `when` | string, one line, at most 40 characters | The app's own time words, such as `后天 周四 08:00` | First segment of the secondary line, after a calendar glyph |
| `date` | `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM` | A date (and time) in the app's zone, without a zone; a real calendar date ([time conventions](time.md)) | `agenda`'s date block (day and weekday) and time; no other style shows it |
| `tags` | array of at most 4 `{ text, tone? }` | `text` one line of at most 24 characters; `tone` one of `neutral` (default), `accent`, `positive`, `warning`, `negative` | Small round tags after the secondary text |
| `image` | link | The same rule as `url` (a path in the app or http(s), at most 2000 characters), resolved against the app's public URL the same way; left out when it does not resolve to http(s) | `gallery`'s thumbnail; in `rows` a 36 px square left of the title |
| `icon` | name | One of `check`, `note`, `link`, `calendar`, `image`, `file`, `person`, `chart`, `clock`, `flag`, `bell`, `folder` | In `rows` and `agenda`, in place of the hollow circle while the item is `active`; `done` and `removed` still show the state circle |
| `value` | string, one line, at most 24 characters | A short value, such as `12`, `¥3,200`, `85%` | `stat`'s big number; `compact`'s right-hand value |
| `progress` | number from 0 to 1 | | A 3 px bar under the secondary line in `rows` |

- **Drop or degrade.** A field of the wrong type or too long (`tags` not an array, `when` not a string, a fifth tag, `progress` of 1.2, `date` of `2026-02-30`) drops the whole card, as any broken rule does. Only a name that is not known degrades: an unknown `style` is left off the card, an unknown tag `tone` is left off the tag (it reads as `neutral`), an unknown `icon` is left off the item. A name of the wrong type (`icon: 3`) still drops the card.
- Lengths count UTF-16 code units, as `title` and `detail` do; `when`, `value` and tag texts have their white space collapsed like `title`.
- `detail` stays and is still split on ` · ` into muted segments. The secondary line is always: `when`, the `detail` segments, the `tags`, `#id`.
- The state and undo answers (`card-state`, `card-undo`) may carry the same fields; a field given there replaces the card's for display. ai-space checks them by the same rules and leaves out an item that breaks one (the version 1 fields keep their version 1 handling: one that does not pass is left off the item). The exported names are `CARD_STYLES`, `CARD_TONES` and `CARD_ICONS` in `src/space/agents/cards.ts`.

### How each style looks

The frame, the header (app icon, app name, title, Undo) and the note line are those of version 1; this is the item area, the same on every client. Sizes and colours come from the client's own type levels (body, secondary, caption) and theme, never fixed colours; light and dark both hold.

- **rows**: version 1, plus: a 12 px calendar glyph before `when`; tags 18 px high, 7 px side padding, fully round, 12 px text; `image` as a 36×36 square, radius 8, cropped to fill, in the circle's place (with an `image` neither the circle nor the `icon` shows; `done` and `removed` show as the pill on the right); `progress` as a 3 px round bar across the text column, the separator colour under the accent colour.
- **compact**: 36 px lines with hairlines between. A 6 px dot on the left for the state (active the secondary text colour, done the success colour, removed hollow); the title at 14 px on one line, cut with an ellipsis; on the right 12 px muted tabular figures: `value`, else `when`, else the first `detail` segment. A removed title is struck through. A line with a `url` opens it. No per-item undo.
- **gallery**: a grid of 3 columns, 2 when the card's content is narrower than 360 px, 8 px gaps, 12 px padding. Each tile: the picture at 4:3, radius 10, cropped to fill; the title under it at 13 px on one line; then a 12 px muted line with `when`, else the first `detail` segment. Until the picture loads, and when it fails, the tile shows the separator colour with the `image` glyph centred. The whole tile opens its `url`. While an item can be undone, a 28 px round undo button sits at the picture's top right on a translucent ground; a removed tile's picture drops to 40% opacity under an Undone label.
- **agenda**: a 44 px date block on the left: the day (18 px bold) over the weekday (11 px muted, in the interface language: `周四` / `Thu`); when several items in a row fall on the same day only the first shows the block, the others leave it empty. When the date's month or year is not today's, an 11 px month line (`12月` / `Dec`) follows the weekday. On the right the title at 14 px, then the secondary line: the time (`HH:MM` when `date` has one, tabular figures), the `detail` segments, the `tags`, `#id`; no `when` (the date block says it). The row ends as in `rows`: an undo glyph while it can be undone, an arrow when read-only with a `url`. Items keep the card's order.
- **stat**: one row of cells, each at least 96 px wide, sharing the width and wrapping when they do not fit, hairlines between them, 12 px padding. Each cell: `value` as a large bold tabular number, under it the `title` at 12 px muted on one line, and the first tag (if any) to its right. No state circle and no undo. A cell with a `url` opens it.

## What the app provides

In `space.yaml` `provides:`, with `callers: [space]`; ai-space calls them through the bus as `space`.

### State (`card-state` in ai-todo)

- Body `{ ids: [...] }`.
- Answer `{ ok, items: [{ id, title, detail, url, version, status }] }`, `status` one of `active`, `done`, `removed` (undone or deleted; the other fields may be left out). An item may also carry the [item fields](#item-fields).
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

The web panel draws cards under the reply (`src/web/ChatCards.tsx`) and shows Undo only on the latest reply with a token. A card is a narrow solid frame (at most 460 px wide). Its header shows the app's icon and name, which the panel takes from the agent's `appIcon` and its own app list for the agent's machine (nothing is added to the card format; without them only the `title` shows), then the `title`, then one Undo button: "Undo" for a single item, "Undo all" while every item of several can be undone, "Undo the other N" once some were undone or changed. Each item is two lines: its `title` (a link to `url`), then its `detail` split on ` · ` into muted segments and its `#id`; a circle on the left says active, done (a check) or removed (dashed), and a pill says Undone, Done or Changed elsewhere. With several items each one that can still be undone has its own undo button. A read-only card has no undo controls, and a row with a `url` opens it as a whole. A `list` card draws the same rows; a `value` card draws its `text` under the header. `edit` (`card-edit`: `{ id, version, patch }`, 409 with the current content on a stale version) follows in a later version.

The panel draws the five [styles](#styles) as described there (`drawnStyle` picks the style, falling back to `rows`), with these choices of its own:

- Sizes follow the panel's type scale (`ui-policy.json`): `stat`'s value is 22 px, the scale's step nearest the large number; everything else uses the sizes given above.
- Colours are the panel's theme tokens (`--text`, `--muted`, `--hairline`, `--solid`, `--accent`, `--success`, `--warning`, `--danger`), so the light and dark presets and an operator's own theme apply. Tag tones mix their status colour toward the text, as the version 1 pills do, so the words keep their contrast on the pale tint.
- Glyphs are inline 24-unit stroke SVGs, like the undo arrow. Weekday and month words come from `Intl.DateTimeFormat` in the panel's language (`zh-CN` or `en`); "today" for the month line is the browser's local date.
- Pictures load with a plain `<img>` over the placeholder; one that fails is removed, leaving the placeholder.
- A per-item undo (the row button, the tile button) shows, as in version 1, only on a card of several items; a single item is undone from the header.
- A removed item keeps its title, `image` and `value`; its `detail`, `url`, `when`, `tags` and `progress` are not shown, as version 1 hides its `detail` and link.
