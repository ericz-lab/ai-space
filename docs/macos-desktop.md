# Native macOS desktop proposal

Status: in progress in `desktop/macos/` (see [Native-first client](#native-first-client) and [Build and run](#build-and-run)). Hub and Peer configuration and the managed local installation remain proposals; none of their APIs exist yet.

Build a Mac application with SwiftUI and AppKit for the desktop interface, WKWebView for the existing React panel, and the existing Bun service for all Space operations. Ship a client for an already running Space first. Add a managed local installation only after the client works reliably.

The motivation is a persistent Mac entry point with native window behavior, workspace selection and desktop integration, while keeping browser access and server deployments working. The first release has a native shell and web content. A fully native SwiftUI panel is a separate, optional later project.

## Product scope

Proposed initial target: macOS 14 or later, Apple Silicon, distributed directly as a signed and notarized application. Validate on the oldest supported macOS and the current release. Intel support can follow a tested build; it is not promised by the initial release.

| Area | First desktop release | Later |
| --- | --- | --- |
| Connections | Existing local Space; remote HTTPS Hub with its existing peers after access validation | Initialize and manage a bundled local Space |
| Hub and Peer configuration | Native saved Hub connections; existing Peer topology and status | Add, test, edit, remove and rotate Peer connections through new operator APIs |
| Native interface | Main window, menu commands, connection settings, status and reconnect screen | Menu bar status, global shortcut, notifications |
| Space interface | Existing launcher, agents, chat, tasks, inbox, settings and terminal | Selected SwiftUI screens if usability justifies them |
| Apps | Open app links in the default browser | Isolated in-app windows for selected apps |
| Backend | Use the operator's existing installation | Signed Bun runtime and packaged Space resources |
| Updates | Manual replacement of the signed desktop app | Coordinated application and managed backend updates |

The first release does not install agent CLIs, change service supervision, migrate an existing workspace, or change a server's configuration. Remote-only use must work without Bun or a local Space installation. Remote Hub and Peer configuration is an explicit follow-on milestone in this proposal, independent of the managed local installation.

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
| macOS service manager | Managed backend lifecycle in the later bundled installation |

Keep business operations in Space. The desktop app must not write `space.db`, interpret app manifests independently, implement another scheduler, or read remote files as local paths.

Load the panel's actual HTTP or HTTPS URL in WKWebView. Do not initially package a second frontend under `file://` or a custom scheme: the existing relative requests, streaming connections and origin checks already align with the server-served page. The server therefore supplies the matching frontend version.

Apple's [WKWebView](https://developer.apple.com/documentation/webkit/wkwebview) is the embedded web content component. Wrap it in SwiftUI and use AppKit where window and menu behavior requires it. Bun remains an independent runtime; SwiftUI does not replace its service implementation.

## Connections and first launch

First launch presents Add Connection with Local Space and Remote Space choices. A connection stores a stable client identifier, display name and panel URL. Desktop preferences belong under the application's own Application Support directory, separate from the Space workspace.

For local use, suggest `http://127.0.0.1:8700`, matching the current default in `src/space/config.ts`, but let the operator change it. A reachable port alone is not proof that the service is ai-space: validate the panel and a known API response before reporting Connected. A missing service leads to retry and setup guidance, not an automatic second backend.

For remote use, require HTTPS and keep the existing tunnel and access layer. The desktop connection picker switches complete Space panels. Existing hub and peer aggregation stays inside each server; the client does not recreate the peer catalogue or claim that a hub can manage every peer setting. See [peers.md](peers.md).

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

Quitting the UI and stopping Space are distinct operations. The first release has no Stop Space action. A later managed installation may offer it with explicit information about active work and with graceful shutdown.

Desktop presence does not make a laptop an always-on server. Do not prevent sleep by default or promise execution during sleep. Work that must continue independently of the Mac belongs on a server. Reopening the UI must reuse the existing background-run recovery behavior rather than treating an interrupted stream as a new task.

## Managed local installation

This is a separate milestone. First build a release prototype that launches the current server from packaged resources on a clean Mac with no Bun on PATH. Verify Bun HTML imports, public assets, chat-widget builds, shared skills, PTY support, SQLite and runtime adapters. Do not assume copying one TypeScript entry point or compiling one binary packages every runtime resource.

Retain `$SPACE_HOME` or `~/.ai-space` as the workspace contract. Keep the installed runtime and release files separate from apps, databases, logs and configuration. Moving or replacing the desktop app must not lose workspace data.

Define two explicit ownership modes:

- **External:** the operator installed the service. The desktop app connects to it and does not stop, upgrade or replace it.
- **Managed:** the desktop installation owns a registered helper and its backend release. It may start, repair and upgrade that installation through explicit lifecycle operations.

Never infer ownership from a PID or an occupied port. Before managed mode ships, add a versioned service identity and readiness contract, installation ownership metadata and a per-workspace exclusion mechanism. Concurrent launches must not start two schedulers against the same workspace. If an external installation already uses that workspace, require an explicit handover instead of silently adopting it.

Evaluate [SMAppService](https://developer.apple.com/documentation/servicemanagement/smappservice) for the app-owned background helper. It manages login items and helper services on macOS 13 and later. The registration's status, user approval, disabling in System Settings and repair path must be visible. Existing `space.<app>` LaunchAgents supervise individual apps; they do not by themselves provide a desktop-owned installation of the Space server.

Agent runtimes remain separate dependencies. Report configured and missing executables with repair guidance. Resolve executable paths deliberately because GUI applications and background services do not inherit an interactive terminal's shell environment. Do not install or upgrade a CLI implicitly while launching the window.

## Packaging and upgrades

Use Xcode and Apple's native build tools for the desktop target while retaining Bun for the existing platform. This proposal requires an explicit addition of a native toolchain when implementation begins; it does not replace the repository's TypeScript tooling or authorize a runtime migration.

Distribute directly with Developer ID signing, Hardened Runtime and notarization, following [Apple's distribution guidance](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution). The initial design targets distribution outside the Mac App Store and does not assume App Sandbox compatibility with arbitrary agent subprocesses and workspace access.

Validate signing and the minimum necessary entitlements for bundled Bun and helper executables in the packaging prototype. Downloaded runtime and app updates need integrity verification. A successful debug launch is not the release acceptance test.

The client-only release uses manual updates and never updates a connected service. Later managed updates must coordinate the helper, Bun runtime and server resources, defer disruptive restarts while work is active, and preserve workspace data. Back up before a database migration. Binary rollback alone is insufficient after an incompatible schema change; recovery must use a compatible migration path or an explicit backup restore.

Uninstalling the desktop UI preserves workspace data. Managed mode needs a Remove Background Service action before deleting the application bundle. Deleting apps, databases or credentials is a separate, explicit operation.

## Implementation sequence

| Stage | Deliverable | Completion gate |
| --- | --- | --- |
| 0 — WebKit prototype | A minimal native window loading an existing Space | Local panel, Chinese input, chat streaming, terminal, uploads and theme work on supported macOS versions; remote access flow is classified as supported or blocked |
| 1 — Desktop client | Native connection settings, lifecycle, navigation policy, errors and signed distribution | A clean Mac can connect to an existing Space; remote-only use needs no Bun; quitting leaves server work intact |
| 1b — Hub and Peer configuration | Shared Peer settings, operator API, Hub-side connection tests and live reconciliation | Adding, editing and removing a Peer changes only the selected Hub; credentials remain redacted; stale data and failed changes are handled correctly |
| 2 — Desktop conveniences | Menu bar entry, optional shortcut and notification integration | Features remain optional; denied permissions and reconnects work; notifications do not duplicate the web or chat channels |
| 3 — Managed local service | Packaged runtime, first-run setup, helper ownership and repair | Clean installation needs no developer checkout; one backend per workspace; external installations remain intact |
| 4 — Managed upgrades | Coordinated updates and recovery | Active-work handling, migration failure and helper replacement are exercised on signed builds |
| 5 — Selected native screens | SwiftUI replacements chosen from observed usability problems | Native and web clients share API behavior; accessibility improves without duplicating business logic |

Stage 0 is a decision gate. If WKWebView cannot support a required terminal, authentication or rendering workflow acceptably, resolve that gap or narrow the supported release before building more native UI. No resource-usage or schedule estimate is promised before this prototype is measured.

## Proposed code organization

Keep the desktop client in this repository so bridge changes and compatibility tests can evolve together. It lives in `desktop/macos/`:

```text
desktop/macos/
  project.yml            XcodeGen spec; AISpace.xcodeproj is generated from it
  AISpace/
    AISpaceApp.swift     app, main window (close hides it), menu bar, menus, Services, aispace:// links
    AppModel.swift       connections, web sessions, conversations, link routing
    Services/            Foundation only: connection rules and store, SpaceCheck, SpaceAPI and
                         cookies, the run stream parser and reply builder, inbox and link rules
    Desktop/             SpaceLive (polled data), ChatController, QuickChat, AppWindows (moved-out tabs),
                         Notifier, HotKey, Preferences
    Web/                 PanelSession (WKWebView and its delegates), NavigationPolicy
    Views/               sidebar, chat, inbox, menu bar, status screens, settings
    Resources/           icon, English and Chinese strings
  AISpaceTests/          swift-testing tests of the Foundation-only code in Services/ and Web/
  scripts/               build.sh and test.sh (swiftc only)
```

Add `src/web/desktop.ts` only when a real bridge consumer exists. Keep backend identity and managed lifecycle changes in the relevant Space modules. Add reproducible desktop build and test entry points to `package.json` that invoke Apple tools on macOS; existing Bun commands continue to work without Xcode on servers.

Open an implementation issue or state the motivation in the PR description before starting the native feature. Split the client, bridge and managed installation into independently reviewable changes.

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

Use swift-testing (which runs from the Command Line Tools as well as Xcode) for meaningful native policy and lifecycle tests and Bun tests for changed Space behavior. Run the repository's full required validation before each implementation push. Add managed-mode tests for duplicate startup, helper approval denial, logout, failed upgrade, recovery and uninstall only when that milestone is implemented.

Measure cold launch to usable panel, idle memory across the app and WebKit processes, and behavior under a long chat and terminal session. Record the machine, OS and whether the independent Bun service is included. Compare against the same workload in Safari; native packaging alone is not evidence of lower resource use.

The first release is complete when an operator can reliably open an existing Space as a Mac application, perform the current web workflows, and close or quit the UI without disrupting server work. An installer that provisions a new Space is the managed-service milestone, not an implicit part of the first release.

## Build and run

The client builds with `swiftc` alone, so the Command Line Tools are enough; Xcode is optional. Run from the repository root on macOS 14 or later:

```bash
bun run desktop:test     # build and run AISpaceTests
bun run desktop:build    # desktop/macos/build/AISpace.app, ad-hoc signed
open desktop/macos/build/AISpace.app
CONFIG=debug bun run desktop:build                       # Web Inspector on, state changes logged
SIGN_IDENTITY="Developer ID Application: …" bun run desktop:build   # then notarize
bun run desktop:xcode    # regenerate AISpace.xcodeproj after adding or moving files
```

These commands are not part of `bun run check`; servers and Linux never need them. The macOS 27 Command Line Tools declare SwiftUI's `@State` as a macro whose plugin only Xcode ships, so view state lives in small `ObservableObject`s, and native strings use `.strings` tables because compiling a String Catalog needs Xcode.

## Native-first client

The first build was a panel in a window: a browser that could only open ai-space. The operator's direction (2026-10-08) is that the desktop app must not be another browser, so the native layer now carries what a browser cannot, and pulls forward items this document had placed in stages 2 and 5:

| Native | What it does | Space routes it uses |
| --- | --- | --- |
| Main window | A sidebar of the selected Space: Home (the panel), Inbox, Agents, Apps; no address bar, reload or browser toolbar | `/api/apps`, `/api/agents` |
| Agent chat | Native conversations, shared by the main window and Quick Chat; a dropped stream reattaches after the last event; Stop ends the run | `POST /api/agents/:app/:agent/chat`, `/runs/:id/events?after=`, `/runs/:id/stop`, `/api/agents/runs` |
| Quick Chat | A floating panel over any app on a global shortcut (⌥Space by default, Carbon hot key, no Accessibility permission) | as above |
| App tabs and windows | An app opens as a tab of the main window, listed in the sidebar; the operator can move any tab into its own window and back (⌥⌘T, toolbar or context menu) without reloading it; links to an app's origin from the panel, the inbox or a notification open in its tab or its window | `/api/apps` (`url`) |
| Inbox | Native list with read and done; new unread threads become Mac notifications with Mark as Read and Done; the unread count is the Dock badge | `/api/inbox?filter=open`, `/api/inbox/mark` |
| Menu bar | Per connection: agents working, unread messages, app shortcuts, Quick Chat | all of the above |
| Mac integration | Services > Ask ai-space puts selected text into Quick Chat; `aispace://chat?agent=<app>/<agent>&text=…`, `aispace://open?app=<name>` and `aispace://inbox` for Shortcuts and other apps | none |

How the native calls authenticate: the operator signs in once on the Home page, inside the window. Native requests then carry that connection's WebKit cookies (for Cloudflare Access, `CF_Authorization`), never Safari's, and no operator token. Redirects are not followed: a redirect, 401 or 403 means "sign in on Home", which the sidebar and menu bar show. The panel routes accept these writes because a request without `Origin` or `Sec-Fetch-Site` is not a browser page (`src/space/auth.ts`).

Safety rules the native layer keeps:

- A link or a Service may fill in a Quick Chat message but never sends it; any web page can open an `aispace://` link.
- Web content still has no bridge or script message handler; the native views talk to the Space directly.
- The first look at a connection's inbox only records it, so connecting does not flood the screen; later notifications are new or changed unread threads.
- A background refresh every 30 seconds keeps the menu bar and notifications current while the window is hidden; the app opts out of App Nap for it but still lets the Mac sleep.

Not done, and why:

- The Mac as a resource agents can use (its files, calendar, screen) needs its own trust design: what an agent on a server may ask of this Mac, how each request is approved, and how that stays narrower than a remote shell. It is the next design task, not part of this client.
- A Share extension and App Intents need Xcode to build (an extension target and the App Intents metadata processor); the Services entry and `aispace://` links cover the same uses until then.
- Checks on the menu bar: `/api/checks` lists definitions whose state each app serves at its own URL; reading them all belongs in the Space, not in the client.

Also still open for the stage 0 gate: completing the Cloudflare Access sign-in inside WKWebView, Chinese input, the terminal WebSocket, uploads and themes, each checked by hand on the oldest and current supported macOS.

Checked on macOS 27 against a scratch Space: the panel reports ready; the sidebar lists the Space's agent; an inbox message posted with `POST /api/notify` is picked up by the next refresh; a chat turn streams from start to "thinking" to the reply and ends cleanly through the native client. The Seoul Hub behind Cloudflare Access reports sign-in needed until the operator signs in on Home; after signing in there, the native views load its 39 apps, 16 agents and inbox with that session, and an app opened by link loads as a tab on its own Access-protected host.
