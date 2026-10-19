# The Local edition on a Mac

Status: the service side is implemented (`src/space/local.ts`, `space local`); the Mac app's
first-run flow and Settings use it ([macos-desktop.md](macos-desktop.md#managed-local-installation)).
What the edition is and why: [editions.md](editions.md#ai-space-local). How it is built:
[release.md](release.md#local-edition).

## Where things live

| Path | What | Who removes it |
| --- | --- | --- |
| `AI Space.app/Contents/Resources/space/` | the release the app carries: `RELEASE.json`, `runtime/bun`, `runtime/space-pty`, `src/`, `node_modules/`, `bundled-apps/*.spaceapp` | deleting the app |
| `~/Library/Application Support/ai-space/local/releases/<version>-<commit>/` | a copy of it, what actually runs; the last three are kept for a rollback | Remove background service |
| `~/Library/Application Support/ai-space/local/current` | link to the release the service runs | Remove background service |
| `~/Library/LaunchAgents/ai.space.local.plist` | the background service: `current/runtime/bun current/src/index.ts start`, at login and after a crash | Remove background service |
| `~/.ai-space/` | the workspace, the same contract as every edition: apps, databases, settings, logs | never by the app |
| `~/.ai-space/installation.json` | this workspace is the app's (`managedBy: ai-space-local`) | never by the app |

The program is copied out of the bundle, so moving, replacing or deleting the app never takes files
from under a running service, and an update can switch `current` and restart.

`SPACE_HOME`, `SPACE_LOCAL_PREFIX` and `SPACE_LOCAL_AGENTS` move the workspace, the program and the
LaunchAgent directory (tests use them).

## Ownership and exclusion

- **Owned** means `installation.json` in the workspace says so. Never a PID, never a busy port.
- `GET /api/space` says `"installation": "managed"` when the running service's workspace has that
  file, `"external"` otherwise ([editions.md](editions.md#service-identity)).
- **One service per workspace**, whatever started it: `start` holds an exclusive `flock` on
  `<workspace>/run/service.lock` for its whole life (`src/space/instance.ts`). A second one exits
  with code 1 and says who holds it (`run/service.json`: pid, port, edition, version). The kernel
  drops the lock when the process ends, so a crash never leaves it stale.

`space local status` reads the state:

| State | Meaning | What the app offers |
| --- | --- | --- |
| `absent` | no workspace, nothing answering on the port | Set up |
| `managed` | the workspace is the app's | Start, Stop, Restart, Remove background service |
| `foreign` | a workspace the app did not make, or a Space it did not start answering on the port, or holding the workspace's lock | Connect to it, or Migrate it |

**Migrate** (`install --migrate`) adopts a foreign workspace as it is (apps, data and settings
stay) and refuses while its own service still runs: the user stops that one first (`systemctl` /
`launchctl` / their terminal), then migrates. Nothing is adopted, stopped or upgraded silently.

## Commands

All take `--json`; the app parses that. They work with ai-space down.

| Command | Does |
| --- | --- |
| `space local status [--claude <path>] [--codex <path>] [--dsh <path>]` | the app's release, the installed one, the workspace and its owner, the LaunchAgent, what answers on the port, `claude`, `codex` and `dsh` |
| `space local install [--migrate] [--device <name>] [--default-model <runtime/tier>] [--wait | --now] [--claude <path>] [--codex <path>] [--dsh <path>]` | refuse a workspace with no runtime when this Mac has no agent CLI (`no-runtime`), and a first install or takeover without a default model (`no-default-model`); store that model, copy the release out, switch `current`, `init` the workspace, write `runtimes.yaml` from the CLIs found when the workspace has none (see [First run](#first-run)), set `SPACE_EDITION=local`, `SPACE_AUTH=builtin`, `SPACE_SUPERVISOR=space`, `SPACE_DEFAULT_APPS=none` (other values stay; `SPACE_TERMINAL_ENABLED=1` and `SPACE_PACKAGE_PORT`, 8702 or a free port, only when the workspace has no value), mark it owned, write and start the LaunchAgent, wait for the service to answer as this version, install the bundled apps. A start that does not answer within a minute puts the previous release back. `--device` also makes a device credential and prints its token once |
| `space local start` / `stop` / `restart` | `launchctl enable`+`bootstrap` / `bootout`+`disable` (stays off at login until started) / both |
| `space local remove-service` | stop and unregister the LaunchAgent and delete the program under Application Support; the workspace stays, still owned, so installing again picks it up |

`--claude`, `--codex` and `--dsh` point at a CLI installed where the search does not look (the
app's Choose…); every command takes them, so the status it prints counts that CLI. DeepSeek
Harness is also looked for in its desktop app's bundle
(`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`, and the same under
`~/Applications`), where its CLI is not on `PATH`; a `dsh` on the user tool directories is used
when it answers `--version` with a semver and names the harness in `--help`.

Upgrading is `install` from a newer app. The default port 8700 taken by another program at the
first install gives the workspace a free one in `SPACE_PORT`.

## First run

Set Up (and Take It Over) stay off until both of these are done, on the same screen:

1. **Agent CLIs.** The Space runs its agents and model calls through Claude Code, Codex or
   DeepSeek Harness, so the app lists all three: the path found (`~/.local/bin`, `/opt/homebrew/bin`
   and the other user tool directories, plus the DeepSeek Harness app's bundled CLI), or how to
   install it, or Choose… for one elsewhere. Install writes `<workspace>/runtimes.yaml` naming each
   CLI by its absolute path, with **no `default` runtime**: every model an app or agent asks for
   names its runtime (`claude/opus`, `codex/intermediate`, `dsh/intermediate`), and a bare one
   (`opus`) is an error that says so. The desktop app's `dsh` is written with
   `provider: deepseek-account`, the login it already holds; a `dsh` installed another way follows
   the route its own configuration names (an API key, normally). Nothing is written when the workspace already has that
   file or runtime variables (`SPACE_MODEL_BIN`, `SPACE_CHAT_BIN`, `SPACE_MODEL_SSH_HOST`,
   `SPACE_MODEL_API_KEY`) in `.env`. A failed upgrade removes a file it wrote.
2. **Default model.** `space local status` lists, before install, every tier of every CLI found
   (`models`, Codex's from its own catalogue), as `GET /api/model/preferences` will. The user picks
   one; `install --default-model <runtime/tier>` stores it in `space.db` before the service starts.
   It is the same setting as Settings → Models → Default model: what Space Assistant, the other
   agents and apps use when nothing chooses a model for them. A first install or a takeover without
   it is refused (`no-default-model`); an upgrade keeps the one it has. A managed Space that has none
   (from an older app) gets a sheet asking for it, which cannot be skipped.
3. **Backups** are off until a target is set (`SPACE_BACKUP_URL`, [backup.md](backup.md)); the
   first run does not ask, and Settings shows no backup status while they are off.

## Signing in

The service listens on loopback only, and coming from loopback proves nothing (the tunnel's
requests do too). The Local edition runs `SPACE_AUTH=builtin`, and the app holds a **device
credential** made at install (`--device`): a bearer token (`spd_…`) stored by its SHA-256 in
`auth_devices`, kept by the app in the Keychain. It counts as the owner. For the app's web views,
`POST /api/auth/device/session` with it sets an ordinary session cookie. No password is needed on
the Mac; `space auth init` sets one later for a browser elsewhere ([auth.md](auth.md#device-credentials)).

## What the service needs from the Mac

| Needs | Without the Command Line Tools |
| --- | --- |
| Bun, a PTY helper | in the release |
| `git` | a stub, never started: default apps are not cloned; bundled apps install from packages |
| `claude`, `codex` | the user's own; the service adds `~/.local/bin`, `~/.claude/local`, `~/.bun/bin`, `/opt/homebrew/bin`, `/usr/local/bin` and others to the bare PATH launchd gives it (`src/space/host-tools.ts`) |
| `dsh` (DeepSeek Harness) | the desktop app's own CLI in its bundle, or one on the tool PATH; its signed-in account, or `DEEPSEEK_API_KEY` for an API-key installation |
| `zstd` | needed only once backups are turned on (`SPACE_BACKUP_URL`); they are off by default |


## Updates

The Local app checks GitHub's latest published release at launch and when its Settings section
opens, at most once every six hours. **Check for app updates** checks immediately. Draft and
prerelease builds are excluded; the release must contain a newer Local DMG for this Mac's
architecture and its matching `manifest.json` entry. **Install and relaunch** downloads it,
checks its size and SHA-256, then verifies the app's Local release version, bundle identifier,
code signature, signing team (the same as the running app), and Gatekeeper assessment. An unsigned
or ad-hoc build cannot self-update. Developer ID signing, notarization and a published release
are required for an end-to-end production update.

After the app quits, a helper swaps the verified bundle into place and opens it. A failed swap
or launch command restores the previous app. A successful swap leaves `AI Space Previous <id>.app`
beside the installed app for manual recovery; remove it once the new app works. This checks the
launch command, not the new GUI's ongoing health. If the new app crashes after launch, quit it and
open the retained previous app. An unwritable installation folder requires downloading and copying
the app manually. Translocated apps must first be moved to Applications.

Updating the app does not pull files from under the background service. On launch the app updates
its managed service only when its bundled version is newer and the service has not been disabled.
Running tasks, model calls, agent turns, terminal sessions and package installs are reported by
`GET /api/space/activity` (owner only). Busy services are retried every two minutes while the app
stays open. Equal or older versions are not automatically installed; **Repair** remains explicit.

Settings offers **Update when idle** (wait up to 30 minutes) and **Update now…** (confirm that work
may be interrupted). The CLI equivalents are `space local install --wait` and `--now`; without
either, an upgrade is refused while work is running. The normal shutdown gives work 30 seconds
with the default `SPACE_DRAIN_SECONDS`, within the LaunchAgent's 40-second timeout. Failed activity
requests do not count as idle; a 404 is accepted for compatibility with older releases.

With the service stopped, the installer snapshots `data/space.db` under
`~/Library/Application Support/ai-space/local/db-snapshots/` (the last three snapshots are kept).
Initialization, bootstrap or health-check failure during an upgrade restores the database, release
link, workspace environment and ownership metadata, then checks the previous service's health.
Database replacement is refused while the workspace is locked by a service. This recovery covers
Space's own database, not arbitrary app databases or external side effects. Bundled apps are
installed only after the new service passes its health check.

Validation includes Swift feed/checksum/version tests and helper replacement tests (successful
swap, missing staged app and failed launch), plus service integration tests for busy/refuse/wait/now,
a failed migration, failed initialization and failed bootstrap. Signed DMG installation and live
launchd timing still need release testing on a Mac with a Developer ID build.

The setup page hides the remote connection form while setup is running. It shows detected agents with their icons. Only missing agents offer a path picker; selected executables must return the expected Claude Code or Codex version signature within three seconds. This checks the CLI identity, not its sign-in state. Choose the default model from the dropdown before continuing. Agent icons are from [Lobe Icons](https://github.com/lobehub/lobe-icons) (MIT).

A fresh setup or takeover always creates a new device credential, even if the keychain still contains one for the same workspace path after a reset. Existing managed installations keep their credential during upgrades.
