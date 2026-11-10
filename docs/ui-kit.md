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

- **The accent is the host's** (see [Accent](#accent)). It marks the square before a tile title, today in a chart, focus and the selected item (`--accent-wash`). It never fills a button, a switch or a checkbox, and never colours a data series.
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

## Accent

The accent is the only token the host sets. The panel keeps its appearance per browser, where an app's origin cannot read it, so the accent travels the way the language does: in the URL the panel opens.

- The manifest's `url` carries an `{accent}` placeholder next to `{lang}`: `url: /?lang={lang}&accent={accent}`. Whoever opens the app fills it with the resolved accent of that browser's panel theme, for the light and for the dark scheme, as `<light>.<dark>`, each six hex digits without `#`: `?accent=8b5cf6.a394ff` ([app-spec.md](app-spec.md#app-pages), [i18n.md](i18n.md#apps)).
- The page's inline `<head>` script reads it before first paint. It accepts only a value matching `^[0-9a-f]{6}\.[0-9a-f]{6}$` (any case), saves it in `localStorage` under `space.accent`, and otherwise falls back to the saved value; an unfilled placeholder, an empty value or anything else is ignored. With a value, it adds an **unlayered** `<style>` that sets `--accent`, which wins over every layer (`kit`, `space`, `app`). `--accent-wash` and `--focus` are made from `--accent` and follow it.
- Only the accent follows the panel. The neutral palette, the radii and the page's light or dark mode stay the kit's and the page's own.
- A page that is already open keeps its accent until it is opened from the panel again. A page opened some other way (a bookmark, its own hostname) shows the accent it saved last, or the kit's default `#8b5cf6` if it never received one.

In the same inline script, after the theme is applied:

```js
// The panel's accent (docs/ui-kit.md#accent): ?accent=<light>.<dark>, kept for the next visit.
var re = /^[0-9a-f]{6}\.[0-9a-f]{6}$/i, a = q.get("accent");
if (a && re.test(a)) { try { localStorage.setItem("space.accent", a); } catch (e) {} }
else a = get("space.accent");
if (a && re.test(a)) {
  var c = a.split("."), st = document.createElement("style");
  st.textContent = ":root{--accent:#" + c[0] + "}" +
    '@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--accent:#' + c[1] + "}}" +
    ':root[data-theme="dark"]{--accent:#' + c[1] + "}";
  document.head.appendChild(st);
}
```

`q` is the page's `URLSearchParams` and `get` reads `localStorage` inside a `try`, as in the head script of [app-spec.md](app-spec.md#app-pages). The key `space.accent` is the same in every app: each app has its own origin, so it is one value per app and browser.

The native clients fill `{accent}` from their own theme where they draw one of the panel's presets (the Mac, iPhone and Android clients: the preset's light and dark accent, without the browser's per-scheme overrides); the Linux and Windows clients follow the desktop's theme and fill it with nothing, which the page ignores.
