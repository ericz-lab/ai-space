# iOS launcher scroll performance

Why Home and the screens of the iPhone client (`mobile/ios/`) dropped frames while scrolling, what was changed, and how to measure it again. Written after the work of 2026-10-13 and 2026-10-14 (PR #14 and the card shadow change that followed).

## The symptom

Scrolling was responsive to the finger but not smooth to the eye: the page moved in steps wherever app icons and, above all, widget cards were on show. Swiping between Home, the screens and Settings stuttered too.

Measured on an iPhone 15 Pro (iOS 26.6.1, 120 Hz) against a Space with 42 apps, 16 agents and 27 widgets, in the Orbit theme.

## What was measured

Before any change, Instruments' Animation Hitches over a scripted scroll showed:

| | Scrolling Home | Swiping pages |
| --- | --- | --- |
| Render time per frame | about 14 ms | about 12 ms |
| GPU time per frame | about 14 ms | about 12 ms |
| Offscreen passes per frame | about 260 | about 160 |
| Longest hitch | 167 ms | 625 ms |

A 120 Hz frame has 8.3 ms. The render server, not the app's main thread, was over its budget on every frame, which is why touches still felt immediate.

The decisive test was by hand: with the content of the widget cards left out and their glass and shadow kept, the scroll was smooth. The cost was what a card holds, not the card's surface and not the number of cards.

## Causes

1. **A view per bar.** A bar trend drew every point as its own `Rectangle` inside a `GeometryReader`. The 13 bar trends on show made 214 views and layers for what is a few dozen rectangles.
2. **A shadow cast by the whole card.** `Glass` applied `.shadow` to the card, content included. Core Animation finds a shadow's outline from everything inside the layer, so the texts and charts of each card were drawn again off screen on every frame of a scroll, to find an outline they never leave. The shadow itself was cheap; what it dragged along was not. This is why the cost followed the content.
3. **Every card made at once.** The library wrapped each section in a `VStack`, so the 27 cards under "Widgets" were one row of the lazy stack: all were built together when the section came into view (a stall of about 140 ms) and all stayed in the view graph afterwards, where every scrolled frame paid for them.
4. **Pages built during the swipe.** The pager was a `LazyHStack`, so the page being swiped to was built, with all its tiles and cards, in the middle of the swipe.
5. **A date parser per call.** `ISO8601.parse` made two `ISO8601DateFormatter`s each time, several times per card.

## Changes

| Change | Where | Looks different? |
| --- | --- | --- |
| A chart is one `Shape` per colour: `SparkBars`, `SparkLine`, `SparkBaseline`, `ProgressFill` | `Views/WidgetBlocksView.swift` | No |
| The shadow is a picture of its own behind the glass (`GlassShadow`, a `Canvas` drawn once per size with the same colour, blur and offset) | `Views/Theme.swift` | No |
| The library's titles, grids and cards are rows of the page's one `LazyVStack` | `Views/HomeView.swift` | Section spacing differs by a few points |
| The pager is an `HStack`; each page stays lazy down its own length | `Views/RootView.swift` | No |
| The two ISO 8601 parsers are made once | `Core/WidgetBlocks.swift` | No |

## Rules that follow

- Draw a chart as a `Shape` or a `Canvas`, never as a view per bar or point.
- Do not put `.shadow` on a container with content. Give the shadow its own layer whose outline is known.
- Do not move the shadow onto the material fill (`shape.fill(.regularMaterial).shadow(...)`): the shadow puts the material in an offscreen group, where it no longer blurs what is behind it. This was tried and it lost the frosted glass.
- A row of a lazy stack is made whole. Anything that should be lazy must be a direct row of it, not a child of a `VStack` inside one.
- A paged row whose pages are heavy should keep its pages; laziness belongs inside each page.
- Formatters are made once, not per call.

## Results

| | Before | After |
| --- | --- | --- |
| Longest main-thread stall scrolling Home | about 140 ms | about 45 ms |
| Longest main-thread stall swiping pages | about 73 ms | about 21 ms |
| By hand | stutters at the widgets | reported as much smoother after each step |

What is not established: the render and GPU figures after the changes. The device stopped starting trace sessions (`Failed starting ktrace session`) after an interrupted recording, so the Animation Hitches recording was not repeated; a restart of the phone normally clears that. The stall figures were taken before the shadow became a picture of its own, and count the main thread only.

## Measuring again

A debug build scrolls by itself: `AISPACE_SCROLL_BENCH=<seconds>` (`AISpace/DebugLaunch.swift`) moves the page on show up and down for the first half of the time, then swipes through the pages, and logs the frames the main thread delivered late. Build with optimizations on and the launch switches kept:

```bash
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
xcodebuild -project mobile/ios/AISpace.xcodeproj -scheme AISpace -configuration Release \
  -destination 'id=<device udid>' DEVELOPMENT_TEAM=<team> \
  'SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG' -allowProvisioningUpdates build
xcrun devicectl device install app --device <device udid> <path to AISpace.app>

# The main thread's side, read from the console:
xcrun devicectl device process launch --device <device udid> --terminate-existing --console \
  --environment-variables '{"AISPACE_SCROLL_BENCH":"16"}' dev.ai-space.ios

# The render server's side:
xcrun xctrace record --device <device udid> --template 'Animation Hitches' --time-limit 23s \
  --output scroll.trace --env AISPACE_SCROLL_BENCH=16 --launch -- dev.ai-space.ios
xcrun xctrace export --input scroll.trace \
  --xpath '/trace-toc/run[@number="1"]/data/table[@schema="hitches-renders"]'
```

The `hitches`, `hitches-renders` (with `offscreen-passes`), `hitches-gpu` and `hitches-updates` tables are the ones to read. The phone must be unlocked for a launch or a recording to start.

Two things the bench's own numbers cannot be trusted for: it counts main-thread lateness only, and during the animated page swipes the display link reports a 120 Hz interval while frames arrive at 60 Hz, so the count of late frames in the paging half is inflated; read the longest stall there, not the count.

## Still open

- Each emoji or placeholder icon has a `.regularMaterial` background, a live blur per tile.
- In a theme with drawn artwork (Orbit, Northern Lights, Paper Cut, Prism) each tile title has a text shadow, an offscreen pass per title.
- The status area and the search field use the system glass effect.
- `EntryIcon` clips through a type-erased `AnyShape`, which may cost a mask per icon where a plain corner radius would do.

None of these was measured on its own. Take them one at a time with a recording before and after.
