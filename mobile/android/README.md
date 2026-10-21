# ai-space for Android

A native Android client of a Space that already runs, ported from the iPhone client (`mobile/ios/`, whose README is the specification this follows): a Compose launcher over the Space's own catalogue, the Space's pages drawn natively, a native terminal, and app pages and the web panel in `WebView`. Nothing is installed or started on the server, and the app carries no token or deployment secret.

Status: builds with Gradle, 172 JVM tests pass, and runs on an Android 16 emulator (API 36) against a scratch Space and against a real Space behind Cloudflare Access. See [What was checked](#what-was-checked).

## What it does

The same as the iPhone client, area by area (see `mobile/ios/README.md` → What it does): saved Spaces; Home (the library with one search), this phone's screens copied from the panel once and kept on the phone, Settings, swiped side by side, opening on the first screen, which carries universal search (the Space's resolver, calculations and conversions at once, action forms and runs, asking an agent, and streamed voice input); widget state cards; reach and peer states with the last catalogue and its age; app pages in retained tabs with one draggable More button; the host list that keeps other sites in the browser; the Space's pages (inbox, chat with the agent's work in order, questions to answer and attached images, tasks, model and app usage, app models, events, apps and connections); the terminal; the web panel; `aispace://` links; and the first four apps of the home screen as launcher shortcuts that carry their Space.

Where Android differs:

| Area | Android |
| --- | --- |
| Per-Space session | One `androidx.webkit` profile per saved Space (`ProfileStore`, `WebViewFeature.MULTI_PROFILE`), the counterpart of `WKWebsiteDataStore(forIdentifier:)`. App pages, the panel and the native calls (which read that profile's `CookieManager`) share one sign-in. On a WebView without multi-profile support every Space shares the default profile: signing out of one clears all; this is logged at start. A removed Space's profile is cleared at once and its files deleted at the next launch (WebView refuses to delete a profile it has loaded in this process). |
| Space check | A native `GET /api/panel/layout` with the profile's cookies once the panel page has loaded; `evaluateJavascript` cannot await a promise and the app exposes no JavaScript bridge. |
| Page background | The page's computed `html`/`body` background, read by a small script after load and every 2.5 s (WebView has no `underPageBackgroundColor`), drawn behind the system bars. |
| Downloads | Same-origin, `data:` and `blob:` downloads to the cache and the share sheet through `FileProvider`; a `blob:` URL is read inside the page (its revocation is delayed by a document-start script where WebView supports one). |
| File inputs | The system picker (`createIntent()`): pick a file or photo; taking a new photo from a file input is not offered. |
| Appearance | The app's light/dark choice draws the app; web pages follow the system's `prefers-color-scheme`. |
| Terminal | Termux's terminal emulator and view (Apache-2.0, vendored in `terminal/`, see its README) in place of SwiftTerm, fed by the Space's socket instead of a local process. Links in the terminal are not detected. |
| Language | English and Chinese resources; Android 13+ per-app language through `locales_config.xml`. |

## Layout

```text
mobile/android/
  settings.gradle.kts, build.gradle.kts   Gradle 8.14.3 (wrapper), AGP 8.11, Kotlin 2.0.21, Compose BOM 2024.12.01
  app/src/main/java/dev/aispace/android/
    AppModel.kt          saved Spaces, sessions, what is on show, link routing (AppModel.swift)
    AISpaceApplication.kt, MainActivity.kt, DebugLaunch.kt
    core/                pure Kotlin, no android.*: iOS Core/ and the Mac client's shared Foundation files
                         (Connection, ConnectionStore, SpaceCheck, SpaceApi on OkHttp, models, ChatStream,
                         DesktopRules, NavigationPolicy), HubModels, TerminalModels, widget blocks, screens
    live/                CatalogueLoader, SettingsLoader, IconStore (+ SVG via an offscreen WebView),
                         BackdropStore, the stores of the Space's pages, ChatStore, TerminalStore and
                         TerminalConnection, AppPaths
    web/                 SpaceProfile, WebSession, downloads, the activity host for pickers and permissions
    ui/                  theme/ (presets, backdrop, glass, mark), common/, home/, settings/, hub/,
                         terminal/, shell/ (root, pager, app page, web panel, connect)
    terminal/            vendored Termux emulator and view, RemoteTerminalSession, TerminalSurface
  app/src/test/java/     JVM tests: core/ (ported from AISpaceTests and the Mac tests), live/, web/
```

## Build and run

Needs a JDK 17 and the Android SDK (platform 36, build-tools, and for the emulator `emulator` and an arm64 system image).

```bash
bun run android:test     # JVM unit tests
bun run android:build    # app/build/outputs/apk/debug/app-debug.apk
adb install -r mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

Dependencies resolve through the Huawei Cloud Maven mirror first (`settings.gradle.kts`), with Google and Maven Central behind it: from some networks Google's hosts are very slow. For the SDK itself, `sdkmanager` can use the Tencent mirror (`https://mirrors.cloud.tencent.com/AndroidSDK/`).

A Space on the same Mac is reached from the emulator at `http://10.0.2.2:8700` (or `http://127.0.0.1:8700` after `adb reverse tcp:8700 tcp:8700`); plain HTTP is allowed to loopback only (`res/xml/network_security_config.xml`, `ConnectionRules`).

A debug build reads launch switches from intent extras, so screens can be reached without touching the device (`DebugLaunch.kt` lists them): connect to a Space, pick a page, set the search text, open one of the Space's pages, open an `aispace://` link. Capture with `adb exec-out screencap -p > shot.png`.

## Lessons carried over from the iPhone client

These came from the iOS commits and hold here too: an answer arriving after sign-out or removal is dropped (the loader counts sessions); cookies are read only after the profile is initialized; a redirect, 401 or 403 means sign in and is never followed natively; writes send the Space's `Origin`; icons on another site load without the Space's cookies and their failure is not a sign-in failure; a chart is one path per colour in one Canvas; library pages are lazy; the theme's glows are drawn once per size, not as a live blur (the one blur is the sheet under Settings and the chat: the backdrop drawn again through a RenderEffect on Android 12 and later, an opaque fill before that or with animations off); the pager's position lives apart from the model so a swipe recomposes the pager only; icon updates reach only the views showing that icon; a theme's artwork is cached on disk and shown at once; the app page reaches the bottom edge; the mark stands in for a blank page through an access layer's redirects.

One of Android's own: WebView loads on the main thread and takes seconds the first time. Pruning the web profiles in `AppModel`'s constructor held the first frame back 8 s; it now waits until the first frame is up (`SpaceProfile.schedule` / `warmUp`), and cookie reads wait for it. A release build starts in about a second; a debug build on the emulator still takes about ten.

## What was checked

On the emulator (Pixel 7, API 36), by screenshots from the debug launch switches and `adb input`:

- Against a scratch Space (`SPACE_TERMINAL_ENABLED=1`) with a stand-in app: connecting, the first screen, the library and its search (Chinese too), Settings, every Space page, the web panel (Ready, dock hidden, cookies in the Space's own profile), the terminal (a real shell, colours, typing), the widget card blocks, `aispace://open`, the More menu with its full-screen scrim, links inside an app and out to the browser, retained tabs keeping their draft, dark mode, a theme's artwork from its disk cache, the Chinese locale.
- Against a scratch Space in dark and light mode with Orbit and Northern Lights: Settings in the panel's sections on the translucent sheet, the blur staying put while the page is swiped; the agent chat on the sheet with its head, a turn sent and streamed, its two calls left unfolded when it ended, the same session reopened from History with the calls folded, opened, and one call's input and output.
- Against a real Space behind Cloudflare Access: signing in through Access in the web panel; the catalogue, icons and widget cards over native calls with the profile's cookie; the same after a force-stop (the cookie survives the process); an app on another subdomain opening signed in; the terminal socket through Access to a peer's shell; the chat agents, their earlier chats and a long Markdown answer; swiping between screens, a long press on an app, landscape.

Not checked yet: a question or approval card in a live turn; the sheet before Android 12; signing out and in again; dragging the More button; TalkBack; downloads and file inputs; Google as an identity provider inside WebView (refused in an embedded view on iOS); a phone without WebView's multi-profile feature.

### Async regression checks

JVM tests cover response-body reads staying off the caller thread and cancellation closing an
in-flight call; settings refreshes and saves arriving after sign-out; history selections racing
with a new chat; clearing local chat data and subscriptions; and resuming a chat after a temporary
503 without submitting its message again. Reconnects use the last event ID with up to five attempts
and exponential backoff; authentication failures require signing in again. Sending is disabled
while the selected history loads. Signing out clears the phone's conversations and drafts but does
not stop an agent run already executing on the Space. These checks do not replace device testing
of the sign-out and sign-in UI or WebView cookie clearing.
