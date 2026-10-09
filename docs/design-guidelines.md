# ai-space Design Guidelines

*Reviewed draft · v0.2 · 2026-10-09*

ai-space is a personal workspace for apps, agents, and everyday work. Its interface should feel open, calm, and precise. Users should recognize their tools at a glance, see what needs attention, and move easily between launching an app and working with an agent.

This document sets the visual and interaction rules for the panel (`src/web/`). Each rule is marked:

- **Implemented**: the panel does this today. The source is named, and [Panel design](panel.md#appearance) describes the mechanism.
- **Proposed**: an accepted direction that has not been built yet. A proposed rule becomes implemented only in the change that builds it, and that change updates this document.

Nothing in this document starts a redesign on its own. The screens layout (home screen, library, more screens; [Panel design](panel.md#screens)) is implemented; section 11 records how it meets these rules and what is still open.

## 1. Principles

**Clarity comes first.** Text, controls, and status stay readable in every preset, in both modes, over every part of the background.

**Transparency shows depth, not fog.** A translucent surface sits over a quiet background, never over another translucent surface. Two layers of blur look cloudy and cost performance.

**Identity comes from composition.** A recognizable background shape, one palette, and restrained highlights make ai-space recognizable. Decoration does not.

**Emphasis follows importance.** Primary actions, focus, and state changes get emphasis. The background stays quiet.

**Personalization keeps coherence.** Presets and adjustments may change color, radius, blur, and glow. Typography, spacing, interaction patterns, and the meaning of status colors stay the same in every preset.

## 2. Review decisions

These decisions were made while reviewing the v0.1 draft. They are binding for the changes that implement this document.

| # | Decision | Reason |
| --- | --- | --- |
| D1 | The orbital-arc identity ships as a new built-in preset, **Space**. Aurora remains the default until Space passes the checklist in section 12 on real screens. Making Space the default is a separate decision. | Operators who already saved Aurora (or never chose) must not see their panel change without warning. |
| D2 | Space uses the existing token set (`COLOR_VARS` in `src/web/theme.ts`). It adds no new color tokens. The arc is drawn from the three glow tokens. | Import, export, overrides, and the boot script all work on that token set. A new token would change the export format version. |
| D3 | Atmospheric colors (`glowA`–`glowC`, `background`) and functional colors (`accent`, `link`, `focus`, status) stay separate. No functional color may depend on the glow to pass contrast. | The glow moves with the viewport and can be switched off; readability must not change when it does. |
| D4 | The three surface roles of v0.1 map onto existing tokens: background field = `background` + glow; glass = `surface` / `surfaceStrong`; reading surface = `panel`. | The panel already distinguishes these; only their values change per preset. |
| D5 | Contrast is measured against the composited color: the surface blended over the brightest glow it can sit on, not over `background` alone. Section 9 gives the method. | v0.1 asked for this; measuring the current presets this way found the failures listed in section 9.3. |
| D6 | Status colors used as **text** must reach 4.5:1. A status color used only as a dot next to a text label must reach 3:1. | `--warning` is used as text in `.widget-asof.outdated` and reaches only about 2:1 in light Aurora. |
| D7 | Fixing the Aurora contrast failures (section 9.3) is a separate, small change and does not wait for Space. | They affect every operator today. |
| D8 | The default background stays static. There is no ambient animation in any built-in preset. | Battery use, scrolling performance, and focus on content matter more. |

## 3. Visual identity

**Proposed (Space preset).** The signature is a **luminous orbital arc in an open field**: a broad, asymmetric arc near one edge of the viewport, with a defined bright edge and a soft halo, and a quiet center where the content sits.

- Draw it from the glow tokens: `glowA` (ice blue) for the bright edge, `glowB` (cyan) for the halo, `glowC` (violet) only as a small secondary accent at one end of the arc.
- Center the arc's circle outside the viewport at the upper right, so only a segment shows: center at about (110%, −20%) with a radius of about 85vmax on desktop. Below 640 px, move the center to about (120%, −8%) and reduce the halo so the arc shows only in the top quarter of the screen.
- The arc does not cross the launcher's first row of tiles at 100% zoom on a 1280×800 viewport.
- One arc per viewport. Panels, modals, and screens (section 11) do not add their own.
- The `glow` switch hides the arc together with the blobs. With glow off, Space is a clean field.
- Build it with CSS gradients on the fixed `.aurora` layer (a `radial-gradient` ring and a softer second ring for the halo). Use no images and no `filter: blur()` on the arc layer. The current Aurora blobs use `filter: blur(70px)` on three viewport-sized elements; Space does not need that layer.

**Implemented (Aurora).** Three blurred blobs (`.aurora i` in `src/web/styles.css`), colored by `--blob-a/b/c`, opacity `--glow-opacity` (0.55 or 0).

## 4. Color

### 4.1 Token roles

These roles are implemented. The values below are for the proposed Space preset; Aurora's values are in `DEFAULT_THEME`.

| Token (CSS variable) | Role | Space light | Space dark |
| --- | --- | --- | --- |
| `background` (`--bg`) | Base field | `#f3f7fc` | `#0c1322` |
| `glowA` (`--blob-a`) | Arc edge, ice blue | `#b9e4ff` | `#0f3a5e` |
| `glowB` (`--blob-b`) | Arc halo, cyan | `#a5f0f7` | `#0c4a54` |
| `glowC` (`--blob-c`) | Secondary violet | `#ddd3fd` | `#2a2463` |
| `text` (`--text`) | Primary text | `#0b1324` | `#edf3fb` |
| `muted` (`--muted`) | Secondary text | `rgba(11, 19, 36, 0.66)` | `rgba(226, 235, 248, 0.68)` |
| `accent` (`--accent`) | Primary action, selection | `#0a66c2` | `#5ab8ff` |
| `onAccent` (`--on-accent`) | Text on accent | `#ffffff` | `#04121f` |
| `link` (`--link`) | Links | `#0a5fb4` | `#7cc6ff` |
| `focus` (`--focus`) | Focus ring | `#0a66c2` | `#7cc6ff` |
| `success` (`--success`) | Done, healthy | `#1a7f37` | `#4ade80` |
| `warning` (`--warning`) | Late, stale, paused | `#9a5b00` | `#fbbf24` |
| `danger` (`--danger`) | Failed, down, destructive | `#c62828` | `#f87171` |
| `selection` (`--selection`) | Text selection | `rgba(10, 102, 194, 0.22)` | `rgba(90, 184, 255, 0.3)` |

Tokens not listed (`code`, `terminal`, `terminalText`, `inverse`, `scrim`) keep the defaults.

### 4.2 Rules

- **Status colors carry meaning, never decoration.** Green, amber, and red appear only for state. Every status color comes with a word or a symbol (`.status` already pairs a dot with a label).
- **One accent per screen region.** The accent marks the primary action, the current selection, and edit-mode handles. It does not color headings or icons.
- **Accent adjustments carry their companions.** When an operator sets only `accent`, `link` and `focus` follow it and `onAccent` becomes black or white by luminance (implemented in `layer()` in `theme.ts`). Do not let a preset break this by setting `link` alone to a color that clashes with its accent.
- **Third-party colors stay inside app content.** App icons, embedded widgets, and the chat widget's `--sc-*` tokens keep their own colors. The panel's accent never reaches apps (implemented).

## 5. Surfaces and materials

### 5.1 Roles

| Role | Tokens | Used by (implemented) | Space light | Space dark |
| --- | --- | --- | --- | --- |
| Field | `background` + glow | page | see 4.1 | see 4.1 |
| Glass | `surface` | tiles, widgets, empty state, inputs, chips | `rgba(255, 255, 255, 0.62)` | `rgba(255, 255, 255, 0.07)` |
| Strong glass | `surfaceStrong` | hover pop-over, modals, list hover, usage cards | `rgba(255, 255, 255, 0.86)` | `rgba(21, 31, 52, 0.9)` |
| Reading surface | `panel` | settings, chat, tasks, terminal, inbox, events | `rgba(251, 253, 255, 0.96)` | `rgba(17, 26, 44, 0.97)` |
| Solid plate | `solid` | emoji tiles, built-in tiles | `#ffffff` | `#1a2439` |

### 5.2 Edges, shadow, blur

| Property | Rule | Space light | Space dark |
| --- | --- | --- | --- |
| Border | 1 px, `border` (`--glass-border`); lighter than the fill in light mode, a faint tint in dark mode | `rgba(255, 255, 255, 0.72)` | `rgba(186, 222, 255, 0.16)` |
| Divider | 1 px `hairline` inside a surface | `rgba(11, 19, 36, 0.09)` | `rgba(255, 255, 255, 0.1)` |
| Shadow | `0 8px 32px var(--shadow-color)` (derived, implemented) | `rgba(16, 52, 96, 0.09)` | `rgba(0, 0, 0, 0.4)` |
| Blur | `blur(var(--blur)) saturate(180%)` on glass and strong glass only | 16 px | 16 px |
| Glow opacity | `--glow-opacity` | 0.55 | 0.55 |

**Proposed: upper-edge highlight.** Glass in Space gets `inset 0 1px 0 rgba(255, 255, 255, 0.5)` (light) or `rgba(255, 255, 255, 0.08)` (dark), added to the box shadow. It is derived from the mode, not a new token.

### 5.3 Rules

- **No glass on glass.** A `backdrop-filter` surface never sits inside another one. Inside glass, use a flat fill (`surfaceStrong` for hover, `hairline` for dividers). The tile pop-over is a sibling layer, not nested glass.
- **Reading surfaces are nearly opaque.** `panel` alpha stays at or above 0.94 in every preset. Chat, settings, and forms are read for minutes, not glanced at.
- **Text and icons are always fully opaque.** Only fills are translucent. The one exception is `muted`, whose alpha is part of its color and is covered by the contrast check.
- **The operator's opacity slider applies to `surface` only** (implemented: `surfaceAlpha`). It never changes `panel`, so reading surfaces stay readable at any slider value.
- **Proposed: fallback without backdrop effects.** Under `@supports not (backdrop-filter: blur(1px))` and under `prefers-reduced-transparency: reduce`, glass uses `surfaceStrong` and the blur is dropped. Today there is no fallback; without `backdrop-filter`, glass shows the field through a pale fill.

## 6. Layout, spacing, radius

### 6.1 Spacing

Use the scale **4, 8, 12, 16, 20, 24, 32, 48, 56 px**. 20 and 56 are already in use (widget gap, section gap) and are kept rather than migrated.

| Context | Value (implemented) |
| --- | --- |
| Page padding | `clamp(40px, 8vh, 80px)` top, `clamp(24px, 5vw, 64px)` sides; phone: 28 px top, 20 px sides |
| Section gap | 56 px; phone 40 px |
| Launcher grid | 96 px columns, gap 28 px rows × 20 px columns; phone `minmax(76px, 1fr)`, 22 × 10 px |
| Widget grid | `minmax(min(320px, 100%), 1fr)`, gap 20 px |
| Panel head | 14 px × 16 px |
| Settings rows | 8 px × 10 px |
| Modal | 24 px |

Content width stays at most 1080 px (`.shell`). *(Proposed:)* reading text in a wide panel stays at most about 72 characters per line.

### 6.2 Radius

One token, `radius`, with two derived steps (implemented):

| Step | Formula | Space (16) | Aurora (18) | Used by |
| --- | --- | --- | --- | --- |
| `--radius` | token | 16 px | 18 px | panels, widgets, modals |
| `--radius-md` | × 8/9 | 14.2 px | 16 px | tile icons, empty state |
| `--radius-sm` | × 7/9 | 12.4 px | 14 px | pop-over |
| fixed | 8–10 px | — | — | inputs, list rows, chips |
| pill | 999 px | — | — | buttons, selects, badges |

**Proposed:** the fixed 8, 9, and 10 px radii in `styles.css` converge on one `--radius-xs` derived as `min(10px, var(--radius) * 5 / 9)`, so the Simple preset (radius 10) gets matching small corners.

## 7. Typography and language

**Implemented:** `500 16px/1.5 Inter, -apple-system, "PingFang SC", system-ui, sans-serif`; monospace `ui-monospace, "SF Mono", Menlo, monospace` for code, terminal output, and identifiers.

| Level | Size / weight | Used by |
| --- | --- | --- |
| Hero value | 40 px / 650, −0.02 em | widget hero number |
| Section title | 22 px / 700, −0.02 em | Apps, Agents, Widgets |
| Panel or modal title | 15–18 px / 600–700 | panel heads, modals |
| Body | 13–14 px / 400–500 | lists, forms, chat |
| Tile name | 13 px / 500, up to two lines | launcher |
| Secondary | 12 px / 400, `muted` | captions, meta |
| Small label | 11 px / 600, uppercase, +0.04 em (Latin only) | setting groups |

Rules:

- **Hierarchy comes from size and weight first,** then `muted`. Never from the accent.
- **11 px is the floor.** Nothing user-facing is smaller. 10 px (current `.widget-peer`, `.task-tag`, usage chart labels) is raised to 11 px when touched.
- **Uppercase and letter spacing apply to Latin text only.** Chinese labels are not tracked. (Proposed: scope the uppercase style with `:lang(en)`.)
- **Chinese text needs room.** Chinese labels often take fewer characters but more height: keep line height at or above 1.4 and avoid `line-clamp: 1` on labels that may be Chinese.
- **Do not truncate actions or status.** Ellipses are allowed for names and titles (with the full text in `title`), never for button labels, error messages, or state words.
- **Numbers use tabular figures** wherever they update or align (implemented in usage, tasks, sizes).
- **Copy is direct.** An action label names its result ("Save theme", "Run task", "Open app"). Every user-visible string goes through `t()` with both dictionaries (docs/i18n.md).

## 8. Icons and app identity

- **App icons keep their artwork.** The panel standardizes only the plate: 64 px, `--radius-md`, centered, 8 px above a two-line name (implemented). Icon packs (panel.md#icon-packs) follow the same plate.
- **Emoji icons sit on the solid plate** (`.tile-icon.solid`, implemented). Image icons cover their plate.
- **Proposed: no glass under image icons.** An image icon covers the tile completely, so its backdrop filter is invisible but still costs a compositing layer per tile. With 40+ apps that is 40+ blurred layers. Give image tiles the solid plate as well.
- **Built-in controls use one icon family** with the same stroke weight (1.75 px at 24 px) and optical size. The built-in tiles (Terminal, Settings) keep their opaque plates.
- **Badges** sit at the top right of the icon (`-6px, -6px`), 20 px high, `danger` fill for unread or failed, with a number. The agent's app sits at the bottom right (implemented). No other positions.

## 9. Accessibility

### 9.1 Targets

| Check | Target |
| --- | --- |
| Normal text (< 18.66 px bold / < 24 px) | ≥ 4.5:1 |
| Large text, hero values | ≥ 3:1 |
| Status dot next to a label, focus ring, input boundary | ≥ 3:1 against the adjacent surface |
| Decorative borders and the arc | no requirement |
| Touch targets | ≥ 24 × 24 px; ≥ 44 × 44 px for primary controls on phones |
| Zoom | usable at 200%; no horizontal page scroll at 320 px CSS width |

### 9.2 Measuring over translucent surfaces

Composite before measuring:

1. The **ground** is `background` with the brightest glow color laid over it at `--glow-opacity` (worst case: the glow at full strength right under the surface).
2. The **surface** is the token (`surface`, `surfaceStrong`, `panel`) alpha-blended over that ground.
3. Measure the text color (also alpha-blended if it is translucent, like `muted`) against the surface.

Check every preset × mode × each of the three glows. The functions in `theme.ts` (`parseColor`, `luminance`) are enough; a test can do this for every built-in preset (proposed: `theme.test.ts` asserts the targets above for `text`, `muted`, `link`, `accent`/`onAccent`, and the status colors).

### 9.3 Current results

Measured this way on 2026-10-09 (lowest value over the three glows):

| Pair | Aurora light | Aurora dark | Space light | Space dark |
| --- | --- | --- | --- | --- |
| `text` on glass | 16.9 | 9.1 | 17.0 | 10.1 |
| `muted` on glass | **4.07** | **4.37** | 5.77 | 5.28 |
| `muted` on panel | **4.15** | 5.45 | 5.92 | 7.19 |
| `link` on panel | **4.40** | **3.06** | 6.16 | 9.34 |
| `accent` on glass | **3.79** | **2.37** | 5.22 | 5.21 |
| `onAccent` on `accent` | **4.23** | **4.23** | 5.69 | 8.76 |
| `warning` as text on glass | **1.97** | 4.57 | 4.98 | 6.74 |
| `success` as text on glass | **1.99** | 4.53 | 4.67 | 6.45 |
| `danger` on panel | **3.70** | 3.63 | 5.46 | 6.23 |

Bold values miss the 4.5:1 text target. Per D7, the Aurora fixes are a separate change: darken light `muted` to about 0.62 alpha, use text-safe `warning`/`success`/`danger` values for text (keep the bright ones for dots), and lighten the dark `link` and `accent`. Simple and Warm inherit some of these values and must be rechecked after that change.

### 9.4 Keyboard, focus, motion

- **Focus is always visible:** a 3 px ring in `--focus` (tiles, implemented) or `color-mix(in srgb, var(--focus) 35%, transparent)` for compact controls (implemented). The ring must reach 3:1 against the surface it sits on; the 35% mix fails that on glass in light mode, so compact controls move to a 2 px solid `--focus` ring with a 2 px offset (proposed).
- **Inputs show focus with the focus token,** not `link` (proposed: `.field input:focus` currently uses `--link`).
- **Every pointer path has a keyboard path:** hover pop-overs have a focus equivalent; edit mode (jiggle, remove, resize) is reachable and operable with the keyboard, and resizing has arrow-key steps.
- **Never color alone:** state words or symbols accompany every status color.
- **Reduced motion:** under `prefers-reduced-motion: reduce`, no jiggle, no panel rise, no pulse, no pet (rise, jiggle, and pet are implemented; proposed: also stop `pulse` and `tabPulse`, replacing them with a static dot).

## 10. Interaction and motion

### 10.1 States

Every interactive element has these states. Values are relative to the element's resting style.

| State | Treatment |
| --- | --- |
| Hover | Fill one step stronger (`surface` → `surfaceStrong`), or tile lift `translateY(-3px) scale(1.05)` |
| Focus | Focus ring (9.4); never removed without a replacement |
| Pressed *(proposed)* | `scale(0.97)` for 100 ms; buttons darken their fill by mixing 8% `text` |
| Selected / current | Accent fill, or a 2 px ring or underline; text tabs also use weight 600, so the state does not rely on color alone |
| Disabled | Opacity 0.55, `cursor: default`, no hover (implemented on `.btn2`) |
| Busy *(proposed)* | Label stays, a spinner or "…" appears beside it, the control is disabled until done |
| Error | `danger` text below the control with the reason; the user's input stays |

### 10.2 Components

Implemented unless marked *(proposed)*.

**Launcher tile.** Rest: plate + name. Hover: lift and, on desktop, the pop-over after the pointer rests. Focus: ring on the plate. Edit mode: jiggle (static under reduced motion), a 22 px remove badge (`danger`, top edge), built-in tiles at 0.6 opacity and not draggable. Stale (peer offline): 0.45 opacity, 60% grayscale, explained in the pop-over.

**Widget card.** Glass, `--radius`, 14 × 16 px padding. Head: icon 22 px, title in `muted` 13 px / 600, then `as of` time on the right (in `warning` with weight 600 when out of date). Hero number 40 px; rows below by size. Error: the source's message in `muted`, never a blank card. Loading *(proposed)*: a single line "Loading…" in `muted`, no skeleton shimmer. Edit mode: size label in the head, resize grip bottom right, 2 px accent outline while resizing.

**Chat panel.** Reading surface. Agent tabs 34 px; the current tab at full opacity with a 2 px `--focus` ring, the others at 0.6. A running agent shows a pulsing `success` dot (static under reduced motion *(proposed)*). *(Proposed:)* the message column is at most about 72 characters wide, the input keeps its draft when a turn fails, and the failure appears in the thread with a retry action.

**Settings.** Reading surface, at most 560 px wide; on phones, full screen. Groups have an 11 px uppercase label (Latin only). Rows are 8 × 10 px with the control on the right. Switches are 40 × 24 px. Drafts (appearance) show a live preview, with Save as the primary action and Cancel beside it.

**Forms and modals.** Labels above fields (13 px `muted`). Fields: glass fill, 10 px radius, 9 × 12 px padding, 16 px font on phones (prevents iOS zoom; implemented). The primary button is filled with `text` and `inverse`; secondary buttons are glass pills. Errors are in `danger` under the actions, and the form keeps every value.

### 10.3 Motion

| Use | Duration / easing (implemented unless marked) |
| --- | --- |
| Hover, color, opacity | 150 ms ease |
| Switch thumb | 220 ms `cubic-bezier(0.34, 1.3, 0.64, 1)` |
| Panel open (`rise`) | 200 ms ease, from 10 px lower at 98.5% scale |
| Glow on/off | 300 ms ease |
| Screen change | 280 ms `cubic-bezier(0.2, 0.8, 0.2, 1)`, 48 px horizontal slide with fade; none under reduced motion |

Motion explains where something came from or that something changed. Nothing loops except an indicator of active work, and that stops under reduced motion and when the page is hidden.

## 11. Screens, library, and dock

The screens layout ([Panel design](panel.md#screens)) is implemented. How it meets this document:

- **Edges are discoverable without hover** (implemented): a faint 4 × 44 px handle in `muted` at 0.22 opacity at each edge with a destination, which becomes a 40 px strong-glass button with a label on hover or keyboard focus (3 px focus ring). Touch screens hide the edges and use the dock and swipes.
- **The dock** (implemented) sits bottom center on strong glass: library, home, one dot per screen, and search. The current dot is full opacity; the others are at 0.45.
- **Screen changes** slide 48 px with a fade in 280 ms and do not animate under reduced motion (implemented, section 10.3).
- **"Added" state** (implemented): the Add button turns into "✓ Added" for an entry already on the target screen, and a notice links to that screen. The check and the word carry the state, not color alone.
- **Search** (implemented): ⌘K / Ctrl+K opens the library with the search focused.

Still open (proposed):

- **The background stays fixed to the viewport, not to a screen.** The `.aurora` layer is `position: fixed` today, so this holds. The Space arc must keep it that way and must not be repainted during a slide.
- **Library cards are glass** (`.lib-card` has its own backdrop filter), so a library with every app means dozens of blurred layers. Draw library cards with the flat `surfaceStrong` fill and no backdrop filter (5.3, section 8's performance note). The library is a list to scan, not a place for depth.
- **The dock's inactive dots** (`currentColor` at 0.45) must reach 3:1 against the dock in every preset (9.1). Check this in the contrast test.
- **The edge handle** at 0.22 opacity is decorative; the button on hover or focus is the control. Keep it that way: the handle must not become the only cue on any input type.

## 12. Review checklist

A change to the panel's look is ready when every box can be checked. Screens to try: 1280 × 800 and 1920 × 1080 desktop, 390 × 844 phone, 320 px width, 200% zoom.

**Readability**
- [ ] Every text pair in 9.3 passes for every built-in preset and both modes (automated test).
- [ ] Main content reads clearly over the brightest part of the background, with glow on and off.
- [ ] Opacity slider at 0% and 100%: glass text still passes (reading surfaces are unaffected by design).

**Identity and materials**
- [ ] The background has one recognizable shape and a quiet content area.
- [ ] No glass inside glass; reading surfaces at 0.94 alpha or more.
- [ ] Cards are distinct from the field without heavy shadows or a cloudy look.
- [ ] Light and dark look equally finished, with screenshots of both in the PR (home, library, and one open panel).

**Interaction**
- [ ] Every control has visible hover, focus, pressed, and disabled states.
- [ ] The whole flow works with the keyboard alone, including edit mode.
- [ ] Under reduced motion, nothing moves except direct responses to input.
- [ ] Errors keep user input and say what happened.

**Language and layout**
- [ ] English and Chinese both fit: no clipped buttons, no truncated status words.
- [ ] Narrow screens and 200% zoom: no horizontal page scroll; panels go full screen below 640 px.

**Performance**
- [ ] Scrolling the launcher and widgets stays at 60 fps on a mid-range laptop with 40+ apps (Chrome performance panel: no long frames from paint or composite while scrolling).
- [ ] Typing in chat shows no input delay with the background visible.
- [ ] Without `backdrop-filter` support, glass falls back to an opaque fill.

**Documentation**
- [ ] Rules moved from Proposed to Implemented in this document; [Panel design](panel.md#appearance) updated if tokens or presets changed.

## 13. Themes and customization

Implemented (panel.md#appearance): every preset defines light and dark; resolution is default → preset → operator overrides; the settings offer accent, background, radius (0–28), blur (0–40), glass opacity, and glow, with live preview, Save, Cancel, and reset to Aurora; import and export are strict JSON.

Rules for presets:

- A preset sets only what differs from Aurora and must pass section 9 in both modes.
- A preset does not change typography, spacing, component behavior, or what a status color means.
- The adjustment controls stay few and understandable. A new control is added only when an existing preset cannot express a common wish.

Proposed: the **Space** preset (`id: "space"`) with the values in 4.1 and 5.1–5.2, `radius: 16`, `blur: 16`, `glow: true`, and the arc of section 3 drawn when `data-preset="space"` is set on `<html>`. Setting that attribute is a small addition to `paint()` and the boot script; the arc's CSS lives in `styles.css`. See [design-guidelines-examples.svg](design-guidelines-examples.svg) for a light and dark sketch.
