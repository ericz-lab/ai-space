# Linux desktop client

Status: built and run on Ubuntu 24.04 (GNOME, Wayland). AI Space Desktop (the Client edition)
connects to Spaces that exist: at its first launch it offers to connect to the AI Space on this
computer (installed first when there is none) or to one on another machine ([below](#first-launch)). It
carries no service. The app follows the Mac client ([macos-desktop.md](macos-desktop.md)) where Linux allows, and says
below where it does less.

## What it is

| Part | What it does |
| --- | --- |
| Home | Pages side by side, as on the Mac ([macos-desktop.md](macos-desktop.md)): a sideways swipe on the touchpad, the dots above them, or Ctrl+Page Up and Ctrl+Page Down. The first page is the **Library**: every app (with the panel's own tiles, `builtin:<name>`: App Store, Inbox, Shortcuts, Terminal and Settings, and this client's Panel tile; [below](#built-in-tiles)), agent and widget under the command box ([panel.md](panel.md#omnibox)). Then the **screens**, one page each; the window opens on the first, the **home screen** (主屏幕, "Main" in the app), which carries the command box too ([below](#the-home-screen-at-first)). Typing filters every app, agent and widget, best names first (the web panel's ranking, `src/space/shortcuts/ranking.ts`), and while the box holds a query that page shows the matches. When the Space reads the text as a shortcut it can run (`POST /api/shortcuts/resolve`: arithmetic, a conversion, an action named at its start such as `待办 明天下午3点 写周报`), a row above Ask Space Assistant shows it with what the text filled, and Return opens the panel's Shortcuts page on it, its form filled from the text (`/?page=shortcuts&run=<text>`, `core/shortcuts.ts`); otherwise Return opens the best match when its name holds the whole query, else asks Space Assistant in a new conversation; Ctrl+Return always asks: in a new conversation, sent at once, as on the Mac; a draft in the chat field stays as it was, and while Space Assistant is still answering, the question waits for that turn to end and then starts its new conversation (the chat field says so; `ask` in `core/conversation.ts`). An agent the Space lists once per machine (the same `app/name` on this machine and on peers) is one tile, standing for the local variant, else the first peer that answers; a screen pinned with one machine's variant shows that tile (`core/agents.ts`, the web's `agent-groups.ts`). A screen shows its tiles, then its **widget cards**, drawn as the panel draws them (`core/widgets.ts`, from `src/web/WidgetBlocks.tsx`): the first block large (value, change, line or bar chart, progress bar, gauge), the next ones as rows, paged with dots when they do not fit; a list widget its items with their age; an `embed` widget the app's own page in a web view. A card is touched as the panel's is ([below](#widget-cards)): views, copy, a local card's actions, the trend readout, a refresh from its time. On a Space that keeps widget frames the cards are laid out stepless, as the panel's widget area ([panel.md](panel.md#resize-a-widget)), and **Edit Layout** in the screen's ⋯ menu resizes them ([below](#widget-layout)); an older Space's cards are drawn in a grid as before. The screens are this computer's (`~/.config/ai-space/screens.json`, `core/screens.ts`): copied from the panel's once, then changed here and never written to the Space; the one thing that still follows the panel is an app installed from the App Store, which lands on the home screen here as it does there ([below](#apps-installed-from-the-app-store)). Right-click a tile or a card for Open, the screens it is on, Remove from This Screen, Open in Browser and Copy Link; the ⋯ button, or a right-click on a screen's empty part, for New Screen, Rename, Edit (reorder and remove), Edit Layout (the widgets' sizes, on a Space that keeps them), Copy the Panel's Layout and Delete |
| Chat | Native conversations with the Space's agents: the agents and recent conversations in a sidebar, messages drawn natively (Markdown, one quiet row per tool call that opens to its input and output, approval and question cards, a failed turn with its reason and Try Again, Grant and retry after a refusal for lack of permission), the permission picker, and, for an agent on several machines, a machine menu naming each machine's agent CLIs (`GET /api/model/inventory`): each machine keeps its own conversations, an offline one is listed but cannot be picked or sent to, and the choice is remembered per agent and opened next time from its tile; pictures attached by button, paste or drop, Stop. A message sent while a turn runs joins it (steering) or waits its turn. A turn survives a dropped connection (it reattaches from the last event) and an app restart (running turns are picked up again). The logic is the Mac's `ChatController`, ported to `core/conversation.ts`. What an app agent's tools did shows as chat cards under the reply ([below](#chat-cards)) |
| Inbox | The Space's open threads; opening one marks it read and goes to its page, and a thread with no page unfolds to its whole text instead (a second click folds it); Mark as Read, Done (with Undo in a toast, which opens the thread again), Mark All as Read. A change the Space did not take says so in a toast ("The change was not saved: …"), and an inbox that could not be read says why, with Try Again, instead of "Nothing new" (`inboxShown`, `inboxClick` in `core/desktop.ts`). New unread threads arrive as desktop notifications with Mark as Read and Done, from every saved Space |
| Terminal | Shells on the Space's machine and its peers, one tab each: xterm.js in a web view whose page counts as the Space's origin, speaking the panel's protocol ([terminal.md](terminal.md)); a passphrase is asked natively and kept in memory |
| Apps | The Space's pages in tabs: apps, the web panel, links from the inbox or a chat. A link to another app opens in that app's tab, a link off the Space in the browser. A tab moves to a window of its own and back (into its own Space's tabs, that Space shown) |
| Quick Chat | A small window with one conversation: `ai-space --quick-chat` shows it or hides it. GNOME and KDE let no app register a global shortcut, so Settings shows the command to bind under Keyboard › Custom Shortcuts |
| Voice input | A microphone beside Home's command box and the chat's message field (Quick Chat's too): the words appear in the field as they are heard and nothing is sent. `ai-space --dictate`, bound to a key the same way, talks into any app: the words show in a capsule at the bottom of the screen, and the text goes into AI Space's own field when it has the keyboard, else onto the clipboard for Ctrl+V ([below](#voice-input)) |
| Floating ball | A small round ball over every window and every workspace, off until Settings › General › Floating Ball turns it on ([below](#floating-ball)). Resting the pointer on it opens a dial of four sections around a hub; each Space sets its own sections on this computer (an app or an agent, Default, or None; the defaults are Keep, Space Assistant, Todo and Design Studio). Clicking a section opens Quick Chat on its agent (an app's own agent, else Space Assistant told where the work goes); a picture dropped on a section opens it with the picture attached, one dropped on the hub opens Space Assistant with it. Drag the ball to move it (its place is remembered); right-click for Quick Chat, Settings and Hide |
| Desk pet | The web panel's Claude walking along the bottom of Home, or of the screen over every app ([below](#desk-pet)); on by default, set in Settings › General › Desk Pet. It shows what the current Space is doing: it looks on while agents work, hops in its corner while one waits for an approval, spins when a turn is done and sleeps when all is quiet, with a line about it in a bubble. A click opens that agent's chat or the inbox; right-click to move it between the window and the desktop, or hide it |
| Settings | Laid out as the web panel's Settings, in its words: the sections on the left, one on the right, and the pages a section opens inside it with Back ([below](#settings)). Then Peer, this computer as a peer of a Space used elsewhere ([below](#peer)) |

Each saved Space keeps its own web tabs and terminal sessions, as the Windows client keeps its tabs
per Space (`core/per-space.ts`): picking another Space in the Space menu hides them, sessions still
running, and picking it again shows them as they were. They close when the Space is removed or
its address is changed.

The window has Home, Chat, Inbox, Terminal and Apps in the header (in a bar at the bottom on a
narrow window), the Space menu at the start of the header, and a banner when the Space needs a
sign-in, cannot be reached (with what was last known, kept on disk) or cannot be opened. Before any
Space is saved it shows the welcome screen ([First launch](#first-launch)).

`aispace://` links work as on the Mac (`core/desktop.ts`, `parseDeepLink`): `chat?agent=&text=`,
`open?app=`, `inbox`, `show`. A link may fill in a message but never sends it.

Shortcuts: Ctrl+1…5 for the views, Ctrl+Page Up and Ctrl+Page Down for Home's pages, Ctrl+F or Ctrl+L for the command box, Ctrl+N for a new
conversation, Ctrl+Shift+T for a terminal, Ctrl+Shift+P for the web panel, F5 to look at the Space
again, Ctrl+Shift+Space for Quick Chat while the app has focus, Ctrl+, for Settings, Ctrl+Q to quit.

## Built-in tiles

The panel's own tiles ([panel.md](panel.md#built-in-pages)) are tiles here too, in the panel's
order: App Store, Inbox, Shortcuts, Terminal and Settings, and Panel, which opens the web panel
itself. Inbox, Terminal and Settings open this app's own views; App Store and Shortcuts open the
panel's page of that name in a tab (`/?page=store`, `/?page=shortcuts`; `builtinPage` in
`core/screens.ts`).

Their pictures are the Space's, not the desktop's symbolic icons: `GET /api/apps` names one for
each tile (`builtins`), which is the panel's own file (`/store.svg`, `/inbox.svg`, …) or, where
the Space's owner chose an icon pack that covers `space/<name>`, the pack's picture. The app draws
that one, on a screen, in the Library and in Edit This Screen. The panel's own five files
(`src/web/public`, copied into the build as `data/builtin/`; a test keeps the list equal to the
server's `BUILTIN_ICONS`) show until the Space's picture has loaded, and stay when the Space names
none (an older Space) or it cannot be read. The Panel tile, which the panel does not have, keeps a
symbolic icon, and so do the Inbox and Terminal buttons in the header, which are the window's
navigation.

## First launch

AI Space Desktop carries no service. With no saved Space the welcome screen shows two entries and
does neither by itself (`core/first-launch.ts`, tested with `bun test`; `app/first-launch.ts` does
the requests and runs the installer; `app/welcome.ts` draws it):

- **Connect to Local AI Space**: the AI Space on this computer. Under it one line says what the
  click will do, from a look made when the screen shows: "Found on this computer", or "Not on this
  computer yet: it is downloaded and installed first". The look saves nothing.
- **Connect to a Remote AI Space** opens the address form.

Looking for the AI Space on this computer:

1. The ports: `SPACE_PORT` from the workspace's `.env` (`$SPACE_HOME/.env`, else
   `~/.ai-space/.env`) when it can be read, then 8700.
2. `GET http://127.0.0.1:<port>/api/space`, giving up after 2 seconds; only JSON that says
   `product: "ai-space"` counts ([editions.md](editions.md#service-identity)).

A click on **Connect to Local AI Space** looks again. **Found**: it is saved as "This Computer",
selected and shown. **Not found**: it is installed first, then connected, with only "Installing AI
Space…" and one progress bar on the screen:

- The app runs the release's own one-command installer
  ([release.md](release.md#one-command-install)), never a copy inside the app: it downloads
  `https://github.com/ericz-lab/ai-space/releases/latest/download/install.sh` to a file in a new
  private temporary directory (from `$AI_SPACE_DOWNLOAD/install.sh` when that variable is set,
  which the installer reads too: a mirror, or `file://` for a test), refuses anything that is
  not a script, and runs `bash <file>` in the app's environment with `AI_SPACE_NO_OPEN=1` and no
  input.
- The bar follows the lines the installer prints at each step (`InstallProgress`,
  [editions.md](editions.md#the-install-progress-bar)); the lines themselves are not shown.
- Exit code 0: the app looks again each second for up to 30 seconds, then saves and shows the
  Space. Any other code: one line of why, Try Again, and the end of the output folded under
  Details. No answer in that time: Try Again looks once more.

The app only ever installs. It never upgrades, stops or uninstalls the service: `space upgrade` and
`space uninstall` do. Removing the app (`install.sh --uninstall`) leaves AI Space, its workspace
and its background service in place. Closing the window while the installer runs does not stop it.

### The home screen at first

However the first Space came (found here, installed from the welcome screen, or connected by its
address), the window then shows Home on the **home screen**: the
first screen, the one tiles are pinned to and the panel calls home (`HOME` in
`src/web/screens.ts`). It is Home's second page; the library is the first, on its left, and the
window never opens there, nor on a later screen (`openingPage` in `core/screens.ts`). Another
saved Space picked from the Space menu opens on its home screen too.

The home screen does not start empty. This computer's first layout of a Space is the panel's
screens (`seed`); a Space just installed has none stored, and the app takes what a new panel
seeds: App Store, Inbox, Shortcuts, Terminal and Settings, then the first apps, agents and
widgets. Where the panel's home screen has nothing pinned (its owner emptied it, or keeps the
tiles on later screens), home gets that same set here, and the later screens are copied as they
are. Once a layout exists nothing fills it again: a home screen emptied here stays empty.

The carousel's own first page is the library, and it can only go to another page once it has a
size and its pages have theirs. Home asks again every 100 ms until the carousel is on the home
screen and stays there, for at most 3 seconds, so a slow first start does not leave the window on
the library.

### Apps installed from the App Store

The App Store tile opens the panel's store in a tab (`/?page=store`), and that page pins every app
it installs to the panel's home screen ([app-catalog.md](app-catalog.md#the-app-store)): the apps
ticked in the first-use choice after an install, and any app installed there later. This computer
keeps its own layout, so the app follows that pin (`adopt` in `core/screens.ts`): at each look at
the Space, an app the Space did not have before and that is on the panel's home screen is added to
the end of this computer's home screen, in the panel's order. Coming back to Home from the Space's
pages looks at once, so the tiles are there when Home shows.

- An app is new once. `screens.json` keeps, per Space, the apps seen since the layout was made
  (`apps`); one taken off the home screen here stays off, also after it is uninstalled and
  installed again.
- A new app the panel has not pinned (installed with `space app install`, or deployed) stays in
  the library; it waits (`awaiting`) and lands if the panel pins it to its home screen later.
- Nothing else follows the panel: what its owner pins, moves or removes there of apps this
  computer already knew changes nothing here. Copy the Panel's Layout still takes all of it.
- A layout made by an earlier version has no list of apps: the first look notes them and adds
  nothing.
- A Space whose panel has no screens stored yet (no browser has opened it) counts the home screen
  the panel would seed, so the first eight apps land here as they would there.

## How it is built

TypeScript, bundled by Bun for [GJS](https://gjs.guide/) (GNOME's JavaScript runtime), on GTK 4,
libadwaita, WebKitGTK 6.0 and libsoup 3. One language with the rest of the repository, the web
code reused as it is, and the desktop's own widgets, notifications and file dialogs.

```
desktop/linux/
  src/core/       runtime-neutral logic, typed and tested with bun test: URLs, connections,
                  the catalogue and search, Space checks, SSE, chat turns and conversations,
                  chat cards (`cards.ts`),
                  the inbox, deep links, Markdown to Pango markup, navigation rules, Home's screens,
                  widget cards and their interactions (`widget-interact.ts`) and the stepless widget
                  area (`widget-area.ts`), the first launch (the look for a Space here, the installer's
                  address and command), strings (en, zh)
  src/app/        GTK glue (GJS only): window, views, chat cards (`chat-cards.ts`), HTTP
                  (libsoup), web views (WebKit), notifications
  src/main.ts     the entry point (`gjs -m main.js`)
  src/ball/       the floating ball's own process (`gjs -m ball.js`, GTK 3 on X11)
  src/pet/        the desk pet's own process on the desktop (`gjs -m pet.js`, GTK 3 on X11)
  src/hud/        the capsule of `--dictate` (`gjs -m hud.js`, GTK 3 on X11)
  terminal/       the terminal page: xterm.js and the session glue, bundled for the browser
  share/          the desktop entry and AppStream metadata
  build.ts        the build (below)
  install.sh      the per-user installer, copied into every build
  ai-space.sh     the launcher, installed as bin/ai-space
```

`core/` imports only what both Bun and GJS have; a test fails if it reaches for `fetch`, `URL`,
`AbortController` or another global GJS lacks. It reuses `src/web/chat-steps.ts` (the ordered
work of a turn, the same rows the panel draws), `src/web/screens.ts`, the widget area's
arithmetic (`src/web/widget-layout.ts`) and a card's interaction rules (`src/web/widget-rules.ts`)
and the ranking above, and
takes its types from the server's own modules. The app layer types GObject libraries loosely
(`src/gi.d.ts`): it is glue, and the logic it drives lives in `core/`.

| Command | Does |
| --- | --- |
| `bun run linux:build` | `desktop/linux/build/ai-space`: `main.js`, `terminal/`, the icon, the built-in tiles' pictures, `bin/ai-space`, `install.sh`, `VERSION.json` |
| `bun run linux:run` | builds, then runs it from the build directory |
| `bun run linux:install` | builds, then installs it for this user |
| `bun desktop/linux/build.ts --out <dir>` | the same build in another directory |
| `bun run release:linux` | the app as a tarball in `dist/` ([release.md](release.md#linux-app)) |

## Installing

Needs GJS, libadwaita 1.5 or later, WebKitGTK 6.0 and libsoup 3, which current GNOME desktops
have (Ubuntu 24.04, Fedora 40, Debian 13, Arch):

```sh
sudo apt install gjs gir1.2-adw-1 gir1.2-webkit-6.0 gir1.2-soup-3.0   # Debian, Ubuntu
sudo dnf install gjs libadwaita webkitgtk6.0 libsoup3                  # Fedora
```

Voice input ([below](#voice-input)) also needs GStreamer's bindings and an audio source plugin.
WebKitGTK already brings GStreamer itself and its base and good plugins; GNOME Shell brings the
bindings, so a GNOME desktop usually has all of it. Without the bindings the app runs and only the
microphone buttons are missing; `install.sh` says so, and so does Settings › General:

```sh
sudo apt install gir1.2-gstreamer-1.0 gstreamer1.0-plugins-good gstreamer1.0-pulseaudio   # Debian, Ubuntu
sudo dnf install gstreamer1 gstreamer1-plugins-good                                        # Fedora
```

Unpack a release tarball (or build one) and run `./install.sh` in it. It installs for the user,
with no root:

| Path | What |
| --- | --- |
| `~/.local/share/ai-space/app/` | the app, replaced on every install |
| `~/.local/bin/ai-space` | the launcher |
| `~/.local/share/applications/dev.ai_space.Desktop.desktop` | the desktop entry; it also handles `aispace://` |
| `~/.local/share/icons/hicolor/scalable/apps/`, `~/.local/share/metainfo/` | the icon and AppStream metadata |

`install.sh --uninstall` removes those. Neither touches a workspace, the saved Spaces, or an AI
Space installed on this computer (from the welcome screen or by its one-command installer: `space
uninstall` removes it).

What the app keeps:

| Path | What |
| --- | --- |
| `~/.config/ai-space/connections.json` | the saved Spaces (an unreadable file is set aside as `connections.unreadable.json` and the app says so; the `managed` mark an older Local build wrote is ignored and left out on the next save) |
| `~/.config/ai-space/screens.json` | Home's screens, per saved Space, with the apps each Space has had (to tell a newly installed one) |
| `~/.config/ai-space/preferences.json` | keep running, notifications, the chat permission, the window's size, the machine chosen for each agent on several machines, appearance, language, widgets on screens, the Settings section shown last, the floating ball (on or off, its place, each Space's sections), the desk pet (on or off, where, its size, its place on the desktop), voice input's language and the Space it transcribes with |
| `~/.local/share/ai-space/desktop/<connection>/` | each Space's web data: cookies (its sign-in), storage, cache |
| `~/.cache/ai-space/catalogue-<connection>.json` | the last catalogue, shown marked as such while the Space cannot be reached |
| `~/.config/autostart/dev.ai_space.Desktop.desktop` | Start at login (`ai-space --background`) |
| `~/.config/systemd/user/ai-space-peer-tunnel.service` | the peer tunnel, when one was started in Settings › Peer (remove it there) |

## Widget cards

A card does what the panel's does ([app-spec.md](app-spec.md#views-copy-and-actions);
`core/widget-interact.ts`, with the rules shared with the panel in `src/web/widget-rules.ts`, drawn
by `app/widget-card.ts`):

- **Views**: a segmented control (linked toggles) under the head when the payload has `views`;
  the first is the default, the choice is kept per widget in `preferences.json` (`widgetViews`).
  Left and Right move between them.
- **Copy**: a copy button on a block with `copy` puts the text on the clipboard (`Gdk.Clipboard`)
  and shows Copied for 1.5 s; a block with controls is not a button, so the copy never opens its link.
- **Actions**, on a local card only (a peer's card draws none, whatever its payload carries): a
  round check in place of a status dot, a pill on a block, an input and buttons in the footer. An
  action with `confirm` asks inside the card (Escape cancels). `POST /api/widgets/:app/:name/action`
  goes with the session's cookies and the Space's origin, as every write here; the fresh card
  replaces this one and its message shows for 4 s; a failure unticks the check, keeps the typed
  text and shows the error in the card for 6 s.
- **Paging**: the rows that do not fit are paged with dots (a click, or Left and Right on them);
  every page is in one stack, so the card's height does not change between pages. A horizontal
  swipe is left to Home's pages, which it already moves.
- **Trend readout**: the pointer over a chart shows the nearest point's value and date in place of
  the latest; leaving puts them back.
- **Refresh**: on a Space with the route (one that keeps frames), a local card's time in its head is
  a button: `POST /api/widgets/:app/:name/refresh`, and the fresh card replaces it.
- **Motion**: a value that changed between two payloads of the same view is coloured for a moment;
  bars, a gauge's marker, tanks, a progress bar and a metric's number move in when the card first
  appears and on a view or page change, not on a refresh. None of it when GTK's animations are off
  (`gtk-enable-animations`, the desktop's reduced motion).
- In Edit Layout and in the Library's cards the controls are drawn and do not respond.

Unknown block types, unknown action kinds and malformed fields are dropped when the payload is
read (the server's own sanitizers in `src/space/panel/blocks.ts`), so a newer app cannot break a card.

## Widget layout

On a Space whose layout has `frames`, a screen's cards are placed as the panel's widget area places
them ([panel.md](panel.md#resize-a-widget)): the arithmetic is the panel's own module,
`src/web/widget-layout.ts`, imported as it is (it uses no browser global, and a test bundles what
the client takes from it and checks so); `core/widget-area.ts` adds where the handles are, the
toolbar's writes and the save's fallback; `app/widget-area.ts` is a `Gtk.LayoutManager` subclass
that allocates each card at its box (a card taller than its box is clipped). Cards flow in rows by
their frames, a card without one gets the default of its size, `widgetAlign` centres short rows,
and below the panel's breakpoint the cards make one column sized by their content. A card's inner
layout follows its drawn box: the size class with its hysteresis, and as many rows per page as fit
under its hero.

**Edit Layout** (the screen's ⋯ menu; Done or Escape ends it, as does going to another page) gives
every card three handles: the right edge (the boundary with the next card moves; the last card of a
row grows into its free space; Shift changes only this card and lets the next ones re-flow), the
bottom edge (the row's height), the corner (both), with the resize cursors. An edge snaps within
8 px to other rows' edges, the area's halves, thirds and quarters and other rows' heights, with an
accent line where it matched; Alt held, it does not snap. The head shows the card's size while the
layout is edited. The handles take the focus: the arrow keys move them 8 px, 1 px with Shift, saved
when the keys rest. A toolbar offers Align, Center, Split evenly, Reset (asked in the toolbar) and,
for eight seconds after a change, Undo. Each gesture or button is one
`PUT /api/panel/layout { frames, sizes, widgetAlign }`, drawn at once and put back with a message
when it fails. A Space that refuses `frames` gets the sizes alone, and the app says so once.
Reordering cards by dragging is not here: Edit This Screen moves them.

## Chat cards

When a person talks with an app's agent, what its tools did this turn shows as cards under the
reply, as the web panel draws them (`src/web/ChatCards.tsx`; the contract and its five styles in
[chat-cards.md](chat-cards.md)). ai-space extracts and checks the cards; the client only decodes,
draws and calls two routes. `core/cards.ts` holds the rules, unit-tested; `app/chat-cards.ts` the
widgets; `core/conversation.ts` the calls and each card's state.

- **Where they come from**: a live turn's `{"type":"cards","cards":[...],"token":"..."}` events,
  and the `cards` of an `ai` message in a restored session (no token). The token stays in memory,
  on the conversation; nothing of a card is written to disk.
- **State**: each card with a `state` capability asks `POST /api/agents/cards/state` (the card as
  received and the agent) when it arrives, when the conversation is shown again (another agent
  picked, back to Chat) and when a session is opened; the answer lays over what was printed.
- **Undo**: only on the conversation's latest reply (no message of the person after it) that came
  live with a token, and only on a `receipt` with an undo. The header's button takes back every
  item still open ("Undo", "Undo all", "Undo the other N", the web's `chat.card.*` words in both
  languages); with several items, `rows`, `agenda` and `gallery` items have their own.
  `POST /api/agents/cards/action` sends the token, the card's index in its event and the ids; a
  409 `{ readOnly: true }` makes the card read-only with a note. A peer's agent uses
  `/api/peers/<peer>/agents/cards/*`.
- **Styles**: `rows` (the first version's look: state circle, or the item's picture or icon,
  title, a secondary line of time, detail, tags and id, a progress bar), `compact` (one 36 px line
  per item with a state dot and a short value), `gallery` (4:3 pictures, three columns, two when the
  card's content is narrower than 360 px), `agenda` (a day block, blank for the same day again,
  with the month when it is not this month) and `stat` (big values side by side). An unknown style,
  or one whose required field (`image`, `date`, `value`) is missing on any item, is drawn as
  `rows`; `stat` on a `receipt` too. The choice is made on the card as printed, so a state answer
  never moves the layout.
- **Look**: a card is at most 460 px wide, on the left under the reply (narrower in Quick Chat),
  in the theme's colours (`app/style.ts`, light and dark). Item icons are symbolic icons of the
  Adwaita theme, each with a fallback name. Pictures load as app icons do (with the Space's
  session on its origin), with the divider colour and an image icon until they load or when they
  do not. A secondary line wraps with `Adw.WrapBox` on libadwaita 1.7 and later, a flow box before.
- **Links**: an item's link opens as any link of a chat does: the app's tab, or the browser.

## Floating ball

The Mac's floating ball ([macos-desktop.md](macos-desktop.md), `FloatingBall.swift`), with its
rules ported to `src/core/floating-ball.ts` and tested with `bun test` (the Mac's
`FloatingBallRulesTests`, with y pointing down as on X11 and GTK).

GNOME on Wayland gives a Wayland window no way to stay above the others or to place itself, and
Mutter has no layer-shell (wlroots and KDE have one; GNOME does not). The choices were:

| Way | Why not, or why |
| --- | --- |
| A GTK 4 window on Wayland | No keep-above, no position: the ball would sit wherever the desktop put it, under the app in front |
| Layer-shell (`gtk4-layer-shell`) | Not on GNOME; a second code path for KDE and wlroots only |
| A GNOME Shell extension | Truly above everything on Wayland, but the person must install and enable it, log out and in on Wayland, and it breaks with Shell versions |
| **An X11 window through XWayland** | Chosen. XWayland runs on every GNOME and KDE session, an X11 window places itself, and Mutter passes drag and drop between Wayland and X11 windows. On an X11 session it is the same window |

So the ball is a second process, `ball.js` (`src/ball/ball.ts`), run by the same GJS with
`GDK_BACKEND=x11` and GTK 3 (GTK 4 cannot place a window or keep it above on any backend). Its
window is override-redirect: Mutter leaves it alone and stacks it above every window it manages,
full-screen ones included, on every workspace, and never gives it the keyboard. (A managed window
kept above was marked as wanting attention, "is ready", whenever it appeared over the focused
window.) The ball therefore places and moves itself, inside the work area of the monitor it is on
(`origin`, `dialCenter`), and only the disc takes clicks and drops: the window's corners let them
through (an input shape).

The ball knows no Space. The app (`src/app/floating-ball.ts`) starts it when the preference is on,
writes what each section shows (`ToBall`: titles, icons as PNG files in the cache, which sections
can take work, the words in the app's language) as JSON lines on its stdin, and reads what the
person did on its stdout (`FromBall`, checked by `decodeFromBall`): a section clicked, a picture
dropped, the ball moved, a menu item. A picture dropped as data (a browser's) is written to
`$XDG_RUNTIME_DIR/ai-space-drops/` (mode 0600); the app reads it and removes it, and removes no
other file. A file dragged from the file manager is read where it is; links, text, several
files and a picture over 5 MB ("Pictures can be at most 5 MB.") are refused, with a notification. Quick Chat then opens on the section's agent with the
picture attached; the click's time goes with it as an X11 startup id, which the window presents
with so the desktop may bring it to the front. If the ball ends by itself it is started again,
at most three times a minute; it ends with the app.

Quick Chat is drawn as the Mac's (Design Studio's design 12): a 380 px panel with rounded
corners and no title bar, a 40 px header (the agent with its list, a spinner while it works,
the permission, New Conversation, Open in Main Window, Close) and the field with "↩ Send" in it; it is about 96 px high while empty and
grows with the replies, the thread scrolling past 324 px. Escape or a click elsewhere hides it;
Ctrl+N starts a new conversation, Ctrl+J lists the agents, Ctrl+P picks the permission (the round button: a lock to ask before changes, a pencil to edit files, an orange open lock for all; shared with the main window), Ctrl+O (or the header's Open in Main Window) moves it to the main window, with the unsent text and pictures, which go after what the main window's field already holds (`handOver` in `core/chat.ts`); Quick Chat's field is emptied.
Where XWayland is there the panel is an X11 window of the app (GTK 4 opens XWayland's display
beside its Wayland one), so the ball can place it: 12 px beside the ball, on its left when there is
room, its bottom 48 px under the ball's middle so it grows upward, and above other windows.

Limits: with no XWayland (rare; `DISPLAY` unset) Settings says the ball cannot run, and Quick
Chat is a Wayland window the desktop places. Opened by its shortcut, Quick Chat also goes where
the desktop puts it. Pictures
promised by a source without data or a file (XDND direct save) are not taken. There is no Share
Picture editor on Linux, so a picture dropped on the hub goes to Space Assistant in Quick Chat.

## Desk pet

The web panel's built-in Claude (`src/web/Pet.tsx`, the sheet `src/web/public/pet-claude.webp`
made by `src/web/pets/claude.py`, copied beside `main.js` by `build.ts`), as on the Mac
([macos-desktop.md](macos-desktop.md#desk-pet)) and the iPhone, so every client shows one figure.
Its rules are the Mac's `PetRules.swift` ported to `src/core/pet.ts` and tested with `bun test`
(the Mac's `PetRulesTests`, with y pointing down): the sheet's animations, the table from the
mood to them, walking and resting, the bubble's timing, the desktop window's frame and the place
it was left. A test keeps the table equal to the web's.

What it shows is the current Space's mood, `GET /api/pets/mood`
([app-spec.md#space-mood](app-spec.md#space-mood)), read with every look at the Space (each 30
seconds, and when the selection changes): it looks on while agents work or one ran into a
problem, walks to its corner and hops there while a turn waits for an approval or a question,
spins once when a turn is done and sleeps after two quiet hours; idle, it walks and rests as on
the web. The mood's line (`say`, in the app's language) shows for six seconds out of twenty
above it, and while the pointer is on it. A click opens what the mood points at, a waiting or
failed agent's chat or the inbox, else plays the jump. A Space that cannot be reached, or one
older than the route, leaves it walking and resting with no mood.

Settings › General › Desk Pet: Show the desk pet (on by default), Where (In the window, or On
the desktop, over every app; the second is greyed with no `DISPLAY`) and Size (small 60, medium
80, large 110 px). Right-clicking the pet moves it to the other place or hides it. With the
desktop's animations off (GNOME's Reduce Animations, `gtk-enable-animations`) it is not shown,
as the Mac hides it under Reduce Motion.

- In the window (`src/app/pet.ts`, `WindowPet`): drawing areas over Home (a `Gtk.Overlay`), the
  sprite moved along the bottom edge and only it taking the pointer, the bubble beside it. Its
  timer runs only while Home is on show in a window that is visible and not minimised, and fires
  only when the cell or the place changes (at most 20 times a second while it walks).
- On the desktop (`src/app/desk-pet.ts`, `src/pet/pet.ts`): a process of its own, `pet.js`, run as
  the floating ball is (GTK 3 on X11 through XWayland, [above](#floating-ball)): an
  override-redirect window along the bottom of the primary monitor's work area, the pet's width
  plus 440 px wide (room for the bubble on either side) and 72 px taller than the pet, moved with
  it, the input shape only over the sprite. Drag it along the bottom to move it; where it was left
  is kept as a fraction of the screen's width (`deskPetSpot`) and clamped when monitors change.
  It holds still while the pointer rests on it. The app writes `ToPet` lines on its stdin (the
  sheet's path, the size, the place, dark or light, the menu's words, the mood and its line) and
  reads `FromPet` lines on its stdout (checked by `decodeFromPet`): moved, a click to open (with
  the click's time as an X11 startup id, as the ball's), a menu item. If it ends by itself it is
  started again, at most three times a minute; it ends with the app.

The rules, the build and the desktop pet's drawing (`AISPACE_PET_SHOT`, [below](#debugging)) are
checked; the two pets have not been tried by hand on a desktop yet.

## Voice input

The Mac's two forms ([macos-desktop.md](macos-desktop.md#voice-input)), as far as Linux lets an
app go. The rules are the Mac's, ported to `src/core/voice.ts` and tested with `bun test`
(`voice.test.ts`); `src/app/voice.ts` records and talks to the Space, `src/app/dictation.ts` is the
`--dictate` side and `src/hud/hud.ts` its capsule.

**In the app's own fields.** A microphone sits beside Home's command box (on the library and the
home screen) and the chat's message field, Quick Chat's included. It shows only when the field's
Space answers `GET /api/voice` with `transcribe: true` (asked once per Space; a failed request is
asked again after 30 seconds). A click records, a second click stops; the words appear in the field
as they are heard, after what it already held (with no space between Chinese characters), and the
final text stays there. Nothing is sent or submitted: Return in the chat field does nothing while
the microphone listens. A failure puts the field back as it was and says why in a bubble beside the
button.

**In any app: `ai-space --dictate`.** GNOME and KDE let no app register a global shortcut, and a
Wayland client never sees another app's keys, so, as for Quick Chat, Settings › General › Voice
Input shows the command to bind under Keyboard › Custom Shortcuts. A shortcut runs a command when
the key goes down, never when it comes back up, so the key toggles: the first press starts
recording, the second stops it (the Mac holds fn instead). While it listens a capsule at the bottom
of the primary screen shows the live words (the last 90 characters), then a grey dot while the
text is on its way, or a note for four seconds. Recording ends by itself after 90
seconds. The capsule is a process of its own, `hud.js`, built as the floating ball is ([Floating
ball](#floating-ball) says why): an override-redirect X11 window through XWayland, which never takes
the keyboard, so the app being typed in keeps it, and lets clicks through. Then the text goes:

- **into AI Space's own field** when a window of this app has the keyboard and a text field is
  focused (the command box, the chat field, Quick Chat): inserted at the cursor;
- **else onto the clipboard**, and the capsule says to press Ctrl+V (Ctrl+Shift+V in a terminal).
  The clipboard is set through XWayland's display (or X11's on an X11 session): a Wayland client may
  set the selection only while it has the keyboard, an X11 client may own it at any time, and the
  desktop hands it on to Wayland apps.

It is not typed or pasted into the other app. Wayland lets no client send keys to another. The one
sanctioned way, the RemoteDesktop portal, asks the person in a dialog the first time, and that
dialog takes the keyboard from the very field the text is for; a restored session then runs with
the desktop's remote-control indicator on; text other than the keyboard's own characters
(Chinese) cannot be typed as keys, so it would have to post Ctrl+V, which a terminal reads as
something else; and none of it could be tried here. Tools that type through `uinput` need root or
a daemon and are not shipped. So the clipboard it is, and the paste is the person's.

A press while the text is on its way does nothing; a press while the Space is still being asked
cancels. Started by `--dictate` alone, the app holds itself only while a recording runs (Start at
login keeps it running, so the first press is not slowed by starting it). Without XWayland (rare;
`DISPLAY` unset) `--dictate` shows a desktop notification that it cannot run, and Settings says so.

**One Space only.** Speech goes to one Space: for a field, the field's (the selected Space); for
`--dictate`, the one chosen under Settings › General › Voice Input › **Transcribe with** (转写使用;
shown when more than one Space is saved; **The selected Space**, 当前选中的 Space, by default), else
the selected one. When it cannot transcribe (or cannot be reached) the capsule says so and nothing
is sent; it never falls over to another saved Space, which may not be the person's own.

**Live, then a clip.** Recording starts at once, with GStreamer (`autoaudiosrc`, converted to
16 kHz mono PCM16, pulled from the sink every 50 ms on the main loop), and the live route
`WS /api/voice/realtime` ([speech.md](speech.md#live-protocol)) opens beside it, through libsoup with
the Space's session cookies and its origin. What is said before it answers `ready` (a cold model
load takes about 15 seconds) is held, up to 50 seconds, and sent first, in frames of at most 100 ms;
`partial` and `final` events update the field or the capsule by `segment_id`. The stop sends the
rest and `stop`; the text goes in once, after `done` (at most 70 seconds later). Until `ready` the
whole recording is also kept, so when the live route is refused (a Space whose transcriber has no
live socket answers 503), fails or never gets ready, the recording goes up on the stop as a WAV to
`POST /api/voice/transcribe` instead. An error after `ready` ends the recording with the reason.

**Language.** Both routes are told the language spoken ([speech.md](speech.md#languages)):
Settings › General › Voice Input › **Voice language** (语音输入语言), the web panel's choices and
words: Same as AI Space (与 AI Space 相同, the default: the app's language, English or Chinese),
Detect automatically (自动识别, sends none), or 中文, English, 日本語, 한국어. Read when a recording
starts.

**The microphone.** Before recording, GStreamer's device monitor is asked for a source that is not
an output's monitor; with none the field or the capsule says "No microphone found" and nothing is
recorded. A source that fails to start, or fails while recording, ends it with GStreamer's reason.
A desktop app outside a sandbox needs no permission for the microphone on Linux; PipeWire's own
access rules, where someone set them, show up as that failure.

**Not tried on a desktop yet.** The rules, the live route, the fallback to a clip, the language,
the cookies and origin, and the missing-microphone message were run in GJS against a stand-in Space,
with `audiotestsrc` as the source, on a machine with no display. The buttons, recording from a real
microphone, the capsule, the clipboard handed to a Wayland app and the insertion into a focused
field have not been run on a desktop.

## Settings

The sections and pages are the web panel's (`src/web/App.tsx`, `SettingsNav.tsx`), with the
panel's strings: `src/web/messages.ts` holds its dictionaries without React, so this app uses the
same words in English and Chinese. The rules behind the rows (status counts, task states, usage
figures and the history grid) are in `src/core/settings.ts`, tested against the panel's. The
panel's Gateway section (the built-in model gateway's providers, keys and tiers, and magpie;
[model-gateway.md](model-gateway.md#settings)) is not here: it is configured in the web panel.

| Section | What |
| --- | --- |
| General | Widgets (cards on Home's screens, on or off), Language (the desktop's, English or 中文; read at start), then this app's own: the saved Spaces (switch, edit the address and name, make default, remove after asking, add; a new address is checked as when connecting), keep running when the window is closed, start at login, notifications, the Quick Chat command, Voice Input (the `--dictate` command, Transcribe with, Voice language; [below](#voice-input)), the floating ball, the desk pet, WebKit's sandbox, About |
| Appearance | Follow system, Light or Dark, for the app and the pages in it. The web panel's themes and colours stay in its own Settings, on the Panel page |
| Models | The default model of app requests and new Space Assistant chats; AI CLIs by machine (each machine's agent CLIs with version, sign-in and runtime, Check Again, and Add to runtimes.yaml for one found here); App models, a page with each app's and purpose's model and the layer that chose it, changed in place, then each peer's apps under its name, saved on the peer with its own choices. In every model picker a choice that is not signed in or on an offline peer is greyed with the reason, and a saved choice no longer offered stays shown, marked |
| Automation | Scheduled tasks (schedule, triggers, last and next run; a task unfolds to its model and its last 20 runs) and Events and calls (the catalogue of what apps provide, publish and consume; the last 100 events, each unfolding to its deliveries) |
| Fix this (随手改) | The feature called Feedback before ([feedback.md](feedback.md)), off until it is turned on here or in the panel: the button on app pages on or off, what happens to a request (fix right away, or record it and fix later), the machine, model and effort of the Fix Engineer, script errors, the shortcut, and each app's switch, with the apps of each peer under its name. It reads and saves what the panel's page does (`GET` and `PUT /api/panel/feedback/settings`), so a change in either shows in the other. The section's name and every word in it are the panel's (`settings.section.feedback` and `feedback.*` in `src/web/messages.ts`), so they are the panel's in both languages. The recent requests, with Fix now and Fix again, stay in the web panel |
| Usage | Model usage (the Space whose ledger it is, a note per peer whose figures are missing or old; 5h, 24h, 7d or 30d: totals, by app and purpose, by model, a year of days and twelve weeks of bars, the last calls) and App usage (7d to all: devices, opens, time in use, a trend per app) |
| Status | Peers, services (start, stop and restart where the Space runs them) and backups, with the problems counted |
| Packages | Installing a `.spaceapp` (upgrade, unsigned), the apps installed and their rollback and removal, the apps of connected Spaces, connections with the apps each may use, adding one |
| Account | Where the Space keeps its own password and this app is signed in: change the password, the signed-in sessions (sign one out), sign out |

The Space sections show the current Space, named under the section's title, and are built again
once it answers. Pages reload with their Reload button. Every call goes through the Space's session
in this app (the same routes the panel's page uses); nothing uses an operator token.

## Peer

Settings › Peer makes this computer's Space a peer of a Space used elsewhere, the hub
([peers.md](peers.md)), in three groups:

| Group | What it does |
| --- | --- |
| This Computer as a Peer | Writes `SPACE_HUB_TOKEN` (32 random bytes, hex; copy, or make a new one), `SPACE_NAME` (suggested from the host name; letters, digits and `-`, so the hub reads it back unchanged) and `SPACE_TERMINAL_ENABLED` into this Space's workspace `.env`, edited as `space setup` edits it (`core/peer.ts`, tested against `src/space/setup.ts`), mode 0600. The workspace is `SPACE_HOME`, else `~/.ai-space`. After Save the Space on this computer has to be restarted by hand. Turning it off empties the token, which removes `/api/peer/*` |
| How the Hub Reaches This Computer | An SSH tunnel: the app writes `~/.config/systemd/user/ai-space-peer-tunnel.service`, which runs `ssh -N -R 127.0.0.1:<port>:127.0.0.1:<SPACE_PORT> <user@host>` with key login only (`BatchMode`), reconnects after a drop and starts at login; Start, Stop and Remove, and the last line ssh logged when it is not connected. The hub's machine needs this computer's key (`ssh-copy-id`); its own `127.0.0.1:<port>` then leads here, and nothing is published. Or an address of the person's own (a Cloudflare tunnel's hostname) with optional headers for its access layer |
| On the Hub | The lines for the hub's `.env` (`SPACE_PEER_<NAME>`, `_TOKEN`, `_HEADERS`), to copy, and a check that asks a saved Space's `GET /api/peers` how it sees this computer |

## Trust boundary

The same as the Mac client's ([macos-desktop.md](macos-desktop.md#authentication-and-the-web-boundary)): each saved
Space has its own WebKit network session, and the native calls (catalogue, chat, inbox) carry that
session's cookies, so signing in on the panel's page signs in everything. No operator token is
used. A redirect, 401 or 403 means "sign in"; native writes name the Space's origin as the page's
do. The web views follow the Mac's navigation rules (`core/navigation.ts`): links that leave the
Space open in the browser, new windows never open inside the app, and only the microphone (never
the camera) is granted, to pages of the view's own origin or the connection's. The app's own voice
input ([below](#voice-input)) records only between a click on a microphone (or a `--dictate`) and
the stop, at most 90 seconds, and sends the audio to one Space, the field's or the one Transcribe
with names, with that Space's session, never to another saved Space and never anywhere else; it
keeps no recording on disk. A remote Space
needs https; plain http is accepted for loopback only. A page whose web process ends is loaded
again after 1, 2 and then 4 seconds; a fourth crash within a minute stops there and shows the page
as failed, with Try Again on an app's tab (`crashReload`).
Every web view adds `AISpaceLinux/<version>` to WebKit's user agent, as the Mac client adds
`AISpaceDesktop/` and the phones `AISpaceMobile/`, so a page (the Fix this button,
[feedback.md](feedback.md#context)) can tell this client from a browser.

WebKitGTK runs each page in a sandboxed web process (bubblewrap). Ubuntu 23.10 and later restrict
the user namespaces bubblewrap needs to programs an AppArmor profile allows. `install.sh` copies
the system's `gjs` into the app as `bin/ai-space-gjs`, and `install.sh --apparmor` (with sudo)
installs a profile for that copy alone, in the shape of Ubuntu's profile for its own web browser
(Epiphany). Without the profile the launcher starts WebKit without its sandbox rather than not at
all, and Settings shows the command that turns it on.

## Debugging

`AISPACE_DEBUG=1` logs state changes and enables WebKit's inspector. Hidden options for checks
without a person at the screen: `--page <home|chat|inbox|terminal>`, `--action <name>` (a window
action such as `new-terminal`, `panel`, `search` or `next-screen`, an app action as
`app.settings`, `ask=<text>`, `query=<text>` to type into the command box, or
`settings=<section>[/<page>]`, such as `settings=usage/activity`, or `ball=<json>`, a line as if the
floating ball had sent it, such as `ball={"type":"open","section":"todo"}`; repeatable) and `--screenshot <file.png>`, which saves the window
(Quick Chat when it is open) after `AISPACE_SCREENSHOT_DELAY` milliseconds (4000) and quits.
`AISPACE_BALL_SHOT=<file.png>` makes the floating ball draw itself and its open dial into a PNG
whenever the app sends it the dial, which needs no screenshot permission from the desktop.
`AISPACE_PET_SHOT=<file.png>` makes the desktop pet draw three poses (resting with its bubble,
walking, the jump) into a PNG once the app sends it a mood, and quit without showing a window.
`AISPACE_VOICE_SOURCE=<GStreamer source>` records from that instead of the microphone, such as
`audiotestsrc is-live=true` or `filesrc location=speech.wav ! decodebin`, and `--action app.dictate`
starts and stops `--dictate`.

## Memory

The window stays open for days, looking at the Space every 30 seconds. Three rules keep that
from growing the process:

- **Redraw only on a change.** The model announces a catalogue or an inbox only when it differs
  from the last one announced (`core/change.ts`); Home draws a page again only when what that page
  shows changed, and the Space menu is made once and refilled only when its rows change. Almost
  every look at a Space returns what is already on screen and draws nothing. A screen's widget
  area stays through a drawing of its page, and a card in it is drawn again only when its own
  payload changes (a resize alone draws nothing again).
- **A handler never holds its own widget.** GJS keeps the handler of an object that something
  else still holds (a gesture held by its widget, a button held by its box), and with it whatever
  the handler holds. A right-click handler that held its tile kept the tile, its gesture and the
  handler alive after the tile left the screen: every dropped Home page stayed in memory. Handlers
  take the widget from the signal (`gesture.get_widget()`, the button passed in) instead. A widget
  card's handlers do reach into it, so each part of a card keeps them in a `Bag` (signals, timers,
  tick callbacks) that is let go of when the part is drawn again or the card goes; its drawing
  functions read plain objects, never a widget.
- **Collect after dropping widgets or reading the Space.** The collector only sees its own heap,
  not the widgets, layouts, textures and answer bytes behind it, so `memory.ts` asks for a
  collection a moment after a redraw or a look. Web views of widgets no page shows are closed, and
  one libsoup session serves every request outside a Space's own.

`bun run linux:soak` builds the client and checks it: a stand-in Space on loopback, the client in
a D-Bus session and XDG directories of its own (on a headless GNOME Shell when there is one), its
RSS every 15 seconds, and the growth per hour after a warm-up. `--poll <seconds>` sets how often
the client looks (`AISPACE_POLL_SECONDS`, 2 by default: fifteen times the real pace), `--churn`
changes a widget on every look so every look redraws, `--minutes` how long it runs, `--build` which
build it runs. `AISPACE_MEMSTAT=<seconds>` makes any run print its RSS and threads.

## What the Mac client has and this one does not (yet)

- Voice input typed straight into another app, and a key held to talk: the text of `--dictate` goes onto the clipboard, and the key presses it once to start and once to stop ([Voice input](#voice-input) says why).
- Dragging tiles and cards into order (Edit This Screen moves them with buttons). An older Space's cards (no stored frames) are not two columns wide.
- The web panel's theme presets and colour adjustments in Settings › Appearance (the Panel page's own Settings has them), the hover-details switch and the panel's own desk-pet switch, which only the panel draws (the app's desk pet is set in General), and the panel's 30-second refresh of the Settings pages (here, Reload).
- Updating the app itself. AI Space installed from the welcome screen is updated with `space upgrade`, not by the app.
- A global shortcut of its own (see Quick Chat above).
