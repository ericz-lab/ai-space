# ai-space for iPhone

A native iOS client of a Space that already runs: a SwiftUI launcher over the Space's own catalogue, with the Space's pages in `WKWebView`. Nothing is installed or started on the server, and the app carries no token or deployment secret.

Status: phase 1, built and exercised on a Mac as a Mac Catalyst app. **It has not been built for the iOS Simulator or a device yet**: the machine it was written on has the Command Line Tools only, which ship no iOS SDK and no Simulator. See [What has been checked](#what-has-been-checked).

## What it does

| Area | In this version |
| --- | --- |
| Spaces | Add a Space by the address of its panel, several if you have them, switch between them. HTTPS everywhere; plain HTTP only to loopback (a Space on the Mac that runs the Simulator). |
| Home | Favorites, apps, agents and widgets from the Space's catalogue, keyed by the panel's own entry keys (`app:<id>`, `agent:<id>`, `widget:<id>`), titles in English or Chinese as the manifests provide, icons from the Space (emoji, bitmap or SVG). |
| Search | One search over the three kinds: every word must appear in the title, description or id, in any of the entry's languages, so `todo` and `待办` find the same app. |
| Favorites | Kept on the phone per Space, seeded once from the panel's home screen. Star an app from its page, or long-press a tile. |
| Reachability | A dot per app from the Space's health probe (running, not answering), paused apps, and peers named as offline with the time of their last snapshot; their tiles are dimmed and say so. While the Space itself cannot be reached, the last catalogue stays on show, marked with its age, and the health dots are withdrawn. |
| App pages | An app opens in a web view with the Space's session: back, forward, reload, share, open in Safari, swipe navigation, file and photo inputs, downloads to the share sheet, JavaScript dialogs titled with their origin. |
| Other sites | Only the Space's hostnames load in the app (below). A link tapped to anywhere else, and a link app whose page is on another site, opens in Safari. |
| Panel | The Space's web panel in a tab: chat with agents, inbox, tasks, settings, terminal. These are not rebuilt natively in this version; agents on Home open this tab. |
| Links in | `aispace://open?app=<id or name>`, `aispace://inbox`, `aispace://chat`, `aispace://show`, the same links as the Mac client. A link only shows something; it never sends a message or changes the Space. |
| Quick actions | The first four favourite apps appear on the app icon's long-press menu and open through the same links. |

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
                         rule, favourites, the catalogue cache, quick actions
    Live/                CatalogueLoader (the Space's routes), IconStore (icons, SVG drawing), paths
    Web/                 WebSession (WKWebView and its delegates), WebContainer
    Views/               Home, tiles and widget cards, app page, panel, settings, connect, theme
    Resources/           the mark, the app icon, English and Chinese strings
  AISpaceTests/          swift-testing tests of Core/
  scripts/               test.sh, build.sh (swiftc only), icons.swift, sources.sh
```

Eight Foundation-only files are compiled from the Mac client where they are, not copied: `Connection`, `ConnectionStore`, `SpaceCheck`, `SpaceAPI` (with its cookie rules), `SpaceModels`, `ChatStream`, `DesktopRules` (the `aispace://` links) and `NavigationPolicy`. `scripts/sources.sh` and `project.yml` list them. The phone adds its own rules on top (a host list instead of one origin) rather than changing them. If both clients are kept, the natural next step is to move those files to a neutral directory (`clients/shared/`) in one commit that touches both projects; that was left out here so the Mac branch stays untouched.

The visual identity is the panel's: the mark is drawn from `src/web/public/favicon.svg` (`scripts/icons.swift`), and `Views/Theme.swift` carries the default "Aurora" tokens of `src/web/styles.css` (ground, the three glows, accent, radii, glass with a hairline).

## Build and run

### With the Command Line Tools only

```bash
bun run ios:test     # build and run AISpaceTests on the Mac
bun run ios:build    # mobile/ios/build/AISpace.app, a Mac Catalyst build, ad-hoc signed
open mobile/ios/build/AISpace.app
```

The Catalyst build is the same Swift, UIKit, SwiftUI and WebKit code as the iPhone build, compiled against the iOS frameworks that the macOS SDK carries, in a phone-sized window. It is how the screens below were checked. It is not a product: it drops the `aispace://` registration so it cannot take the Mac client's links.

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

These commands have not been run: `xcodebuild` and `simctl` do not exist on the machine this was written on. Expect small fixes on the first Xcode build (the asset catalog and the test host are the parts only Xcode compiles). A Space on the same Mac is reachable from the Simulator at `http://127.0.0.1:8700`.

A debug build reads launch switches from its environment, so screens can be reached and captured without touching the device (`SIMCTL_CHILD_AISPACE_TAB=panel xcrun simctl launch …`, or `open --env` for the Catalyst build). `AISpace/DebugLaunch.swift` lists them: connect to a Space, pick a tab, set the search text, open an `aispace://` link, write a PNG of the window and quit. None of it exists in a release build.

## Authentication

What the real access path is (docs/ingress.md, docs/router.md, docs/cloudflare.md, docs/panel.md#trust-boundary, `src/space/auth.ts`):

- ai-space binds loopback. The outside reaches it through a Cloudflare Tunnel, and **Cloudflare Access is the login**: one Access application on the panel's hostname and one on `*.<domain>` for the apps, each with a 24 hour session, allowing the owner's e-mail.
- The panel's routes carry no token. They trust whoever passed the access layer, and refuse a write only when it comes from another site's page (`guardBrowserWrites`). The operator token (`SPACE_API_TOKEN`) is for machine-side routes and must never be in a client. There is no mobile login, refresh or per-device revocation in ai-space itself.

What the app does about it:

- **Each saved Space has its own WebKit data store** (`WKWebsiteDataStore(forIdentifier:)`), apart from Safari and from every other Space. The panel tab, every app page and the native catalogue calls use it: the native calls read the store's cookies for each request (`SpaceAPI`), so one sign-in in the web view serves all three. Nothing is copied out of Safari.
- **Sign-in happens in the web view.** A request that is redirected, or answered 401 or 403, means "sign in": Home shows a card, the Sign In button opens the panel tab, the access layer's pages load there (a bar names the host you are on), and when the panel is back and answers `GET /api/panel/layout` as ai-space does, the catalogue loads and Home returns. An app on its own hostname goes through the same redirect inside its page; with Access the team-domain cookie makes that silent.
- **`ASWebAuthenticationSession` is deliberately not used.** It shares cookies with Safari, not with the app's web views, so a sign-in there would not reach the pages the app shows. Access has no token exchange a native client could use instead without a service token, which would be a long-lived secret on the phone.
- **Nothing secret is stored by the app.** The session cookie lives in the Space's WebKit store inside the app's sandbox; saved Spaces and favourites are plain files with addresses and entry keys. There is nothing for the Keychain to hold in this version.
- **Sign Out** (Settings) clears that Space's website data (cookies, storage, caches), the saved catalogue and the open pages. Removing a Space also deletes its data store.
- **Expiry** shows as the same sign-in card, with the last catalogue still on show; the app never retries a write on its own.

Confirmed on this machine against a stand-in access layer (redirect to a login on another origin, a callback that sets a cookie): the sign-in-needed state, the redirect staying in the view, the native calls succeeding with the web view's cookie right after, sign-out returning to sign-in-needed.

To confirm on a real iPhone, in this order:

1. The Access login completes inside `WKWebView`. One-time PIN by e-mail should; **Google as identity provider refuses embedded web views** (`disallowed_useragent`), and then the choice is another login method on the Access policy or a platform-side client session (below).
2. The `CF_Authorization` cookie is readable from the store by the native calls (it is `HttpOnly`, which the cookie store API does return).
3. An app on `*.<domain>` opens without a second prompt.
4. The panel's chat stream (SSE) and terminal (WebSocket) hold through the tunnel on cellular, and what happens to them when the app is backgrounded.
5. The 24 hour session: a daily sign-in on a phone is tiresome. Access's session length is the owner's setting, not the app's.

## The host list

`Core/SpaceHosts.swift` decides what loads in the app: the panel's origin, the page origin of every app that runs a service on the Space or on a peer, and, when the Space routes hostnames itself (`GET /api/router` names its domain), every HTTPS host under that domain. `MobileNavigation` applies the Mac client's `NavigationPolicy` with that list:

- a page on the list loads; a new window for one loads in the same view;
- a link tapped on a Space page to any other site goes to Safari, and so does a link app's page (documentation, a repository elsewhere), where your own logins for that site are;
- a redirect off the list that nobody tapped stays in the view: that is the access layer's sign-in, and it has to finish in the Space's session;
- other schemes (`mailto:`, `tel:`) leave only on a tap; frames are left alone.

Camera and microphone prompts are offered to pages on the list only. Web content has no bridge and no script message handler.

## What has been checked

On macOS 27, Command Line Tools 27.0, Swift 6.4 (language mode 5), against a scratch Space run from source with a scratch workspace, a second scratch Space as its peer and three stand-in apps:

- `scripts/test.sh`: 27 tests in 6 suites pass (catalogue decoding and tolerance, reach states, languages, search, host list, navigation rule, favourites, cache, quick actions).
- `scripts/build.sh`: debug and release Catalyst builds, no warnings.
- Run as a Catalyst app, with window captures read back: first launch; Home with favourites seeded from the panel's home screen, apps, agents, a widget, health dots, an SVG avatar; Chinese titles and Chinese search; an app page; the panel tab; settings in Chinese; sign-in needed, signing in, signed in, signed out; an address that is not ai-space; an unreachable Space with and without a last catalogue; a peer going offline.
- By log, with scripted clicks in the page: a link inside the app stays and enables Back; a link and a new window to another site are handed to the browser; a new window to another app of the Space loads in the view; a script redirect off the Space is treated as a sign-in; `aispace://open` finds an app by id and by bare name, and sends a link app to the browser.

Not checked, because it needs the iOS SDK, a Simulator or a device: the `xcodebuild` build and the tests under Xcode, the asset-catalog app icon, safe areas and the tab bar on a real iPhone layout, the software keyboard over a page, the photo picker and camera for file inputs, downloads into the share sheet, home-screen quick actions, `aispace://` from another app, memory-pressure reloads, VoiceOver and Dynamic Type, and everything listed under Authentication.

## What the platform could offer every client

No server change was made or needed for this version; the app reads `GET /api/apps`, `/api/agents`, `/api/widgets`, `/api/peers`, `/api/panel/layout`, `/api/router` and the icon routes as they are. Things a phone runs into that are not a phone's business to solve alone:

- **A client session of the Space's own**, with a device list and revocation: today the only login is the access layer's cookie, and the only credential ai-space has is the operator token. This is what would make notifications, a share extension and background refresh possible, and it would serve the Mac client and any other client the same way.
- **Push notifications** as a `notify` transport (APNs), next to the chat channels, with the inbox thread as the payload's target.
- **Links into the panel**: an address that opens an agent's chat or an inbox thread (`/?chat=<app>/<agent>`), so a client can hand over to the web panel at the right place. Today agents on Home can only open the panel's first screen.
- **A service identity route**: both clients recognise ai-space by the shape of `GET /api/panel/layout`. A small `GET /api/space` with a name and a version would be an honest check and tell a client what the server supports.
- **Favourites that follow the workspace**: the panel's screens already do (`PUT /api/panel/layout { screens }`). The phone seeds from the home screen once and then keeps its own list; writing back is a product decision, not a missing route.
- **A bitmap variant of the icon routes** would spare each native client an SVG renderer; the phone draws SVG itself for now.

## Phases

1. **This version**: connect, sign in through the web view, native launcher with search, favourites and honest states, app pages, the web panel, `aispace://` links and quick actions.
2. **On a device**: the Xcode build, the checks listed above, then TestFlight for the owner's own phone.
3. **Native inbox and chat**, reusing the Mac client's `SpaceAPI`, stream parser and inbox rules, which are already compiled into the app; notifications once the platform has a client session and a push transport.
4. **Share extension and quick add** (Todo, Notes): needs an app-side contract for "add this", which belongs in each app's manifest, and a session an extension can use.
5. **Widgets and App Intents** on the home screen and in Shortcuts, from the Space's own widgets.

A note for distribution: an app that is mostly web views risks App Store guideline 4.2. The native launcher, search, favourites, links and quick actions are the start of an answer; a personal build through TestFlight or direct install does not face that review at all.
