# Service supervision

Status: implemented (`src/space/services/`) for systemd and, on macOS, launchd, with `setup` asking
the question. Handing the running machines over is the next step; see [Rollout](#rollout).

An app's `service` is a long-running process. Somebody has to start it at boot, restart it when it
crashes, stop it when the app is paused or uninstalled, and say where its log is. Until now that was
always the operator: a unit installed by hand, which the space only probed for health and, on
uninstall, stopped through `SPACE_SERVICE_STOP`. This document is the other choice: the space runs
the process itself.

## One setting, two contracts

`SPACE_SUPERVISOR` in the workspace `.env` chooses, per machine:

| Value | Who runs the services | What the space does |
| --- | --- | --- |
| `operator` (default when unset) | Units the operator installed, named after the app | Probes health; stops a unit on uninstall through `SPACE_SERVICE_STOP`; reads logs through `SPACE_SERVICE_LOGS`. Exactly the behaviour before supervision. |
| `space` | The space: one user unit per app, `space-<app>.service` (on macOS the LaunchAgent `space.<app>`, see [macOS](#macos)) | Writes, starts, restarts and removes the unit on every sync; reads its log; stops it on uninstall. |

`operator` stays the default so a machine whose services are the operator's units keeps them until
it is switched on purpose; a switch without first disabling those units would start every app twice
on the same port (the space refuses that, see [Conflicts](#conflicts)).

Under `space`, `SPACE_SERVICE_STOP` and `SPACE_SERVICE_LOGS` describe units that no longer run the
apps, so ai-space refuses to start with either of them set: remove them from the `.env` when
switching.

`space` needs a systemd user manager that runs without a login session: `loginctl enable-linger
<user>`. Without one, every sync of an app records `failed` with that reason and nothing is written.
On macOS the manager is launchd, and the user's GUI session takes the place of lingering: see
[macOS](#macos). A machine with neither stays on `operator`.

## Who should be running

An app's service should run if and only if the manifest declares `service` and `status` is
`active`. `paused` and `archived` mean stopped, the same line the scheduler draws for tasks
(`Scheduler.schedulable`). Removing the `service` section also removes the unit.

## The unit

`~/.config/systemd/user/space-<app>.service` (`$XDG_CONFIG_HOME` when set):

```ini
# Written by ai-space. Do not edit: it is regenerated on every app sync.
[Unit]
Description=<title> (ai-space app)
X-Space-App=<app>
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=<app dir>
EnvironmentFile=<workspace>/run/env/<app>.env
ExecStart=/bin/sh -c "<service.command>"
Restart=on-failure
RestartSec=5
KillMode=control-group
TimeoutStopSec=30

[Install]
WantedBy=default.target
```

- The first line is the marker. The space only ever changes or deletes a unit that starts with it;
  anything else of that name is left alone and reported.
- The command is escaped for systemd (`\`, `"`, and `%` and `$` doubled), so the shell sees exactly
  the manifest's command, with `${VAR}` placeholders already resolved from the workspace `.env` as
  for tasks. A command over several lines is refused: put the lines into a script.
- The main process is `/bin/sh`, which runs the command as its child (dash does not `exec` it), so
  `KillMode=control-group` sends SIGTERM to every process of the unit at once; `KillMode=mixed`
  would signal only the shell and SIGKILL the app (seen on Seoul, 2026-09-28). `TimeoutStopSec=30`
  leaves the 10 seconds the app contract promises plus room before systemd kills what is left.

### The environment file

One generated file instead of three `EnvironmentFile=` lines, so precedence is decided once, in
code, as [app-spec.md](app-spec.md#service) states it, lowest first:

1. `PATH` of the ai-space process (a user unit does not get the login shell's `PATH`);
2. the app's `.env`;
3. `<workspace>/data/<app>/space.env` (identity, token, databases, blob store);
4. `service.env`, placeholders resolved;
5. what the space sets: `PORT`, `SPACE_APP`, `SPACE_APP_DIR`, `SPACE_APP_DATA_DIR`, `SPACE_API_URL`,
   `SPACE_NAME`.

It is written to `<workspace>/run/env/<app>.env` with mode 0600, as `KEY="value"` lines. A variable
whose name systemd would not accept or whose value holds a line break is left out, logged and shown
in `space app service <app>`.

The file is a snapshot. **An edit to the app's `.env` or to a `${VAR}` in the workspace `.env` takes
effect at the next sync of the app** (`space app sync <app>`), which rewrites the file and restarts
the unit because its content changed.

## Reconciling

On every sync of an app (boot, `POST /api/apps/sync`, `POST /api/apps/:app/sync`), after storage has
written `space.env` and before the router reloads, the supervisor compares what the app should be
with what is on disk and in systemd:

| Should run | On disk | systemd | Action |
| --- | --- | --- | --- |
| yes | no unit | — | write env file and unit, `daemon-reload`, `enable --now` |
| yes | unit or env file differs from the rendering | — | rewrite, `daemon-reload`, `restart` |
| yes | both identical | active | nothing |
| yes | both identical | not active | `start` |
| no | a unit of ours | — | `disable --now`, delete unit and env file, `daemon-reload`, `reset-failed` |
| any | a unit of that name without the marker | — | refuse: `conflict` |

"Differs" is the rendered text against the file on disk. That is the rule that matters most: a sync
that changes nothing never restarts an app, so `POST /api/apps/sync` stays cheap and safe to run at
any time.

After a start or restart, when the service declares `health`, the space polls it for up to
30 seconds in the background and records `ok` or `down`.

The outcome of the last sync is kept per app (`installed`, `restarted`, `started`, `unchanged`,
`removed`, `absent`, `conflict`, `failed`) and shown in the Services list, `space app service` and
`space status`. A failure never stops the app from registering: its tasks, agents and widgets are
synced as usual, and only the Services row turns red.

At boot, after every app is synced, units of ours whose app no longer exists (its directory left
while ai-space was down) are removed. A directory whose manifest failed to load keeps its unit.

Operations on one app are serialised: a sync and a restart from the panel never interleave.

### Conflicts

Before starting anything, the space checks for the operator's unit named after the app, in the user
and the system manager. If it is enabled or running, the app is not started and the outcome is
`conflict`, naming the command that disables it. Two processes on one port would fail in a loop.

## Uninstall

Uninstalling an app (panel, `DELETE /api/apps/:app`, `space app uninstall`) removes its unit and
environment file instead of running `SPACE_SERVICE_STOP`. The rest is unchanged: a task run in
flight still blocks it (409 unless forced), the directory goes to `trash/`, the data stays.

## App installers

An app that ships `deploy/install.sh` (a default app, run by `install-defaults`) receives
`SPACE_SUPERVISOR` in its environment. Under `space` the installer installs dependencies and stops
there: the space wrote the unit at boot, and a unit of the installer's own, named after the app, would
be a [conflict](#conflicts). Until the dependencies are in, the space's unit fails and systemd retries
it every 5 seconds, so the app comes up by itself once the installer is done.

## Logs

The app writes to stdout and stderr; systemd puts both in the journal of its unit. `GET
/api/apps/:app/logs` and `space logs <app>` read `journalctl --user -u space-<app>.service`. The
journal already rotates, timestamps and follows; writing files under `<workspace>/logs/<app>/`
would duplicate that, so the promise in app-spec.md was changed to the journal.

## HTTP and CLI

```
GET  /api/apps/:app/service                     supervisor, unit, state, restarts, since, last sync
POST /api/apps/:app/service  { action }         start | stop | restart (space only; 409 under operator, naming the command)
POST /api/apps/:app/service  { action: "supervise", to? }
                                                hand-over to the space (default) or back to the operator; 502 with the steps when rolled back
```

Panel routes, no bearer token, like uninstall. `GET /api/services` carries `supervisor` at the top
and on each local row, and the last sync's outcome as `supervision`.

```
space app service APP           who runs it, the unit, state, restarts, since when, the last sync
space app start|stop|restart APP
space app supervise APP [space|operator]
space status                    one line more: the supervisor and any unit in conflict or failed
```

A `stop` lasts until the next sync of the app, which starts it again; to keep an app stopped, set
`status: paused`.

### Hand-over

`space app supervise APP` moves one app from the operator's unit to the space's, on a machine
already set to `SPACE_SUPERVISOR=space`: it disables the operator's `<app>.service` (a system unit
through `sudo -n`, so it needs passwordless sudo for `systemctl`), syncs the app so the space writes
and starts `space-<app>.service`, and waits up to 30 s for the health path (or, without one, for the
unit to be active). If the unit fails or the app never answers, the space's unit is removed and the
operator's comes back as it was: enabled again if it was enabled, only started if it was only
running. `space app supervise APP operator` is the way back, for an app whose operator unit is still
installed: the space's unit goes, the operator's is enabled, and later syncs record it as a
conflict and leave it running. The app is down for the seconds between the stop and the first
healthy answer.

## Rollout

1. The code above, with `operator` as the default: nothing changes on a machine until it opts in.
2. One unimportant app on one machine, handed over by hand: disable its operator unit, set
   `SPACE_SUPERVISOR=space`, remove `SPACE_SERVICE_STOP` / `SPACE_SERVICE_LOGS`, restart ai-space,
   check `space app service`, the page and the journal. The switch is per machine, but the
   [conflict](#conflicts) rule makes it safe to take apps over one at a time: every app whose
   operator unit is still enabled shows `conflict` and keeps running under that unit, untouched.
   Until an app is handed over, its logs and its uninstall are the operator's again
   (`journalctl -u <app>`, `systemctl disable --now <app>`).
3. Done: `setup` asks the question (section 3 of 6), checks lingering among the tools, offers `space`
   by default on a machine with lingering and no operator templates, and clears the templates when
   `space` is chosen; install.md and install-by-agent.md write `SPACE_SUPERVISOR=space` for a fresh
   install. The default app's installer (ai-usage) must honour `SPACE_SUPERVISOR=space` before a
   fresh install relies on it.
4. Machine by machine, app by app, with `space app supervise <app>` ([hand-over](#hand-over)).

## macOS

On macOS (`process.platform === "darwin"`) the same supervisor drives launchd instead of systemd
(`src/space/services/launchd.ts`, behind the `ServiceManager` interface in `manager.ts` that
`systemd.ts` implements too). Everything above holds (the rule for who should run, the
reconcile table, conflicts, hand-over, uninstall), with these words swapped:

| systemd | launchd |
| --- | --- |
| `~/.config/systemd/user/space-<app>.service` | `~/Library/LaunchAgents/space.<app>.plist`, label `space.<app>`, domain `gui/<uid>` |
| the marker on the first line | the marker comment on the second line, after the XML declaration |
| `EnvironmentFile=` with `KEY="value"` | a shell file, `export KEY='value'`, sourced by the wrapper below |
| `Restart=on-failure`, `RestartSec=5` | `KeepAlive` `{SuccessfulExit: false}`, `ThrottleInterval` 5 |
| `WantedBy=default.target` + lingering | `RunAtLoad`: loaded at every login of the user |
| `KillMode=control-group` | the wrapper passes SIGTERM to the job's process group |
| `TimeoutStopSec=30` | `ExitTimeOut` 30 |
| `enable --now` / `disable --now` | `launchctl enable` + `bootstrap` / `bootout` + `launchctl disable` |
| `restart` | `bootout`, wait, `bootstrap` (launchd reads the plist only when it loads it) |
| the journal | `<workspace>/logs/<app>/service.log` |
| the operator's `<app>.service`, user or system | the operator's job labelled `<app>`: `~/Library/LaunchAgents/<app>.plist` or `/Library/LaunchDaemons/<app>.plist` |

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!-- Written by ai-space. Do not edit: it is regenerated on every app sync. -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>space.<app></string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>[ -r "$1" ] || exit 78; . "$1"; trap '…' TERM INT HUP; /bin/sh -c "$2" &amp; wait $!</string>
    <string>space-<app></string>
    <string><workspace>/run/env/<app>.env</string>
    <string><service.command></string>
  </array>
  <key>WorkingDirectory</key><string><app dir></string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ExitTimeOut</key><integer>30</integer>
  <key>ProcessType</key><string>Standard</string>
  <key>StandardOutPath</key><string><workspace>/logs/<app>/service.log</string>
  <key>StandardErrorPath</key><string><workspace>/logs/<app>/service.log</string>
</dict>
</plist>
```

- **The wrapper.** launchd signals only the job's main process. The shell sources the environment
  file, runs the command in the background and waits; its trap sends SIGTERM to the job's whole
  process group (launchd makes each job a group leader), so the app gets the SIGTERM the contract
  promises however the command starts it. The command's exit status is the job's, so a clean exit
  stays down and a crash restarts. The credentials stay in the environment file (0600), never in
  the plist, which other users can read. The command and the file path are arguments, so nothing in
  them is quoted for the shell.
- **Stopping.** `launchctl bootout` returns before the job has exited. Every stop and restart
  therefore waits for the job's process group to empty (SIGKILL after 35 s) and for the label to
  leave the domain before the next `bootstrap`: the new process never meets the old one on the
  port.
- **States.** `launchctl print` is mapped onto systemd's words: running is `active`; `spawn
  scheduled` after a crash is `activating`/`auto-restart`; not running with a non-zero last exit is
  `failed`. `restarts` is launchd's run count less one, and `since` comes from `ps -o lstart`.
  A loaded job that is not running is unloaded and loaded again on `start`, so the counts start
  over.
- **Enabled.** A LaunchAgent whose file exists and whose label is not switched off
  (`launchctl print-disabled`) is `enabled`: it loads at the next login. An operator's agent that is
  enabled or running is a [conflict](#conflicts), exactly as an enabled systemd unit is; `space app
  supervise <app>` unloads and disables it (a LaunchDaemon through `sudo -n launchctl`) and gives it
  back the same way.
- **The session.** LaunchAgents run in the user's GUI domain, which exists while the user is logged
  in at the Mac (automatic login keeps it so after a reboot). Without it (`launchctl print
  gui/<uid>` fails, e.g. only an SSH session) the supervisor answers like a systemd machine without
  lingering: every sync records `failed`, nothing is written. `setup` checks it among the tools.
- **Logs.** stdout and stderr are appended to `<workspace>/logs/<app>/service.log`; `space logs
  <app>` and `GET /api/apps/:app/logs` read it with `tail`. Hourly, and at boot, a log over 10 MiB
  is copied to `service.log.1` and truncated in place (launchd keeps it open for appending, so the
  app goes on writing at the new end).
- **ai-space itself** is not one of these jobs: restarting it leaves every app running, and the
  next sync finds them `unchanged`. How ai-space itself is kept running on a Mac (a LaunchAgent of
  the operator's, a terminal) is up to the operator; `SPACE_SERVICE_LOGS` still says where its own
  log is for `space logs space`.

## Not in v1

Resource limits (`MemoryMax=`, `CPUQuota=`), ordering between apps, cgroup metrics, machines with
neither systemd nor launchd, and services that need root. The unit is the obvious place for the first three when they
come; they would be manifest fields rendered into it.
