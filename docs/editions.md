# Editions: Server, Client and Local

Status: plan. None of the three editions ships as a release yet. This document says what each one is,
where the lines between them run, and what has to exist before each can be published. The work
itself is tracked in separate items: the release pipeline, optional GitHub and Cloudflare, the
built-in user system, and the Mac standalone install (see [The work, in order](#the-work-in-order)).

## Why

Today ai-space is installed by someone who can run a server: a Linux machine, a domain on
Cloudflare, a tunnel and an access layer, GitHub CLI, and a coding agent to build apps with
([install.md](install.md)). That suits an operator and shuts out everyone else. The goal is a product
that works as soon as it is installed and grows only when you ask it to. You start on your own
machine and add outside access, a server, backups and more machines only when you need them. You
still choose which model or agent it uses.

Splitting the product into three editions keeps both kinds of use. A server that runs all day and is
reached from anywhere stays a supported way to run ai-space. A person who has never opened a terminal
gets a Mac app that does everything for them.

## The three editions

| Edition | What it contains | How it is used | Who it is for |
| --- | --- | --- | --- |
| **AI Space Server** | The Space service, the web panel, the app runtime | Installed on a server or an always-on machine; reached from a browser or a client | People who need it running all day and reachable from elsewhere |
| **AI Space Client** | The native client only | Installed, then connected to an existing Space; no Space service runs on this machine | People who already have a Space, or only use Spaces on other machines |
| **AI Space Local** (working name) | The native client, the Space service, its runtime (Bun) and the bundled apps | Installed, it creates a Space on this machine on first launch; it can also connect to remote Spaces | People who want it to work out of the box |

All three are one product: the same source tree, the same version number, the same Space API.
What differs is how each one is packaged, installed, started and updated.

## Rules every edition keeps

1. **One codebase, one version.** A release tag builds all three. The version lives in
   `package.json`; the native projects carry copies that `bun run set-version <x.y.z>` rewrites and
   a test keeps equal. Which clients work with which services is decided by the API level the
   service reports ([Service identity](#service-identity)), checked when connecting, not assumed.
2. **Program and data are separate.** The workspace stays `$SPACE_HOME` or `~/.ai-space`
   ([machines.md](machines.md)): apps, databases, logs, configuration and credentials. The program
   lives elsewhere: an `.app` bundle, or a release directory on a server. Replacing, moving or
   uninstalling the program never deletes workspace data. Deleting data is a separate, explicit
   action.
3. **Extensions are optional.** A domain, Cloudflare (Tunnel, Access, R2), GitHub CLI, S3 backups,
   chat notifications and peers are added after installation, each on its own. None of them is
   required to install, start, or use a Space on loopback.
4. **AI access is configured, not bundled.** "Local" means the Space runs on this machine, not that
   every AI feature works offline. Agents and model calls still need a runtime (Claude Code, Codex, an
   API key) chosen and set up by the user ([runtimes.md](runtimes.md)). The first run guides that
   setup. It never installs or upgrades an agent CLI silently.
5. **Mac first.** Each edition is published only for the systems and CPU architectures that were
   built and tested. Mac on Apple Silicon is first. Linux x64 and arm64 follow for Server. Windows and
   Intel Macs are accepted one by one.

## AI Space Server

**Contains** the Space service, the web panel's assets, the shared skills and templates, and
scripts that create a workspace and register a background service.

**Installs** from a release archive per system and architecture (for example
`ai-space-server-<version>-linux-x64.tar.gz`), or from source as today (`deploy/install.sh`, the
git-push deploy of `deploy/post-receive`). The source channel stays.

**Runs** under the system's service manager: a systemd user unit on Linux
(`deploy/ai-space.service`), launchd on a Mac that stays on. Apps run under the same supervisor
([supervision.md](supervision.md)).

**Basic install ends** when the service answers its health check on `127.0.0.1:8700`, the panel opens
there (through an SSH port forward on a remote machine), and one runtime is configured. Bundled apps,
outside access, backups, notifications and peers are reported separately. A failure in any of them is
not a failed install.

**Outside access** stays behind a protected entry. The service keeps listening on loopback. The
supported entries are a Cloudflare Tunnel with Access ([ingress.md](ingress.md)) and, once the
built-in user system exists, a login of ai-space's own. Binding to `0.0.0.0` does not replace
either. `SPACE_API_TOKEN` protects the API, not the panel.

**Today:** source install and git-push deploy work, the service reports its version and edition
(`GET /api/space`), and a release tag builds an archive for Linux x64 and arm64 with an installer
that upgrades and rolls back ([release.md](release.md)). Missing: a setup that does not ask for `gh` and Cloudflare during the basic install, and a
login that does not depend on Cloudflare Access.

## AI Space Client

**Contains** the native client: the Mac app (`desktop/macos/`), the iPhone app (`mobile/ios/`), the
Android app (`mobile/android/`).

**Installs** as a signed, notarized `.app` in a `.dmg` on the Mac. Phones install through their
stores or a test channel.

**Phones are Client only.** iOS and Android do not get a Server or Local edition: a phone cannot keep
the Space service, its scheduler and the apps' processes running in the background. Server and
Local are for computers (Local starts on the Mac); a phone always connects to a Space on another
machine.

**Never** installs, starts, stops or upgrades a Space service, on this machine or another. With no
reachable Space it shows how to reach one, and does not start one itself. Remote use needs no Bun, no
Git and no developer tools on the client machine.

**Connects** to a Space by URL: a local one on `http://127.0.0.1:8700`, a remote one over HTTPS
behind its access layer. A connection counts only after the client has checked the panel and a known
API answer, not because a port answered ([macos-desktop.md](macos-desktop.md#connections-and-first-launch)).

**Today:** the Mac and iPhone clients connect to existing Spaces. A release tag builds the Mac
app into a `.dmg`, signed and notarized once the Developer ID secrets are configured
([release.md](release.md)). Missing: the Developer ID certificate itself, the Share extension in
the release build, and store or test-channel distribution for the phones.

## AI Space Local

**Contains** the native client, the Space service with its resources (panel assets, skills,
templates, the PTY helper), a pinned Bun, and the bundled apps as packages ([app-packages.md](app-packages.md)).

**Installs** as a signed, notarized `.app` in a `.dmg`. A `.pkg` is used only if a system-level
component proves necessary.

**First launch** creates the workspace, starts the Space service as a background helper the app owns,
installs the bundled apps from the packages inside the bundle (no Git, no network clone), and opens
the panel. The only question it has to ask is how to reach a model or agent. The other extensions
can be added later from Settings.

**Owns only what it installed.** This is the managed mode of
[macos-desktop.md](macos-desktop.md#managed-local-installation):

- It records that it owns the installation (an ownership file in the workspace and a versioned
  identity the service reports). It never decides ownership from a PID or a busy port.
- It allows one Space service per workspace. Two launches never start two schedulers on the same
  workspace.
- If it finds an installation it did not make (a source checkout, a Server edition, an `operator`
  supervisor), it offers two explicit choices: connect to it as a client, or migrate it. It never
  adopts, stops or upgrades that installation on its own.
- Quitting the window leaves the service running. Stopping the service and removing the background
  helper are separate actions in Settings, and the second one has to happen before the app is
  deleted.

**Also connects** to remote Spaces, exactly like the Client edition.

**Authentication:** the local service still listens on loopback only. The app gets its own device
credential when the service is installed. Coming from loopback is never taken as proof that a
request is from the app.

**Today:** the prototype exists: `release/local.ts` packs the service into the Mac app and
`release/local-smoke.ts` runs it from there, read-only, with no Bun on `PATH` (HTML imports, public
assets, chat-widget build, skills, PTY through a bundled helper, SQLite, runtime adapters;
[release.md](release.md#local-edition)). Managed mode is built ([local.md](local.md)): ownership,
the one-service-per-workspace lock, the LaunchAgent, the device credential, bundled apps, the
first-run flow and Settings. The release workflow builds, smoke-tests, signs and notarizes it with
the others. Updates inside the app are built ([local.md](local.md#updates)); signed DMG
installation and live launchd timing still need release acceptance testing.

## Service identity

`GET /api/space` says what a running service is. It is a public route ([auth.md](auth.md#access-policy)):
a client asks before anyone has signed in.

```json
{ "product": "ai-space", "api": 1, "version": "0.1.0", "edition": "server", "installation": "external" }
```

- `product` and `api` let a client tell an ai-space from any other program on the port, and tell
  whether it can talk to it. `api` is raised only when a change breaks clients of the previous
  level (`API_LEVEL` in `src/space/identity.ts`); a new route or field does not raise it.
- `version` is `package.json`'s; `edition` is `SPACE_EDITION` (`server` by default, `local` when the
  Local edition starts the service). There is no `client` value: a client never runs the service.
- With the operator token or the owner's session, the answer also has `id`, the Space's stable id
  (the same one packages and connections use), and `name` (`SPACE_NAME`, by default the hostname).
- `installation` is `managed` when the Local app installed the service (`installation.json` in its
  workspace), `external` otherwise: the app's way to tell its own service from someone else's
  ([local.md](local.md#ownership-and-exclusion)).

The native clients do not call it yet; checking it before showing Connected is the next client
change.

## How the editions relate

```text
                 one release tag, one version
      ┌──────────────────┼──────────────────┐
   Server             Client              Local
   service + panel    native client       native client + service
   + app runtime                          + Bun + bundled apps
      │                  │                  │
      │  HTTPS / loopback│                  │  owns a local Space
      ◄──────────────────┤                  │  and can also connect
      ◄──────────────────┼──────────────────┘  to remote ones
```

A Local edition can later grow into a server setup without changing editions: you add outside
access, backups or peers from Settings. When a Space has to run somewhere that is always on, it moves
to a Server edition through backup and restore ([backup.md](backup.md)), and the Mac keeps the Client
side.

## The work, in order

| # | Work | Unblocks |
| --- | --- | --- |
| 1 | GitHub CLI and Cloudflare become optional extensions of the Server's setup | A basic install with no accounts and no domain, for Server and Local |
| 2 | Release pipeline, phase 1: checks on every push, a version from the tag, the Client signed, notarized, in a `.dmg`, published as a draft release (built; signing waits for a Developer ID certificate) | Client edition |
| 3 | Built-in user system: owner login, sessions, revocation, one access policy across the API (in progress separately) | A Server reachable without Cloudflare Access; device credentials for Local |
| 4 | Release pipeline, phase 2: the Server release archive, install script, health check, upgrade test (built, [release.md](release.md)) | Server edition as a download |
| 5 | Local prototype: the service from packaged resources on a clean Mac (built, [release.md](release.md#local-edition)) | Proves the Local edition can be packaged at all |
| 6 | Managed mode: identity, ownership, exclusion, background helper, bundled `.spaceapp` apps, first-run flow (built, [local.md](local.md)) | Local edition |
| 7 | Release pipeline, phase 3: Local built and signed in the same run (built, [release.md](release.md#local-edition)) | Local edition as a download |
| 8 | Creating, changing and installing apps from inside ai-space (built, [app-studio.md](app-studio.md)) | Apps without GitHub and a coding tool outside the product |
| 9 | Updates inside the installed app, coordinated with running work and database migrations (built; signed release acceptance pending, [local.md](local.md#updates)) | Keeping Local current without a manual reinstall |

Step 1 and steps 2–3 do not depend on each other. Steps 5 and 6 come after 1 and 3, because a Local
install has to stand without accounts and needs a credential for its own client.

## Acceptance

- **Every edition:** a release tag leads to its commit, its check results, its artifacts and their
  SHA-256. Upgrading keeps workspace data; a failed database migration recovers through a
  compatible path or a backup restore.
- **Server:** the archive installs on each published target, starts, and passes the health check
  with no `gh`, `cloudflared`, `cf`, S3, notifications or peers configured. Existing deployments
  that use Cloudflare keep working unchanged.
- **Client:** signing and notarization verify. A clean Mac with no Bun connects to a local and to a
  remote Space. Quitting leaves the server's work running. The client never starts a service.
- **Local:** on a clean Mac with no Bun, Git or developer tools, the app creates a Space, starts it,
  and opens a bundled app. The model or agent setup is guided. An existing installation is
  detected, and the user is asked to connect or migrate. Moving or replacing the app keeps the
  background service working. Quitting the window and stopping the service behave as Settings
  describes.

## Open questions

- The final name of the Local edition.
- Whether Local uses `~/.ai-space` like the other editions or its own default workspace, and what
  happens when a Server edition already uses `~/.ai-space` on the same Mac. The first choice keeps
  one workspace contract; the second avoids collisions. Either way, a found workspace is never
  adopted silently.
- Which bundled apps Local ships, and that each one installs from a package without Git.
- The Client/Server version compatibility range, and how a client shows a mismatch.
