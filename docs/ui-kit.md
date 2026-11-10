# The built-in apps' UI kit

The apps that ship with ai-space (AI Usage, Space Ops, Task Shelf, Todo) share one look, **Space Tiles**: a flat neutral canvas, off-white rounded tiles, pill buttons, thin charts and big thin figures. It is one stylesheet, `src/web/ui-kit/kit.css`, served by the space at `/_space/ui.css`. Other apps may use it; nothing requires them to.

The designs it was drawn from are in Design Studio (designs 79 to 84: the component sheet and the four app screens).

## Loading it

The page has three sources of style, and cascade layers put them in order whatever order the files arrive in: the app's own copy of the kit, the space's current version, the app's own rules.

`web/styles.css` (the one stylesheet the page links):

```css
@import "./kit.css" layer(kit);
@layer app {
  /* this app's rules, written with the kit's tokens */
}
```

In `<head>`, in the inline script that applies the theme before first paint:

```js
var s = document.createElement("style");
s.textContent = '@layer kit, space, app; @import url("/_space/ui.css") layer(space);';
document.head.appendChild(s);
```

- `web/kit.css` is the app's copy of `src/web/ui-kit/kit.css` (`curl -s http://127.0.0.1:8700/_space/ui.css > web/kit.css`). It is all the page has when it is reached on its own port or on an older ai-space, where `/_space/ui.css` is a 404.
- `/_space/ui.css` is the space's version. The router sends every app hostname's `/_space/*` to ai-space and the package gateway answers the same path, so it is same-origin for both kinds of app. In the layer `space` it wins over the copy; the app's rules in `app` win over both.
- The inline `<style>` must come before the page's stylesheet in the document, because the first `@layer` statement fixes the order. A bundler that builds the page (Bun's HTML import) moves and merges the linked stylesheets to the end of `<head>`, which is why the page cannot place a second `<link>` between two of them, and why the space's URL is added by script: the bundler would try to resolve it at build time.
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
