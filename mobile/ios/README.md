# ai-space for iPhone

A native iOS client of a Space that already runs: a SwiftUI launcher over the Space's own catalogue, with the Space's pages in `WKWebView`. Nothing is installed or started on the server, and the app carries no token or deployment secret.

Status: built and exercised on a Mac as a Mac Catalyst app, and built with Xcode 27, development-signed, installed and launched on an iPhone 15 Pro running iOS 26.6.1. Device installation and launch are verified; the launcher has also been visually checked in the Simulator. The device interaction checks below remain outstanding. See [What has been checked](#what-has-been-checked).

## What it does

| Area | In this version |
| --- | --- |
| Spaces | Add a Space by the address of its panel, several if you have them, switch between them. HTTPS everywhere; plain HTTP only to loopback (a Space on the Mac that runs the Simulator). |
| Pages | Home, each screen of the panel and Settings sit side by side and are swiped through, as on an iPhone's home screen: left of the first screen is Home, right of the last one is Settings. The app opens on the first screen, and so does switching to another Space. A bar at the bottom names the three parts and jumps between them; dots above it say which screen is on show while there are several. |
| Home | The library, drawn natively: every app, agent and widget of the Space, with one search. An app's icon is a rounded square, an agent's a circle; only what is wrong is marked on a tile (not answering, paused, its machine offline). Entries are keyed by the panel's own entry keys (`app:<id>`, `agent:<id>`, `widget:<id>`), titles in English or Chinese as the manifests provide, icons from the Space (emoji, bitmap or SVG). Downloaded icons and rendered SVGs are cached locally per saved Space, so reopening the app can display them immediately. |
| Panel | The screens, drawn natively with nothing above them: the main screen, then your own. **Kept on the phone, per Space.** The first catalogue of a Space copies the panel's screens once (its built-in tiles left out); after that the phone's layout is its own and nothing is written to the Space, so a phone and a browser can be laid out differently. Touch and hold an entry on Home and choose Add to Panel (with several screens, which one); touch and hold one on a screen to take it off. Touch and hold the empty part of a screen for the screen's own actions: a new screen, a list to drag its entries into order or delete them, deleting it, and replacing the phone's layout with a fresh copy of the panel's. |
| Widgets | A widget that sends blocks is drawn as the panel's state card: the first block large, the rest as rows, as many as the card's size holds (metric with its change, trend as a line or bars, progress, gauge with its zones, status). Other widgets show their list. |
| Search | One search over the three kinds: every word must appear in the title, description or id, in any of the entry's languages, so `todo` and `待办` find the same app. |
| Reachability | A dot per app from the Space's health probe (running, not answering), paused apps, and peers named as offline with the time of their last snapshot; their tiles are dimmed and say so. While the Space itself cannot be reached, the last catalogue stays on show, marked with its age, and the health dots are withdrawn. |
| App pages | An app opens in a retained web view with the Space's session. Until a page is drawn, the mark and "Connecting…" stand in for the blank view, through the redirects of an access layer that needs no one; a sign-in page that does need someone shows once it has loaded, under a bar naming its host. One floating More button opens the page controls: back, forward, reload, return to Space, share, open in Safari, add to Panel, close tab. Open app tabs appear below the actions. The button can be dragged: it snaps to the left or the right edge at the height it was let go, the place is kept on the phone, and the menu opens above or below it, wherever there is more room. Each tab remembers the launcher page where it was created: Home, a particular Panel screen, or Settings. Return to Space restores that tab’s opening page, including after switching retained tabs; a deleted screen falls back to the first Panel screen. Returning to the launcher or switching tabs preserves the page; closing a tab discards it. Tabs are isolated per Space and cleared on sign-out or removal; they last for the current app process. Upward finger swipes hide the button and downward swipes reveal it, with a 24-point direction threshold. Horizontal gestures do not hide it; VoiceOver keeps it visible and offers moving it to the other side as an action. Swipe navigation, file and photo inputs, downloads to the share sheet, JavaScript dialogs titled with their origin. |
| Other sites | Only the Space's hostnames load in the app (below). A link tapped to anywhere else, and a link app whose page is on another site, opens in Safari. |
| Settings | The phone's own display choices (appearance, theme, widgets on the screens, the language through iOS Settings), which the panel keeps per browser too. The theme is one of the panel's presets: colours, glows and radius, and for the presets that have drawn artwork behind the panel (Orbit, Northern Lights, Paper Cut, Prism) that artwork, fetched from the Space (`/backdrops/<name>.html`) and drawn once to a picture behind the pages. The picture is kept on the phone, so the next launch shows it at once and draws the artwork again behind it; until the Space has sent it a first time the theme's ground colour shows. Then the Space's settings, read from the Space: status, the default model, the Space's pages (next row), peers, services with their health, backups with their state. Below them, what belongs to the phone: saved Spaces, the session, the app. The panel's hover details and desk pet are not here. |
| The Space's pages | Drawn by the app from the Space's own routes, in a cover over the tabs with its own navigation, read each time a page opens and when it is pulled down (no timer). **Inbox**: the threads with the panel's four filters; opening one marks it read; done, reopen, unread, read all. **Chat**: the agents, and one agent's conversation: a turn is a run on the Space followed over its event stream (picked up again after a break, stopped with the stop button), earlier chats from the agent's sessions; the model and permission mode are the agent's defaults. **Scheduled tasks**: by app, with schedule, triggers, last and next run, the last 20 runs with their output, and the model of a task that takes one. **Model usage**: the four windows, totals, rows by app and tag and by model, lifetime figures with tokens by week, the last calls. **App usage**: windows and kinds, opens and time in use with a 30-day trend. **App models**: the model each app's calls run on and the panel's override for the app or a tag. **Events and calls**: the recent events with their data and deliveries, and the catalogue of capabilities and events. **Apps and connections**: installed packages, packages other Spaces share, and each connection with its switch and what this Space shares over it. Four things here change the Space, as the same controls on the panel do: a task's model, an app's model, a connection's switch and shares, and the inbox marks. Installing, rolling back or removing a package and making a connection stay in the web panel. |
| Terminal | A shell on the Space's machine or on a peer that offers one, drawn by the app: SwiftTerm as the emulator over the routes the panel's page uses (docs/terminal.md), a ticket request and then a WebSocket with the session's cookies and the Space's origin. One tab per session, the machines with the ones that are off or down listed and disabled, the passphrase asked for when a machine wants one and kept in memory only, the recent sessions from the Space's audit rows. Sessions and their scrollback are kept while the app runs, so leaving the page does not end them; signing out or removing the Space does. The Space decides what runs; the phone sends keystrokes and the window size. A dropped socket is not picked up again (the Space hangs the shell up), and iOS drops it in the background. |
| Web panel | The Space's web page over the tabs, opened by a sign-in and from Apps and connections: package installs, and whatever the app does not draw. The page leaves its own dock, edges, swipe and hint out there (by the `AISpaceMobile/` user agent; for a Space that does not do so yet, the app hides them with a style), since the Panel tab has the screens. A file the panel downloads (a theme export) goes to the share sheet, as on an app page. |
| Links in | `aispace://open?app=<id or name>`, `aispace://inbox`, `aispace://chat`, `aispace://show`, the same links as the Mac client. `inbox` and `chat` open the native pages; a text in a chat link is put in the field, not sent. A link only shows something; it never sends a message or changes the Space. |
| Quick actions | The first four apps of the home screen of the Space on show appear on the app icon's long-press menu and open through the same links. Each carries its Space, so it opens that Space's app also when the app starts on another one. |

## Layout and the Mac client

The Mac client lives in `desktop/macos/` on `feat/macos-desktop`; this branch starts from it and puts the phone next to it:

```text
mobile/ios/
  project.yml            XcodeGen spec; AISpace.xcodeproj is generated from it
  AISpace/
    AISpaceApp.swift     app, scene delegate (quick actions), aispace:// links
    AppModel.swift       saved Spaces, sessions, what is on show, link routing
    DebugLaunch.swift    launch switches of debug builds (screens without touching the device)
    Core/                Foundation only: catalogue decoding, search, the host list and navigation
                         rule, screens and their store, widget blocks, the Space's settings and the
                         shapes of its pages (HubModels), the catalogue cache, quick actions
    Live/                CatalogueLoader (the Space's routes), SettingsLoader, HubStores (one store
                         per page of the Space, and the chat), TerminalSession and TerminalStore (a shell's
                         ticket and socket, the open tabs), IconStore (icons, SVG drawing),
                         BackdropStore (a theme's artwork), paths
    Web/                 WebSession (WKWebView and its delegates), WebContainer
    Views/               Home (library, screens, screen bar and editor), tiles, widget cards and
                         their blocks, app page, panel, settings, the Space's pages (Hub*Views,
                         ChatView), the terminal (TerminalViews, and TerminalSurface around SwiftTerm), connect, theme
    Resources/           the mark, the app icon, English and Chinese strings
  AISpaceTests/          swift-testing tests of Core/ and of CatalogueLoader, against scripted answers
  scripts/               test.sh, build.sh (swiftc only), swiftterm.sh, icons.swift, sources.sh
```

Eight Foundation-only files are compiled from the Mac client where they are, not copied: `Connection`, `ConnectionStore`, `SpaceCheck`, `SpaceAPI` (with its cookie rules), `SpaceModels`, `ChatStream`, `DesktopRules` (the `aispace://` links) and `NavigationPolicy`. `scripts/sources.sh` and `project.yml` list them. The phone adds its own rules on top (a host list instead of one origin) rather than changing them. If both clients are kept, the natural next step is to move those files to a neutral directory (`clients/shared/`) in one commit that touches both projects; that was left out here so the Mac branch stays untouched. The Mac client now also compiles this client's `Core/` and `Live/` files (its `scripts/sources.sh`), so a change to one of them must build on both.

One dependency: [SwiftTerm](https://github.com/migueldeicaza/SwiftTerm) 1.20.0 (MIT), the terminal emulator of the Terminal page. `scripts/swiftterm.sh` clones it into `build/deps/SwiftTerm` at the pinned commit; `project.yml` compiles those sources as a static library target (`bun run ios:xcode` fetches first) and `build.sh` compiles them once with `swiftc` (about half a minute). It is not taken as a Swift package, because the package needs a build-tool plugin trusted and the Metal toolchain installed to compile a shader the app never uses (SwiftTerm draws with Core Graphics unless asked for Metal). Only `Views/TerminalSurface.swift` imports it. An iPhone release build grows from 6.1 MB to 9.0 MB with it (1.4 MB to 2.4 MB zipped; Xcode 27, arm64, unsigned).

The visual identity is the panel's: the mark is the ai-space logo, drawn from `docs/logo.svg` (`scripts/icons.swift`), and `Views/Theme.swift` carries the default "Aurora" tokens of `src/web/styles.css` (ground, the three glows, accent, radii, glass with a hairline). The launch screen is the mark on the Aurora ground (`UILaunchScreen` in `Info.plist`, `LaunchLogo` and `LaunchGround` in the asset catalog). While a Space is reached for the first time, Home shows the mark with its circles and leaf dipping in turn (`ConnectingMark`), still under Reduce Motion.

## Build and run

### With the Command Line Tools only

```bash
bun run ios:test     # build and run AISpaceTests on the Mac
bun run ios:build    # mobile/ios/build/AISpace.app, a Mac Catalyst build, ad-hoc signed
open mobile/ios/build/AISpace.app
```

The Catalyst build is the same Swift, UIKit, SwiftUI and WebKit code as the iPhone build, compiled against the iOS frameworks that the macOS SDK carries, in a phone-sized window. It is how the screens below were checked. It is not a product: it drops the `aispace://` registration so it cannot take the Mac client's links. Its web views have no microphone or camera: WebKit leaves `navigator.mediaDevices`, `MediaStream`, `MediaRecorder` and `RTCPeerConnection` out of a Mac Catalyst app's pages (checked on a secure page, also with WebKit's own switches on), so a page's voice input reports that the browser cannot record. That is this build only; the iPhone build declares the usage strings and answers the capture prompt for the Space's pages, and has yet to be tried on a device.

Two rules keep the sources compiling without Xcode, as in the Mac client: no `@State` (the macOS 27 Command Line Tools declare it as a macro whose plugin only Xcode ships; view state lives in small `ObservableObject`s), and `.strings` tables instead of a String Catalog.

### With Xcode (required for the Simulator and a device)

```bash
bun run ios:xcode    # regenerate AISpace.xcodeproj after adding or moving files
xcodebuild -project mobile/ios/AISpace.xcodeproj -scheme AISpace \
  -destination 'platform=iOS Simulator,name=iPhone 16' build test
xcrun simctl boot 'iPhone 16'
xcrun simctl install booted <DerivedData>/Build/Products/Debug-iphonesimulator/AISpace.app
xcrun simctl launch booted dev.ai-space.ios
```

The Simulator build and launch were checked with Xcode 27 and the iOS 27 runtime. On a Mac whose default developer directory is the Command Line Tools, prefix Xcode commands with `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`. A Space on the same Mac is reachable from the Simulator at `http://127.0.0.1:8700`.

A debug build reads launch switches from its environment, so screens can be reached and captured without touching the device (`SIMCTL_CHILD_AISPACE_TAB=panel xcrun simctl launch …`, or `open --env` for the Catalyst build). `AISpace/DebugLaunch.swift` lists them: connect to a Space, pick a tab, set the search text, open one of the Space's pages, send a chat message, open an `aispace://` link, write a PNG of the window and quit. None of it exists in a release build.

## Authentication

What the real access path is (docs/ingress.md, docs/router.md, docs/cloudflare.md, docs/panel.md#trust-boundary, `src/space/auth.ts`):

- ai-space binds loopback. The outside reaches it through a Cloudflare Tunnel, and **Cloudflare Access is the login**: one Access application on the panel's hostname and one on `*.<domain>` for the apps, each with a 24 hour session, allowing the owner's e-mail.
- The panel's routes carry no token. They trust whoever passed the access layer, and refuse a write only when it comes from another site's page (`guardBrowserWrites`). The operator token (`SPACE_API_TOKEN`) is for machine-side routes and must never be in a client. There is no mobile login, refresh or per-device revocation in ai-space itself.

What the app does about it:

- **Each saved Space has its own WebKit data store** (`WKWebsiteDataStore(forIdentifier:)`), apart from Safari and from every other Space. The panel tab, every app page and the native catalogue calls use it: the native calls read the store's cookies for each request (`SpaceAPI`), so one sign-in in the web view serves all three. On a cold launch, `WebCookieSession` first loads a local blank page to initialize the persistent profile, then releases the waiting native requests. Reading the cookie store before that initialization can return an empty jar even when valid cookies are on disk. This does not contact the identity provider or extend any cookie expiry. Nothing is copied out of Safari.
- **Sign-in happens in the web view.** A request that is redirected, or answered 401 or 403, means "sign in": Home shows a card, the Sign In button opens the web panel over the tabs, the access layer's pages load there (a bar names the host you are on), and when the panel is back and answers `GET /api/panel/layout` as ai-space does, the catalogue loads and the web panel closes. An app on its own hostname goes through the same redirect inside its page; with Access the team-domain cookie makes that silent.
- **`ASWebAuthenticationSession` is deliberately not used.** It shares cookies with Safari, not with the app's web views, so a sign-in there would not reach the pages the app shows. Access has no token exchange a native client could use instead without a service token, which would be a long-lived secret on the phone.
- **Nothing secret is stored by the app.** The session cookie lives in the Space's WebKit store inside the app's sandbox; saved Spaces and screens are plain files with addresses and entry keys. There is nothing for the Keychain to hold in this version.
- **Sign Out** (Settings) clears that Space's website data (cookies, storage, caches), the saved catalogue, local icon cache and the open pages. Removing a Space also deletes its data store. A catalogue request still on its way when either happens is dropped when it answers.
- **Expiry** shows as the same sign-in card, with the last catalogue still on show; the app never retries a write on its own.
- **A write names its origin.** The two routes that set a model (`PATCH /api/panel/tasks/:id/model`, `/api/panel/apps/:app/model`) take a write from the panel's own origin only, so no other site's page can make one with the operator's cookie. `SpaceAPI` sends `Origin: <the Space>` on every request with a body: the app is a client of that origin holding its session, not a page of another site. The server rule is unchanged.

Confirmed on this machine against a stand-in access layer (redirect to a login on another origin, a callback that sets a cookie): the sign-in-needed state, the redirect staying in the view, the native calls succeeding with the web view's cookie right after, sign-out returning to sign-in-needed.

To confirm on a real iPhone, in this order:

1. The Access login completes inside `WKWebView`. One-time PIN by e-mail should; **Google as identity provider refuses embedded web views** (`disallowed_useragent`), and then the choice is another login method on the Access policy or a platform-side client session (below).
2. The `CF_Authorization` cookie is readable from the store by the native calls (it is `HttpOnly`, which the cookie store API does return).
3. Force-quit and reopen the app while the Access session is valid: Home loads without a login prompt. Repeat after backgrounding. Sign Out must still require a new login; another saved Space must remain isolated.
4. An app on `*.<domain>` opens without a second prompt.
5. The panel's chat stream (SSE) and terminal (WebSocket) hold through the tunnel on cellular, and what happens to them when the app is backgrounded.
6. The 24 hour session: a daily sign-in on a phone is tiresome. Access's session length is the owner's setting, not the app's.

## The host list

`Core/SpaceHosts.swift` decides what loads in the app: the panel's origin, the page origin of every app that runs a service on the Space or on a peer, and, when the Space routes hostnames itself (`GET /api/router` names its domain), every HTTPS host under that domain. `MobileNavigation` applies the Mac client's `NavigationPolicy` with that list:

- a page on the list loads; a new window for one loads in the same view;
- a link tapped on a Space page to any other site goes to Safari, and so does a link app's page (documentation, a repository elsewhere), where your own logins for that site are;
- a redirect off the list that nobody tapped stays in the view: that is the access layer's sign-in, and it has to finish in the Space's session;
- other schemes (`mailto:`, `tel:`) leave only on a tap; frames are left alone.

Camera and microphone prompts are offered to pages on the list only. Web content has no bridge and no script message handler.

## What has been checked

On macOS 27, Command Line Tools 27.0, Swift 6.4 (language mode 5), against a scratch Space run from source with a scratch workspace, a second scratch Space as its peer and three stand-in apps:

- `scripts/test.sh`: 60 tests in 12 suites pass (the shapes of the Space's pages: tasks and their states, model and app usage, app models, events, packages, inbox, chat routes and figures; the Space's services, backups and default model, catalogue decoding and tolerance, reach states, languages, search, host list, navigation rule, screens and their store, widget blocks and number formats, cache, quick actions and the Space they carry, icon sources, and the catalogue loader with answers held back: signing out during a refresh, online to offline and back).
- `scripts/build.sh`: debug and release Catalyst builds, no warnings.
- Run as a Catalyst app, with window captures read back: first launch; Home with the screens copied from the panel, the library, a second screen, widget state cards (gauge, bar trend, metric with its change), health dots, an SVG avatar; the Panel tab with the screens; Settings with a Space's peers, services and backups; the theme presets in light and dark; each of the Space's pages against a live Space (inbox, agents, tasks, model usage, app usage, events, apps and connections), and one chat turn sent and streamed back; the web panel over the tabs without the page's dock; Chinese titles and Chinese search; an app page; the panel tab; settings in Chinese; sign-in needed, signing in, signed in, signed out; an address that is not ai-space; an unreachable Space with and without a last catalogue; a peer going offline.
- By log, with scripted clicks in the page: a link inside the app stays and enables Back; a link and a new window to another site are handed to the browser; a new window to another app of the Space loads in the view; a script redirect off the Space is treated as a sign-in; `aispace://open` finds an app by id and by bare name, and sends a link app to the browser.
- The terminal, against the scratch Space and its peer with `SPACE_TERMINAL_ENABLED=1`, as the Catalyst app and in the iPhone 17 Simulator, with window captures read back: the page with its machines and recent sessions; a shell on the Space's machine and one on the peer through the hub (the audit row lands on the peer), typed into by the launch switch; colours in light and dark; a session silent for 80 seconds still open; the window size the shell reports matching the view, above the keyboard on the phone. Not checked: the passphrase prompt and the tab and machine menus as taps, the keyboard's accessory row, a session through Cloudflare Access (the socket carries the session's cookie and the Space's origin, which the routes need; whether Access lets the upgrade through on that cookie has to be tried on a real Space), and what the phone does to a session in the background.

Not checked on a screen: the swipe between the pages, the long press on a screen and the menus it and the tiles bring up, and the sheet that rearranges a screen (gestures cannot be scripted, and what is presented over the window is not in the captures the debug build writes); their rules are tested, their drawing and feel are not.

Not checked on the Space's pages, because a gesture cannot be scripted here: the pages one level in (a task with its runs, an event with its deliveries, an inbox thread, the capabilities list) and the controls that change the Space as taps (the app-model request itself was sent by hand with and without `Origin`, and undone; the inbox marks, a task's model and a connection's switches were not exercised).

Device check on 2026-10-13: the Debug `xcodebuild` build, automatic development signing, installation and launch on an iPhone 15 Pro running iOS 26.6.1 passed with Xcode 27. First launch required trusting the development profile in the phone's Settings. The Foundation-only test command also passed all 60 tests.

Not checked on a device: the tests under Xcode, the asset-catalog app icon's appearance, safe areas and the tab bar on a real iPhone layout, the software keyboard over a page, the photo picker and camera for file inputs, downloads into the share sheet, home-screen quick actions, `aispace://` from another app, memory-pressure reloads, VoiceOver and Dynamic Type, and everything listed under Authentication. Simulator checks are recorded below; they do not replace device validation.

Cold-start session check on 2026-10-13: an iPhone 15 Pro returned zero cookies before profile initialization, producing login redirects despite valid cookies on disk. With initialization awaited, the same saved profile returned its cookies and the catalogue loaded with HTTP 200 without signing in again. The Xcode Simulator suite passed 62 tests, including concurrent cookie reads, reopening a profile, profile isolation and clearing the session on sign-out.

### Icon cache

`IconStore` keeps decoded images in memory and PNGs under the app's Caches directory, separated by saved Space. File keys hash the Space origin and icon URL. Cached images appear immediately after relaunch; after 24 hours, a requested icon refreshes in the background while its previous image stays visible. A failed refresh retains that image and retries after the catalogue is refreshed. An icon URL change loads a new entry. iOS may reclaim these cache files when space is needed.

Sign Out and removing a Space clear its icon cache. A download already in flight cannot write it back after clearing. Simulator regression tests cover reopening the cache without downloading, stale refresh success and failure, origin isolation and clearing during a pending request.

### SVG rendering regression

SVG icons and rendered theme backdrops keep their rendering web views at full opacity behind the app's content. Lowering a rendering view's alpha also fades its snapshot, making cached icons look empty. `SVGRasterizerTests` runs under Xcode on iOS and checks the resulting bitmap's color and opacity; the Foundation-only command does not run this WebKit test.

Icon completions notify only the views displaying that icon, rather than invalidating the catalogue,
all tiles, and Settings. Missing disk entries are checked once per store lifetime; repeated reads share
an in-flight request. Cache invalidation still clears visible icons on sign-out. For device scrolling
checks, use a Release build so Swift compiler optimizations are enabled; Simulator screenshots and
unit tests do not establish real-device frame rates.

Catalogue refresh decodes widget data off the main actor and queues cache encoding/writes on a
serial background queue. Sign-out drains queued writes before removing the cache. Unchanged
status flags do not notify the launcher again, and the refresh guard is not view-observed.

### Scrolling

What made Home and the screens stutter on a device was what a widget card holds, not how many cards there are. Two rules follow:

- A chart is one shape per colour (`Spark`, `ProgressBar`), never a view per bar or point.
- The library's titles, grids and cards are rows of the page's one lazy stack, so a card is made when it is scrolled to. The pager's row is not lazy: a lazy one builds the page being swiped to in the middle of the swipe.

`AISPACE_SCROLL_BENCH=<seconds>` in a debug build scrolls the page on show up and down and then swipes through the pages, and logs the frames the main thread delivered late; run it under Instruments' Animation Hitches for the render server's side. Measure on a device with compiler optimizations on (`-configuration Release SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG` keeps the launch switches).

A card's shadow is a picture of its own behind the glass (`GlassShadow`), not `.shadow` on the card: cast by the whole card it makes the render server draw the card's texts and charts again off screen on every frame, and cast by the material fill alone it stops the material blurring what is behind it.

The measurements, the causes and what is still open are in [docs/dev/ios-scroll-performance.md](../../docs/dev/ios-scroll-performance.md).

### Safe-area regression checks

The launcher measures each page inside the system safe area and lets scrolling content draw behind the frosted status area. One shared backdrop extends behind the status bar, Home search area, Panel and Settings. A single stationary glass layer covers only the status safe area, outside the horizontal pager; it does not overlap the search capsule or move with adjacent pages. Search uses untinted regular glass to diffuse moving labels instead of magnifying them through clear glass. The search field and initial content positions respect the safe area; Home has no peer-status strip. There is no bottom dock or reserved dock space; horizontal swipes switch Home, Panel screens, and Settings. Insets come from the current view, not a device model or a fixed notch height.

After changing the launcher layout, run these visual regression checks:

- Home: the search field stays below the status bar, including while scrolling and pulling to refresh. The area around it uses the panel backdrop, with no solid header band or peer-status strip.
- Panel: the first row starts below the cutout, and scrolling continues behind the frosted status area.
- Settings: Spaces is the first section below the status bar, followed by Display and the current Space's settings; the last row can scroll above the home indicator. Home and Settings have no separate title bar. Space switching and adding a Space are in Settings → Spaces.
- Swipe across Home, every Panel screen, and Settings; no bottom navigation obscures the last row. Watch the upper-left edge of Search while swiping and scrolling: no neighboring header glass should cross it or flash.
- Home, Panel and Settings share a continuous background in each theme; Settings keeps readable grouped rows over it.
- Rotate both ways on a notch or Dynamic Island phone: initial content stays clear of the side cutout, and swiping still lands on a full page. Repeat in light and dark appearance.

Checked on 2026-10-13: Xcode 27 Simulator build and portrait screenshots of Home, Panel and Settings on iPhone 18 Pro / iOS 27, using an unreachable local Space to exercise its status card. The Foundation-only suite passed all 60 tests. Gesture, rotation and real-device checks of this change remain pending. The older iOS 18.4 Simulator could not launch this Xcode 27 build because its runtime lacks `libswiftWebKit.dylib`.

## What the platform could offer every client

No server change was made or needed for this version; the app reads `GET /api/apps`, `/api/agents`, `/api/widgets`, `/api/peers`, `/api/panel/layout`, `/api/router`, the icon routes and the routes the panel's own windows read (`/api/inbox`, `/api/tasks`, `/api/model/usage`, `/api/model/calls`, `/api/usage`, `/api/model/apps`, `/api/events`, `/api/capabilities`, `/api/panel/package-catalogue`, `/api/panel/connections`, the agents' chat routes) as they are. Things a phone runs into that are not a phone's business to solve alone:

- **A client session of the Space's own**, with a device list and revocation: today the only login is the access layer's cookie, and the only credential ai-space has is the operator token. This is what would make notifications, a share extension and background refresh possible, and it would serve the Mac client and any other client the same way.
- **Push notifications** as a `notify` transport (APNs), next to the chat channels, with the inbox thread as the payload's target.
- **Links into the panel**: an address that opens the package settings, so a client can hand over to the web panel at the right place. Today that row opens the panel's first screen.
- **A service identity route**: both clients recognise ai-space by the shape of `GET /api/panel/layout`. A small `GET /api/space` with a name and a version would be an honest check and tell a client what the server supports.
- **A layout per device, kept by the Space**: the panel's screens follow the workspace (`PUT /api/panel/layout { screens }`) and are one layout for every browser. The phone copies them once and then keeps its own on the phone, by decision: devices are laid out differently. A named layout per client in the Space would let a phone's layout survive a reinstall.
- **A bitmap variant of the icon routes** would spare each native client an SVG renderer; the phone draws SVG itself for now.

## Phases

1. **This version**: connect, sign in through the web view, native launcher with search, screens of its own and honest states, app pages, the Space's pages (inbox, chat, tasks, usage, app models, events, packages, the terminal), the web panel, `aispace://` links and quick actions.
2. **On a device**: the Xcode build, the checks listed above, then TestFlight for the owner's own phone.
3. **Notifications** once the platform has a client session and a push transport; in chat, the model and permission pickers, attachments and restoring a run that was left running.
4. **Share extension and quick add** (Todo, Notes): needs an app-side contract for "add this", which belongs in each app's manifest, and a session an extension can use.
5. **Widgets and App Intents** on the home screen and in Shortcuts, from the Space's own widgets.

A note for distribution: an app that is mostly web views risks App Store guideline 4.2. The native launcher, search, screens, links and quick actions are the start of an answer; a personal build through TestFlight or direct install does not face that review at all.

### App browser checks

The expanded browser menu and the floating button, resting at the bottom right and against the
left edge with the menu below it, were visually checked on iPhone 16 Pro (iOS 27) against News Radar.
Dragging the button was not: gestures cannot be scripted, so only its placement rules are tested. The iOS tests cover retained WebView identity and form state after reopening, tab switching,
closing and recreating a tab, Space isolation, sign-out/removal cleanup, gesture thresholds, and where the floating button rests and its menu opens.
On a phone, open two apps and use More to switch between their tabs. Return to Space from the menu and reopen
an app, then verify its scroll position and draft text remain. Swipe up to hide the
button and down to reveal it, also inside nested scrolling lists. Drag the button to each edge,
flick it across, and reopen the app to see it where it was left. Check the expanded menu,
landscape, keyboard, VoiceOver, and Reduce Motion. WebKit may reload a page under memory pressure;
retaining a tab does not prevent iOS from reclaiming its web content process.

App-page safe areas use WebKit's observed `underPageBackgroundColor`, derived from the
page's HTML/body backgrounds. They follow CSS theme changes and navigation without changing
`prefers-color-scheme`, injecting JavaScript, or moving content into the system safe areas.
The Space launcher keeps its own theme. Background tests cover light and dark CSS changes,
transparent bodies over an HTML background, and navigation to a differently colored page.

The Home search field dismisses its keyboard on submit, a tap in the catalogue, a scroll,
or leaving Home/opening another page. Dismissing does not clear the query; the Clear button
keeps the field available for continued typing. Check these gestures with both matching
results and an empty result list on a phone.

For a repeatable scrolled layout screenshot, launch a debug build with `AISPACE_SCROLL_Y=500`.

The status-bar safe area uses noninteractive, untinted clear glass on iOS 26 and later, with
an ultra-thin material fallback on older systems. It has no additional background fill.
The bottom dock has been removed; pages remain accessible by horizontal swiping.

The launcher header fades its clear blur through the search region, with no hard horizontal
edge at the status bar. Search uses an untinted regular glass capsule on iOS 26+. The idle search hint is centered; focusing it reveals the editable field, with the
existing query, Clear action, and keyboard-dismissal behavior preserved.
