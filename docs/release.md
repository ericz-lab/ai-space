# Releases

Status: implemented for the Server edition (Linux x64 and arm64), the Client edition and the Local
edition (Mac, Apple Silicon; Linux x64 and arm64; [editions.md](editions.md)). Updates inside an installed app are a
separate piece of work: a newer Local app is installed over the old one and its Settings offer the
update ([local.md](local.md)).

One tag builds every edition from one commit and one version. Nothing is published without a
person: the pipeline ends in a draft GitHub Release.

## What a release contains

| File | Edition | What it is |
| --- | --- | --- |
| `ai-space-server-<version>-linux-x64.tar.gz` | Server | The service, its production dependencies and a pinned Bun, for Linux on x64 |
| `ai-space-server-<version>-linux-arm64.tar.gz` | Server | The same for arm64 |
| `ai-space-client-<version>-macos-arm64.dmg` | Client | The Mac app, signed with a Developer ID and notarized |
| `ai-space-client-<version>-macos-arm64-unsigned.dmg` | Client | Built when no signing identity is configured: for testing, macOS blocks it for everyone else |
| `ai-space-local-<version>-macos-arm64.dmg` | Local | The Mac app with the service inside ([local.md](local.md)), signed and notarized |
| `ai-space-local-<version>-macos-arm64-unsigned.dmg` | Local | The same without a signing identity: for testing only |
| `ai-space-linux-client-<version>-x64.tar.gz` | Client | The Linux app ([linux-desktop.md](linux-desktop.md)); `./install.sh` in it installs it for the user |
| `ai-space-linux-local-<version>-x64.tar.gz` | Local | The Linux app with the service inside ([local.md](local.md#on-linux)) |
| `ai-space-linux-client-…-arm64.tar.gz`, `ai-space-linux-local-…-arm64.tar.gz` | Client, Local | The same for arm64 |
| `SHA256SUMS` | | `sha256sum -c SHA256SUMS --ignore-missing` checks a download |
| `manifest.json` | | Version, commit, the run that built it, every file's size and SHA-256 |

Only systems and architectures that are built and checked are published. Not yet: the Mac Share
extension (it needs an Xcode build with a development team, `desktop:share:build`), Intel Macs,
Windows, a Server edition for macOS.

## Cutting a release

```bash
bun run set-version 0.2.0          # package.json and every native copy of the version
bun run check
git commit -am "chore(release): 0.2.0"
git tag v0.2.0
git push origin main v0.2.0        # origin is GitHub; the deploy remotes are separate
```

The tag must equal `package.json`'s version, or the run stops at its first job. The run
(`.github/workflows/release.yml`):

1. **check**: the same checks as every push (`check.yml`: typecheck and tests on Linux; the Mac and
   iPhone clients' tests and a Mac build on macOS).
2. **server** (x64 and arm64, each on its own runner): `bun release/server.ts` builds the archive
   from committed files, then `bun release/smoke.ts` unpacks it, starts it with `PATH=/usr/bin:/bin`
   (no Bun of the machine's), checks `/healthz`, `GET /api/space`, the panel page and `space help`,
   stops it, and starts it again on the same workspace to prove the Space id survives.
3. **client**: `desktop/macos/scripts/package.sh` builds the app, puts it in a DMG, and when the
   signing secrets exist signs it, notarizes it with `notarytool`, staples the ticket and checks it
   with `spctl`. A signed build without notarization credentials fails instead of shipping.
4. **draft release**: `bun release/manifest.ts` writes `SHA256SUMS`, `manifest.json` and the notes;
   the draft is created, or refreshed when a rerun built the same commit. A published release, or a
   draft holding another commit's files, is never overwritten.

Then install the draft's files on a clean machine and a clean Mac (the checks below) and publish
it on GitHub. A run started by hand (Actions → release → Run workflow) builds the same files as
`<version>-dev.<sha>` and keeps them on the run, without a release.

Every step is a script in the repository, so the same commands run locally:
`bun run release:server`, `bun run release:smoke dist/<archive>`, `bun run release:client`.

## Signing secrets

The Mac app is signed only with secrets in the repository's `release` environment (Settings →
Environments; restrict it to tags and add a required reviewer so only a trusted run reads them):

| Secret | What it is |
| --- | --- |
| `MACOS_CERT_P12_BASE64` | The "Developer ID Application" certificate and its key, exported as .p12, base64 |
| `MACOS_CERT_PASSWORD` | The .p12's password |
| `MACOS_SIGN_IDENTITY` | `Developer ID Application: <name> (<team id>)` |
| `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_PASSWORD` | The Apple ID, team and an app-specific password for `notarytool` |

The certificate comes from an Apple Developer Program membership (Certificates → Developer ID
Application). An "Apple Development" certificate does not notarize. Without these secrets the run
still produces the `-unsigned` DMG.

## Installing the Server edition

On Linux with systemd, as the user that will own ai-space (lingering on, as in
[install.md](install.md) step 1):

```bash
tar -xzf ai-space-server-<version>-linux-<arch>.tar.gz
bash ai-space-server-<version>-linux-<arch>/install.sh
```

`install.sh` copies the release to `~/.local/share/ai-space/releases/<version>` (`AI_SPACE_PREFIX`
moves it), points `current` at it, and runs `current/deploy/install.sh` with the release's own Bun:
the workspace (`~/.ai-space` or `SPACE_HOME`), the user unit running from `current`, the `space`
command in `~/.local/bin`, `/healthz`. The machine needs no Bun, Git or developer tools; when it has
no Bun, the release's is linked as `~/.local/bin/bun` and comes first on the unit's `PATH`, so the
apps' services find it too. Then `space setup` as in [install.md](install.md) step 4.

The program and the data stay apart: everything under `~/.local/share/ai-space` can be deleted and
installed again without touching apps, databases or `.env`.

## Upgrading

Install the next archive the same way. `current` moves to the new release, the unit restarts, and
the installer waits for the health check. The last three releases are kept.

### Rollback

If the new release does not answer its health check, `install.sh` points `current` back at the
release that ran before, runs its installer again and exits with an error. By hand, any kept
release: `cd ~/.local/share/ai-space && ln -sfn releases/<version> current && bash current/deploy/install.sh`.

A rollback changes the program, not the data. A release whose start migrated a database may leave
it in a shape the older release does not read; then restore the snapshot taken before the upgrade
([backup.md](backup.md)), which is why a backup target is worth setting before upgrading a space
that matters.

## Local edition

The `local` job of the release workflow, after the checks, with the same signing secrets as the
Client. By hand on a Mac:

```bash
bun run release:local [--app <file.spaceapp>]...       # dist/local/AI Space.app, ad-hoc unless SIGN_IDENTITY
bun run release:local-smoke "dist/local/AI Space.app"  # the service from inside the app
EDITION=local APP="dist/local/AI Space.app" desktop/macos/scripts/package.sh   # the .dmg
```

The Client and the Local app share the bundle id: installing the Local app replaces the Client,
which it contains. Bundled apps come from `--app` or `LOCAL_APPS`; the workflow bundles none until
the list is chosen ([editions.md](editions.md#open-questions)).

`release/local.ts` builds the Mac client, puts the release tree of `release/server.ts` (edition
`local`) at `Contents/Resources/space`, builds the terminal's forkpty helper there as
`runtime/space-pty`, and signs every Mach-O file inside with the hardened runtime, the bundled Bun
with `SpaceRuntime.entitlements` (JIT), then the app. `SIGN_IDENTITY` picks a Developer ID instead
of ad-hoc.

`release/local-smoke.ts` copies the app, makes `Resources/space` read-only, and starts the service
from it with `PATH=/usr/bin:/bin`, a fresh home and `SPACE_EDITION=local`. It checks the identity
route, the panel's HTML import and files, the chat widget, the linked skills, SQLite, a terminal
session through `space-pty` (size, resize, job control) and the runtime adapters; then that nothing
was written inside the app and its signature still verifies.

What a running service needs from the machine, and what it does without it:

| Needs | On a Mac without the Command Line Tools |
| --- | --- |
| Bun | Bundled (`runtime/bun`) |
| A PTY for the terminal | Bundled (`runtime/space-pty`); the `/usr/bin/python3` stub is never started |
| `git` | Missing (a stub, never started): default apps are not cloned; Local installs its apps from packages |
| `claude`, `codex` | The user's; the service adds the usual tool directories (`~/.local/bin`, `/opt/homebrew/bin`, ...) to the bare PATH launchd gives it |
| `zstd` | Missing: backups fail until it is installed (to solve before Local ships backups) |

## Linux app

The `linux` job of the release workflow, after the checks, on x64 and arm64. By hand on Linux:

```bash
bun run release:linux                     # dist/ai-space-linux-{client,local}-<version>-<arch>.tar.gz
bun release/linux.ts --edition client     # one edition
```

`release/linux.ts` runs `desktop/linux/build.ts` for each edition: the app bundled for GJS, the
terminal page, the icon, the launcher and `install.sh`; for Local also the release tree of
`release/server.ts` (edition `local`) at `space/` with `runtime/space-pty` built from
`src/space/terminal/pty_helper.c`. Nothing is signed: Linux has no counterpart of the Mac's
notarization, so `SHA256SUMS` is what a download is checked against.

## Checks before publishing

- The tag's run is green, and `manifest.json` names the tag's commit.
- On a clean Linux machine (no Bun): install the archive, `space status`, open the panel over an
  SSH forward; install it over the previous release and see the apps and data still there.
- On a GNOME desktop (Ubuntu 24.04): unpack the Linux client, `./install.sh`, open it from the app
  grid, connect it to a Space, send a chat message, open a terminal; with the Local tarball, set up
  the Space on that machine and see `systemctl --user status ai-space-local` running.
- On a clean Mac: open the DMG, drag the app to Applications, open it without a Gatekeeper warning,
  connect it to a Space.
