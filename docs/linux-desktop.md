# Linux desktop client

Status: built and run on Ubuntu 24.04 (GNOME, Wayland). The Client edition connects to existing
Spaces; the Local edition also sets up and runs a Space on this computer as a systemd user service
([local.md](local.md#on-linux)). It follows the Mac client ([macos-desktop.md](macos-desktop.md))
where Linux allows, and says below where it does less.

## What it is

| Part | What it does |
| --- | --- |
| Home | The command box over the library ([panel.md](panel.md#omnibox)): typing filters every app, agent and widget, best names first (the web panel's ranking, `src/space/shortcuts/ranking.ts`). Return opens the best match when its name holds the whole query, otherwise asks Space Assistant in a new conversation; Ctrl+Return always asks. Below it: the panel's home screen (its apps, agents, widgets and the panel's own tiles, `builtin:<name>`), the widgets, the apps with Inbox, Shortcuts, Terminal, Panel and Settings, and the agents. Right-click an app for Open in Browser |
| Chat | Native conversations with the Space's agents: the agents and recent conversations in a sidebar, messages drawn natively (Markdown, one quiet row per tool call that opens to its input and output, approval and question cards, a failed turn with its reason and Try Again, Grant and retry after a refusal for lack of permission), the permission picker, pictures attached by button, paste or drop, Stop. A message sent while a turn runs joins it (steering) or waits its turn. A turn survives a dropped connection (it reattaches from the last event) and an app restart (running turns are picked up again). The logic is the Mac's `ChatController`, ported to `core/conversation.ts` |
| Inbox | The Space's open threads; opening one marks it read and goes to its page; Mark as Read, Done, Mark All as Read. New unread threads arrive as desktop notifications with Mark as Read and Done, from every saved Space |
| Terminal | Shells on the Space's machine and its peers, one tab each: xterm.js in a web view whose page counts as the Space's origin, speaking the panel's protocol ([terminal.md](terminal.md)); a passphrase is asked natively and kept in memory |
| Apps | The Space's pages in tabs: apps, the web panel, links from the inbox or a chat. A link to another app opens in that app's tab, a link off the Space in the browser. A tab moves to a window of its own and back |
| Quick Chat | A small window with one conversation: `ai-space --quick-chat` shows it or hides it. GNOME and KDE let no app register a global shortcut, so Settings shows the command to bind under Keyboard › Custom Shortcuts |
| Settings | The saved Spaces (switch, make default, remove, add), keep running when the window is closed, start at login, notifications, the Quick Chat command; in the Local edition, AI Space on This Computer; Peer, this computer as a peer of a Space used elsewhere ([below](#peer)) |

The window has Home, Chat, Inbox, Terminal and Apps in the header (in a bar at the bottom on a
narrow window), the Space menu at the start of the header, and a banner when the Space needs a
sign-in, cannot be reached (with what was last known, kept on disk) or cannot be opened. Before any
Space is saved it shows the welcome screen: an address to connect to, a Space already answering on
`127.0.0.1:8700` in one click, and in the Local edition the setup.

`aispace://` links work as on the Mac (`core/desktop.ts`, `parseDeepLink`): `chat?agent=&text=`,
`open?app=`, `inbox`, `show`. A link may fill in a message but never sends it.

Shortcuts: Ctrl+1…5 for the views, Ctrl+F or Ctrl+L for the command box, Ctrl+N for a new
conversation, Ctrl+Shift+T for a terminal, Ctrl+Shift+P for the web panel, F5 to look at the Space
again, Ctrl+Shift+Space for Quick Chat while the app has focus, Ctrl+, for Settings, Ctrl+Q to quit.

## How it is built

TypeScript, bundled by Bun for [GJS](https://gjs.guide/) (GNOME's JavaScript runtime), on GTK 4,
libadwaita, WebKitGTK 6.0, libsoup 3 and libsecret. One language with the rest of the repository,
the web code reused as it is, and the desktop's own widgets, notifications, keyring and file
dialogs.

```
desktop/linux/
  src/core/       runtime-neutral logic, typed and tested with bun test: URLs, connections,
                  the catalogue and search, Space checks, SSE, chat turns and conversations,
                  the inbox, deep links, Markdown to Pango markup, navigation rules, strings (en, zh)
  src/app/        GTK glue (GJS only): window, views, HTTP (libsoup), web views (WebKit),
                  the Local manager, notifications
  src/main.ts     the entry point (`gjs -m main.js`)
  terminal/       the terminal page: xterm.js and the session glue, bundled for the browser
  share/          the desktop entry and AppStream metadata
  build.ts        the build (below)
  install.sh      the per-user installer, copied into every build
  ai-space.sh     the launcher, installed as bin/ai-space
```

`core/` imports only what both Bun and GJS have; a test fails if it reaches for `fetch`, `URL`,
`AbortController` or another global GJS lacks. It reuses `src/web/chat-steps.ts` (the ordered
work of a turn, the same rows the panel draws), `src/web/screens.ts` and the ranking above, and
takes its types from the server's own modules. The app layer types GObject libraries loosely
(`src/gi.d.ts`): it is glue, and the logic it drives lives in `core/`.

| Command | Does |
| --- | --- |
| `bun run linux:build` | `desktop/linux/build/ai-space`: `main.js`, `terminal/`, the icon, `bin/ai-space`, `install.sh`, `VERSION.json` |
| `bun run linux:run` | builds, then runs it from the build directory |
| `bun run linux:install` | builds, then installs it for this user |
| `bun desktop/linux/build.ts --local --out <dir>` | the Local edition: the same plus `space/`, the Space's release tree (release/server.ts `stageRelease`, `runtime/bun`, `runtime/space-pty`) |
| `bun run release:linux` | both editions as tarballs in `dist/` ([release.md](release.md#linux-app)) |

## Installing

Needs GJS, libadwaita 1.5 or later, WebKitGTK 6.0, libsoup 3 and libsecret, which current GNOME
desktops have (Ubuntu 24.04, Fedora 40, Debian 13, Arch):

```sh
sudo apt install gjs gir1.2-adw-1 gir1.2-webkit-6.0 gir1.2-soup-3.0 gir1.2-secret-1   # Debian, Ubuntu
sudo dnf install gjs libadwaita webkitgtk6.0 libsoup3 libsecret                          # Fedora
```

Unpack a release tarball (or build one) and run `./install.sh` in it. It installs for the user,
with no root:

| Path | What |
| --- | --- |
| `~/.local/share/ai-space/app/` | the app, replaced on every install |
| `~/.local/bin/ai-space` | the launcher |
| `~/.local/share/applications/dev.ai_space.Desktop.desktop` | the desktop entry; it also handles `aispace://` |
| `~/.local/share/icons/hicolor/scalable/apps/`, `~/.local/share/metainfo/` | the icon and AppStream metadata |

`install.sh --uninstall` removes those. Neither touches a workspace, the saved Spaces, or the
Local edition's background service (remove that first, in Settings › This Computer).

What the app keeps:

| Path | What |
| --- | --- |
| `~/.config/ai-space/connections.json` | the saved Spaces (an unreadable file is set aside as `connections.unreadable.json` and the app says so) |
| `~/.config/ai-space/preferences.json` | keep running, notifications, the chat permission, the window's size, agent CLIs chosen by hand |
| `~/.local/share/ai-space/desktop/<connection>/` | each Space's web data: cookies (its sign-in), storage, cache |
| `~/.cache/ai-space/catalogue-<connection>.json` | the last catalogue, shown marked as such while the Space cannot be reached |
| `~/.config/autostart/dev.ai_space.Desktop.desktop` | Start at login (`ai-space --background`) |
| `~/.config/systemd/user/ai-space-peer-tunnel.service` | the peer tunnel, when one was started in Settings › Peer (remove it there) |

## Peer

Settings › Peer makes this computer's Space a peer of a Space used elsewhere, the hub
([peers.md](peers.md)), in three groups:

| Group | What it does |
| --- | --- |
| This Computer as a Peer | Writes `SPACE_HUB_TOKEN` (32 random bytes, hex; copy, or make a new one), `SPACE_NAME` (suggested from the host name; letters, digits and `-`, so the hub reads it back unchanged) and `SPACE_TERMINAL_ENABLED` into this Space's workspace `.env`, edited as `space setup` edits it (`core/peer.ts`, tested against `src/space/setup.ts`), mode 0600. The workspace is the Local edition's, else `SPACE_HOME`, else `~/.ai-space`. Save restarts the Local edition's service; another Space on this computer has to be restarted by hand. Turning it off empties the token, which removes `/api/peer/*` |
| How the Hub Reaches This Computer | An SSH tunnel: the app writes `~/.config/systemd/user/ai-space-peer-tunnel.service`, which runs `ssh -N -R 127.0.0.1:<port>:127.0.0.1:<SPACE_PORT> <user@host>` with key login only (`BatchMode`), reconnects after a drop and starts at login; Start, Stop and Remove, and the last line ssh logged when it is not connected. The hub's machine needs this computer's key (`ssh-copy-id`); its own `127.0.0.1:<port>` then leads here, and nothing is published. Or an address of the person's own (a Cloudflare tunnel's hostname) with optional headers for its access layer |
| On the Hub | The lines for the hub's `.env` (`SPACE_PEER_<NAME>`, `_TOKEN`, `_HEADERS`), to copy, and a check that asks a saved Space's `GET /api/peers` how it sees this computer |

## Trust boundary

The same as the Mac client's ([macos-desktop.md](macos-desktop.md#authentication-and-the-web-boundary)): each saved
Space has its own WebKit network session, and the native calls (catalogue, chat, inbox) carry that
session's cookies, so signing in on the panel's page signs in everything. No operator token is
used. A redirect, 401 or 403 means "sign in"; native writes name the Space's origin as the page's
do. The web views follow the Mac's navigation rules (`core/navigation.ts`): links that leave the
Space open in the browser, new windows never open inside the app, and only the microphone (never
the camera) is granted, to pages of the view's own origin or the connection's. A remote Space
needs https; plain http is accepted for loopback only.

WebKitGTK runs each page in a sandboxed web process (bubblewrap). Ubuntu 23.10 and later restrict
the user namespaces bubblewrap needs to programs an AppArmor profile allows. `install.sh` copies
the system's `gjs` into the app as `bin/ai-space-gjs`, and `install.sh --apparmor` (with sudo)
installs a profile for that copy alone, in the shape of Ubuntu's profile for its own web browser
(Epiphany). Without the profile the launcher starts WebKit without its sandbox rather than not at
all, and Settings shows the command that turns it on.

## Debugging

`AISPACE_DEBUG=1` logs state changes and enables WebKit's inspector. Hidden options for checks
without a person at the screen: `--page <home|chat|inbox|terminal>`, `--action <name>` (a window
action such as `new-terminal`, `panel` or `search`, an app action as `app.settings`, or
`ask=<text>`; repeatable) and `--screenshot <file.png>`, which saves the window after
`AISPACE_SCREENSHOT_DELAY` milliseconds (4000) and quits. `AISPACE_LOCAL_BUNDLE` points the Local
manager at another release tree.

## What the Mac client has and this one does not (yet)

- Voice input in the message field.
- Editing the home screens (pin, new screen, copy the panel's layout); Home shows the panel's own.
- The native Settings sections beyond the app's own (Appearance, Models, Usage, Status,
  Packages, Account); the web panel's Settings has them.
- Updating the app itself; the Local edition updates its service from the release the app carries.
- A global shortcut of its own (see Quick Chat above).
