# Application packages and connected Spaces

Tracking: [issue #3](https://github.com/ericz-lab/ai-space/issues/3), Seoul Todo #116 (children #117–#127).

## Motivation and implementation boundary

An application should install from a portable artifact and run locally without an internet connection when its features permit it. Installing it must not implicitly start a permanent service or share it with another machine. A peer can use applications granted by its Hub; the peer separately controls whether that Hub can discover and use its local applications.

Implemented in the first stage: pure validation of the format-1 package index, spec-2 application manifest, compatibility requirements and installation identity. These functions neither execute files nor register applications. The running app registry still accepts **spec 1 only**. Pack/install commands, activation, grants and the gateway are subsequent stages, not available merely because a declaration validates.

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

The `.spaceapp` artifact is a gzip-compressed tar archive. The planned strict archive reader accepts regular files only: no links, devices or executable install hooks. It checks the entire index and archive before any activation. The outer files are:

```text
package.json          format, target, sourceIncluded, files
package.sig           optional detached Ed25519 signature envelope
app/space.yaml        the only application declaration
app/...               indexed payload files
```

`package.json` contains exactly `format: 1`, `target: { os, arch }`, `sourceIncluded: boolean` and `files: [{ path, size, sha256, executable }]`. Paths are relative to `app/`; the SHA-256 digest covers exact bytes. The index must list every payload file, including a non-executable `space.yaml`. It has at most 100,000 files and at most 4 GiB of declared unpacked bytes; metadata is at most 32 MiB. The reader must also enforce limits while decompressing, not only trust declared sizes. The packer should use a tighter configurable operator limit when appropriate.

Targets are `any/any`, `linux/x64`, `linux/arm64`, `darwin/x64` or `darwin/arm64`. Portable means both OS and architecture are `any`; incompatible targets fail before execution. Paths are canonical relative POSIX paths using ASCII letters, numbers and `_@.+/-`, with no empty/dot/parent segments, backslashes, encoded separators or segments ending in a dot. Case-insensitive collisions and file/directory collisions are rejected on all hosts. This conservative initial policy makes a package mean the same thing on Linux and macOS; it can be versioned if broader names become necessary.

Do not include credentials, `.env` (except `.env.example`), databases, logs or user data. Explicit file selection, built-in exclusions and review precede packing. An index checksum proves integrity, not publisher identity. The detached signature must cover the **exact bytes of package.json**, which bind all payload digests. Trust derives from a host-owned publisher-key allowlist; a public key supplied in the same package cannot grant itself trust. Missing/untrusted signatures require an explicit local trust decision; remote installation must not infer trust from upload permission. Implement signature verification and canonical envelope limits with the packer/reader, not a fake `trusted` manifest flag.

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

Spec-1 deployments remain unchanged until explicitly migrated. Migrate launch/host settings into spec-2 launch and host-owned installation settings, build the artifact, preserve data and switch deployment ownership. Never let a Git hook and a package installer mutate the same live directory. The legacy registry must reject spec 2 until activation and registration enforce these semantics. Pilot representative applications before a fleet migration; no production migration is implicit in this design.

Delivery order is the Todo sequence: contract; pack; install; lifecycle; connection/grants; gateway; tasks/agents; upgrade/recovery; CLI/UI; migration; end-to-end validation. Each stage records implementation evidence and remaining limits. Offline installation/start/use, denied reverse access, revoked streams, failure recovery and absence of duplicate tasks are release acceptance criteria.
