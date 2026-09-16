# Terminal: a shell on this machine and on peers

Status: implemented (`src/space/terminal/`, `src/web/Terminal.tsx`). Off by default.

## Problem

Operating a space sometimes needs a shell: read a log, restart a unit, run a one-off script, look at a directory the panel does not show. The panel already runs on the machine as the operator's user, the chat already opens a Claude Code session there with `bypassPermissions` when asked, and on a peer machine the same is true through the hub. What was missing is the plain thing: a terminal in the browser, on whichever machine the panel knows, without an SSH client, a VPN or a second tool.

A terminal is also the most direct exposure a web page can have, so this design is mostly about what it does *not* let happen.

## Shape

One built-in panel, opened from Settings, with a machine picker (this machine and every peer that offers a terminal) and one tab per session. Each session is one shell process in a pseudo-terminal on the chosen machine, connected to an xterm.js instance in the browser over one WebSocket.

```
browser ── xterm.js ══ ws ══ hub ai-space ── PTY ── $SHELL -l            (this machine)
                        └═══ ws ══ hub ── ws ══ peer ai-space ── PTY ── $SHELL -l   (a peer)
```

Rules:

- **The client chooses nothing about the process.** The command (`SPACE_TERMINAL_SHELL`, default `$SHELL -l`), the working directory (the workspace root) and the environment come from the machine's configuration. The browser sends keystrokes and the window size, nothing else.
- **Off unless turned on.** No `SPACE_TERMINAL_ENABLED=1` in a machine's `.env`, no shell there: the session routes answer 404 and the machine reads "off" in the picker. A peer that leaves it off is not offered to the hub either.
- **A shell costs one session on one machine.** The hub never runs anything on behalf of a peer; it forwards the two requests that open a session and bridges the socket frame by frame.
- **Be honest.** A session that ends says why (the shell exited with a code, the browser left, idle, ended by the operator, ai-space restarted), in the terminal and in the audit row.

## Opening a session

Two steps, because a browser cannot put a header on a WebSocket and a socket URL must not carry a standing credential:

1. `POST /api/terminal/sessions { cols, rows }`. The server checks that the terminal is on, that the request comes from the panel's own origin, the passphrase when one is configured, and the session cap; then it reserves a session and answers `{ id, ticket, expiresIn }`. The ticket is 24 random bytes, valid for 30 seconds, usable once.
2. `GET /api/terminal/ws?ticket=…` upgrades to a WebSocket. The ticket is redeemed (a second use, or a late one, is a 401), the shell is spawned in a new PTY of the requested size, and the socket is attached.

On the socket, **binary frames** are bytes: keystrokes towards the shell, output towards the browser. **Text frames** are JSON control messages: the browser sends `{"type":"resize","cols","rows"}` (and may send `{"type":"ping"}`); the server sends `{"type":"ready", id, backend, shell, idleMs}` once, `{"type":"exit", code}` when the shell ends (`code` is null when it was killed; `detail` carries the wrapper's stderr when the shell could not start), and `{"type":"closed", reason}` before it closes the socket for idle, killed or shutdown. The close code is 1000 with reason `exit` when the shell ended on its own, 4000 with the reason otherwise.

A session ends when:

| Event | What happens |
| --- | --- |
| The shell exits | `exit` message, socket closed, audit row with the exit code. |
| The browser closes the socket (tab closed, network gone) | The shell gets SIGHUP; SIGKILL two seconds later if it is still there. No reconnection: a dropped connection is a new session, like an SSH client without tmux. Run `tmux` or `screen` inside for anything that must outlive the tab. |
| No keystroke for `SPACE_TERMINAL_IDLE` (default 30 minutes) | `closed: idle`, then the shell is hung up as above. Output alone does not count as activity, so a forgotten `tail -f` still closes. `0` turns the limit off. |
| `DELETE /api/terminal/sessions/:id` (the operator, from any panel on the same origin) | `closed: killed`. |
| ai-space stops | `closed: shutdown`; every session is hung up. Rows still open at the next boot are marked `lost`. |

A ticket that is never redeemed expires with its 30 seconds and the reservation is dropped by the next sweep. Reservations count against `SPACE_TERMINAL_MAX_SESSIONS` (default 4) together with open sessions, so a page cannot pile up tickets.

## The pseudo-terminal

Two backends behind one interface (`pty.ts`), chosen at boot:

- **`python3`** with the standard `pty` module, through `pty_helper.py`, whenever `python3` is on the PATH: the helper forks the shell in a PTY (`pty.fork()`, which makes it a session leader with the PTY as controlling terminal) and speaks a five-byte framing on its stdin (kind, length, payload: keystrokes or a resize) with raw output on stdout. Every Linux server and macOS has it; nothing is installed. It exits with the shell's status, or 128 + signal, and hangs the shell up when its stdin closes.
- **`Bun.Terminal`**, the runtime's own PTY, as the fallback when the Bun version has it (`typeof Bun.Terminal === "function"`). As of Bun 1.4.2 it attaches the PTY as plain stdio without making it the controlling terminal: bash reports "no job control in this shell", Ctrl-C reaches no process, and programs that open `/dev/tty` (sudo, ssh prompts, polkit's agent) fail. Fine for output, poor for a shell, hence second.

`SPACE_TERMINAL_PTY=bun|python` forces one (for the day Bun's PTY sets a controlling terminal). Neither backend exists → `enabled` is false in the status with a boot log line saying so, and the picker says "off".

Sessions run with the ai-space process's environment minus anything that looks like a credential (`*TOKEN`, `*SECRET`, `*PASSWORD`, `*PASSPHRASE`, `*API_KEY`, `*ACCESS_KEY`, `*PRIVATE_KEY`, `*CREDENTIALS`), plus `TERM=xterm-256color`, `COLORTERM=truecolor`, a UTF-8 `LANG` when none is set, `SPACE_HOME` and `SPACE_TERMINAL_SESSION`. The workspace `.env` is loaded into the process at boot, so the strip keeps `SPACE_API_TOKEN`, `SPACE_HUB_TOKEN`, `SPACE_PEER_*_TOKEN`, `SPACE_S3_SECRET_ACCESS_KEY`, `GH_TOKEN` and the model keys off the screen (`env`, a shared recording, a screenshot) and out of whatever the shell spawns by accident. It is not isolation: the shell runs as the operator's user, who can `cat` the file. A login shell (`-l`) reads the user's own profile, so the operator's PATH and aliases apply, the same as over SSH.

## Peers

A peer with the terminal enabled serves it to its hub under the bearer-guarded peer routes ([peers.md](peers.md)): `GET /api/peer/terminal`, `POST /api/peer/terminal/sessions`, `DELETE /api/peer/terminal/sessions/:id`, `GET /api/peer/terminal/ws`. Its snapshot carries `terminal: true`, which is how the hub's machine picker knows to offer it. With the terminal off on the peer these routes are absent and the flag is false, whatever the hub wants.

On the hub the same four exist under `/api/peers/:peer/terminal/…`. The two HTTP ones are forwarded like chat, with the token, the access-layer headers and the passphrase header (`x-terminal-passphrase`) added: the passphrase, when the *peer* sets one, is typed on the hub's page and checked on the peer. The socket is bridged: the hub upgrades the browser, dials the peer's `/api/peer/terminal/ws?ticket=…` with the same headers, and copies frames both ways; the peer's close code and reason reach the browser, and the browser leaving closes the peer side. A peer that refuses the socket (bad ticket, wrong token, down) closes the browser side with code 4002 and says which peer refused.

The hub keeps no session state for peer sessions and writes no audit row for them; the peer does both, as for its own. A peer session ends by the peer's rules (its idle limit, its cap).

## Configuration

In `<workspace>/.env`, per machine:

```
SPACE_TERMINAL_ENABLED=1           # off by default
# SPACE_TERMINAL_SHELL=/bin/zsh -l # default: $SHELL -l, else bash, else sh; split on spaces, no quoting
# SPACE_TERMINAL_PASSPHRASE=       # typed in the browser before the first session; kept in memory only
# SPACE_TERMINAL_IDLE=30m          # 0 = never
# SPACE_TERMINAL_MAX_SESSIONS=4    # open sessions plus unredeemed tickets
```

A bad value is reported at boot and replaced by the default. A passphrase shorter than eight characters is reported too. Five wrong passphrases in a minute lock the check for a minute, for everyone, including the right one: the panel has one operator, and a lockout beats an oracle.

## Trust boundary

The panel routes carry no bearer token ([panel.md](panel.md#trust-boundary)): whoever passes the operator's access layer, or reaches loopback, has the panel. For the terminal this means a shell, so the boundary is stated here in full.

What the terminal adds on top of the panel's exposure: nothing in kind (the chat with `bypassPermissions` is already a shell on the machine), one thing in degree (a terminal is direct and interactive), and one new class of risk: a page on **another site** that a logged-in operator visits. Browsers send the access layer's cookie with a cross-site WebSocket, and a WebSocket is not subject to CORS. Hence:

- **Same origin.** Every request that opens or ends a session (`POST …/sessions`, `DELETE …/sessions/:id`, the socket upgrade) must carry an `Origin` matching the host the request arrived at (or `X-Forwarded-Host` behind a proxy), or, without `Origin`, a `Sec-Fetch-Site` of `same-origin` or `none`. Anything else is a 403 before any other check. A request with neither header (a script on the machine, the hub's forward) passes: those are not browsers.
- **One-time tickets.** The socket URL carries a ticket that expires in 30 seconds and dies on first use, never a token. A leaked URL (a log line, a `Referer`) is worth nothing after that.
- **Off by default, per machine.** A machine that does not want a shell over HTTP sets nothing and has none, whatever the hub's operator wants.
- **Passphrase**, optional, as a second check in the browser for operators whose access layer is weak or shared. It is typed per page load and held in memory; a `401` from the server clears it. This is a check on the machine, not a substitute for the access layer: an operator who wants a real second factor puts it in front of the tunnel.
- **Caps and idle.** A forgotten tab closes itself; a page cannot open more than the cap.
- **Audit, not surveillance.** One row per session in `space.db` (`terminal_sessions`): when it started and ended, how it ended, the exit code, the user agent, bytes each way, the size. Keystrokes and output are never recorded, matching the chat's rule; an operator who wants a transcript runs `script` inside the session.

What the hub token grants on a peer grows accordingly: it was a chat with `bypassPermissions`, it is now also a terminal, when the peer enables one. [peers.md](peers.md#trust-boundary) says to treat the hub's workspace as holding a shell on every peer; that stays true and is now literal.

What the terminal does not do: it does not run as another user, does not confine the shell (no container, no seccomp), does not filter commands, does not record sessions, and does not reconnect a dropped socket. Each of these is a different product; the terminal here is the operator's own shell on the operator's own machine, reached through the operator's own access layer.

## Web UI

- **The Terminal tile**, a built-in tile next to Settings in the Apps grid, opens the panel; it stays mounted, so closing it (✕ or a click outside) keeps the sessions and their scrollback. Escape is left to the shell.
- **Header**: the machine picker (this machine first, then peers; a machine that is off or down is listed but disabled), ＋ for a new session on the picked machine, 🕘 for the recent sessions of this machine (from the audit rows), ✕.
- **Tabs**: `<machine> #n` with a dot: amber while connecting, green while open, grey when closed. The ✕ on a tab closes its socket, which hangs the shell up.
- **Passphrase**: a field appears when the machine says one is required or the one given was wrong; the entry is kept in memory for the page.
- **Terminal**: xterm.js with the fit addon; the shell is resized whenever the pane is. Light and dark themes follow the panel's.
- A footer line says where the shell runs and what is recorded.

## Routes

| Route | Purpose |
| --- | --- |
| `GET /api/terminal` | status (enabled, backend, shell, whether a passphrase is set, limits), the machines (this one and the peers with their `enabled` and health), open sessions, recent audit rows |
| `POST /api/terminal/sessions` | `{ cols, rows }` → `{ id, ticket, expiresIn }`; `x-terminal-passphrase` when one is set; same-origin |
| `DELETE /api/terminal/sessions/:id` | end a session; same-origin |
| `GET /api/terminal/ws?ticket=` | the session's socket; same-origin, ticket redeemed once |
| `GET /api/peers/:peer/terminal`, `POST …/sessions`, `DELETE …/sessions/:id`, `GET …/ws` | the same on a peer, forwarded and bridged by the hub |
| `GET /api/peer/terminal`, `POST /api/peer/terminal/sessions`, `DELETE /api/peer/terminal/sessions/:id`, `GET /api/peer/terminal/ws` | this space as a peer: the four above behind the hub token, present only while the terminal is enabled here |

## Module layout

```
src/space/terminal/   config.ts (SPACE_TERMINAL_*, the environment strip), pty.ts (Bun.Terminal and python backends),
                      pty_helper.py, service.ts (tickets, sessions, cap, idle sweep, passphrase lockout), store.ts (audit rows),
                      api.ts (routes, same-origin check, the websocket handler, the hub bridge), terminal.test.ts
src/web/Terminal.tsx  the panel (xterm.js, tabs, machine picker, passphrase, history)
```

## Failure modes considered

- No PTY backend on the machine: status says `enabled: false` with the reason in the boot log; the session route answers 404 with the reason.
- The shell binary is missing or not executable: the session opens, the wrapper's stderr arrives in an `error` message, the session ends as `failed`.
- A slow browser: output is dropped for that socket once four megabytes are buffered, the shell is never blocked.
- A large paste: socket frames are capped at one megabyte; the browser splits or the frame is refused.
- The hub loses the peer mid-session: the peer hangs the shell up when its socket closes; the browser sees the close reason.
- Two tabs open the same ticket: the second is a 401; the first keeps the session.
- ai-space restarts: every shell is hung up (`shutdown`); rows left open are marked `lost` at the next boot.
