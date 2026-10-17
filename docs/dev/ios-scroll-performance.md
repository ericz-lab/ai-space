# iOS launcher scroll performance

Why Home and the screens of the iPhone client (`mobile/ios/`) dropped frames while scrolling, what was changed, and how to measure it again. Written after the work of 2026-10-13 and 2026-10-14 (PR #14 and the card shadow change that followed); the horizontal swipe between pages was taken up later on 2026-10-14 (see [Swiping between pages](#swiping-between-pages)).

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
- No row of a lazy stack is taller than the screen, and every row has an id of its own (see [The page jumping while scrolling](#the-page-jumping-while-scrolling)).
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

## Swiping between pages

After the changes above, scrolling a page up and down felt smooth, but swiping sideways between Home, the screens and Settings still stuttered, by hand more over app icons than over widget cards. Same phone, same Space, in a theme with glows (the layer audit found the glow layers, not drawn artwork).

### What was measured

The scripted bench on the build before these changes, paging half:

| | Per frame |
| --- | --- |
| Render time | about 5.3 ms, 11 to 15 ms on the first frames of each swipe |
| GPU time | about 5.1 ms |
| Offscreen passes | about 44 |
| Longest main-thread update | 12 ms on a screen, 37 ms when the swipe starts from Home |

The bench ran at 60 Hz throughout (see below), where none of this shows as a hitch; at the 120 Hz a finger gets, a frame has 8.3 ms and the first frames of every swipe miss it.

A layer audit of the window (`AISPACE_LAYERS=1`, below) found no layer of its own per app tile: no mask, no blur, no shadow. What it found on every page were the theme's glows: three circles under a 70-point blur, one layer the size of the screen with a filter, drawn again by the render server on every frame anything over it moves. The flat Simple theme, which has no glows, halved the GPU time and the offscreen passes in the same bench.

### Causes

1. **A live blur under every page.** `Backdrop` blurred its glows on each frame. Nothing about them changes while scrolling.
2. **Every page evaluated again in mid-swipe.** `pagerID` was a published property of `AppModel`, which every page observes, so the moment the page under the finger changed, Home, each screen and Settings were all evaluated again, Home with its whole library.

### Changes

| Change | Where | Looks different? |
| --- | --- | --- |
| The glows are flattened into one picture with `.drawingGroup()`, drawn again only when the size or the colour scheme changes | `Views/Theme.swift` | No |
| The page on show is its own object (`PagerPosition`), observed by the paging scroll view alone (`PagerScroll`); `homePage` is no longer published | `AppModel.swift`, `Views/RootView.swift`, `Views/HomeView.swift` | No |
| A layer audit for debug builds, `AISPACE_LAYERS=1` | `DebugLaunch.swift` | No |

Tried and taken back, because the bench showed no change in offscreen passes or frame times: clipping icons by a concrete shape instead of `AnyShape`, a tint instead of `.regularMaterial` under emoji and placeholder icons, and flattening the tile titles' text shadow with `.drawingGroup()`. Of the items left open above, the material under icons, the title shadow and the `AnyShape` clip are therefore measured and not worth changing.

### Results

Scripted bench on the library page, before and after:

| | Before | After |
| --- | --- | --- |
| GPU time per frame, scrolling / paging | 5.5 / 5.0 ms | 3.1 / 2.4 ms |
| Offscreen passes per frame, scrolling / paging | 51 / 44 | 31 / 24 |
| Render time per frame, paging | about 5.0 ms | about 5.4 ms (no change) |
| Longest main-thread update, paging | 37 ms | 32 ms |
| By hand | stutters sideways, most over app icons | reported fixed |

### Rules that follow

- A blur over content that does not change is drawn once (`.drawingGroup()`, or a `Canvas`), not left live under a scroll.
- State that changes during a gesture lives in an object only the view that follows the gesture observes, not in the model every page observes.

### Measuring a sideways swipe

- The bench cannot run above 60 Hz: `Info.plist` has no `CADisableMinimumFrameDurationOnPhone`, so its display link, and with it every frame it drives, is capped at 60 Hz on an iPhone. Read its render and GPU times against 8.3 ms, not against what it reports as hitches.
- A finger is the only 120 Hz source. XCUITest could swipe with real touches, but its runner needs a provisioning profile of its own, and this Mac's Xcode has no account signed in; the only profile is the app's.
- `xctrace record --launch` sometimes leaves the app on a black screen, with no frames after launch; this happened with and without the bench. Check the frame count before reading a recording, and run it again.
- `xctrace record --attach` did not find the running app by its name (`AISpace` or `ai-space`) or by its process id. `--all-processes` works, but 40 seconds made a 939 MB trace that took about six minutes to save; keep such a recording short.
- `AISPACE_LAYERS=1` logs the layers on show that need a pass of their own, five seconds after launch; read them with `xcrun devicectl device process launch --console`. It shows which layers to look at; it does not measure them.

## The page jumping while scrolling

Reported on 2026-10-16 (ai-todo #169, with a screen recording): scrolling Home slowly up past the end of the apps, the page shook. In the recording the apps come into view over a few frames, then the page snaps back down to the Agents title in one frame, again and again while the finger moves.

### Cause

Each grid of tiles was one row of the page's `LazyVStack`. With 44 apps, that row was about 1,100 points tall, more than a screen. The stack drops a row that leaves the screen and stands in for it with an estimate; when the row comes back it is measured again, the estimate was wrong, and the stack moves the content to keep what is on show in place. Right at the edge of the grid that happened on every frame or two. On the phone, the stack's own idea of the page's height swung between 21,639, 10,230 and 8,688 points during one sweep.

Splitting the grid into rows needs a stable id per row. The first attempt used the index of the row's first tile, which the Apps and the Agents grids share; with two rows of one stack under the same id, the page jumped once on the first scroll down.

### Change

| Change | Where | Looks different? |
| --- | --- | --- |
| A grid of tiles is a row of the stack per row of tiles, with the column count an adaptive grid would choose, fixed for every row; each row is known by its first tile | `Views/HomeView.swift` | No |
| The bench logs every frame where the page moved by itself under it (`jump at y=… by …`, with the content height) and their count; `AISPACE_SCROLL_SPEED` slows the sweep | `DebugLaunch.swift` | No |

### Results

`AISPACE_SCROLL_BENCH=50` on Home, the same Space (44 apps, 16 agents, 28 widgets):

| | Before | After |
| --- | --- | --- |
| Simulator, 1500 pt/s | 6 jumps, up to 250 pt, on every pass at the grid's end | none in three runs |
| Simulator, 400 pt/s | | none |
| iPhone 15 Pro, 1500 pt/s | jumps up to 1,140 pt, content height swinging by 13,000 pt | none after the catalogue arrived, at 1500 and 400 pt/s |

Jumps logged before the catalogue has arrived are the page filling in, not this; read the content height in the line.

## Still open

- On the first swipe onto a page, the main thread spent about one second in SwiftUI's lazy layout (`LazySubviewPlacements`, `lengthAndSpacing`), with an update of 25 to 30 ms every 100 ms. Which view causes it was not found.
- The render server still takes 5 to 6.7 ms a frame, close to the 8.3 ms of a 120 Hz frame. The remaining offscreen passes come mostly from widget cards (secondary-style text over material, drawn with a filter) and the system glass of the status area and the search field.
- An icon's image is read from disk and decoded on the main thread the first time its tile is made (`IconStore.image`). It costs on the first showing only, not on later swipes.
- Whether a paging swipe settles at 120 Hz without `CADisableMinimumFrameDurationOnPhone` is not established.
- The status area and the search field use the system glass effect; not measured on its own.
