# Native macOS desktop proposal

Status: in progress in `desktop/macos/` (see [Native-first client](#native-first-client) and [Build and run](#build-and-run)). Hub and Peer configuration remains a proposal. The app is a client only: it never bundles, starts or updates a Space (a Local edition that did was built and retired on 2026-11-24).

Build a Mac application with SwiftUI and AppKit for the desktop interface, WKWebView for the existing React panel, and the existing Bun service for all Space operations. The app is a client of an already running Space, on this Mac or elsewhere.

The motivation is a persistent Mac entry point with native window behavior, workspace selection and desktop integration, while keeping browser access and server deployments working. The first release has a native shell and web content. A fully native SwiftUI panel is a separate, optional later project.

## Product scope

Proposed initial target: macOS 14 or later, Apple Silicon, distributed directly as a signed and notarized application. Validate on the oldest supported macOS and the current release. Intel support can follow a tested build; it is not promised by the initial release.

| Area | First desktop release | Later |
| --- | --- | --- |
| Connections | Existing local Space; remote HTTPS Hub with its existing peers after access validation | None |
| Hub and Peer configuration | Native saved Hub connections; existing Peer topology and status | Add, test, edit, remove and rotate Peer connections through new operator APIs |
| Native interface | Main window, menu commands, connection settings, status and reconnect screen | Menu bar status, global shortcut, notifications |
| Space interface | Existing launcher, agents, chat, tasks, inbox, settings and terminal | Selected SwiftUI screens if usability justifies them |
| Apps | Open app links in the default browser | Isolated in-app windows for selected apps |
| Backend | Use the operator's existing installation | None: the app carries no service |
| Updates | Manual replacement of the signed desktop app | None for the service, which updates itself |

The first release does not install agent CLIs, change service supervision, migrate an existing workspace, or change a server's configuration. (Since then the desktop app offers, at first launch on a Mac without an AI Space, to run AI Space's own installer: [Connections and first launch](#connections-and-first-launch).) Remote-only use must work without Bun or a local Space installation. Remote Hub and Peer configuration is an explicit follow-on milestone in this proposal.

## Architecture and ownership

```text
ai-space.app
  SwiftUI and AppKit
    window, connection picker, settings, connection status
  WKWebView
    existing React panel served by the selected Space
         |
         | HTTP, SSE and WebSocket using the page's own origin
         v
  Existing local Bun service OR remote HTTPS Space
    API, agents, scheduler, storage, apps, peers, terminal
```

| Component | Responsibility |
| --- | --- |
| Native shell | Window lifecycle, selected connection, desktop permissions and narrowly scoped native actions |
| React panel | Current Space workflows, application state and existing API clients |
| Bun service | Workspace data, agent processes, scheduled work, app supervision and authorization |

Keep business operations in Space. The desktop app must not write `space.db`, interpret app manifests independently, implement another scheduler, or read remote files as local paths.

Load the panel's actual HTTP or HTTPS URL in WKWebView. Do not initially package a second frontend under `file://` or a custom scheme: the existing relative requests, streaming connections and origin checks already align with the server-served page. The server therefore supplies the matching frontend version.

Apple's [WKWebView](https://developer.apple.com/documentation/webkit/wkwebview) is the embedded web content component. Wrap it in SwiftUI and use AppKit where window and menu behavior requires it. Bun remains an independent runtime; SwiftUI does not replace its service implementation.

## Connections and first launch

A connection stores a stable client identifier, display name and panel URL. Desktop preferences belong under the application's own Application Support directory, separate from the Space workspace.

**First launch** (the desktop app carries no service). With no saved Space the welcome view shows two entries and takes neither by itself (`Services/FirstLaunch.swift`, `Views/FirstLaunchView.swift`):

- **Connect to Local AI Space** (primary): the AI Space on this Mac. Under it one line says what the click will do, from a look the app makes at launch: "Found on this Mac", or "Not on this Mac yet: it is downloaded and installed first". The look saves nothing.
- **Connect to a Remote AI Space…** (secondary) is the address form below.

Looking for the AI Space on this Mac (`Services/LocalSpace.swift`):

1. The candidate ports are `SPACE_PORT` from the workspace's `.env` (`$SPACE_HOME/.env`, else `~/.ai-space/.env`) when that file can be read, then 8700, the default in `src/space/config.ts`.
2. Each gets `GET http://127.0.0.1:<port>/api/space` with a 2-second timeout. A reachable port alone is not proof that the service is ai-space: only an answer whose JSON has `product: "ai-space"` counts (`SpaceCheck.isSpace`).

A click on **Connect to Local AI Space** looks again. **Found:** the Space is saved as "This Mac", selected, and the window opens on it. **Not found:** the app installs it first and then connects, showing only "Installing AI Space…" and one progress bar:

- It runs the release's own one-command installer ([release.md](release.md#one-command-install)), never a copy inside the app (`Services/SpaceInstaller.swift`). The app downloads `https://github.com/ericz-lab/ai-space/releases/latest/download/install.sh` to a temporary file (`<AI_SPACE_DOWNLOAD>/install.sh` when that variable is set, which the installer honours too: mirrors and tests use it) and runs `/bin/bash <file>` with `AI_SPACE_NO_OPEN=1` and `/usr/bin:/bin:/usr/sbin:/sbin` at the front of `PATH`, since a GUI app's `PATH` is bare and the script needs curl, tar and launchctl.
- The bar follows the lines the installer prints at each step (`InstallProgress`, [editions.md](editions.md#the-install-progress-bar)); the lines themselves are not shown.
- On exit code 0 the app looks again, once a second for up to 30 seconds, then saves and selects the Space. On any other exit code it shows one line of why, Retry, and the installer's last lines folded under Details; when the installer went through but nothing answers yet, Retry only looks again. A Space that has come up meanwhile is used as it is rather than installed over.

Removing every saved Space later shows the two entries again without adding one back.

What the app installs this way is the standard AI Space, the same as the command in a terminal gives: a LaunchAgent `ai.space.server` of the user's own, on `127.0.0.1:8700`, with the workspace `~/.ai-space`. The desktop app never bundles, upgrades, stops or uninstalls it, and removing the app leaves AI Space in place (`space uninstall` removes it; running the one-command installer again upgrades it).

A Space on this Mac can also be added by hand: the form suggests `http://127.0.0.1:8700` and lets the operator change it. A missing service leads to retry and setup guidance, not an automatic second backend.

For remote use, require HTTPS and keep the existing tunnel and access layer. The desktop connection picker switches complete Space panels. On the launcher it is the toolbar button with the status dot and the Space's name; it opens an AppKit menu with a checkmark on the Space on screen, not a SwiftUI `Menu`, whose toolbar label a build with the macOS 26 SDK draws as a bare chevron on macOS 27. Existing hub and peer aggregation stays inside each server; the client does not recreate the peer catalogue or claim that a hub can manage every peer setting. See [peers.md](peers.md).

Connection states are connecting, ready, authentication required, unreachable and incompatible. Failures retain the chosen connection and show a useful retry action. Switching connections never stops agents or services on the previous machine. Warn about unsent page drafts before destroying the previous view; reconnecting does not automatically resend an agent prompt.

## Remote Hub and Peer configuration

A Hub is an ordinary Space configured to consume other Spaces as peers. The same Space may also expose its own local resources to another Hub. These are connection directions, not exclusive machine roles. Preserve the existing one-level aggregation: a Hub imports a peer's local resources, not that peer's peers.

The recommended topology for an always-on workspace is:

```text
Mac desktop client
  -> remote Hub (for example, the Seoul Space)
       -> Hub's own apps, agents and tasks
       -> Peer A's local apps and agents
       -> Peer B's local apps and agents

Optional: a local Mac Space can act as another Hub or a reachable Peer.
```

Saving a remote Hub in the Mac client does not register the Mac as its Peer. Connecting to a Hub requires no local Bun service. Making a local Mac Space a Peer requires an explicit reachable endpoint, authentication and its own backend; it will appear offline while the Mac sleeps or is unreachable. Never advertise `127.0.0.1` as the Mac's address to a remote Hub.

### Settings and configuration ownership

Use native Settings for saved desktop connections. Each connection has a label, panel URL and default-selection flag. Removing it changes only this Mac. Within the selected Hub, provide a shared web Settings page for Peer configuration so browser and desktop operators use the same control plane.

The Peer page shows the target Hub prominently, then each peer's name, URL, health, last successful snapshot, resource counts and credential-configured indicators. Separate actions are Test Connection, Add Peer, Edit Peer, Replace Credential, Remove Peer and Open Peer Panel. Opening a peer's own panel requires that panel's normal login; a Hub token is not a browser login credential.

| Configuration | Stored by | Consumer |
| --- | --- | --- |
| Saved Hub label and panel URL | Desktop preferences | Mac connection picker |
| Panel access session | Connection-specific WebKit data store | Panel browser requests |
| Optional operator credential for configuration | Mac Keychain, or an explicitly authenticated web operator session | Restricted configuration API |
| Peer URL, token and access headers | Selected Hub's protected server configuration | Hub-to-Peer requests |
| Inbound Peer token, currently `SPACE_HUB_TOKEN` | Peer server's protected configuration | Its `/api/peer/*` routes |

### Add and change a Peer

1. Select the destination Hub. Establish operator authorization separately from ordinary panel access.
2. Enter a stable peer name and HTTPS Space base URL, plus the peer's inbound token and optional access-layer service credentials. Existing installations use `SPACE_PEER_<NAME>`, `_TOKEN` and `_HEADERS` on the Hub, and `SPACE_HUB_TOKEN` on the peer.
3. Run the connection test on the Hub itself, using `/api/peer/snapshot`. A request from the Mac cannot prove that the Hub can reach the peer. Report network, TLS, access-layer, invalid-token and incompatible-response failures distinctly, without echoing credentials.
4. Show the resolved peer identity and resource counts before saving. Validate names against existing peer and local app names. Make clear which Hub will change and what remote access the stored token grants.
5. Save atomically with a configuration revision check, apply the connection without restarting unrelated work, fetch the first snapshot, and report saved and active status separately. A failed validation must leave the prior configuration intact.

Edits reuse stored credentials when fields are omitted; replacing or clearing a credential must be explicit. Reads expose only configured indicators. Removing a Peer disconnects it from this Hub and clears its active view; it does not uninstall remote apps or delete their data. Last known resource state remains visibly stale while a configured peer is down.

Treat inbound token rotation separately from updating one Hub's stored copy. Today's single `SPACE_HUB_TOKEN` can be used by multiple Hubs, so rotating it affects every consumer. A future overlapping-key or per-Hub credential design needs its own backend contract; until then, document and coordinate the interruption instead of claiming seamless rotation.

### Required platform work

The current `src/space/peers/api.ts` exposes Peer status and resource forwarding, not Peer configuration CRUD. Add an operator-only API for redacted configuration reads, connection tests, versioned saves and deletes. Proposed paths may live under `/api/peer-config`; finalize the schema with backend implementation rather than presenting these paths as existing routes.

Keep one authoritative server configuration source. Initially preserve the existing `.env` representation through a parser and serializer that retain unrelated settings, restrict file permissions, escape values and never log secrets. If process-level environment overrides make an entry externally managed, show it as read-only rather than saving an ineffective change. Do not create a second competing Peer list in desktop preferences or SQLite.

Add explicit Hub reconciliation for create, edit and removal, including connection replacement, polling cleanup, snapshot state and in-flight requests. New calls use the committed revision; existing streams should drain under a documented policy. If an older server cannot apply configuration safely, display upgrade guidance and read-only status instead of restarting it implicitly.

The native client may call the narrow operator API with credentials from Keychain. It must not expose a generic authenticated-request bridge to web content. A browser implementation needs an explicit operator authorization flow; ordinary same-origin panel access alone must not reveal credentials or authorize their replacement. Native and web clients must use the same validation and server-side configuration service.

Connection tests can reach networks accessible from the Hub, so restrict them to authenticated operators, supported schemes and the snapshot path. Reject credential-bearing URLs, prevent credentials from following redirects to another origin, bound timeouts and response size, and redact access-layer errors. This is an administrative network operation, not a public URL fetcher.

Peer tokens and access headers stay on the selected Hub. Credential fields use protected entry and are cleared after submission; they must not appear in page storage, connection exports, logs or task records. Validate the exact capabilities the installed server supports; Hub aggregation does not imply remote task, backup or settings administration.

## Authentication and the web boundary

The current panel uses same-origin browser writes and the deployment's access layer; operator APIs use separate bearer authentication. A desktop wrapper does not turn `SPACE_API_TOKEN` into a panel login. Preserve the contracts in [panel.md](panel.md#trust-boundary), [terminal.md](terminal.md#trust-boundary) and `src/space/auth.ts`.

Validate the actual remote authentication flow in WKWebView before including it in the supported release. A login in the default browser does not automatically create a WebKit session. If the access provider rejects embedded login, remote desktop support needs an explicit provider-supported callback or session exchange. Keep Open in Browser as the fallback; do not disable the access layer or copy browser cookies.

The first client should not need to store an operator token. The later Hub and Peer configuration milestone requires separate operator authorization; native credentials belong in Keychain and must remain scoped to their exact service. An Authorization header on the initial navigation does not authenticate all subsequent page requests or WebSockets.

Retain HTTPS validation. Permit plain HTTP only for explicitly validated loopback destinations. Scope any necessary application transport exception narrowly and test redirects. Store web sessions separately from Safari and plan per-connection website data isolation; validate available WebKit data-store APIs against the minimum OS. Removing a connection must offer removal of its saved session.

Keep ordinary app links and arbitrary external sites in the default browser. Authentication redirects may use a controlled web flow with no native privileges. A page at another origin, an iframe widget and a popup must never inherit a privileged desktop bridge.

## Native integration

Start with native window and menu actions that require no web bridge: show the main window, manage connections, reload, open the current panel in a browser, and open desktop settings.

Only add a bridge for a concrete feature. Apple's [WKScriptMessageHandler](https://developer.apple.com/documentation/webkit/wkscriptmessagehandler) supports web-to-native messages; use a versioned, typed message contract rather than arbitrary JavaScript or shell commands. Check the sending frame, its exact security origin, the current connection and the allowed action on every request. Detach handlers when views are replaced.

Later examples include a user-initiated folder picker, revealing an approved local path and asking for native notification permission. A picked Mac path is meaningful only to a local workspace; remote file access requires the existing upload or remote workflow. No generic read-file, run-command, fetch-with-credentials or execute-script bridge is planned.

Voice input in a page (`getUserMedia`) needs three things the client declares: `NSMicrophoneUsageDescription` in `Info.plist`, the `com.apple.security.device.audio-input` entitlement (`AISpace/AISpace.entitlements`; the hardened runtime refuses the microphone without it, silently), and the web view's media capture decision (`MediaCapturePolicy`): the microphone for a page and frame of the session's own origin or the connection's, nothing for other sites, never the camera. macOS asks the operator once for the app (System Settings › Privacy & Security › Microphone). An ad-hoc signed build gets a new identity on each build, so macOS may ask again after a rebuild.

Keep web functionality usable without the bridge through feature detection. Reuse web English and Chinese translations; add native strings in a String Catalog. Native date displays and future scheduling controls must follow [time.md](time.md), including explicit display zones and the existing API's declared timestamp format.

## Window and background behavior

| User action or event | Expected behavior |
| --- | --- |
| Close the main window | Hide the window; retain its view while the desktop process remains alive |
| Reopen from the Dock | Restore the existing window |
| Quit the desktop app | Exit the UI; existing independent Space services and runs continue |
| Connection loss | Show reconnect state; preserve server run identity and never silently resubmit work |
| Web content process crash | Recreate the view and reconnect to existing server state |
| Mac sleep or network change | Reconnect on wake; execution and missed schedules remain the backend's responsibility |
| Logout or shutdown | Local user services cannot be promised to keep running |

Quitting the UI and stopping Space are distinct operations. The app has no Stop Space action.

Desktop presence does not make a laptop an always-on server. Do not prevent sleep by default or promise execution during sleep. Work that must continue independently of the Mac belongs on a server. Reopening the UI must reuse the existing background-run recovery behavior rather than treating an interrupted stream as a new task.

## Packaging and upgrades

Use Xcode and Apple's native build tools for the desktop target while retaining Bun for the existing platform. This proposal requires an explicit addition of a native toolchain when implementation begins; it does not replace the repository's TypeScript tooling or authorize a runtime migration.

Distribute directly with Developer ID signing, Hardened Runtime and notarization, following [Apple's distribution guidance](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution). The initial design targets distribution outside the Mac App Store and does not assume App Sandbox compatibility with arbitrary agent subprocesses and workspace access.

Validate signing and the minimum necessary entitlements on the signed build. A successful debug launch is not the release acceptance test.

The app uses manual updates and never updates a connected service, including one installed from its first launch.

Uninstalling the desktop UI preserves workspace data and leaves any Space on this Mac running. Deleting apps, databases or credentials is a separate, explicit operation.

## Implementation sequence

| Stage | Deliverable | Completion gate |
| --- | --- | --- |
| 0 — WebKit prototype | A minimal native window loading an existing Space | Local panel, Chinese input, chat streaming, terminal, uploads and theme work on supported macOS versions; remote access flow is classified as supported or blocked |
| 1 — Desktop client | Native connection settings, lifecycle, navigation policy, errors and signed distribution | A clean Mac can connect to an existing Space; remote-only use needs no Bun; quitting leaves server work intact |
| 1b — Hub and Peer configuration | Shared Peer settings, operator API, Hub-side connection tests and live reconciliation | Adding, editing and removing a Peer changes only the selected Hub; credentials remain redacted; stale data and failed changes are handled correctly |
| 2 — Desktop conveniences | Menu bar entry, optional shortcut and notification integration | Features remain optional; denied permissions and reconnects work; notifications do not duplicate the web or chat channels |
| 3 — Selected native screens | SwiftUI replacements chosen from observed usability problems | Native and web clients share API behavior; accessibility improves without duplicating business logic |

Stage 0 is a decision gate. If WKWebView cannot support a required terminal, authentication or rendering workflow acceptably, resolve that gap or narrow the supported release before building more native UI. No resource-usage or schedule estimate is promised before this prototype is measured.

## Proposed code organization

Keep the desktop client in this repository so bridge changes and compatibility tests can evolve together. It lives in `desktop/macos/`:

```text
desktop/macos/
  project.yml            XcodeGen spec; AISpace.xcodeproj is generated from it (git-ignored)
  AISpace/
    AISpaceApp.swift     app, main window (close hides it), menu bar, menus, Services, aispace:// links
    AppModel.swift       connections, catalogue, screens, web sessions, conversations, link routing
    Services/            Foundation only: connection rules and store, SpaceCheck, the first launch
                         (LocalSpace, SpaceInstaller, FirstLaunch), SpaceAPI and cookies, the run
                         stream parser and reply builder, inbox and link rules, FnHoldRules and
                         HoldKey (a held modifier key), DictationRules (where a transcript goes)
    Desktop/             SpaceLive (polled data), ChatController, QuickChat, AppWindows (moved-out tabs),
                         IconStore, Notifier, HotKey, Preferences, Dictation with FnKey (one per held key:
                         fn, right ⌥), LiveVoice and DictationOverlay (voice input and spoken notes in any app)
    Web/                 PanelSession (WKWebView and its delegates), NavigationPolicy, the cookie
                         session, the theme's drawn backdrop
    Views/               launcher, tiles, Settings page, the Space's pages, terminal, chat, menu bar,
                         status screens, theme tokens, settings window
    Resources/           icon, mark, English and Chinese strings
  AISpaceTests/          swift-testing tests of the Foundation-only code in Services/ and Web/ and
                         of the iPhone client's shared Core files
  scripts/               build.sh and test.sh (swiftc only), sources.sh (the shared iPhone files),
                         fetch-deps.sh (SwiftTerm for the Xcode project), icons.swift
```

Add `src/web/desktop.ts` only when a real bridge consumer exists. Add reproducible desktop build and test entry points to `package.json` that invoke Apple tools on macOS; existing Bun commands continue to work without Xcode on servers.

Open an implementation issue or state the motivation in the PR description before starting the native feature. Split the client and the bridge into independently reviewable changes.

## Validation and acceptance

The desktop release matrix covers these workflows on a signed build:

- Existing local Space, remote Space, missing local installation, expired remote login, wrong URL and occupied port.
- Chat SSE recovery with no duplicated prompt; large responses, Chinese IME, attachments and interrupted connections.
- Terminal WebSocket connection, resize, copy and paste, reconnect, and the server's existing session cleanup rules.
- App links, downloads, file inputs, authentication redirects and popups; untrusted content cannot call native actions.
- Window close, Dock reopen, UI quit, web process crash, sleep and wake, server restart and connection switching with drafts.
- Multiple saved Hubs, Hub-side Peer discovery, duplicate names, bad tokens, access-layer failures, stale snapshots, configuration revision conflicts and externally managed environment overrides.
- Peer removal without remote data deletion; credential replacement without disclosure; token rotation's effect on all consuming Hubs; a sleeping Mac Peer while the remote Hub continues operating.
- Keyboard navigation, VoiceOver, text scaling, light and dark appearance, English and Chinese.

Use swift-testing (which runs from the Command Line Tools as well as Xcode) for meaningful native policy and lifecycle tests and Bun tests for changed Space behavior. Run the repository's full required validation before each implementation push.

Measure cold launch to usable panel, idle memory across the app and WebKit processes, and behavior under a long chat and terminal session. Record the machine, OS and whether the independent Bun service is included. Compare against the same workload in Safari; native packaging alone is not evidence of lower resource use.

The first release is complete when an operator can reliably open an existing Space as a Mac application, perform the current web workflows, and close or quit the UI without disrupting server work. The first-launch offer added later runs AI Space's own installer and manages nothing afterwards.

## Build and run

The client builds with `swiftc` alone, so the Command Line Tools are enough; Xcode is optional. Run from the repository root on macOS 14 or later:

```bash
bun run desktop:test     # build and run AISpaceTests
bun run desktop:build    # desktop/macos/build/AISpace.app, ad-hoc signed
open desktop/macos/build/AISpace.app
CONFIG=debug bun run desktop:build                       # Web Inspector on, state changes logged
SIGN_IDENTITY="Developer ID Application: …" bun run desktop:build   # then notarize
bun run desktop:xcode    # generate AISpace.xcodeproj (git-ignored): after a clone, after adding or moving files
```

These commands are not part of `bun run check`; servers and Linux never need them. The macOS 27 Command Line Tools declare SwiftUI's `@State` as a macro whose plugin only Xcode ships, so view state lives in small `ObservableObject`s, and native strings use `.strings` tables because compiling a String Catalog needs Xcode.

## Native-first client

The first build was a panel in a window: a browser that could only open ai-space. The operator's direction (2026-10-08) is that the desktop app must not be another browser, so the native layer now carries what a browser cannot, and pulls forward items this document had placed in stages 2 and 3:

| Native | What it does | Space routes it uses |
| --- | --- | --- |
| Main window | The iPhone client's layout (mobile/ios/README.md): pages side by side, moved through with a sideways trackpad swipe, the page dots in the toolbar or ⌥⌘← and ⌥⌘→. Home is the library of every app, agent and widget (the pointer over a library tile shows its state, peer and description; a screen's tiles show none) under the command box ([panel.md#omnibox](panel.md#omnibox)), which the first screen, where the window opens, carries too (⌘F focuses it there; while it holds a query that page shows the matches instead of the screen): what is typed filters the library, best names first (`OmniboxRules.swift`, the web panel's rules); when the Space reads the text as a shortcut it can run (`POST /api/shortcuts/resolve`: arithmetic, a conversion, an action named at its start such as `待办 明天下午3点 写周报`), that comes first and Return opens the panel's Shortcuts page on it with its form filled from the text (`/?page=shortcuts&run=<text>`, `Services/ShortcutOffer.swift`); otherwise Return opens the best match when its name holds the whole query and else asks Space Assistant in a new native conversation, ⌘Return always asks, and a question asked while the assistant still answers another one starts a conversation of its own beside it (as it does beside a conversation holding an unsent draft or pictures, which keeps them); when Space Assistant cannot be asked yet (still loading, signed out, offline, none on the Space) the box keeps the text and says why under it; a microphone, shown when `GET /api/voice` says the Space can transcribe, records a clip (AAC, at most 90 s) and puts the transcript into the field, as it does in every chat's message field (`VoiceInput.swift`, `POST /api/voice/transcribe`); then the screens, copied from the panel once and kept on this Mac (right-click for Add to Screen, New Screen, Edit, Copy the Panel's Layout, Delete); The panel's own windows are tiles as on the web panel (src/web/screens.ts `BUILTINS`): App Store, Inbox, Shortcuts, Terminal and Settings follow the apps in the library's Apps section and pin to a screen as `builtin:<name>`, each with the icon the Space serves for it ([Home screen and built-in tiles](#home-screen-and-built-in-tiles)); App Store and Shortcuts open as the panel's own pages in a tab. Settings opens over the launcher (not a page of the pager), sectioned as the web panel's, its sections listed on the left and the last one shown remembered: General (the saved Spaces, widgets, language, the Inbox, Chat, Terminal and Web Panel pages), Appearance (mode and theme), Models (the default model, App models, the agent CLIs on each machine with Check Again and, for one found here that no runtime uses, Add to runtimes.yaml; in every model menu a choice that is not signed in or whose machine is offline is greyed with the reason, and a saved choice no longer offered stays, marked), Automation (overviews of Scheduled tasks and of Events and calls), Fix this (随手改 in Chinese; the feature the routes and [feedback.md](feedback.md) still call feedback: the Fix this button on app pages and the Fix Engineer, as the panel's, read and changed through the same `GET`/`PUT /api/panel/feedback/settings`: the main switch, off until the owner turns it on, what happens to what is sent (fix it right away, or record it and fix later), machine, model and effort, each app's switch and each peer's apps, and what was sent lately with Fix now, Fix again and Fix the waiting ones), Usage (overviews of Model usage over the last day and App usage over the last week), Status (the Space's status, peers, services and backups), Packages (Apps and connections) and Account (Sign Out, the version). An overview's More, and a section's row, open the page inside the pane with Back to the section; Inbox, Chat and Terminal open over the launcher. An app, a page of the Space or the web panel comes up over the launcher with Back to Space (⇧⌘H) in the toolbar; the window opens on the home screen, the first screen of pinned tiles | `/api/apps`, `/api/agents`, `/api/widgets`, `/api/peers`, the panel layout, `/api/router`, `/api/voice`, the settings routes |
| Space pages | Inbox, chat (in the main window beside a sidebar with New Conversation, the agents to switch to, one entry per agent however many machines it runs on, a working one marked, and the shown agent's conversations: the ones open on this Mac and not stored yet, then its recent sessions, each marked while a turn runs in it, here or on another client, and picked without stopping the others; an agent on several machines has a machine menu above the conversation, remembered per agent on this Mac, each machine keeping its own conversation, an offline one shown and not sent to), scheduled tasks, model usage (the Space named, a model run elsewhere as `machine:model`, a hub's peers' calls with a note for each peer whose figures are stale or missing) and app usage, app models (on a hub each peer's apps under its name, with that peer's choices, saved on the peer), events, packages and a terminal (SwiftTerm), drawn natively from the same files the iPhone client uses | the routes of each page, docs/terminal.md |
| Agent chat | Native conversations, several per agent at once (`AgentChats`, rules in `Services/ChatRoster.swift`): New Conversation opens another one while a turn still runs, showing another one never stops a turn, a turn of the agent started on the web panel or another device becomes a conversation of its own, and idle conversations beyond the four shown last are let go (a stored one opens again from the history). The one on show is shared by the main window and Quick Chat, drawn as the iPhone's (replies on the solid surface, the person's in the accent, a column of about 72 characters); a dropped stream reattaches after the last event; Stop ends the run (it shows Stopping… until the turn ends, and a stop the Space did not take says so in the thread); an action the permission tier does not cover waits as an approval card (Allow / Deny) and a message written during a turn joins it; a failed turn shows its reason in the thread (rate limit, sign-in, time-out, a runtime that exited without a word, with the Space's own text under it) and Try Again sends the message once more; what the agent's tools did shows as chat cards under the reply, in the main window and Quick Chat, drawn by the iPhone client's shared `Views/ChatCardsView.swift` ([chat-cards.md](chat-cards.md): the five styles, the state read each time a card is shown, Undo on the latest live reply only, read-only otherwise, an item's link opening as an app's tab) | `POST /api/agents/:app/:agent/chat` (`interactive: true`), `/runs/:id/events?after=`, `/runs/:id/stop`, `/runs/:id/steer`, `/runs/:id/approvals/:rid`, `/api/agents/runs`, `POST /api/agents/cards/state` and `/action` (a peer's agent: `/api/peers/:peer/agents/cards/*`) |
| Quick Chat | A floating panel over any app on a global shortcut (⌥Space by default, Carbon hot key, no Accessibility permission) or a section of the floating ball, drawn to Design Studio's spec (design 12): 380 points wide, rounded glass, a 40-point header with the agent and its list (⌘J), New Conversation (⌘N, also while a turn runs: that turn carries on in the conversation left, listed in the main window's sidebar) and Close (Esc) as 20-point round buttons; Open in Main Window stays on ⌘O. With no conversation it is the header and the field (96 points); it grows upward with the replies to 420 points and then scrolls. Pasted or dropped pictures wait as 44-point thumbnails above the field; the permission is the one last chosen in the main window. A click elsewhere closes it, except for its own file picker or a sheet. When another app already holds the chosen shortcut, Settings › General says so under the picker | as above |
| Floating ball | A small round window over every app and every Space, off until Space → Floating Ball or Settings › General turns it on. Resting the pointer on it opens a glass dial of four sections around a hub; each Space sets its own sections on this Mac (Settings › General › Floating Ball: an app or an agent, Default, or None; the defaults are Keep, Space Assistant, Todo and Design Studio). Clicking a section opens Quick Chat on its agent (an app's own agent, else Space Assistant told where the work goes), to paste text and pictures into; a picture dropped on a section opens it with the picture attached; a click on the hub or the closed ball does nothing, and a picture dropped there opens Share Picture. Drag the ball to move it (its place is remembered on this Mac and kept on screen when a display goes); right-click for Share Picture…, Paste Picture, Pending Shares and Hide; it never takes the keyboard | `GET /api/capture`, `POST /api/capture/image?to=…`, `/api/agents/:app/:agent/chat` |
| Voice input | In any app, off until Settings › General › Hold fn to talk turns it on: hold the fn (Globe) key to talk and the words show live in a large overlay above the bottom of the screen, with a level meter, a timer and what letting go does; let go and the text goes into the field that has the keyboard. Settings › General › Hold right ⌥ to capture (also off by default) records the same way on right ⌥, but sends the text to an app of the Space that takes spoken notes (Send to, when there are several) and types it nowhere. The Space chosen in the switcher at the top left of the main window transcribes, and never another; a Space whose transcriber has no live socket gets the recording as a clip on release ([Voice input](#voice-input)) | `GET /api/voice`, `WS /api/voice/realtime`, `POST /api/voice/transcribe`, `GET /api/capture`, `POST /api/capture/text?to=…` |
| Desk pet | The web panel's built-in Claude (`src/web/public/pet-claude.webp`), in the window along the launcher's bottom edge or on the desktop over every app; it shows the selected Space's mood and a click opens the chat or the inbox it points at ([Desk pet](#desk-pet)) | `GET /api/pets/mood` |
| App tabs and windows | An app opens as a tab of the main window, over the launcher, shown as up to five app icons in their own toolbar group, separated from navigation and the grouped browser/window controls, with remaining tabs in an overflow menu and the active app kept visible and highlighted; right-click an icon to close it or all tabs. Page controls include back, forward and reload; Open in Browser, Open in New Window and Close share one toolbar group; Add to Screen remains in the launcher context menu; the mark stands in for the page until it has drawn; the operator can move any tab into its own window and back (⌥⌘T, toolbar or context menu) without reloading it; an app's own window has back, forward and reload in its toolbar beside Move to Main Window, and Reload (⌘R) and Open in Browser act on it while it is in front; links to an app's origin from the panel, the inbox or a notification open in its tab or its window | `/api/apps` (`url`) |
| Inbox | Native list with read and done (swipe, or right-click for Done or Reopen and Mark as Read or Unread); new unread threads become Mac notifications with Mark as Read and Done; the unread count is the Dock badge | `/api/inbox?filter=open`, `/api/inbox/mark` |
| Menu bar | Per connection: agents working (each opens its own conversation), unread messages, app shortcuts, Quick Chat | all of the above |
| Dock menu | The first apps and agents of the first screen, as the iPhone's home-screen quick actions | none |
| Mac integration | Services > Ask ai-space puts selected text into Quick Chat; `aispace://chat?agent=<app>/<agent>&text=…`, `aispace://open?app=<name>` and `aispace://inbox` for Shortcuts and other apps | none |

How the native calls authenticate: the operator signs in once in the web panel, inside the window (the launcher's Sign In card opens it and comes back once the sign-in is done). Native requests then carry that connection's WebKit cookies (for Cloudflare Access, `CF_Authorization`), never Safari's, and no operator token. Redirects are not followed: a redirect, 401 or 403 means "sign in", which the launcher and menu bar show. The panel routes accept these writes because a request without `Origin` or `Sec-Fetch-Site` is not a browser page (`src/space/auth.ts`).

Safety rules the native layer keeps:

- A link or a Service may fill in a Quick Chat message but never sends it; any web page can open an `aispace://` link.
- Web content still has no bridge or script message handler; the native views talk to the Space directly.
- The first look at a connection's inbox only records it, so connecting does not flood the screen; later notifications are new or changed unread threads.
- A background refresh every 30 seconds keeps the menu bar and notifications current while the window is hidden; the app opts out of App Nap for it but still lets the Mac sleep.

Widget cards (`Views/WidgetCard.swift`, `Views/WidgetBlocksView.swift`, `Views/WidgetArea.swift`) follow the web panel's ([panel.md#widgets](panel.md#widgets)) when the Space sends `widgetAlign` in `GET /api/panel/layout` (a Space with the stepless layout always does; nothing is probed with writes). On a screen the cards are placed in stepless rows by `Core/WidgetLayout.swift` (a port of src/web/widget-layout.ts with the same constants) and each card's inner layout follows its box: the size class with hysteresis, and as many rows a page as fit, the rest paged with dots and the Left and Right arrows (not with a trackpad swipe, which already moves between pages of the window). Inside a card: the view switch (remembered per widget on this Mac), Copy on a row (confirms in place, never opens the row's link), a local widget's checks, buttons and input (`POST /api/widgets/:app/:name/action`; a confirm is asked inside the card; a tick is drawn at once and taken back with the error in the card when the Space refuses it, typed text kept), the pointer over a trend reading the nearest point, the as-of time refreshing the card (`POST …/refresh`), and the value flash and entrance motion, off with Reduce Motion. While the screen is arranged each card has a right, a bottom and a corner handle (drag with the resize cursor; Option stops snapping, Shift changes only this card and lets the next ones re-flow; a guide shows the line it snapped to; the live size in the card's head; focus a handle and use the arrow keys, 8 points or 1 with Shift; VoiceOver adjusts it) and a toolbar over the cards aligns, centres, splits evenly, resets (asked in the window) and undoes the last change. Each change is drawn at once and written once (`PUT /api/panel/layout {frames, sizes, widgetAlign}`), and put back with a message when the Space refuses it; a Space that refuses frames but takes sizes keeps the nearest size, said once. The controls do nothing while arranging and in the library. Against an older Space, and in the library, the cards are on the classic grid as before.

Shared with the iPhone client: the Mac compiles the iPhone client's Foundation-only `Core/` files (catalogue, search, screens and their store, widget blocks, the Space's settings and page shapes, terminal routes) and the `Live/` loaders and page stores from `mobile/ios/AISpace/`, where they live, as the iPhone compiles the Mac's `Services/`; `scripts/sources.sh` and `project.yml` list them. The views are the Mac's own, ported from the iPhone's with AppKit in place of UIKit. Its own files: Application Support/ai-space/`screens.json` next to `connections.json`, the last catalogue and the icons under the app's Caches folder. What the iPhone has and the Mac does not need: the draggable page button and the glass status bar (the toolbar carries the page dots), home-screen quick actions (the Dock menu), and drawing the backdrop once to a picture for scrolling (a Mac window is resized, so the backdrop page itself sits behind).

Not done, and why:

- The Mac as a resource agents can use (its files, calendar, screen) needs its own trust design: what an agent on a server may ask of this Mac, how each request is approved, and how that stays narrower than a remote shell. It is the next design task, not part of this client.
- App Intents remain unimplemented. The image Share extension is built with Xcode (see below).
- Checks on the menu bar: `/api/checks` lists definitions whose state each app serves at its own URL; reading them all belongs in the Space, not in the client.

Also still open for the stage 0 gate: completing the Cloudflare Access sign-in inside WKWebView, Chinese input, the terminal WebSocket, uploads and themes, each checked by hand on the oldest and current supported macOS.

The launcher layout was checked on macOS 27 against the Seoul Hub (42 apps, 16 agents, 27 widgets): the first screen with its tiles and widget cards, the library with search, a timed-out refresh shown as the last-known card, Settings with services, peers, backups and the default model, the inbox and the agents list, each written by the debug build's `AISPACE_SNAPSHOT` hook.

Checked on macOS 27 against a scratch Space: the panel reports ready; the sidebar lists the Space's agent; an inbox message posted with `POST /api/notify` is picked up by the next refresh; a chat turn streams from start to "thinking" to the reply and ends cleanly through the native client. The Seoul Hub behind Cloudflare Access reports sign-in needed until the operator signs in on Home; after signing in there, the native views load its 39 apps, 16 agents and inbox with that session, and an app opened by link loads as a tab on its own Access-protected host.

### Home screen and built-in tiles

Names first, since the Mac's menus and the panel's documents use "home" for different pages. The **library** is the leftmost page (`Pager.home`; the Space menu calls it Home). The **home screen** (主屏幕) is the first screen of pinned tiles to its right (`Screens.home`; the page dots call it Main), and the screens after it are Screen 2, 3…. The rules below are `Services/Builtins.swift` and `Services/DesktopScreens.swift`, tested in `AISpaceTests/DesktopScreensTests.swift`.

- **Where the window opens.** On the home screen: at launch, after a first install (the Space found or installed on this Mac), and when another Space is picked. When the home screen is empty and a later screen is not, on the first screen that holds something (`DesktopScreens.opening`); never on the library, and never on an empty screen while another holds the tiles. A window still on the home screen when the Space's layout is first copied moves by the same rule.
- **Built-in tiles.** The five of the panel (`builtin:store`, `inbox`, `shortcuts`, `terminal`, `settings`), in that order. A tile shows the icon the Space serves for it: `builtins` of `/api/apps`, which is the active icon pack's file when the pack covers the tile ([panel.md](panel.md#icon-packs)) and the panel's own artwork otherwise, so a hub with an icon pack looks the same here as in a browser. The app carries the panel's five drawings (`src/web/public/store.svg`, `inbox.svg`, `shortcuts.svg`, `terminal.svg`, `settings.svg`, copied by `scripts/build.sh` and `project.yml`, never redrawn) and shows them until the Space's icon has loaded or when it cannot be read; no system symbol stands in for them. Inbox and Terminal carry the same icon on their rows in Settings › General. Inbox, Terminal and Settings are drawn by the app; App Store (`/?page=store`) and Shortcuts (`/?page=shortcuts`) are the panel's [built-in pages](panel.md#built-in-pages) in a tab of the main window, beside the open apps, and are not counted as an app's use.
- **The first layout.** The first catalogue of a Space copies the panel's screens once (`ScreenStore`, shared with the iPhone, whose copy keeps Settings alone of the built-in tiles); the Mac then puts the panel's other built-in tiles back in their places (`DesktopScreens.keepingBuiltins`), and so does Copy the Panel's Layout. A Space that has stored no screens yet is seeded as the panel seeds it: the first eight apps, the five built-in tiles, the first four agents and widgets. A layout this Mac copied before it drew those tiles keeps what it has; they are in the library to pin.
- **First apps.** A Space with no catalog app shows the panel's first-use card on the home screen ([app-catalog.md](app-catalog.md#the-app-store)): **Open the App Store** opens it (`/?page=store`), **Not now** hides the card for that Space on this Mac. It reads `GET /api/app-catalog` once per sign-in.
- **Installed apps land on the home screen.** The store pins an install to the panel's home screen, and this Mac keeps screens of its own. Each time the catalogue is read (when the launcher comes back from a tab, on Reload, after a chat turn), an app this Mac has not seen before that stands on the panel's home screen is pinned to this Mac's home screen too (`InstallRules.adopt`), at the end, in the catalogue's order. The apps seen are kept per Space in the app's preferences (`installWatch.<connection id>`); the first look pins nothing, since the copied layout already has what the panel pinned. A new app that is on no screen of the panel (a link added to the library, a peer's app) stays in the library; the store's pin may land up to ten minutes after the app first shows. A tile taken off this Mac's screen stays off; an app uninstalled and installed again is pinned again.

### Desk pet

The pet is the web panel's built-in Claude, the same sheet (`src/web/public/pet-claude.webp`, rendered by `src/web/pets/claude.py`, copied into the app by `scripts/build.sh` and `project.yml`) and the same animations, so every client shows one figure. It is on by default and set in Settings › General › Desk Pet: Show the desk pet, Where (In the window, or On the desktop, over every app) and Size (small 60, medium 80, large 110 points); Space → Desk Pet turns it on and off, and right-clicking the pet moves it to the other place or hides it.

What it shows is the selected Space's mood, `GET /api/pets/mood` ([app-spec.md#space-mood](app-spec.md#space-mood)), read with each refresh of the live state (every 30 seconds, and when the selection changes). The table from the mood to the animations is in `Services/PetRules.swift` (`PetSprite.claude`, `PetMood.shown`), the web's (`src/web/Pet.tsx`), and `src/web/pet-claude.test.ts` checks the two agree: it looks on while agents work or one is in trouble, hops in its corner while a turn waits for an approval, spins once when a turn is done and sleeps after two quiet hours; idle, it walks and rests as on the web. A line (the mood's `say`) shows for six seconds out of twenty above it. A click opens what the mood points at, a waiting or failed agent's chat or the inbox, else plays the jump.

- In the window (`LauncherPet` in `Views/MainView.swift`, the drawing in the iPhone's `Views/PetView.swift`): it walks along the launcher's bottom edge, under the pages and over nothing that takes clicks except the sprite itself; it is hidden, and stops, while an app, a page or Settings covers the launcher or the window is hidden.
- On the desktop (`Desktop/DeskPet.swift`): a borderless non-activating panel at the floating level, on every Space and over full-screen apps, that moves with the pet along the bottom of the main screen's visible frame (above the Dock); it takes the pointer only over the sprite (`ignoresMouseEvents` is set from a pointer check ten times a second), so the desktop under it stays usable. Drag it along the bottom to move it; where it was left is kept as a fraction of the screen (`deskPetSpot`) and clamped when displays change (`DeskPetRules`).

It draws one cell of the sheet at a time, cropped with ImageIO, on a timer that fires only when the cell or the place changes (at most 20 times a second while it walks), and nothing runs while it is not seen: a hidden or covered panel, a minimised window, or Reduce Motion, which hides it.

The rules (the mood table, walking, frames, the bubble, the desktop window's frame and remembered place) are covered by `AISpaceTests/PetRulesTests.swift`; the two pets themselves have not been checked by hand on a Mac yet.

### Voice input

Hold fn, talk, let go (Settings › General › Hold fn to talk, off by default). `Desktop/Dictation.swift` owns it, `Desktop/FnKey.swift` watches the key, `Desktop/LiveVoice.swift` records and transcribes; the decisions are in `Services/FnHoldRules.swift` and `Services/DictationRules.swift`, covered by `AISpaceTests/FnHoldRulesTests.swift`, `AISpaceTests/HoldKeyTests.swift` and `AISpaceTests/DictationRulesTests.swift`.

A second key does the same for a note: hold right ⌥, talk, let go (Settings › General › Hold right ⌥ to capture, off by default), and the text goes to an app of the Space instead of the field ([Spoken notes](#spoken-notes) below). Everything else here is shared by both keys: the recording, the overlay (in each key's own mode), which Space, the language and the clip fallback. The two are one `Dictation` with a destination (`DictationRules.Destination`: `field` for fn, `capture` for right ⌥); a press of either key while a recording, its transcript or a note is still on its way is ignored, and only the key that started a recording ends it.

**The key.** A Carbon hot key cannot be a bare modifier, so `FnKey` installs `NSEvent` monitors for `flagsChanged` and `keyDown` while the setting is on. fn is the `flagsChanged` of key 63 (`kVK_Function`); arrow and function keys also carry the fn flag on their own key events, so only that one counts. A press arms a 0.25 second timer and recording starts only if fn is still held alone when it runs out: a tap, fn+arrow, fn+F5, fn+Delete or fn with ⌘⌥⌃⇧ never starts. Once recording, other keys are ignored; letting go of fn stops. The global monitor sees other apps' keys only while AI Space is allowed under System Settings › Privacy & Security › Accessibility (Apple's documented rule for key events); without it fn works only while AI Space is in front, and Settings says so. Turning the setting on shows the system's Accessibility prompt when the permission is missing, and a monitor made before the grant is made again once it arrives (checked every 3 seconds while missing). While fn is down the current modifier state is also read every 0.1 seconds, so a release the monitors miss (a password field's secure input takes key events from them) still ends the recording; that reading counts only after it once showed fn down.

`FnKey` takes the key it watches (`HoldKey`), and the app runs one per switch. Right ⌥ is the `flagsChanged` of key 61 (`kVK_RightOption`); left ⌥ (key 58) is another key to it, so it spoils an armed hold. The event's device-dependent flag bit (`NX_DEVICERALTKEYMASK`, 0x40) tells right ⌥ down from up, since `.option` stays set while left ⌥ is held; left ⌥, ⌘, ⌃ or ⇧ held with it make a combination. The same 0.25 second rule applies, so a tap or right ⌥ with a letter (typing a special character) never starts: the letter's `keyDown` spoils it before the timer runs out. The missed-release reading is `CGEventSource.keyState` of key 61, because the modifier state cannot tell right ⌥ from left. Seeing right ⌥ in other apps needs the same Accessibility permission as fn, with the same prompt and the same note in Settings.

macOS acts on the Globe key itself (System Settings › Keyboard › "Press 🌐 key to": the emoji picker, the input source, Dictation). The app reads that setting (`AppleFnUsageType` in `com.apple.HIToolbox`, 0 = Do Nothing) and, when it is anything else or unset, Settings asks for Do Nothing; it never changes it. A keyboard whose fn key is handled in its own firmware (most non-Apple keyboards) sends no event and cannot be used.

**Live transcription.** `LiveVoice` is the iPhone client's live voice (`mobile/ios/AISpace/Live/OmniboxVoice.swift`) on the Mac, sharing its `VoiceTranscript` and `VoicePCMFrames` (`mobile/ios/AISpace/Core/OmniboxModels.swift`): AVAudioEngine, converted to mono 16 kHz PCM16, frames of at most 100 ms over `WS /api/voice/realtime` ([speech.md](speech.md#live-protocol)). Recording starts once the microphone is allowed; what is said before the transcriber answers `ready` (a cold model load takes about 15 s) is held, up to 50 seconds, and sent first. Partial and final events update the overlay (the end of the transcript, four lines of it). The tap also measures each buffer's loudness for the overlay's meter (`LiveVoice.level`: RMS in dB, −50 to −10 dB as 0 to 1, smoothed, at most 20 updates a second, 0 when not recording). Letting go sends the rest and `stop`; the text goes in once, after `done` (at most 70 seconds later). Recording ends by itself after 90 seconds. Typing provisional text into the field and correcting it is deliberately not done: it cannot be done reliably across apps.

**Which Space.** One only: the Space chosen in the switcher at the top left of the main window (`AppModel.selected`, else the default connection), so switching to a remote Space with a voice interface makes voice input go there and switching back to This Mac brings it back. It is not a setting: the earlier Settings › General › Transcribe with is gone and a value it stored (`voiceInputSpace`) is removed at launch. The overlay shows the Space's name while it listens. When its `GET /api/voice` says it cannot transcribe, the overlay says so with its name and nothing is sent; speech never falls over to another saved Space, which may not be the person's own. The answer is kept for a minute per Space (`Services/VoiceProbes.swift`, covered by `AISpaceTests/VoiceProbesTests.swift`), a request that fails is not kept, and a failed recording forgets it, so a Space that gained or lost its voice interface is asked again rather than answered from an old reply. The microphone beside a field uses the same answers and the Space of the page it is on: the command box the selected Space, a chat's message field the Space of that conversation. That answer is about files: the live route also needs a provider with a live socket (`voice-studio`; the `openai-compatible` adapter has none), and the Space refuses the socket with a 503 otherwise. Until the live route is `ready` the whole recording is also kept, so when the socket is refused, fails or never gets ready, it goes up on release as a WAV clip to `POST /api/voice/transcribe` and that text goes in instead; the overlay then shows no live text.

**Which language.** Both routes are told the language spoken (`language` in the live `start`, a `language` field on the clip; [speech.md](speech.md#languages)), as is the microphone beside a field: Settings › General › Voice language (语音输入语言), by default Same as AI Space, which is the app's language (`Lang.current`, what Settings › Language shows) when it is Chinese, English, Japanese or Korean and otherwise lets the Space's provider detect it; Detect automatically sends none; or one of those four. The rule is `VoiceLanguage` in `Services/SpaceModels.swift`, shared with the iPhone client and covered by `AISpaceTests/VoiceLanguageTests.swift`; the choice is read once when a recording starts.

**How the text goes in** (`DictationRules`):

- **A window of this app has the keyboard** (the main window, or Quick Chat over another app): the transcript is pasted through the app's own responder chain (`paste:`), which needs no permission and reaches text fields, the chat field, pages in web views and the terminal.
- **Another app is in front and AI Space is allowed under Accessibility**: the app posts ⌘V to it (the physical V key, so a layout that moves V needs the layout's key).
- **Otherwise** the transcript is left on the clipboard and the overlay says to press ⌘V.

The text goes through the general clipboard. For the two pastes it is marked `org.nspasteboard.TransientType`, so clipboard managers skip it, and after 0.8 seconds the clipboard's earlier contents (every item, every type) come back, unless something was copied meanwhile. A transcript left for ⌘V stays. Accessibility is granted to a signed app: an ad-hoc build (`bun run desktop:build`) is a different app to macOS after each rebuild and must be allowed again.

<a id="spoken-notes"></a>**Spoken notes** (right ⌥). When the recording starts, `Dictation` asks the transcribing Space for its places for a note (`GET /api/capture`, `textTargets`: the capabilities declaring `capture: { kinds: [text] }`, here and on its peers; [events.md](events.md#capture)). With none, the overlay says that no app on the Space takes spoken notes and nothing is recorded. Settings › General shows the same list under the switch: a Send to picker when there are several (remembered per Space in `Preferences.voiceCaptureTargets`), the one app's name when there is one, or that there is none. When the final text is in it is tidied as for the field and sent once as `POST /api/capture/text?to=<target>` with `{ text, via: "voice", id }`, `id` a fresh UUID; after a network error it is sent again once with the same `id`, so the app keeps it once. The overlay then shows a large check, Kept in the app's title with the answer's `label` when it has one ("Kept in Decree · Decree #3"), and the note itself, for 2.5 seconds. When it does not arrive (the Space or the app refused it, the network failed twice, or the answer says `ok: false`) the overlay says so and the text is put on the clipboard, not marked transient, so nothing said is lost. Nothing is ever pasted in this mode, so delivering needs no Accessibility permission; only seeing the key in other apps does.

**The overlay** (`DictationHUD`, drawn by `Desktop/DictationOverlay.swift`; what it says and for how long is `DictationRules`, covered by `AISpaceTests/DictationRulesTests.swift`). A borderless non-activating panel at the status bar level, on every Space and over full-screen apps, ignoring the pointer and never taking the keyboard. It holds a glass card (`.regularMaterial`, 28 pt continuous radius, hairline border, a deep soft shadow) about 560 pt wide (at most 90% of the visible width), centred, its bottom edge 16% of the visible height above the bottom of the screen under the pointer. It appears with a 0.16 second scale-and-fade (a fade only with Reduce Motion) and leaves with a fade.

- **Header**: a mode badge that tells the keys apart, fn in the theme's accent with a microphone, "Voice input" and "into the current field"; right ⌥ in the warm warning colour with a note glyph, "Note to <app>" with the target's localized title ("Spoken note" until the Space named it). On the right the listening Space's name and the elapsed time (`0:07`, monospaced digits), red for the last 10 seconds before the 90 second limit.
- **Meter**: 36 rounded bars, 48 pt tall, the recent history of the microphone level with the newest on the right, tinted by the mode. Before the microphone is on they sit low and breathe (still with Reduce Motion).
- **Words**: the live transcript in 22 pt type, up to four lines, its end shown (`DictationRules.tail(_:units:)`, a CJK character counting twice); before anything is heard, "Speak now".
- **Footer**: a key cap (`fn`, `right ⌥`) and what letting go does: "let go to insert", or "let go to send to <app>".
- **After release** the meter becomes a running progress line, the words dim, and the footer says Transcribing…, then for a note Sending to <app>….
- **Results**: a kept note as above, 2.5 seconds; for fn the overlay just leaves once the text is in. Anything gone wrong or worth saying (no Space, a Space that cannot transcribe or is not connected, no app that takes spoken notes, the microphone refused, a failed transcription, the clipboard fallback, a note not sent) is the same card with a warning glyph and the message, for four seconds, six when the text waits on the clipboard.

VoiceOver reads the card as one element (mode, Space, words, state); the meter and the progress line are hidden from it. A press while the previous text is still on its way is ignored. No cancel key.

## Picture sharing

The signed Xcode build embeds a macOS Share extension. Share one image from Finder, Preview or the screenshot preview to **ai-space**, choose a saved Space and a destination app, optionally add a note, then save. If the extension is absent from the share menu, enable it in macOS sharing-extension settings. Open the main app once and sign in to the Space before using the extension.

The main app also offers **Space → Share Picture…**, **Paste Picture**, and **Pending Shares**. The editor, target discovery (`GET /api/capture`), image upload (`POST /api/capture/image?to=…`), bounded image decoding and persistent retry state are shared with iOS. The Mac extension also accepts secure `NSImage` archives supplied by AppKit, rasterizing them to at most 2048 pixels per side before encoding. Files are limited to 40 MiB before decoding, then converted if necessary to fit the capture endpoint. The Mac editor has a fixed header with Cancel (Esc), outside the scrolling content, because a system extension host does not provide the iPhone navigation toolbar. Cancel ends the extension request and retains already received pictures; a successful save removes the picture, and Done closes the share session. The system owns the share window above its source app; the extension does not raise its window level. Once an upload starts, retries retain its ID, destination and note to prevent duplicate saves. Delete pending pictures explicitly when they are no longer needed.

The **floating ball** (`Desktop/FloatingBall.swift`, rules in `Services/FloatingBallRules.swift`) is the same import with no menu to reach for: a borderless non-activating panel at the floating level, on every Space and over full-screen apps, that is a drag destination. What a drag offers is decided from the pasteboard before the drop (`FloatingBallRules.offer`): one file whose content type is an image, else image data on the pasteboard (PNG, TIFF, or anything `NSImage` reads), else a file promise (a browser's image drag), which is received into a folder of its own under the temporary directory, read once and removed. Links, text and several files are refused, so the drag shows no drop cursor. A taken picture goes through `PictureSharing.take`, the same bounded decoding, editor and retry store as Share Picture…; a file that turns out not to be a picture opens the editor with the reason. The ball is moved by hand (a borderless panel is not moved by the system) and settled back inside the visible frame of the screen it was left on; the place is kept in the app's defaults and clamped again when displays change. It is off by default (`floatingBall` in Preferences). Under the pointer, or when a picture is dragged over it, the panel grows into the dial (Design Studio's spec, design 11: a 168-point disc, a 60-point hub that names the section under the pointer, 28-point icons, the hovered section tinted blue, sections that cannot take a dragged picture faded and grey, an empty one a dashed circle with a plus) (`FloatingBallRules.dialCenter` keeps it whole on its screen) and shrinks back a moment after the pointer leaves the disc; the window is resized without animation and only the dial's scale and fade animate, so the content never slides from the old frame's corner. `FloatingBallRules.section(at:center:)` maps the pointer to a section; each section's entry and agent come from the selected Space's catalogue and `floatingBallSlots` in Preferences (entry keys per connection, `""` default, `-` empty), read again when the catalogue is older than a minute. During a drag a section that has no agent refuses the drop.

Xcode builds use `$(TeamIdentifierPrefix)dev.ai-space.desktop.capture` for App Group drafts and addresses, and `$(AppIdentifierPrefix)dev.ai-space.desktop.share` for device-only Data Protection Keychain sessions. Only cookies matching the capture endpoint are exported, scoped to the saved connection and URL, refreshed when WebKit cookies change and revoked on sign-out/removal. The extension has App Sandbox and outgoing-network entitlements. No credentials are written to the App Group files.

Build with the same Apple development team for the app and extension:

```bash
DEVELOPMENT_TEAM=YOUR_TEAM_ID bun run desktop:share:build
```

The output is `desktop/macos/build/share/Build/Products/Release/AISpace.app`. The ordinary `desktop:build` remains ad-hoc signed, supports the in-app import menu, and has no Share extension. Its drafts live in `Application Support/ai-space/PendingShares`; signed builds use the App Group instead. These stores are separate; finish pending imports in the build that received them before switching builds.

Validation: signed macOS build and 52 Xcode tests passed, including shared Keychain isolation/revocation, frozen-payload retries, unavailable destinations, stale responses and bounded previews. The Foundation-only Mac suite passed 46 tests. The system registered and enabled `dev.ai-space.desktop.share`. A native sharing-service smoke test received an AppKit `NSImage` archive, persisted the image and loaded the authenticated destination list; it did not upload a fixture into a user app. The iOS regression suite passed 113 Simulator tests and 97 Foundation-only tests.


### Native chat permissions

Mac chat and Quick Chat use the Web panel's permission flow (`src/web/Chat.tsx`). The composer
offers Ask before changes (default), Edit files (`acceptEdits`) and All permissions
(`bypassPermissions`). The choice is remembered on this Mac and captured when each new turn is
sent; changing it during a run does not change that run or its reconnect request. Every turn is
sent as interactive, so on Claude Code and Codex it runs on the conversation's live process
([runtimes.md#live-chat](runtimes.md#live-chat)): Ask before changes lets the agent ask before an
edit or a command instead of refusing it.

An action the tier does not cover arrives as an approval card in the reply: what the agent wants to
run, why, and **Allow** / **Deny**. Allow runs that one action as asked; Deny refuses it and the
agent carries on without it. The card then reads Allowed, Denied or Not answered (the turn ended, or
Stop denied it). An answer is sent only by a click; nothing is approved automatically. Several open
cards can be answered in any order, and a card answered on another client shows the outcome here.

A question the agent asks (Claude Code's AskUserQuestion, Codex's request_user_input) arrives as a
question card: its options as buttons and a field for an answer of one's own. One question with one
choice goes back on the click; several questions, a multiple choice or a typed answer go back with
**Send**. **Skip** answers nothing and the agent goes on without it. The card then shows the answer,
Skipped or Not answered.

A runtime without live chat, or an action refused anyway, still shows the refusal beneath the
reply. Once the turn finishes, **Grant and retry** on the latest reply selects the next permission
tier and asks the agent to finish the refused step in the same session, preserving any unsent draft.
Bash needs All permissions; other tools first get Edit files and a further refusal can raise it to
All permissions. The selected scope is shown beside the button and applies to subsequent messages.

A message written while a turn runs joins that turn instead of waiting for it: the reply shows it
waiting until the agent has read it after its current step. When the running turn cannot take it
(the turn just ended, or the runtime has no live chat), it is sent as the next turn, in order, so no
message is lost. All permissions skips the approval cards entirely.

### Native agent work messages

A running turn previously collapsed tool names into one short line and omitted successful Codex results. Native chat and Quick Chat show assistant messages as borderless text and, in event order, each operation as one quiet line after the web panel's tool rows (`src/web/ChatToolRow.tsx`): a glyph, the kind of tool (Bash, Read, Edit, Search, Web, …) and the first line of the call. A running call shimmers (still under Reduce Motion); once it ends, the dot beside it turns green for a success and red for a failure, whose text turns red too; consecutive calls stack as one list. A click opens the full input and output (IN / OUT, up to 12,000 characters). An operation with no result is marked as such when the turn ends; it is never assumed successful. Replay uses event sequence numbers and stable tool IDs to avoid duplicate cards. Claude and Codex share the normalized tool-use/result contract; no private reasoning is displayed. An earlier chat opened from the history shows its text and tool calls in order, with each call's input and output, where the runtime's records have them, and folds each run of two or more calls to one line (Ran commands or Called tools, and how many) that opens to the calls; older records without steps show their text only. The composer labels its access selector **Permission**.

Chat, Quick Chat and the home command box leave Return to the input method while it has marked text (for example, a Chinese candidate). After composition finishes, Return submits; Shift-Return inserts a newline.

The Mac refreshes the owning Space catalogue after every native agent turn and when returning to the launcher. Refreshes requested during an existing fetch queue one follow-up, so an older in-flight response cannot hide a newly installed app. Local package pages use isolated `*.localhost` HTTP origins; the Mac ATS configuration permits HTTP for `localhost` and its subdomains only, in addition to local networking.

Native agent chat supports image selection, clipboard paste and drag-and-drop, removable thumbnails, and image-only messages under the same limits as [Web chat images](panel.md#agent-chat-images). Image imports finish before sending, and failed turns retain their attachments for retry.

The Mac chat composer handles screenshot and Finder-image paste in its AppKit text editor, including Command-V and Edit → Paste. Ordinary text paste stays with AppKit; Return confirms marked input before it can send, and Shift-Return inserts a line break. The empty composer and a single line share the same height; wrapping and explicit newlines grow it up to the scrolling limit. Long text wraps at the field's edge, in the main window and in Quick Chat alike: the editor is always as wide as the field, however SwiftUI measures it, so the caret stays in view.

Native Mac assistant replies use Foundation Markdown parsing and SwiftUI block layout for tables, headings, nested lists, quotes and fenced code. Tables and code scroll horizontally when needed; ordinary reply text remains borderless. Inline emphasis and links retain their parsed attributes.
