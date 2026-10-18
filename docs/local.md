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
| `space local status` | the app's release, the installed one, the workspace and its owner, the LaunchAgent, what answers on the port, `claude` and `codex` |
| `space local install [--migrate] [--device <name>]` | copy the release out, switch `current`, `init` the workspace, set `SPACE_EDITION=local`, `SPACE_AUTH=builtin`, `SPACE_SUPERVISOR=space`, `SPACE_DEFAULT_APPS=none` (other values stay), mark it owned, write and start the LaunchAgent, wait for the service to answer as this version, install the bundled apps. A start that does not answer within a minute puts the previous release back. `--device` also makes a device credential and prints its token once |
| `space local start` / `stop` / `restart` | `launchctl enable`+`bootstrap` / `bootout`+`disable` (stays off at login until started) / both |
| `space local remove-service` | stop and unregister the LaunchAgent and delete the program under Application Support; the workspace stays, still owned, so installing again picks it up |

Upgrading is `install` from a newer app. The default port 8700 taken by another program at the
first install gives the workspace a free one in `SPACE_PORT`.

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
| `zstd` | missing: backups fail until it is installed |
