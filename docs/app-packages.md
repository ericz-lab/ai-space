# Application packages and connected Spaces

Tracking: [issue #3](https://github.com/ericz-lab/ai-space/issues/3), Seoul Todo #116 (children #117–#127).

## Motivation and implementation boundary

An application should install from a portable artifact and run locally without an internet connection when its features permit it. Installing it must not implicitly start a permanent service or share it with another machine. A peer can use applications granted by its Hub; the peer separately controls whether that Hub can discover and use its local applications.

Implemented: format-1 index/spec-2 manifest validation, `space app pack` and `space app inspect-package`, bounded archive reading, file integrity and Ed25519 signature verification. The local installation API now stages and publishes verified files with a persistent operation journal. After file installation, the package runtime provisions storage and registers its lifecycle. Background processes start explicitly; on-demand processes wait for a lease, and static applications have no child process. Receipt-verified packages register their pages, tasks, agents and local service components. The panel/CLI manage installations and connections, and a separate gateway serves local and authorized remote apps. The raw legacy loader still accepts **spec 1 only** so source sync cannot bypass package validation.

## Build and inspect a package

Build the application with its own checked-in Bun scripts first. Select prepared files/directories explicitly; the manifest is always included:

```sh
bun run space app pack ./prepared-app --include web,agents,skills --output ./notes-1.0.0.spaceapp
bun run space app inspect-package ./notes-1.0.0.spaceapp --check-host --json
```

The packer makes no network/model calls and runs no build/install hooks. Output must be outside the source tree and must not already exist. Directories are traversed in sorted order; timestamps/ownership are normalized so identical inputs produce identical archives. Excluded files are reported. Symlinks (including dependency links) are rejected: bundle dependencies into prepared outputs first. An installation may rely on an already-installed compatible host Bun but must not fetch dependencies on install. Packing cannot prove arbitrary application code never uses the network; offline features require the acceptance tests below.

Use `--target linux/arm64` (or another supported pair) for native artifacts and `--source-included` when shipping source. `any/any` is the default and rejects recognized native binary headers. Native launch entries must be executable. A concrete target is the publisher's declaration; cross-platform execution needs testing on that target.

To sign, pass `--sign-key /path/to/ed25519-private.pem`; keep keys outside the staging tree. Inspect with `--trusted-key /path/to/publisher-public.pem`. Signature status is `unsigned`, `untrusted` (no matching independently supplied key), or `verified`; a wrong signature for a supplied trusted key fails inspection. Successful inspection alone is not an installation trust decision. The current reader/packer imposes a 128 MiB compressed and decompressed working limit, below the format ceiling, and rejects oversized input. Inspection verifies the entire payload without extracting it.

## One application declaration

`app/space.yaml` owns application identity, version, launch behavior and the existing tasks, agents, skills, storage, events and other components. The outer index does not repeat application identity or capabilities. Source inclusion is a distribution property, not an access policy.

```yaml
spec: 2
name: notes
version: 1.0.0
title: Notes
requires:
  spaceApi: 1
offline:
  features: [Read and edit notes]
  online: [Cloud model summaries]
launch:
  kind: static
  root: web
  index: index.html
```

A process launch replaces `launch` with:

```yaml
requires:
  spaceApi: 1
  bun: 1.3.0
launch:
  kind: process
  runtime: bun
  entry: dist/server.js
  args: []
  mode: on-demand
  idleTimeoutMs: 300000
  health: /healthz
```

`runtime: native` executes a packaged executable and does not require Bun. A runtime dependency may instead be met by the already-installed Space host, verified before installation; offline installation never downloads it silently. Native artifacts require a concrete OS/CPU target. Static files require no app process. Omit `launch` for a task/agent-only application. `mode: background` explicitly requests a persistent process and cannot set an idle timeout. `on-demand` is the default for processes. Health paths have no authority, query or fragment. Argument arrays are passed to a process without shell evaluation.

Application names are explicit, lowercase, at most 64 characters, and use `[a-z0-9][a-z0-9._-]*` except `.` and `..`. Version strings use numeric `major.minor.patch` (no ranges, prereleases or implicit latest in this initial format). `requires.spaceApi` is an integer API compatibility floor, separate from the app version, manifest spec and archive format. `requires.bun`, when present, is the minimum installed Bun release. Existing component definitions remain in their established sections. New cron tasks must declare their IANA zone; one-shot timestamps require an offset, as specified in [time.md](time.md).

Spec 2 rejects the legacy `service`, `url` and `deploy` fields: they could encode a fixed host port, public URL or install-time network command. A launch creates the app's logical `main` entry. The host resolves that entry to a URL and injects its assigned port/environment. This does not remove source build commands from the project's `package.json`; build them before creating the artifact. Optional online features are declared as user-readable descriptions; this is a claim to test, not automatic network isolation.

## Artifact format 1

The `.spaceapp` artifact is a gzip-compressed USTAR archive. The strict archive reader accepts regular files only: no links, devices or extension headers. It checks the entire index and archive before any activation. The outer files are:

```text
package.json          format, target, sourceIncluded, files
package.sig           optional detached Ed25519 signature envelope
app/space.yaml        the only application declaration
app/...               indexed payload files
```

`package.json` contains exactly `format: 1`, `target: { os, arch }`, `sourceIncluded: boolean` and `files: [{ path, size, sha256, executable }]`. Paths are relative to `app/`; the SHA-256 digest covers exact bytes. The index must list every payload file, including a non-executable `space.yaml`. It has at most 100,000 files and at most 4 GiB of declared unpacked bytes; metadata is at most 32 MiB. The reader must also enforce limits while decompressing, not only trust declared sizes. The packer should use a tighter configurable operator limit when appropriate.

Targets are `any/any`, `linux/x64`, `linux/arm64`, `darwin/x64` or `darwin/arm64`. Portable means both OS and architecture are `any`; incompatible targets fail before execution. Paths are canonical relative POSIX paths using ASCII letters, numbers and `_@.+/-`, with no empty/dot/parent segments, backslashes, encoded separators or segments ending in a dot. Case-insensitive collisions and file/directory collisions are rejected on all hosts. This conservative initial policy makes a package mean the same thing on Linux and macOS; it can be versioned if broader names become necessary.

Do not include credentials, `.env` (except `.env.example`), databases, logs or user data. Explicit file selection, built-in exclusions and review precede packing. An index checksum proves integrity, not publisher identity. The detached signature must cover the **exact bytes of package.json**, which bind all payload digests. Trust derives from a host-owned publisher-key allowlist; a public key supplied in the same package cannot grant itself trust. Missing/untrusted signatures require an explicit local trust decision; remote installation must not infer trust from upload permission. The signature envelope is `{ algorithm: "ed25519", keyId, signature }`, at most 4096 bytes. `keyId` is the lowercase SHA-256 digest of the DER SPKI public key; `signature` is the canonical base64 encoding of its 64-byte signature. There is no self-authorizing `trusted` manifest flag.

## Installation identity and ownership

An installation key is `(spaceId, appId)`. A Space creates and persists a random UUID v4 at initialization; an alias such as `seoul`, a hostname, a URL or a port is not that identity. Reconnecting or renaming preserves identity; cloning a workspace onto an independent active machine must create a new Space identity. One installed version per app ID per Space is the initial model. Multiple Spaces can independently install the same app.

Application code remains in `apps/<app>` and state in `data/<app>`; development stays in `app-src/<app>`. Activation must journal intent and retain the last working version. Data migrations have their own backup and compatibility plan: switching program files back cannot undo a database migration. Installation, use, management and sharing are different operations and permissions.

## Lifecycle and gateway

The host serves static applications and activates processes on demand. Active requests, streaming connections and background work hold leases; closing one browser tab cannot kill work used by another. Task-only apps are awakened by the scheduler without a page or permanent app service. Tasks run only where the application is installed, never on machines displaying its catalogue.

The gateway resolves a logical entry using installation identity, checks grants at the owning Space, activates if necessary and serves or proxies the result. It must support HTML, resources, API methods, uploads, redirects, SSE and WebSocket. It must isolate application origins/storage and preserve authentication and CSRF boundaries. A naive path prefix under the operator panel's origin is not an acceptable substitute. Caddy is an optional TLS/domain edge; removing it does not remove the obligation to implement isolation, certificate handling or routing. Offline local access cannot depend on public DNS or an online certificate service.

## Connection and directional grants

Connecting a client to a Hub is not registering its machine as a peer. A peer connection establishes identity and a channel; it is not a blanket authorization. For a connection:

| Direction | Effective access |
| --- | --- |
| Peer → Hub | Hub's explicit grant of discover/use on selected applications |
| Hub → peer | Disabled by default; peer enables selected applications and may revoke |
| Peer A → peer B | No transitive grant merely because both connect to the Hub |
| Remote install/manage | Separate operator grant, never implied by application use |

The owning Space enforces grants on HTTP and streaming requests. A revoked grant also closes affected persistent connections. A peer may initiate an outbound authenticated connection to a Hub, allowing authorized reverse requests without a publicly reachable peer port. Reconnection must preserve identity and must not widen grants. Secrets stay on the server. These are service authorization rules, not an OS sandbox for arbitrary same-user code.

## Offline behavior and migration

Disconnecting from a remote Hub leaves local installed applications accessible through the local Space. Unreachable remote installations are shown as unavailable; never silently substitute another installation's data. A remotely installed app is not a local offline copy. Replication and conflict resolution are a separate feature.

Spec-1 deployments remain unchanged until explicitly migrated. Migrate launch/host settings into spec-2 launch and host-owned installation settings, build the artifact, preserve data and switch deployment ownership. Never let a Git hook and a package installer mutate the same live directory. Raw spec-2 directories are rejected by the legacy loader; installed packages enter through their verified receipt. Pilot representative applications before a fleet migration; no production migration is implicit in this design.

Delivery order is the Todo sequence: contract; pack; install; lifecycle; connection/grants; gateway; tasks/agents; upgrade/recovery; CLI/UI; migration; end-to-end validation. Each stage records implementation evidence and remaining limits. Offline installation/start/use, denied reverse access, revoked streams, failure recovery and absence of duplicate tasks are release acceptance criteria.

## Local installation API

`POST /api/packages` accepts `application/octet-stream` with the package bytes. It requires the operator credential when configured, is subject to the same-origin write guard, and limits both buffered uploads and installation work to two concurrent operations. `Idempotency-Key` accepts a UUID v4; reusing it with different bytes fails. Query `GET /api/packages/operations/:id` after an uncertain response rather than blindly repeating a write. `GET /api/packages` lists operations and the persisted Space identity. Time fields are UTC ISO instants.

`SPACE_PACKAGE_TRUST_KEYS` contains comma-separated public-key file paths (workspace-relative or absolute). An upload cannot add a trust root. An operator may explicitly send `X-Space-Allow-Unsigned: true` for an unsigned artifact; that does not accept an untrusted signed package or grant a peer installation rights. The future peer installation API must have separate management authorization.

The installer validates the entire package and compatibility before reserving an operation. It checks disk capacity, writes only regular files to a private `run/packages/<operation-id>` staging directory, syncs file contents, creates a host-owned `.space-install.json` receipt and publishes to `apps/<app>`. The destination must be absent: existing directories and symlinks require an explicit migration/upgrade workflow. It never changes `data/<app>`. A successful result means files are installed, not that the application is running.

The journal and Space UUID live in additive tables in `space.db`. At service startup, interrupted operations whose published files match their receipt are completed; missing or altered files produce a failed operation without executing code or deleting an existing app tree. An interruption during an empty destination reservation may leave that empty directory for operator inspection; recovery does not guess ownership and delete it. Shutdown drains in-progress installation work before closing the database. The upgrade journal and retained versions extend this recovery model as described below; neither path claims automatic restoration of application databases or every physical power-loss failure.

## Package process lifecycle

The host loads installed applications from its journal and receipt, checking hashes and compatibility before registration. `GET /api/packages/apps/:app/runtime` is operator-only and reports static/idle/starting/running/failed/paused state, active lease count and an internal port when running. It is not a public application URL. File installation may succeed while activation fails; the upload response then includes the installed operation and a separate activation error.

`PackageRuntime.acquire` shares a single startup across concurrent requests. Each caller releases its lease exactly once when the work ends. An idle process stops only after the last release and its declared idle interval. Background processes remain running and restart after crashes with bounded backoff. Health waits time out; failed starts terminate the child and release the caller's lease. Static serving permits only indexed regular files under the declared root and rejects links and path traversal. The app gateway must hold process leases through response streams and WebSocket lifetimes.

Child environments receive provisioned app variables and PATH, not the operator's entire environment. Launch arguments are never evaluated by a shell. Logs append to `logs/<app>/package.log`. Linux uses `setsid` when available to stop the process group; on other hosts or without setsid only the direct process is terminated, matching the current runtime runner limitation. Packaged processes must terminate their own child work on SIGTERM. A forced stop follows a 10-second grace period. Dynamic loopback port selection is checked by startup health; a bind race surfaces as startup failure rather than granting a permanent port from the package.

## Connected Space API

The package connection protocol is separate from legacy `SPACE_PEER_*` snapshots and `SPACE_HUB_TOKEN`. Existing credentials do not silently acquire package access. Operator-only routes create and change connections:

- `GET /api/connections`: this Space UUID and sanitized connection state.
- `POST /api/connections`: `{ remoteSpaceId, direction, apps? }` for incoming connections, plus `{ url, tokenEnv }` for outgoing connections.
- `PATCH /api/connections/:id`: `{ apps?, enabled? }`; apps always refer to applications owned by this machine.
- `DELETE /api/connections/:id`: close the connection's work and delete it with its grants and incoming credential. A connection's endpoint, credential name and remote identity cannot be edited: remove it and create it again. `PATCH` with `enabled: false` disconnects and keeps it.
- `POST /api/connections/:id/rotate`: issue a new incoming token, returned once.

First create an incoming connection on the Hub bound to the peer UUID, selecting which Hub app IDs it may use. The token is returned only on creation/rotation and stored as a hash. Put that token in the peer workspace environment, then create an outgoing connection there naming the Hub UUID, HTTPS origin and the token's environment-variable name. Plain HTTP is accepted only for a loopback endpoint. Outgoing connection credentials are never copied into connection catalogue responses or uploaded grant definitions. The server environment must contain the credential before it connects.

The peer opens an authenticated WebSocket to `/api/connections/channel`; the Hub verifies the token and peer UUID, and the peer verifies the Hub UUID in the protocol handshake. The single connection carries requests in both directions, so authorized Hub access requires no inbound peer port. Both sides default to an empty local application grant. To allow Hub access, the peer sets its outgoing connection's `apps` list. Grants do not transit through the Hub to other peers, and application use never authorizes installation, a shell, or operator APIs. Grant changes, disable and rotation close affected connections and all in-flight streams before reconnecting.

The channel supports at most 16 concurrent request streams, 32 KiB body chunks with consumption credit, bounded metadata frames and a 30-second response-header deadline. Response bodies stream until completion/cancellation; a physical disconnect aborts all active requests. Incoming sockets use the existing 25-second server ping. Outgoing connections retry while enabled. Protocol 1 exposes the authorized local catalogue and application HTTP/WebSocket transport through the gateway below.

## Application entry gateway

Set `SPACE_PACKAGE_PORT=8702` to enable the separate loopback app server. Keep this port stable: changing an origin changes its browser storage. Operator-only `POST /api/packages/open` takes `{ app, spaceId, connectionId? }` and returns a short-lived, single-use browser entry URL. Local entries use installation-specific `*.localhost` origins. They require neither Caddy nor public DNS; the browser and Space must be on the same machine. App traffic cannot reach the panel's operator routes on this server.

For a browser accessing the Seoul server directly, set `SPACE_PACKAGE_BASE_URL=https://apps.example.com` and route `*.apps.example.com` through wildcard DNS, TLS and ingress to the gateway's loopback port, preserving Host. Caddy can provide that edge, as can an existing TLS proxy/tunnel. Use a dedicated app domain, separate from the operator panel and its cookies. Installing a package does not open a public port or create DNS/TLS configuration. A peer with its own Space can instead open Hub apps through its local gateway over its authenticated outbound channel.

The entry ticket lasts 30 seconds and creates a host-only, HttpOnly, SameSite=Strict session lasting 12 hours (Secure on HTTPS). Tickets and sessions remain only in host memory and expire on restart. The gateway forwards app cookies and authorization headers, never its own session cookie or the operator credential. Server-set cookie Domain attributes are removed; installation-specific origins isolate browser storage. Origin checks protect writes and WebSocket upgrades. Installed same-user application code remains trusted code, not OS-sandboxed code.

The gateway proxies arbitrary local app paths, standard API methods, uploads, redirects, multiple cookies, range headers and streaming responses. Process leases remain held until response completion or cancellation. WebSocket text/binary frames and the selected subprotocol travel through the same peer-initiated channel; each message is limited to 1 MiB with bounded queues. Disconnects and grant revocations close active requests and sockets. Absolute redirects pointing to the app's loopback origin become relative; redirects to external sites remain external. Applications should use relative asset/API URLs and must not publish hardcoded loopback ports.

## Installed tasks and agents

Receipt-verified packages now register with the local scheduler and app/agent registry at boot, install and explicit sync. Raw spec-2 source directories still cannot enter through the legacy manifest loader. Repeated sync retains task IDs, run history and operator overrides; tasks removed from a manifest, or belonging to a paused app, become orphaned instead of being duplicated. Cron declarations require an explicit IANA timezone. The scheduler applies its existing missed-run, concurrency, timeout and retry rules.

A package HTTP task uses a local absolute path, for example `run: { http: { url: /jobs/refresh } }`. The host acquires the app process, resolves its current private port and holds the lease through the response. Explicit HTTPS task URLs are external dependencies; fixed loopback HTTP URLs are rejected. Commands and agent tasks hold the installed code without starting the web process, so task-only apps need no service. Agent prompts and working directories resolve inside the actual installation; interactive turns retain their lease after a browser disconnects. Agent runtimes and online model credentials remain host configuration and do not make an AI-dependent feature offline.

Shared skills are linked after installation using the existing workspace skill discovery. Storage, notifications, task-trigger event subscriptions and backup tasks use the existing host services. Local checks, item widget feeds and bus HTTP providers acquire the package's dynamic service through the gateway. Deep links open the isolated application origin. Embedded iframe widgets are rejected until an isolated iframe session flow is available. Agent use through a package connection is not exposed by protocol 1's app-page grant.

The catalogue answer carries the sharing Space's UUID, its `SPACE_NAME` and the granted apps. A Space keeps the last catalogue of each enabled connection in memory, refreshed every 30 seconds and after a connection changes, and lists every shared app that has a page in `GET /api/apps` next to its own: `id` is `<space name>/<app>` (the first eight characters of the UUID when the other side sends no name), `peer` is that name, `connection` the connection ID and `url` the connection entry route. A catalogue entry carries a text icon as `icon`, or `iconFile: true` when the manifest icon is an SVG, PNG or WebP file of the package; the `icon` operation on the channel returns that file for a granted app (at most 512 KiB), the using Space fetches it once per version and serves it from `GET /api/panel/shared-apps/:connection/:app/icon` with the headers of an uploaded pack icon. An answer whose UUID differs from the connection's is ignored. While a Space does not answer, its apps stay listed with `stale: true`; disabling or removing the connection drops them. A local app or legacy peer app with the same `id` wins. Such an entry can be reordered and hidden like any tile but not uninstalled here.

Remote catalogues do not create local scheduled tasks or agent registrations. Legacy peer snapshot, event, agent and app routes exclude package installations; old Hub credentials do not gain package access when a package joins the local registry. Package removal is refused by the legacy app-uninstall route and must use the package lifecycle workflow.

## Upgrades, rollback and removal

Upload to `POST /api/packages` with `X-Space-Upgrade: true` to replace an installed app. Publisher trust and complete artifact validation still apply. Each mutation accepts a UUID `Idempotency-Key`; query `GET /api/packages/changes` after an uncertain response. Changes have `pending`, `done` or `failed` state and UTC ISO timestamps. Keep the same key when retrying the same request.

An upgrade installs into a private staging workspace, then takes an exclusive runtime suspension. Active HTTP/WS requests, scheduled runs and agent turns refuse the change rather than being killed. New work cannot acquire a lease during replacement. The previous program tree moves to `run/package-changes/<change-id>/previous`; the new tree takes its stable `apps/<app>` path. Registration, task overrides and browser origin remain associated with the same installation identity. After activation the host starts a process application once and waits for its health path, on-demand ones included, before the change is recorded as done; the on-demand process then stops after its idle interval. A failed activation or startup restores the previous code and registers it again. At restart, a pending mutation restores receipt-verified previous code before any package starts. Unknown or altered trees leave that application's recovery blocked for inspection: its change stays pending, the application is not activated and accepts no further change, the reason is logged at boot, and the rest of the Space starts. They are never overwritten speculatively.

`POST /api/packages/apps/:app/rollback` takes `{ operationId }`, naming a retained installation from `GET /api/packages`. `DELETE /api/packages/apps/:app` stops and unregisters an unused app and retains its program tree. The old panel-uninstall route cannot bypass this workflow. Both operations require operator authorization. Data directories, provisioned databases, secrets and configuration are retained; there is no implicit data purge. Retained versions currently require deliberate operator cleanup after backup, with no automatic retention pruning.

These are **code** rollbacks. App startup may perform its own database migrations or make external writes; switching program files back cannot reverse those changes. Publishers must keep data backward-compatible within versions intended for rollback, and operators must take a verified application backup before an incompatible migration. Arbitrary migration scripts and automatic database restore are not part of this version. Directory syncs protect the main rename boundaries, but this is not a claim of transactional rollback of every filesystem/database or sudden-power-loss scenario. Cross-filesystem staging is unsupported: workspace apps and run directories must share a filesystem.

## Panel controls

Settings → Application packages installs/uploads packages, switches versions, removes unused installations while retaining data, lists local and connected app entries, creates connections and selects individual local apps to share. Application pages also open from their local library tile, and apps shared by a connected Space appear in the app grid and library labelled with that Space's name. Remote outages are shown as unavailable; a remote app is never substituted with an unrelated local copy. The CLI offers the same lifecycle and connection operations (see `docs/cli.md`). Connecting an outgoing peer currently references a credential already provisioned in its host environment; the UI never reads existing tokens back.

`/api/panel/packages/*`, `/api/panel/connections/*` and `/api/panel/package-catalogue` use the existing operator panel trust boundary: the whole panel must remain behind the operator's loopback/ingress authentication, and the global same-origin write guard applies. They do not require the CLI bearer token in browser JavaScript. These routes are never mounted on the isolated app gateway. Incoming connection tokens are shown once to the operator who creates/rotates them. Package use grants do not expose any panel-management route. `/_space/apps/:app` and the corresponding connection entry route issue temporary app sessions without putting operator credentials in app URLs.

The upload UI saves its operation ID locally before sending the artifact, shows ongoing work, and re-queries recorded state after a refresh. An uncertain response blocks another upload until that operation is checked or deliberately dismissed; dismissing a notice does not cancel server work. The target is the Space whose panel is open. Use a separately authenticated target panel, or the CLI's `--url` with that target's operator credential, to install elsewhere; a use-only connection is never treated as a deployment grant.

## Existing applications

Follow [package-migration.md](package-migration.md) to build a release without changing a source deployment manifest, move secrets into the data directory, rehearse a cutover and retire the old deployment owner. The repeatable `package-pilot` command uses an isolated keep source checkout and synthetic data; it does not migrate a running fleet.

Acceptance lanes and their limits are recorded in [package-validation.md](package-validation.md), including blocked-internet execution, Seoul Linux tests and the optional Caddy edge check.
