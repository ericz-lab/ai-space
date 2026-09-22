# Service supervision

Status: implemented (`src/space/services/`), with `setup` asking the question. Handing the running
machines over is the next step; see [Rollout](#rollout).

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
| `space` | The space: one user unit per app, `space-<app>.service` | Writes, starts, restarts and removes the unit on every sync; reads its journal; stops it on uninstall. |

`operator` stays the default so a machine whose services are the operator's units keeps them until
it is switched on purpose; a switch without first disabling those units would start every app twice
on the same port (the space refuses that, see [Conflicts](#conflicts)).

Under `space`, `SPACE_SERVICE_STOP` and `SPACE_SERVICE_LOGS` describe units that no longer run the
apps, so ai-space refuses to start with either of them set: remove them from the `.env` when
switching.

`space` needs a systemd user manager that runs without a login session: `loginctl enable-linger
<user>`. Without one, every sync of an app records `failed` with that reason and nothing is written.
A machine without systemd (a laptop on macOS) stays on `operator`.

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
KillMode=mixed
TimeoutStopSec=30

[Install]
WantedBy=default.target
```

- The first line is the marker. The space only ever changes or deletes a unit that starts with it;
  anything else of that name is left alone and reported.
- The command is escaped for systemd (`\`, `"`, and `%` and `$` doubled), so the shell sees exactly
  the manifest's command, with `${VAR}` placeholders already resolved from the workspace `.env` as
  for tasks. A command over several lines is refused: put the lines into a script.
- `KillMode=mixed` sends SIGTERM to the main process only; `TimeoutStopSec=30` leaves the 10 seconds
  the app contract promises plus room before systemd kills what is left.

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
```

Panel routes, no bearer token, like uninstall. `GET /api/services` carries `supervisor` at the top
and on each local row, and the last sync's outcome as `supervision`.

```
space app service APP           who runs it, the unit, state, restarts, since when, the last sync
space app start|stop|restart APP
space status                    one line more: the supervisor and any unit in conflict or failed
```

A `stop` lasts until the next sync of the app, which starts it again; to keep an app stopped, set
`status: paused`.

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
4. Machine by machine, app by app. A `space app supervise <app>` that does the hand-over with a health
   check and rolls back on failure is the next piece of code.

## Not in v1

Resource limits (`MemoryMax=`, `CPUQuota=`), ordering between apps, cgroup metrics, machines without
systemd, and services that need root. The unit is the obvious place for the first three when they
come; they would be manifest fields rendered into it.
