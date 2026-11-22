# Releases

Status: implemented. A release publishes two things ([editions.md](editions.md)):

- **AI Space**: the service with its web panel (the Server edition), for Linux x64 and arm64, a Mac
  on Apple silicon and Windows x64. One command installs it ([below](#one-command-install)).
- **AI Space Desktop**: the native app that connects to an AI Space (the Client edition), for a Mac
  on Apple silicon, Linux and Windows on x64 and arm64 (Windows not signed yet).

The Local edition (the app with the service inside, [local.md](local.md)) is no longer published:
its builders stay for the installations that exist ([Local edition](#local-edition)).

One tag builds both from one commit and one version. Nothing is published without a
person: the pipeline ends in a draft GitHub Release.

## What a release contains

Every file is named product, version, system, CPU: `ai-space-…` is the service, `ai-space-desktop-…`
the app. Releases up to 0.2.1 named the service `ai-space-server-<version>-…`; the installers still
find those.

| File | What it is |
| --- | --- |
| `ai-space-<version>-linux-x64.tar.gz` | AI Space: the service, its production dependencies and a pinned Bun, for Linux on x64 |
| `ai-space-<version>-linux-arm64.tar.gz` | The same for arm64 |
| `ai-space-<version>-macos-arm64.tar.gz` | The same for a Mac on Apple silicon |
| `ai-space-<version>-windows-x64.tar.gz` | The same for Windows itself, without WSL (`bun.exe` inside) |
| `ai-space-desktop-<version>-macos-arm64.dmg` | AI Space Desktop for Mac, signed with a Developer ID and notarized |
| `ai-space-desktop-<version>-macos-arm64-unsigned.dmg` | Built when no signing identity is configured: for testing, macOS blocks it for everyone else |
| `ai-space-desktop-<version>-linux-x64.tar.gz`, `…-linux-arm64.tar.gz` | AI Space Desktop for Linux ([linux-desktop.md](linux-desktop.md)); `./install.sh` in it installs it for the user |
| `ai-space-desktop-<version>-windows-x64.zip`, `…-windows-arm64.zip` | AI Space Desktop for Windows ([windows-desktop.md](windows-desktop.md)), not signed; `AISpace.exe` in it runs and offers to install itself for the user |
| `install.sh`, `install.ps1` | The one-command installers of AI Space ([below](#one-command-install)); `release/get.sh` and `release/get.ps1` in the repository |
| `SHA256SUMS` | `sha256sum -c SHA256SUMS --ignore-missing` checks a download |
| `manifest.json` | Version, commit, the run that built it, every file's size and SHA-256 |

Only systems and architectures that are built and checked are published. Not yet: the Mac Share
extension (it needs an Xcode build with a development team, `desktop:share:build`), Intel Macs,
a signed Windows app, AI Space for Intel Macs.

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
   iPhone clients' tests and a Mac build on macOS; the Windows client's tests and build on
   Windows).
2. **server** (x64 and arm64, each on its own runner): `bun release/server.ts` builds the archive
   from committed files, then `bun release/smoke.ts` unpacks it, starts it with `PATH=/usr/bin:/bin`
   (no Bun of the machine's), checks `/healthz`, `GET /api/space`, the panel page and `space help`,
   stops it, and starts it again on the same workspace to prove the Space id survives.
3. **client**: `desktop/macos/scripts/package.sh` builds the app, puts it in a DMG, and when the
   signing secrets exist signs it, notarizes it with `notarytool`, staples the ticket and checks it
   with `spctl`. A signed build without notarization credentials fails instead of shipping.
4. **linux** and **windows**: the Linux and Windows apps ([below](#linux-app), [below](#windows-app)).
5. **draft release**: `bun release/manifest.ts` writes `SHA256SUMS`, `manifest.json` and the notes;
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

## One-command install

```bash
curl -fsSL https://ai-space.me/install.sh | bash
```

`https://ai-space.me/install.sh` redirects to the latest release's `install.sh` (`release/get.sh`),
so the command always runs the installer that came with the newest published release. The same
command works on Linux with systemd (x64 or arm64) and on a Mac (Apple silicon): it picks the
Server archive for the machine from the same release, checks it against `SHA256SUMS`, unpacks it
in a temporary folder and runs the archive's own `install.sh`
([below](#installing-the-server-edition)). It asks nothing, needs no sudo, Bun, git or account, and
refuses to run as root. At the end it prints the panel's address (`http://127.0.0.1:8700/`) and
opens it on a desktop; over SSH it prints the port forward instead.
When no agent CLI is found (`claude`, `codex`, `dsh`) it says how to get one: ai-space works through
one signed-in CLI, and the installer never installs one. Running it again upgrades.

On Windows 10 and 11 the same thing is one PowerShell command, on Windows itself, without WSL:

```powershell
irm https://ai-space.me/install.ps1 | iex
```

`install.ps1` is `release/get.ps1` as the release carries it. It picks the release's
`ai-space-<version>-windows-x64.tar.gz` (which also runs on Windows on Arm, emulated),
checks it against `SHA256SUMS`, unpacks it with Windows' own `tar.exe` and runs the archive's
`install.ps1` (`release/install.ps1`): the program under `%LOCALAPPDATA%\ai-space` as
`releases\<version>` with a junction `current`, the workspace `%USERPROFILE%\.ai-space`, the `space`
command (`%LOCALAPPDATA%\ai-space\bin\space.cmd`, added to the user's `Path`), and the background
service, a Task Scheduler task started at logon ([below](#the-background-service)). It needs no
elevation, Bun or account, waits for the health check, and puts the previous release back when the
new one does not answer. The same variables apply, set as `$env:AI_SPACE_VERSION = "0.2.0"` and so
on before the command; `AI_SPACE_NO_PATH=1` leaves the user's `Path` alone. `space upgrade` and
`space uninstall` work as on the other systems; a program cannot delete its own running files on
Windows, so `uninstall` hands the program directory to a command that removes it a few seconds
after it ends. Git for Windows is not installed by it: Claude Code needs it, and ai-space runs the
build commands of apps in its shell.

On the first install the workspace is new, and `init` makes it usable as it is
([install.md](install.md#a-new-workspace)): no app is cloned with git (apps come from the app
catalog on the panel's first-use card), the package gateway gets a port (`SPACE_PACKAGE_PORT`, 8702
next to 8700) so catalog apps open, and `runtimes.yaml` lists the agent CLIs found on the machine.
An existing workspace's `.env` is never rewritten, so an upgrade changes none of its values.

Settings, all optional, as environment variables before `bash`:

| Variable | What it does |
| --- | --- |
| `AI_SPACE_VERSION` | That release (`0.2.0` or `v0.2.0`) instead of the latest |
| `AI_SPACE_PREFIX` | Where the program goes (default `~/.local/share/ai-space`) |
| `SPACE_HOME` | Where the workspace goes (default `~/.ai-space`) |
| `AI_SPACE_DOWNLOAD` | Where the release's files are: a mirror, or `file://<dir>` with the files downloaded already |
| `AI_SPACE_NO_OPEN` | `1`: do not open a browser at the end |

It stops, having changed nothing, on a machine whose workspace belongs to the AI Space app (the
Local edition, [local.md](local.md)): that app already runs ai-space there with a service of its
own. Not yet: Intel Macs, a Linux machine without a systemd user manager.

Afterwards, on the machine:

| Command | What it does |
| --- | --- |
| `space open [--print]` | Opens the panel in the browser, or prints its address |
| `space upgrade [--version <x.y.z>] [--check]` | Installs the newest release over this one, as running the one-command installer again would: same program directory, same workspace, a rollback when the new release does not answer. `--check` only says what is available |
| `space uninstall [--workspace] [--yes] [--dry-run]` | Stops and unregisters ai-space's service and the apps' services it wrote, removes the `space` command and deletes the program. The workspace (apps, databases, `.env`) stays unless `--workspace` is given; it asks first unless `--yes` |
| `space service status \| start \| stop \| restart` | The background service ([below](#the-background-service)) |

## Installing the Server edition

On Linux with systemd, or on a Mac, as the user that will own ai-space (on Linux with lingering
on, as in [install.md](install.md) step 1):

```bash
tar -xzf ai-space-<version>-<linux|macos>-<arch>.tar.gz
bash ai-space-<version>-<linux|macos>-<arch>/install.sh
```

`install.sh` copies the release to `~/.local/share/ai-space/releases/<version>` (`AI_SPACE_PREFIX`
moves it), points `current` at it, and runs `current/deploy/install.sh` with the release's own Bun:
the workspace (`~/.ai-space` or `SPACE_HOME`), the background service running from `current`
([below](#the-background-service)), the `space` command in `~/.local/bin`, `/healthz`. The machine needs no Bun, Git or developer tools; when it has
no Bun, the release's is linked as `~/.local/bin/bun` and comes first on the unit's `PATH`, so the
apps' services find it too. A new workspace needs nothing more ([install.md](install.md#a-new-workspace)); `space setup`, as in [install.md](install.md) step 4, is for the optional settings.

The program and the data stay apart: everything under `~/.local/share/ai-space` can be deleted and
installed again without touching apps, databases or `.env`.

## The background service

One installer serves both systems; what differs is the service manager that keeps ai-space
running, and that difference lives in one place: `space service` (`src/space/service.ts`), which
`deploy/install.sh` calls instead of writing a unit itself.

| | Linux | Mac |
| --- | --- | --- |
| Manager | systemd, the user's manager | launchd, the user's GUI domain |
| Definition | `~/.config/systemd/user/ai-space.service` (`deploy/ai-space.service` with this machine's paths) | `~/Library/LaunchAgents/ai.space.server.plist` |
| Runs | `<bun> src/index.ts` in the program directory, `SPACE_HOME` set | the same |
| Starts | at boot, with lingering on (`loginctl enable-linger`, asked for by the installer) | when the user logs in at the Mac |
| After a crash | restarted (`Restart=on-failure`) | restarted (`KeepAlive`, not after a clean exit) |
| On stop | SIGTERM, then the drain (`TimeoutStopSec=360`) | SIGTERM, then the drain (`ExitTimeOut` 360) |
| Its log | the journal: `journalctl --user -u ai-space` | `<workspace>/logs/space.log` |

On Windows the manager is the Task Scheduler (`src/space/services/schtasks.ts`), and the service is a task, not a Windows service: a service runs in session 0 under another logon, where the user's agent CLIs are neither on the search path nor signed in, while a task in the user's own session has both.

| | Windows |
| --- | --- |
| Manager | the Task Scheduler, a task named `ai-space` that any user may register for their own logon |
| Definition | `%LOCALAPPDATA%\ai-space\service\ai-space.xml`, and the launcher it runs, `ai-space.cmd` |
| Runs | the launcher under `conhost.exe --headless` (no console window): `SPACE_HOME` set, the Bun's directory first on `Path`, `<bun> src\index.ts` in the program directory |
| Starts | when the user logs on |
| After a crash | started again by the Task Scheduler, after a minute at the earliest, five times |
| On stop | the process and everything it started are ended at once: Windows has no signal to drain on, so work in flight ends with it |
| Its log | `<workspace>\logs\space.log` |

Whether it runs is read from the workspace's lock (`run\service.lock`, `run\service.json`), which the service holds for its life and which names its pid: the Task Scheduler's own state comes back in the system's language, and its "end" stops the launcher but leaves what the launcher started.

`space logs space` reads either. `space service install [--root <dir>] [--bun <path>]` writes the
definition for that code and Bun and (re)starts it; `status`, `start`, `stop` (off until started
again), `restart` and `remove` do what they say, and `space service workspace` prints the workspace
the installed service runs on. A workspace that belongs to the AI Space app keeps the app's
service (`ai-space-local.service`, `ai.space.local`): `restart` drives that one, `install` and
`remove` refuse.

A Mac is not a server by default. A LaunchAgent runs only while its user is logged in, so a Mac
that should serve after a reboot needs automatic login, and one that should serve all day needs
sleep turned off (`sudo pmset -a sleep 0`); the installer says so and changes neither. Apps under
`SPACE_SUPERVISOR=space` have the same condition ([supervision.md](supervision.md#macos)).

## Upgrading

`space upgrade` does it in one step: it reads the newest release's `manifest.json`, and when that
is another build than the installed one, downloads that release's `install.sh` and runs it with
this installation's program directory and workspace. By hand:


Install the next archive the same way. `current` moves to the new release, the service restarts, and
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

Not part of a release any more (the workflow has no `local` job); for the installations that
exist it is built by hand on a Mac:

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
| `git` | Missing (a stub, never started): default apps are not cloned (a new workspace has none); apps install from packages |
| `claude`, `codex` | The user's; the service adds the usual tool directories (`~/.local/bin`, `/opt/homebrew/bin`, ...) to the bare PATH launchd gives it |
| `zstd` | Missing: backups fail until it is installed (to solve before Local ships backups) |

## Linux app

The `linux` job of the release workflow, after the checks, on x64 and arm64. By hand on Linux:

```bash
bun run release:linux                     # dist/ai-space-desktop-<version>-linux-<arch>.tar.gz
bun release/linux.ts --edition local      # dist/ai-space-local-<version>-linux-<arch>.tar.gz, not published
```

`release/linux.ts` runs `desktop/linux/build.ts`: the app bundled for GJS, the
terminal page, the icon, the launcher and `install.sh`; for Local also the release tree of
`release/server.ts` (edition `local`) at `space/` with `runtime/space-pty` built from
`src/space/terminal/pty_helper.c`. Nothing is signed: Linux has no counterpart of the Mac's
notarization, so `SHA256SUMS` is what a download is checked against.

## Windows app

The **windows** job runs on Windows for x64 and arm64, after the checks, where the program file
gets its icon and version: `bun release/windows.ts --arch <arch>` publishes the app self-contained
(`dotnet publish -r win-<arch> --self-contained`) and zips it into one folder. By hand:

```bash
bun release/windows.ts --arch x64            # dist/ai-space-desktop-<version>-windows-x64.zip
```

On Linux the app builds without its icon. Nothing is signed yet; SmartScreen asks once, and
`SHA256SUMS` is what a download is checked against. A release no longer carries the Local zip that
set the service up in WSL 2: AI Space runs on Windows itself ([above](#one-command-install)).

## Checks before publishing

- The tag's run is green, and `manifest.json` names the tag's commit.
- On a clean Linux machine (no Bun): install the archive, `space status`, open the panel over an
  SSH forward; install it over the previous release and see the apps and data still there.
- The one-command installer against the draft (its files are not public yet):
  `gh release download v<version> --dir rel && AI_SPACE_DOWNLOAD=file://$PWD/rel bash rel/install.sh`
  on a clean Linux machine, then the panel opens and `space status` answers. After publishing,
  `curl -fsSL https://ai-space.me/install.sh | bash` on another one.
- On a GNOME desktop (Ubuntu 24.04): unpack AI Space Desktop, `./install.sh`, open it from the app
  grid, connect it to a Space, send a chat message, open a terminal.
- On Windows 11 and Windows 10 (x64; arm64 when there is one): unzip AI Space Desktop, run `AISpace.exe`,
  install it, connect it to a Space, get an inbox notification and open it, open Quick Chat with
  its shortcut, open an `aispace://inbox` link; uninstall from Installed apps.
- On a clean Mac: open the DMG, drag the app to Applications, open it without a Gatekeeper warning,
  connect it to a Space.
