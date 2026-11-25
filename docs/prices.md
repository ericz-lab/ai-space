# Prices

Every price ai-space uses comes from one module, `src/space/prices/`, and one set of sources. The ledger's estimate for Codex CLI calls, the built-in model gateway, speech, the `anthropic-api` and `deepseek-harness` runtimes, `space codex-upgrade`, Settings → Gateway and `GET /api/model/pricing` all ask it the same question: what does `<vendor or provider>/<model>` cost. The answer is a price and where it came from, or no price. A call with no price is unpriced, never free.

## Where to change a price

| You want | Edit | Takes effect |
| --- | --- | --- |
| A price on this machine, now, without a deploy (a relay's discount, a plan, a model nobody lists yet) | `<workspace>/gateway-prices.yaml` (the owner's file) | within a minute: the file is looked at every minute and before each gateway call. Earlier gateway calls are costed again, and the ledger's estimate follows. |
| A list price for every Space of every user | `src/space/prices/tables/<vendor>.json` in the ai-space repository, with its `asOf` moved to today | once merged to main: the [catalogue](#the-catalogue) is published, and every Space fetches it within a day, old releases included, with no release and no deploy. |
| Nothing | — | models.dev's catalogue, fetched daily, fills in every model the two above do not name. |

The owner's file always wins. Nothing fetched can override it.

## The order

A **vendor's list price**, for a runtime call (Codex CLI on the ledger, `anthropic-api`, `deepseek-harness`, speech sent straight to a vendor's own API), key `<vendor>/<model>`: `openai/…`, `anthropic/…`, `deepseek/…`, `minimax/…`:

1. the owner's file, `<vendor>/<model>`;
2. the catalogue's entry for that vendor and model;
3. models.dev's provider of the same name.

A **gateway provider's price**, for a call through the built-in gateway ([model-gateway.md](model-gateway.md#prices)), key `<provider>/<model>`:

1. the owner's file, `<provider>/<model>`, then `<provider>/*` (every model of a relay or a plan);
2. the catalogue: [Model Watch](#model-watch)'s row for the page of this provider's site (CNY at the owner's rate), then, when the provider is a vendor's own host (the `hosts` of its data file: `api.openai.com`, `api.anthropic.com`, `api.deepseek.com`, `api.minimax.io`), that vendor's list price;
3. models.dev, for the models.dev provider that matches the provider's preset and site, or its host.

The sources and the types are the same. Only the key differs, because a gateway provider's price can differ from the vendor's for the same model: a relay's discount, the China site, CNY. A snapshot id (`gpt-6-luna-2026-09-01`) takes its base model's price when it has none of its own. A gateway provider named like a vendor (`openai`) shares the owner's `openai/<model>` lines with the list price, which is the meaning they have.

Both questions are also answered for apps by `GET /api/model/pricing` ([model.md](model.md#shared-gpt-price-catalogue)).

## A price

A price is USD per million tokens (`input`, `output`, `cacheRead`, `cacheWrite`), long-context `tiers` (the whole call at a tier's prices once its prompt, input plus cache reads and writes, is over `over` tokens), and for what is not priced by the token `perImage`, `perMinute` (of audio transcribed) and `perMillionChars` (spoken). A unit price takes over from the tokens of an answer that has that unit. A missing cache price is the input price. `cacheWrite: null` means the model has no cache-write price, so a call that wrote to the cache is unpriced. `fastMultiplier` is OpenAI's Fast (priority) tier. It only ever comes from ai-space's own data files, never from the owner's file or models.dev.

## The owner's file

`<workspace>/gateway-prices.yaml`, one `key: price` per line:

```yaml
openai/gpt-6-sol: [2, 10, 0.1, 2.5]              # input, output[, cache read, cache write], USD per million tokens
anthropic/claude-opus-5-5: [4, 20, 0.2, 5]       # the list price anthropic-api pays, until the catalogue has it
relay/*: [0.5, 2]                                # every model of gateway provider "relay"
ark/doubao-seedream-5: { perImage: 0.03 }        # a mapping for what is not priced by the token
openai/whisper-1: { perMinute: 0.006 }
```

A mapping takes `input`, `output` (together), `cacheRead`, `cacheWrite`, `perImage`, `perMinute` and `perMillionChars`. A file that does not parse keeps the prices read before, and Settings → Gateway shows why. The file is its own, not a key of `gateway.yaml`, whose parser refuses unknown keys, so an older ai-space keeps its gateway after a rollback. A speech provider's `price:` in providers.yaml ([speech.md](speech.md#prices)) still wins for that provider. It predates this file, and the file is the place for new prices.

## The catalogue

ai-space's price catalogue is one JSON document: `{ schema: 1, asOf, vendors: { <vendor>: { name, asOf, source, hosts, note, models } }, modelWatch }`. It is built from the checked-in data files:

- `src/space/prices/tables/openai.json`: GPT standard rates with their long-context tiers and Fast multipliers, OpenAI's speech prices;
- `src/space/prices/tables/anthropic.json`: the Claude models the `anthropic-api` runtime names;
- `src/space/prices/tables/deepseek.json`: DeepSeek at peak. Off-peak is half, but a call's billing window is not recorded, so the peak figure is used and overstates off-peak calls;
- `src/space/prices/tables/minimax.json`: MiniMax's speech prices on its international site;
- `src/space/prices/tables/model-watch.json`: [Model Watch](#model-watch)'s rows.

`asOf` is the newest date among them. Every Space fetches the published copy from `https://bucket.ai-space.me/prices/v1.json` once a day: at boot when its cached copy (`run/prices-catalogue.json`) is missing or a day old, then daily. The request is conditional (`If-None-Match`), so an unchanged catalogue costs a 304. Until a fetch succeeds, and while a machine is offline, the copy built from the release's own data files is used. Of the fetched copy and the release's own, the one with the newer `asOf` is in force (the fetched one on a tie). When the catalogue in force changes, earlier gateway calls are costed again and the ledger's estimate follows, as for models.dev.

**Privacy and trust.** The fetch sends nothing about the install: no token, no machine name, the user agent `ai-space`. A fetched catalogue can only supply prices. It is checked whole before use: the schema, at most 4 MB, every vendor and host well formed, every figure a number from 0 to 100,000 (a Fast multiplier from 1 to 10), no unknown keys in a price, not empty, and not zero for every token price. A catalogue that fails is refused and the last good copy kept. Anything in it but the fields above is dropped.

**Turning it off or pointing elsewhere.** `SPACE_PRICES_URL` in the workspace `.env` or the service environment replaces the URL (a mirror, a test server). An empty value (`SPACE_PRICES_URL=`) turns the fetch off, and the release's own copy is then used.

## Publishing

`.github/workflows/prices.yml` publishes the catalogue when a merge to main touches `src/space/prices/tables/` (or by hand, Actions → prices → Run workflow). It builds it (`bun run prices build`) with the same check a Space makes, writes what it changes against the published copy to the run's summary (`bun run prices check`), and uploads it to the `ai-space-store` bucket as `prices/v1.json`, with a dated copy `prices/v1/<asOf>.json`. The workflow is off until the repository variable `PRICES_PUBLISH` is `on`. It needs the secrets `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`: an R2 token that may write objects in that bucket and nothing else.

`v1` is the schema in the path. A later schema is published beside it (`v2.json`), and `v1.json` keeps being published for the releases that read it.

`bun run prices check [--against <url|file>] [--max-move 0.5] [--strict]` compares this checkout's catalogue with the published one. A change past the bound is any of these:

- a figure moved by more than half again or a third less;
- a figure removed;
- a new figure of zero;
- prices changed without `asOf` moving.

`--strict` exits 1 when a change is past the bound. It is the gate for a change no person has reviewed.

## Model Watch

Model Watch (the `model-watch` app, on the owner's Mac) reads the vendors' pricing pages every day. Its rows reach the catalogue through `src/space/prices/tables/model-watch.json`, written by `bun run sync-prices` (`scripts/sync-model-watch-prices.ts`, which reads Model Watch's database read-only and prints the rows added, removed and changed). How a row prices a gateway provider (which page prices which site, which row is which model, variants, units, CNY) is in [model-gateway.md](model-gateway.md#from-model-watch).

**Proposed daily path** (not built yet): a Task Shelf job on the Mac runs `bun run sync-prices` in a fresh worktree of origin/main every day. When the file changed, it runs `bun run prices check --strict --report <file>` and opens a pull request with the report as its body. A pull request within the bound may be merged without review once the owner allows it (auto-merge). One past the bound waits for a person. Merging publishes. The risk is that a misread vendor page reaches every Space within a day, and the bound is the guard. A move of more than 50%, a vanished price, a new zero or an undated change never goes out unreviewed.

## Not done

- A runtime call's stored cost (`anthropic-api`, `deepseek-harness`) is kept as it was costed. Only gateway calls (from `price_basis`) and the Codex ledger estimate (computed at read time) follow a later price change.
- A peer prices its own calls with its own book. The owner's file is per machine. A hub does not hand its file to its peers.
- Claude Code reports its own cost, which is kept.
