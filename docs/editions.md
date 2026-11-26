# Editions: Server and Client

This document says what each edition is, where the line between them runs, and what each still
needs before it is published everywhere. The work itself is tracked in separate items: the release
pipeline, optional GitHub and Cloudflare, the built-in user system (see
[The work, in order](#the-work-in-order)).

## What is published (2026-11-21)

A release carries two products, and their files say which is which
([release.md](release.md#what-a-release-contains)):

| Name people see | Edition in this document | Files |
| --- | --- | --- |
| **AI Space** | Server: the service with its web panel, installed by one command | `ai-space-<version>-<os>-<arch>.tar.gz` |
| **AI Space Desktop** | Client: the native app, which connects to an AI Space | `ai-space-desktop-<version>-<os>-<arch>.{dmg,tar.gz,zip}` |

A third edition, Local (a desktop app that carried the service and managed it through
`space local`), was retired on 2026-11-24 and its code removed. The desktop app instead looks for
an AI Space on the machine at first launch and, when there is none, installs the standard one (the
same installer, program directory and background service as the one command), or connects to
another machine. A workspace that an old Local install marked as its own (`installation.json` with
`"managedBy": "ai-space-local"`) is still refused by `space service install`, `remove`,
`uninstall`, `space upgrade` and the installers, so the Server never runs beside that app's service:
remove the service from the app, then delete the file. On Windows the service no longer goes into
WSL 2: AI Space runs on Windows itself.

## Why

Today ai-space is installed by someone who can run a server: a Linux machine, a domain on
Cloudflare, a tunnel and an access layer, GitHub CLI, and a coding agent to build apps with
([install.md](install.md)). That suits an operator and shuts out everyone else. The goal is a product
that works as soon as it is installed and grows only when you ask it to. You start on your own
machine and add outside access, a server, backups and more machines only when you need them. You
still choose which model or agent it uses.

Splitting the product into two editions keeps both kinds of use. A server that runs all day and is
reached from anywhere stays a supported way to run ai-space. A person who has never opened a terminal
gets a desktop app that installs the same AI Space on their own computer and connects to it.

## The two editions

| Edition | What it contains | How it is used | Who it is for |
| --- | --- | --- | --- |
| **AI Space Server** | The Space service, the web panel, the app runtime | Installed on a server or an always-on machine; reached from a browser or a client | People who need it running all day and reachable from elsewhere |
| **AI Space Client** | The native client only | Installed, then connected to a Space: the one it finds on this computer (or offers to install there), or one on another machine | People who already have a Space, or only use Spaces on other machines |

Both are one product: the same source tree, the same version number, the same Space API.
What differs is how each one is packaged, installed, started and updated.

## Rules every edition keeps

1. **One codebase, one version.** A release tag builds both. The version lives in
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
4. **AI access is configured, not bundled.** A Space on this machine does not mean every AI feature
   works offline. Agents and model calls still need a runtime (Claude Code, Codex, an API key) chosen
   and set up by the user ([runtimes.md](runtimes.md)); a new workspace starts with the agent CLIs
   found on the machine ([install.md](install.md#a-new-workspace)). ai-space never installs or
   upgrades an agent CLI silently.
5. **Mac first.** Each edition is published only for the systems and CPU architectures that were
   built and tested. Mac on Apple Silicon is first. Linux x64 and arm64 follow for Server, then for
   Client (a GNOME/GTK desktop app). Windows x64 and arm64 are built for Client
   and go out once they pass the install checks on Windows
   ([release.md](release.md#checks-before-publishing)). Intel Macs are accepted one by one.

## AI Space Server

**Contains** the Space service, the web panel's assets, the shared skills and templates, and
scripts that create a workspace and register a background service.

**Installs** from a release archive per system and architecture (for example
`ai-space-<version>-linux-x64.tar.gz`), or from source as today (`deploy/install.sh`, the
git-push deploy of `deploy/post-receive`). The source channel stays.

**Runs** under the system's service manager: a systemd user unit on Linux
(`deploy/ai-space.service`), a LaunchAgent on a Mac that stays on; `space service` writes and
drives either ([release.md](release.md#the-background-service)). Apps run under the same supervisor
([supervision.md](supervision.md)).

**Basic install ends** when the service answers its health check on `127.0.0.1:8700`, the panel opens
there (through an SSH port forward on a remote machine), and one runtime is configured. Bundled apps,
outside access, backups, notifications and peers are reported separately. A failure in any of them is
not a failed install.

**Outside access** stays behind a protected entry. The service keeps listening on loopback. The
supported entries are a Cloudflare Tunnel with Access ([ingress.md](ingress.md)) and the
built-in sign-in, a login of ai-space's own ([auth.md](auth.md)). Binding to `0.0.0.0` does not replace
either. `SPACE_API_TOKEN` protects the API, not the panel.

**Today:** source install and git-push deploy work, the service reports its version and edition
(`GET /api/space`), and a release tag builds an archive for Linux x64 and arm64 and for a Mac on Apple silicon, with
one installer for both systems that upgrades and rolls back ([release.md](release.md)). `space setup` is the basic install with no
GitHub, Cloudflare, domain or bucket, and `setup github` / `ingress` / `backup` / `notifications` /
`peers` add one extension each ([install.md](install.md)); the built-in sign-in protects the panel and
the API without Cloudflare Access ([auth.md](auth.md)). Missing: the sign-in for app hostnames, which
still need Access in front of them ([auth.md](auth.md#not-done-yet)).

## AI Space Client

**Contains** the native client: the Mac app (`desktop/macos/`), the Linux app (`desktop/linux/`),
the Windows app (`desktop/windows/`), the
iPhone app (`mobile/ios/`), the Android app (`mobile/android/`).

**Installs** as a signed, notarized `.app` in a `.dmg` on the Mac, and from a tarball whose
`install.sh` installs it for the user on Linux ([linux-desktop.md](linux-desktop.md)), and from a
zip whose program installs itself for the user on Windows ([windows-desktop.md](windows-desktop.md)).
Phones install through their stores or a test channel.

**Phones are Client only.** iOS and Android do not get a Server edition: a phone cannot keep the
Space service, its scheduler and the apps' processes running in the background. Server is for
computers; a phone always connects to a Space on another machine.

**At first launch** with no saved Space, the desktop apps show two entries: **Connect to Local AI
Space** and **Connect to a Remote AI Space**. They look for an AI Space on the computer (the
workspace's `SPACE_PORT`, then 8700; `GET /api/space` must say `product: "ai-space"`) only to say
under the first entry whether one is there. A click on it connects straight to the one found; with
none, it runs the release's one-command installer on this computer first (the same `install.sh` or
`install.ps1`, with `AI_SPACE_NO_OPEN=1`) behind a single progress bar, then connects. The remote
entry is the address form ([macos-desktop.md](macos-desktop.md#connections-and-first-launch),
[linux-desktop.md](linux-desktop.md#first-launch), [windows-desktop.md](windows-desktop.md#this-computer)). That is all the app does to
a service: it **never** carries, starts, stops, upgrades or removes one. `space upgrade` and
`space uninstall` do that, and removing the app leaves AI Space in place. Remote use needs no Bun,
no Git and no developer tools on the client machine.

**Connects** to a Space by URL: a local one on `http://127.0.0.1:8700`, a remote one over HTTPS
behind its access layer. A connection counts only after the client has checked the panel and a known
API answer, not because a port answered ([macos-desktop.md](macos-desktop.md#connections-and-first-launch)).

**Today:** the Mac, Linux, Windows and iPhone clients connect to existing Spaces. A release tag
builds the Linux app into tarballs and the Windows app into one `.exe` per CPU (not signed yet), for x64 and
arm64, and the Mac app into a `.dmg`, signed and notarized once the Developer ID secrets are configured
([release.md](release.md)). Missing: the Developer ID certificate itself, the Share extension in
the release build, and store or test-channel distribution for the phones.

### The install progress bar

The installers print no percentages, so all three apps move one bar by the lines `release/get.sh`
and `release/get.ps1` print at each step, at one pace. In a step the bar goes in a straight line,
from where it stood when the step began toward the step's ceiling, covering 0.8 of the way in the
step's usual length; a step that runs over then slows down near its ceiling, so a long download
never looks stuck, and one that ends early makes no jump: the next step starts where the bar is and
only goes a little faster. The ceilings are set so that steps of their usual length (from a real
install, about 40 s in all) move the bar evenly to 95 %. The bar only goes forward and reaches the
end only when the Space answers.

| Step | Begins with the line | Heads toward | Usual length |
| --- | --- | --- | --- |
| fetching | (the app downloads the installer) | 9.4 % | 3 s |
| looking | `ai-space: looking for …` | 13.75 % | 2 s |
| downloading | `ai-space: downloading <archive>` | 50 % | 12 s |
| placing | `ai-space <version> (<commit>) in <dir>` | 80 % | 12 s |
| apps | `ai-space core: installed, answering …` | 88.1 % | 5 s |
| starting | `ai-space is running…`, or the installer ended well | 97.5 % | 4 s |

The same table is `InstallProgress` in `desktop/macos/AISpace/Services/SpaceInstaller.swift`,
`desktop/linux/src/core/first-launch.ts` and `desktop/windows/AISpace.Core/InstallProgress.cs`;
a change to those lines in the installers needs the same change there.

## Service identity

`GET /api/space` says what a running service is. It is a public route ([auth.md](auth.md#access-policy)):
a client asks before anyone has signed in.

```json
{ "product": "ai-space", "api": 1, "version": "0.1.0", "edition": "server", "installation": "external" }
```

- `product` and `api` let a client tell an ai-space from any other program on the port, and tell
  whether it can talk to it. `api` is raised only when a change breaks clients of the previous
  level (`API_LEVEL` in `src/space/identity.ts`); a new route or field does not raise it.
- `version` is `package.json`'s; `edition` is always `server`. There is no `client` value: a client
  never runs the service.
- With the operator token or the owner's session, the answer also has `id`, the Space's stable id
  (the same one packages and connections use), `name` (`SPACE_NAME`, by default the hostname), and
  `uptime: { startedAt, totalMs }`, this run's start and the service's whole recorded running time
  on this machine ([usage.md](usage.md#uptime)).
- `installation` is always `external`. The retired Local edition answered `managed` for a service
  its app had installed, and `edition: "local"`; both fields stay so clients built then still decode
  the answer.

The Linux and Windows clients check it before showing Connected; the Mac, iPhone and Android
clients do not call it yet.

## How the editions relate

```text
          one release tag, one version
        ┌──────────────┴──────────────┐
     Server                         Client
     service + panel                native client
     + app runtime                       │
        ◄────── HTTPS / loopback ────────┘
```

A Space on a desktop computer is a Server edition like any other: outside access, backups or peers
are added when needed. When a Space has to run somewhere that is always on, it moves there through
backup and restore ([backup.md](backup.md)), and the desktop keeps the Client side.

## The work, in order

| # | Work | Unblocks |
| --- | --- | --- |
| 1 | GitHub CLI and Cloudflare become optional extensions of the Server's setup (built, [install.md](install.md)) | A basic install with no accounts and no domain |
| 2 | Release pipeline, phase 1: checks on every push, a version from the tag, the Client signed, notarized, in a `.dmg`, published as a draft release (built; signing waits for a Developer ID certificate) | Client edition |
| 3 | Built-in user system: owner login, sessions, revocation, one access policy across the API (stage 1 built, [auth.md](auth.md); app hostnames, more accounts and roles are stages 2 and 3) | A Server reachable without Cloudflare Access |
| 4 | Release pipeline, phase 2: the Server release archive, install script, health check, upgrade test (built, [release.md](release.md)) | Server edition as a download |
| 5 | Creating, changing and installing apps from inside ai-space (built, [app-studio.md](app-studio.md)) | Apps without GitHub and a coding tool outside the product |
| 6 | The app catalog: published apps as signed packages, or built from their source, from the panel or one command (built in the Space; the first signed releases pending, [app-catalog.md](app-catalog.md)) | Apps for any Space without Git, and the default apps as packages |

Step 1 and steps 2–3 do not depend on each other.

## Acceptance

- **Every edition:** a release tag leads to its commit, its check results, its artifacts and their
  SHA-256. Upgrading keeps workspace data; a failed database migration recovers through a
  compatible path or a backup restore.
- **Server:** the archive installs on each published target, starts, and passes the health check
  with no `gh`, `cloudflared`, `cf`, S3, notifications or peers configured. Existing deployments
  that use Cloudflare keep working unchanged.
- **Client:** signing and notarization verify. A clean Mac with no Bun connects to a local and to a
  remote Space. Quitting leaves the server's work running. The client never starts a service.

## Open questions

- The Client/Server version compatibility range, and how a client shows a mismatch.
