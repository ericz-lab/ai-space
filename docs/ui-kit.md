# The built-in apps' UI kit

The apps that ship with ai-space (AI Usage, Space Ops, Task Shelf, Todo) share one look, **Space Tiles**: a flat neutral canvas, off-white rounded tiles, pill buttons, thin charts and big thin figures. It is one stylesheet, `src/web/ui-kit/kit.css`, served by the space at `/_space/ui.css`. Other apps may use it; nothing requires them to.

The designs it was drawn from are in Design Studio (designs 79 to 84: the component sheet and the four app screens).

## Loading it

A page links two stylesheets before its own:

```html
<link rel="stylesheet" href="./kit.css">
<script>(function(){var l=document.createElement("link");l.rel="stylesheet";l.href="/_space/ui.css";var k=document.querySelector('link[href$="kit.css"]');k.parentNode.insertBefore(l,k.nextSibling)})()</script>
<link rel="stylesheet" href="./styles.css">
```

- `./kit.css` is the app's own copy of `src/web/ui-kit/kit.css` (`curl -s http://127.0.0.1:8700/_space/ui.css > web/kit.css`). It paints first, and it is all the page has when it is reached on its own port or on an older ai-space, where `/_space/ui.css` is a 404.
- `/_space/ui.css` is the space's current version, added at runtime because a bundler that builds the page (Bun's HTML import) would try to resolve the path at build time. The router sends every app hostname's `/_space/*` to ai-space and the package gateway answers the same path, so the link is same-origin for both kinds of app. It lands after the copy and before `styles.css`, so the space's version wins over the copy and the app's own rules win over both.
- The response carries an `ETag` and `cache-control: no-cache`: a page revalidates on every load and gets a 304 until the space is upgraded.

The page still applies its theme before first paint and offers the language and theme controls ([app-spec.md](app-spec.md#app-pages)).

## Tokens

Custom properties on `:root`, light by default, dark under `prefers-color-scheme` unless `data-theme="light"`, and under `data-theme="dark"`.

| Group | Tokens |
| --- | --- |
| Ground | `--canvas` (the page), `--surface` (a tile), `--strip`, `--well` (an inset), `--pill` (a quiet button, a track) |
| Lines | `--line`, `--rule-strong`, `--control-line` |
| Text | `--ink` (titles, values), `--body`, `--muted`, `--faint` (disabled only) |
| Action | `--btn-ink-bg`, `--btn-ink-tx`, `--btn-ink-hover`; `--danger-bg`, `--danger-tx`, `--danger-hover` |
| Accent | `--accent`, `--on-accent`, `--accent-wash`, `--focus` |
| State | `--ok`, `--warn`, `--bad`, each with `-bg` and `-tx`; `--run` |
| Shape | `--r-tile` 16, `--r-well` 8, `--r-mark` 4, `--r-pill` |
| Type | `--font-sans` (the device's system font, PingFang SC, Noto Sans SC), `--font-mono` |

Type sizes are 12 (captions, counts), 15 (everything read or pressed), 28 (page title, small figures) and 48 (`.sp-fig.lg`); weights 300 for figures, 400, 500.

## Rules

- **The accent is the host's.** It marks the square before a tile title, today in a chart, focus and the selected item (`--accent-wash`). It never fills a button, a switch or a checkbox, and never colours a data series.
- **One ink button per screen at most** (`.sp-btn-ink`), for the screen's main action. The rest are `.sp-btn`.
- **State colours come with a word.** Green, amber and red appear only in a badge, a dot beside a label, a banner or a meter. Running is ink (`.run`), not amber; amber is a warning.
- **A count appears once.** If the navigation shows it, the heading does not repeat it.
- **Tiles sit on the canvas edge to edge.** No frame around the app; the canvas is the page.
- **Series colours** in a chart are ink, mid grey and amber, in that order.

## Classes

All start with `sp-`.

| Area | Classes |
| --- | --- |
| Shell | `.sp-app` (left column + work), `.sp-side` with `.sp-brand`, `.sp-ngroup`, `.sp-nitem` (`aria-current`), `.sp-side-foot`; `.sp-work` (`.has-aside`), `.sp-center`, `.sp-aside` with `.sp-aside-head`, `.sp-aside-body`, `.sp-composer`; `.sp-mbar` (phone bar) |
| Tile | `.sp-tile` (`.pad`), `.sp-tt` with `.sp-sq`, `.sp-head`, `.sp-toolbar` |
| Buttons | `.sp-btn` (`.outline`, `.ghost`, `.sm`), `.sp-btn-ink`, `.sp-btn-danger`, `.sp-icon-btn`, `.sp-send` |
| Choice | `.sp-seg` (`aria-pressed` or `aria-selected`), `.sp-check`, `.sp-switch` with `.sp-track` |
| Fields | `.sp-search`, `.sp-kbd`, `.sp-field` (`.error`), `.sp-input`, `.sp-select`, `.sp-textarea`, `.sp-err`, `.sp-hint` |
| State | `.sp-chip`, `.sp-badge` (`.ok .run .warn .bad .off .ai`), `.sp-dot` |
| Figures | `.sp-stats`, `.sp-stat`, `.sp-fig` (`.lg`), `.sp-unit`, `.sp-meter` (`--v`), `.sp-bars` (`.b`, `--h`, `.now`) |
| Data | `.sp-table`, `.sp-rows`, `.sp-row`, `.sp-gh`, `.sp-code`, `.sp-facts` |
| Feedback | `.sp-banner` (`.warn .bad`), `.sp-state`, `.sp-sk`, `.sp-toast`, `.sp-scrim`, `dialog.sp-dialog` |

Drawers are classes on `body`: `sp-open-nav` (left column below 960 px), `sp-open-aside` (right column below 1200 px, a bottom sheet below 760 px), `sp-sheet-open` (the scrim). The page toggles them; the kit has no script.

## Not yet

The accent follows the space's theme only by its default: the panel keeps its appearance in the browser, where an app's origin cannot read it. Serving the operator's accent with `/_space/ui.css` needs the appearance stored by the space.
