# Windows desktop client

Status: built, its core library tested (`dotnet test`), and run on a Windows 11 laptop against an
AI Space on the same machine. Home, Inbox, Shortcuts and the Space's Settings are native pages;
the terminal and agent chat are the Space's own pages in tabs of the window. It is a client: it opens Spaces
that run on this computer or elsewhere and carries no AI Space of its own. At its first launch it
offers to connect to the AI Space on this computer (installed first with AI Space's own installer
when there is none) or to one on another machine ([below](#this-computer)). It follows the Mac client
([macos-desktop.md](macos-desktop.md)): the same parts, the same rules, the same names, and says
below where it does less.

## What it is

A window with the Space's own pages, natively where the app has them, and Windows around it. The
terminal and the agents' chat are the Space's own pages in tabs of the window, the web panel stays
one click away, and the app adds what a page cannot do.

| Part | What it does |
| --- | --- |
| Window | The bar: the Space menu (each saved Space with its state, Add a Space…); Home's places, the Library and then a tab per screen, each opening Home there ([below](#the-window)); the web tabs, one per open app, the chat, the terminal and the web panel (past five, under More); while a web tab is shown, Back, Forward, Reload and Open in Browser; and the Inbox with its count, only while something is unread. The bar has no menu: the Space's App Store, Inbox, Shortcuts, Terminal and Settings are tiles on Home and in the Library, the last four also Ctrl+2 to Ctrl+5 (Ctrl+1 is Home), the web panel has no entry of its own (it shows by itself while a Space needs a sign-in, and Settings opens its Settings for what has no native copy: Appearance, Fix this' recent requests, installing apps and connections, a task's model, peers' app models), an agent's chat is its tile, Quick Chat is the notification area's, its shortcut's and the floating ball's, and AI Space Settings… is in the notification area's menu and Settings › This Computer. The Space picker keeps one width, from the selected Space's name (a long one ends in an ellipsis), whether its list is open or not. A middle click or Ctrl+W closes a tab, F5 reloads. Before any Space is saved it shows the welcome page: Connect to Local AI Space (installing it first when there is none), or Connect to a Remote AI Space with the address form ([below](#this-computer)). The window keeps its size and place, always wholly on one monitor's work area, so its title bar can be reached ([below](#the-window)) |
| Native pages | Home, Inbox, Shortcuts and Settings are the app's own (WPF, one set per Space, kept while hidden). Settings is the Space's own settings; it leads to AI Space Settings…, the app's. Not built yet: each says so and offers Open in Web Panel ([below](#the-window)) |
| Web pages | The terminal (`/?page=terminal`), an agent's chat (`/?page=chat&agent=…`), the App Store (`/?page=store`), each open app and the web panel are web pages in tabs. Each saved Space has its own WebView2 profile (cookies, storage, cache), so signing in on the panel signs in everything that Space's pages and native calls do. A link to one of the Space's own pages never leaves the app: it opens the native page, or its tab; a link to an app of the Space opens in that app's tab, a link off the Space in the default browser. A page that cannot load shows why, with Try Again, Open in Browser and Edit Space… |
| Sign-in | While a Space needs a sign-in, the window shows its web panel, where the sign-in page appears, in place of the native pages, and the native page again once the panel has signed in |
| Quick Chat | A small window over every app with one agent's chat (the panel's own, so a conversation there is the same one): Ctrl+Alt+Space by default (Ctrl+Shift+Space, Alt+Shift+Space or off in Settings), the notification area menu, the jump list, a section of the floating ball, or `aispace://chat`. 380 wide as the Mac's, with no title bar: a 40 high header to drag it by (the Space, the agent, Open in Main Window, Close), then the page's chat in its narrow layout, whose header holds the model and the permission choice. The shortcut opens it in the upper middle of the screen, the ball beside itself ([below](#the-floating-ball)). It remembers the agent last used; Escape or Close hides it, and an answer being written goes on |
| Floating ball | A 52 px ball over every app that never takes the keyboard (off until Settings › General turns it on; the notification area menu and its own right-click menu show and hide it) ([below](#the-floating-ball)) |
| Notification area | The icon (the Mac's menu bar extra): a click opens the window; the menu has each Space with its state (it opens its Home), a sign-in when it needs one, who is working (each opens that agent's chat), the unread threads and the Inbox, and its apps, then Quick Chat, Show the Floating Ball, Settings… and Quit AI Space. Its tooltip counts what is unread and who is working |
| Notifications | New unread inbox threads of every saved Space as Windows notifications, with Mark as Read and Done; a click opens the thread's link, else the Inbox. The taskbar button carries a badge while something is unread |
| Links | `aispace://` links as on the Mac (`DeepLink` in `AISpace.Core`): `chat?agent=&text=` (Quick Chat), `open?app=` (the app's tab), `inbox` (the Inbox page), `show`. A link may fill in a message but never sends it. The jump list has Quick Chat and Inbox |
| Settings | General (notifications, keep running when the window is closed, start at sign-in, the Quick Chat shortcut, the floating ball and its sections, installing, the log), and Spaces (add, edit, make default, sign out, remove) |

The app is one copy per Windows session: starting it again (the Start menu, a link, the jump
list) hands what it was started with to the running copy. Closing the window leaves it in the
notification area, so the inbox can reach the person, unless Settings says not to keep running;
Quit AI Space ends it. A Space and its agents keep running wherever they run.

The interface is in English or Chinese, following Windows' display language. The Chinese is kept
in one table per area, merged at startup (`Strings.cs`): `Strings.zh.cs` for the shell,
`Strings.zh.Home.cs`, `Strings.zh.Inbox.cs` (Inbox, Shortcuts, the desk pet) and
`Strings.zh.SpaceSettings.cs`; `desktop/windows/strings.test.ts` checks that every string has its
Chinese, in one table only, and that no table keeps a string nobody uses.

## The window

**Where it is.** A new window asks for 1280 × 820 and gets at most the work area (the screen
without the taskbar) of its monitor, centred on it. A saved place, and any window that would open
partly off the screen (Settings, the Space form), is moved, and shrunk if need be, onto the work
area it overlaps most, else the nearest one (`AISpace.Core/WindowPlacement.cs`); once more after
the window is shown, since Windows may still move a new window by its frame. A window that lay
across two monitors comes back on the one it covered most.

**What it shows.** For the selected Space, one of its native pages or one of its web tabs. The
native pages (`Views/NativePage.cs`) share one contract: made the first time they are shown for
their Space, with that Space's `PageContext` (its live state, its API with its sign-in, its icons,
and the window's ways of opening things), kept while hidden, told when they are shown, hidden,
refreshed in the background or asked to reload, and closed when their Space is removed, signs out
or changes its address. The desk pet's layer lies over Home (`Views/PetView.cs`).

**The bar's places.** Right of the Space picker, a tab for the Library, then one for each of Home's
screens, as the web panel has the library left of them (Home still opens on the first screen) (`HomePage.Places`, which the bar follows through `PlacesChanged`; each Space has its own
Home and screens). A tab is checked only while Home shows that place, and a click on one from any
page or web tab opens Home there, so they are also the way back to Home. The bar holds four screen
tabs (two under 1100 wide, where the Library's tab shows its icon only); the others are under a
menu beside them, the shown one taking the last tab's place (`HomeScreens.BarTabs`), so many
screens never push the web tabs out; the Library's tab is never under that menu. A right click on a tab (Shift+F10) holds the screen's actions:
New Screen, Edit Screen ([edit mode](#home)), Rename Screen…, Copy the Web Panel's Layout… and Delete Screen…. Ctrl+Page Down and
Ctrl+Page Up move through the places in that order while Home is shown. Without a Space, or while it needs a
sign-in, the bar has no places.

**Where a page of the Space opens** (`AISpace.Core/SpacePages.cs`, the forms of
`src/web/panel-link.ts`): the panel's root and `/?page=inbox|shortcuts|settings` (and the fragment
links `#inbox`, `#shortcuts`, `#settings`) open the native Home, Inbox, Shortcuts and Settings;
`/?page=terminal` and `#terminal` the Terminal tab; `/?page=store` and `#store` the App Store tab
(the web panel's own page, [app-catalog.md](app-catalog.md), shown alone in its tab);
`/?page=chat&agent=…&session=…` and `#chat=…&text=…` the Chat tab on that agent, the text as a draft. Only the Space's own origin and
the panel's own path count. So the panel's built-in tiles and its chat's "open in a new tab", which
ask for a new window, stay in the app, and a native page's link goes the same way. A navigation in
the Terminal or Chat tab to another of the Space's pages (closing the page leads to the root) goes
to that page's own place instead of loading the web launcher in the tab.

## Home

The Space's screens and its library, natively (`Views/HomePage.cs`), as the Mac's launcher and the
Linux client's Home lay them out; the rules are in `AISpace.Core` (`HomeCatalogue.cs`,
`HomeSearch.cs`, `HomeWidgets.cs`, `HomeScreens.cs`), tested with the other clients' cases.

- **What it reads.** `GET /api/apps` and `/api/agents`, with `/api/widgets`, `/api/peers` and
  `/api/panel/layout` when the Space has them (`SpaceApi.GetHome`), when the page is first shown,
  on F5, and after each background refresh while it is shown. The page is drawn again only when
  what it shows changed, and the focused tile keeps the focus. When the Space cannot be read it
  keeps what it last knew under a banner with Try Again.
- **The command box.** Typing searches every app, agent, widget and built-in page: every word of
  the query in a title (any language), id, description or machine, best names first (the web
  panel's `ranking.ts`, the Mac's `OmniboxRules`). Enter opens the best match when its name holds
  the whole query; anything else, and Ctrl+Enter always, opens Space Assistant's chat with the text
  as a draft, never sent. Down moves into the results, Escape clears, Ctrl+F (or Ctrl+K) comes back.
- **Shortcuts in the box** (`Views/HomeShortcuts.cs`, [shortcuts.md](shortcuts.md#native-search-and-shared-resolution)):
  a quarter of a second after typing stops, the Space reads the text (`POST /api/shortcuts/resolve`):
  arithmetic, a conversion, an action named at its start with the rest filling its inputs
  (`待办 明天下午3点 写周报` is ai-todo's Create todo with title, date and time). Up to three rows above
  Ask Space Assistant show what can run and what the text filled; the first takes Enter, before a
  library match, when it is arithmetic, a conversion or a named action and the text means one thing
  only (a matched agent skill leaves Enter to the assistant). Choosing one opens its form under the
  box, the Shortcuts page's: a read whose inputs are filled runs at once, a write waits for Create (or
  Enter again). Escape closes the form, then clears the box. A Space with no resolver, or one that
  does not answer, leaves the box as before.
- **Places.** Each screen and the Library are tabs of the window's bar ([above](#the-window)),
  not of the page; the page shows the one chosen. The Library shows the apps with the built-in pages (App Store, Inbox, Shortcuts, Terminal,
  Settings, the web panel's five in its order; the web panel has no tile, and a screen saved with its old tile simply no longer shows it), the agents (one tile per agent on several machines) and the widgets, with a filter by
  kind. A tile shows what is wrong (not answering, paused, its machine offline), an app's and the
  Inbox's unread count, and an agent at work; the library's tiles show their details under the
  pointer. A click opens an app in its tab, an agent's chat, a built-in page, a widget's page.
- **Where it opens.** On the home screen (主屏幕): the first screen, `home`, titled Main, which
  holds the pinned tiles. A first install copies the panel's home screen (or the one it would
  seed: the first apps and the five built-in tiles), so that is what shows. Should the home
  screen hold nothing the client draws while a later screen does, Home opens on the first screen
  that has tiles (`HomeScreens.Opening`); it never opens on the Library or on an empty screen
  while another has tiles. This is decided once, when the Space is first read after the app
  starts; a place the person chose meanwhile is kept.
- **Screens** are this computer's (`screens.json` beside the saved Spaces, by Space): the panel's
  screens (or the home screen the panel would seed) are copied once, then a tile's or a card's
  menu (right click, Shift+F10) puts it on a screen or takes it off and moves it, and a screen
  tab's menu in the bar makes, renames and deletes screens or copies the web panel's layout again. Nothing is written to
  the Space. A removed Space's screens go with it.
- **Edit mode** (编辑屏幕), the web panel's ([panel.md](panel.md#arranging-hiding-and-uninstalling-apps)),
  one screen at a time (`Views/HomeEdit.cs`): Edit Screen in its tab's menu or in a tile's or a
  card's on it. The command box gives way to a bar naming the screen, with Rename…, Delete
  Screen… (not on Main) and Done. Every tile and card has an ✕ that takes it off the screen, and
  is dragged onto another of its kind to take that one's place (tiles and cards are drawn apart, as
  the menu's Move Earlier and Move Later keep them); a click arranges and opens nothing. From the
  keyboard, on the focused entry, Delete removes it and Ctrl with an arrow moves it. Done, Escape,
  Ctrl+F or another place leaves edit mode. As the menus, it changes this computer's screens only.
- **Apps from the App Store.** The web panel pins an app the store installs to its home screen
  ([app-catalog.md](app-catalog.md)); this computer keeps its own layout, so Home adds it to the
  home screen here too. `screens.json` remembers the apps on the panel's home screen (`panelHome`),
  and each time the Space is read an app that has appeared there since is put at the end of the
  home screen here, unless a screen here already holds it (`HomeScreens.FollowPanel`). Nothing
  else is followed: what was taken off or moved here stays so, an app taken off the panel's home
  screen stays here, and the panel's other screens and its order are not copied. An app pinned
  to the panel's home screen by hand in a browser arrives the same way. A `screens.json` from
  before this only takes the panel's home screen as the starting point, and its home screen
  gains the App Store's tile.
- **First apps.** While the Space has none of the App Store's apps (`GET /api/app-catalog`, the
  web panel's `catalogOffers`), the home screen shows the panel's first-use card: Open the App
  Store opens its tab (`/?page=store`), Not Now
  hides the card for this Space on this computer (`storeCardHidden` in `screens.json`). Home
  reads the Space again when it is shown after the store was opened, so what was installed is
  on the home screen then.
- **Icons.** An app's icon is cut to a rounded square, an agent's avatar to a circle, as the web
  panel, the Mac and Linux draw them; a built-in page's tile shows artwork the app carries
  (`AISpace/Assets/Builtins/`, [below](#built-in-icons)), or the picture of the Space's icon pack
  when it has one for that page. Pictures come through `IconStore.cs` with the Space's sign-in: PNG,
  JPEG and the like as bitmaps, SVG (the panel's built-in icons and agents' avatars are SVG) as
  vector drawings, sharp at any scale, read by `AISpace.Core/SvgReader.cs` and drawn by
  `SvgDrawing.cs`. The reader takes `viewBox` (else width and height), `g`, `path`, `rect`
  with `rx`/`ry`, `circle`, `ellipse`, `line`, `polygon`, `polyline`; `fill`, `stroke`,
  `stroke-width`, `stroke-linecap`, `stroke-linejoin`, `fill-rule`, `opacity`, `fill-opacity`
  and `stroke-opacity` as attributes or in `style`, inherited as in SVG; `transform`; linear and
  radial gradients (stops, units, `gradientTransform`, `href`); colours as hex, `rgb()`/`rgba()`
  and common names. Filters (shadows, glows) are left out. An icon with text, an embedded image,
  `use`, a mask, a clip path or a style sheet is not drawn at all, so the tile keeps its letter
  rather than half an icon. The reader refuses DTDs and external references and caps the size.
- **Widget cards** follow the blocks contract ([panel.md](panel.md#widgets)): the first block is
  drawn large (metric with its change, trend as a line or bars, progress, gauge with its zones,
  status, tanks), the next ones as rows, as many as the card's size holds; a card without blocks
  lists its items with their age; a card says when its state is outdated or its machine offline.

Where it differs from the Mac: an `embed` widget's page is not drawn inside its card (a web view
does not scroll with the page's content); the card opens it. Tiles and cards are moved with their
menu or in edit mode, and the box does not offer agent skills' intents of its own.

### Built-in icons

The five built-in tiles draw the artwork the Seoul hub shows, carried in the app
(`AISpace/Assets/Builtins/`, WPF resources, read by `BuiltinArt` in `Views/HomeTiles.cs`), so a tile
has its picture before the Space answers and is never a look-alike glyph:

| Tile | File | From |
| --- | --- | --- |
| App Store | `store.svg` | `src/web/public/store.svg`, unchanged (the hub's icon pack has none for it) |
| Inbox, Shortcuts, Terminal, Settings | `inbox.png`, `shortcuts.png`, `terminal.png`, `settings.png` | the hub's active icon pack (`per-app`, `space~<name>.webp`, 512 px full-bleed plates), scaled to 256 px with the corners cut to the tiles' rounded square (radius 21.875%), so the corners are transparent |

`/api/apps` names an icon for each built-in page (`builtins`). When it is the panel's stock one
(`/<name>.svg`, `HomeScreens.IsStockIcon`) the tile keeps the carried artwork; when it is an icon
pack's ([panel.md](panel.md#icon-packs)) the tile shows that picture, the carried one meanwhile and
if it cannot be drawn. A tile is drawn on no plate of its own: what is transparent in the picture
shows the window. The bar's buttons and the tabs keep Windows' one-colour glyphs.

## The floating ball

The Mac's floating ball ([macos-desktop.md](macos-desktop.md)), with the same rules
(`AISpace.Core/FloatingBallRules.cs`, the Mac's `Services/FloatingBallRules.swift` with y pointing
down; the Linux client's `core/floating-ball.ts` is the same port):

- **The ball** is a round tool window above every app (topmost, no taskbar button, not in Alt+Tab,
  and a click on it leaves the app in front where it was). Drag it anywhere: it stays inside the
  screen it was left on and comes back there next time (`floatingBallOrigin` in the preferences).
- **The dial.** Rest the pointer on the ball and four sections open around it: top Keep, right
  Space Assistant, bottom Todo, left Design Studio by default. A click on one opens Quick Chat on
  its agent beside the ball (left of it when there is room, its bottom a little under the ball's
  middle: `ChatOrigin`). An app with no agent of its own lends Space Assistant, with "Save this
  to …:" already in the draft. An empty section (None) opens Settings.
- **Drop a picture.** One picture (a file from Explorer, or picture data from another app) dropped
  on a section opens Quick Chat there with the picture attached; on the hub it goes to Space
  Assistant. A picture that is not PNG, JPEG, GIF or WebP (a bitmap, a TIFF) is converted to PNG.
  More than one file, a file that is not a picture, or one over 5 MB is refused with a notice
  from the notification area. The picture is handed to the chat page as a dropped file once the
  page has opened the agent's chat; it is never sent by itself.
- **Sections per Space.** The sections come from the Space the main window shows. Settings ›
  General sets what each opens in that Space (Default, None, any app or agent); each Space keeps
  its own choices (`floatingBallSlots`, by the saved Space's id).

`AISpace/FloatingBall.cs` fills the sections from the Space's live catalogue and its icons (fetched
with the Space's sign-in) and turns what the ball reports into Quick Chat; `Views/BallWindow.cs`
draws the ball and the dial and reads the pointer and drags.

Where it differs from the Mac: Quick Chat is the Space's chat page rather than a native view, so it
keeps one height (520) instead of growing from 96 to 420 with the replies, and a click elsewhere
does not hide it.

## Inbox

The native Inbox page (`Views/InboxPage.cs`) is the web panel's inbox ([notify.md](notify.md#inbox),
`src/web/Inbox.tsx`; the Mac's and the Linux client's): every app's notifications as threads. The
Space groups them (`src/space/notify/inbox.ts`): one app's notifications with the same key are one
thread with a count ("×3"), a notification without a key a thread of its own. The page lists them
newest first, from `GET /api/inbox` under a filter, All, Unread, To Handle (open threads at
`alert` or `warn`) or Done, and an app (the menu keeps every app seen, so narrowing the list never
empties it). A row shows the level's dot (full while unread), the title (else the text's first
line), the count, the time, the app, "needs action" and "done"; it is bold and on a brighter card
while unread. Opening a row shows the whole text and how often it came since when, and marks it
read; there, Open Link opens the thread's link as a link from a page goes
([below](#how-the-app-opens-the-spaces-pages): a page of the Space natively or in its tab, an app's
page in the app's tab, anything else in the browser), and Mark as Done, Reopen and Mark as Unread
change it. Mark as Read and Mark as Done (or Reopen) are also on the row, and Mark All as Read
(`POST /api/inbox/read-all`, of the app chosen) in the header. A change shows at once
(`InboxRules.Marked`, the server's rule: done implies read), goes to `POST /api/inbox/mark`, and
asks the Space for a fresh look, so the bar's, the tray's and the taskbar's counts follow; one
that fails says so and the list is read again. The list is read when the page is shown, after
each background look at the Space (every 30 seconds) and on F5; an empty inbox and an empty
filter each say so. The rules (the routes, decoding, marks, filters, times) are
`AISpace.Core/InboxThreads.cs`, tested in `InboxTests`.

## Shortcuts

The native Shortcuts page (`Views/ShortcutsPage.cs`, `Views/ShortcutRunner.cs`) is the web
panel's Shortcuts window ([shortcuts.md](shortcuts.md), `src/web/Shortcuts.tsx` and
`ActionRunner.tsx`; the iPhone's native forms): the action catalogue
(`GET /api/shortcuts/actions`) with a search over every language's titles, descriptions and
keywords, only the actions that can run (one the Space lists as unavailable, a template no app
fills or a capability it lacks, is left out, as on the web panel's). Choosing one
opens its form under the catalogue: a field per input (text, number, a date typed or picked as
today or tomorrow, a time, a period, a choice or a task), the required ones marked, with how a
relative date or period reads today in this computer's zone, where a write goes and the zone
sent. One button runs it, Show for a read, Create for a write, Run for a task, with no second
prompt; Enter in a field does the same. `POST /api/shortcuts/runs` carries the Windows zone as
an IANA name and a request id that changes only once a run came back, so a second click, or a
send again after the network failed, answers the first run instead of running twice. A run still
going is read again every 1.5 seconds while the page is shown; a write or a task that went
through is not offered again from the same form (New starts over). The result card shows a
value with Copy, a receipt's created items, a list's items with their times and links, or a
task's run with its status, error and output; an error, or "may have been created" for a write
whose answer was lost, with Retry where the provider allows it. Recent Runs
(`GET /api/shortcuts/runs?limit=30`) follows, each row opening to its result, read again every
15 seconds while the page is shown (2 while one is running). A run goes on in the Space whatever
the page does. Not here (as on the web's Shortcuts window): saved shortcuts, and the command
box's sentence resolution, which is Home's. The rules are `AISpace.Core/ShortcutRules.cs` and
`ShortcutModels.cs`, tested in `ShortcutTests`.

## Desk pet

The web panel's built-in Claude (`src/web/Pet.tsx`), as on the Mac, the iPhone and Linux
([linux-desktop.md](linux-desktop.md#desk-pet)), so every client shows one figure, and only it:
the web panel's own pet went with the web Home. It walks along the bottom of the native Home page
(`Views/PetView.cs`), in a layer the window lays over Home with no background, so only the
sprite takes the pointer. Its rules are the Linux client's `core/pet.ts` (the Mac's
`PetRules.swift`) ported to `AISpace.Core/PetRules.cs` and tested in `PetRulesTests` (the Linux
tests, and a check that the table is still `CLAUDE` in `Pet.tsx`): the sheet's animations, the
table from the mood to them, walking and resting, and the bubble's timing.

What it shows is the selected Space's mood, `GET /api/pets/mood`
([app-spec.md#space-mood](app-spec.md#space-mood)), read after every look at the Space (each 30
seconds, and when another Space is chosen): it looks on while agents work or one ran into a
problem, walks to its corner and hops there while a turn waits for an approval or a question,
jumps once when a turn is done and sleeps after two quiet hours; idle, it walks and rests as on
the web. The mood's line (`say`, in the app's language) shows in a bubble for six seconds out of
twenty, and while the pointer is on the pet; screen readers hear it as the pet's help text. A
click (or Enter, since the pet is a button the keyboard reaches after Home's own controls) opens
what the mood points at, a waiting or failed agent's chat or the Inbox, else plays the jump.
Right-click (or Shift+F10) offers Hide the Desk Pet; Settings › General › Show the desk pet on
Home (`deskPet` in the preferences, on by default) shows it again. With Windows' animation
effects off (Settings › Accessibility › Visual effects) it is not shown, as the Mac hides it
under Reduce Motion. Its timers run only while Home is on show in a window that is visible and
not minimised, and fire only when a cell or the place changes (at most 20 times a second while it
walks). A Space that cannot be reached, or one older than the route, leaves it walking and
resting with no mood. The desktop pet of the Linux client (over every app) is not in this one.

The sheet is `Assets/pet-claude.png`, a PNG of `src/web/public/pet-claude.webp` (the panel's,
made by `src/web/pets/claude.py`), since WPF reads WebP only where Windows has the WebP codec. It
was made once on Windows with the system's own decoder (WIC, through WPF in PowerShell) and
scaled to 128-pixel cells (1536 × 640, 12 by 5); made again after the sheet changes:

```powershell
Add-Type -AssemblyName PresentationCore
$s = [IO.File]::OpenRead("src\web\public\pet-claude.webp")
$f = [Windows.Media.Imaging.BitmapDecoder]::Create($s, 'PreservePixelFormat', 'OnLoad').Frames[0]; $s.Close()
$t = New-Object Windows.Media.Imaging.TransformedBitmap($f, (New-Object Windows.Media.ScaleTransform((1536 / $f.PixelWidth), (640 / $f.PixelHeight))))
$e = New-Object Windows.Media.Imaging.PngBitmapEncoder; $e.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($t))
$o = [IO.File]::Create("desktop\windows\AISpace\Assets\pet-claude.png"); $e.Save($o); $o.Close()
```

## Settings page

Settings (its tile on Home and in the Library, Ctrl+5) is the Space's own settings, drawn natively (`Views/SpaceSettings*.cs`): the
web panel's Settings ([panel.md](panel.md)) in the Linux client's layout
([linux-desktop.md](linux-desktop.md#settings)). The sections are listed on the left (icons only,
with their names as tooltips, below 900 wide), the chosen one on the right; the last one chosen is
kept in `%APPDATA%\ai-space\space-settings.json`. A section reads its routes when it is shown, again
when it is shown after 30 seconds, and on F5 or Reload; the background refresh leaves it alone,
except that a Space coming back online is read again. Each part reads one route, so a route that
fails shows its message with Retry in its place and the rest of the section stays. The rules and
the routes' shapes are in `AISpace.Core` (`SettingsModels.cs`, `SettingsRules.cs`,
`SpaceApi.Settings.cs`), tested against a real Space's answers.

| Section | What |
| --- | --- |
| Overview | The Space (name, address, version, edition, id, whether it answers), then the panel's Status: one line counting the services, backups, peers, runtimes and speech providers and the problems among them; the runtimes on each machine with their state, fallback and load; the speech providers; the peers and services (Start, Stop and Restart where the Space runs the unit); the backups |
| Models | The Space's default model (`PUT /api/model/preferences`); the agent CLIs on each machine, with Check Again (`POST /api/model/status/probe`); each app's model for the whole app and each purpose (`PATCH /api/panel/apps/:app/model`). A choice that is not signed in or offline is greyed, a saved one no longer offered stays shown and marked. Each picker saves only with its Save button, never on a selection (the arrow keys move through it), and the result shows as a notice |
| Scheduled Tasks | By app: state, schedule and triggers, last and next run; a task opens to its last 20 runs and their output. Read-only; a task's model is chosen in the web panel |
| Events and Calls | What each app provides, publishes and consumes, and the last 100 events, each opening to its deliveries. Read-only |
| Model Usage | 5h to 30d: totals, by app and purpose, by model and backend, the totals since the first call, the last 30 calls. The year's grid of days stays in the web panel |
| App Usage | 7d to all time, by kind: opens, time in use, the most used, a row per app, agent and built-in page; each device's time in the foreground |
| Packages | The apps installed from packages (version, state, Open), the apps of connected Spaces. Installing, rolling back, removing and sharing lead to the web panel |
| Fix this | 随手改, the feature the Space's routes still call feedback ([feedback.md](feedback.md)), read from `GET /api/panel/feedback/settings` and changed by `PUT` there, one field at a time as the web panel's Settings does, so both show the same settings: the button on app pages (off until turned on), Fix now or Fix later, the machine the Fix Engineer runs on (when there is more than one), its model and effort, attaching script errors, the shortcut, the default for apps and each app's own switch (Default, On, Off), the same for apps on peers; with requests waiting, Fix them now (`POST /api/panel/feedback/fix`). A switch or a choice of two or three saves when pressed and waits for the Space's answer; the machine and the model save with their Save button. The recent requests stay in the web panel, one row away |
| Appearance | Leads to the web panel's Settings in its tab (this app follows Windows' light or dark mode) |
| Account | Where the Space keeps its own password and this app is signed in: change the password, the signed-in sessions (sign one out). Either way, Sign Out…, which ends the session on the Space and clears the Space's cookies and pages here, as Settings › Spaces does |
| This Computer | AI Space Settings… (the app's own window: General) and the saved Spaces (its Spaces tab) |

The only writes to the Space are the ones made on the page by the person (the default model, an
app's model, a service's start, stop or restart, re-checking the CLIs, Fix this' settings, the
password, signing a session out), each followed by a notice that says what it did or why it failed. A link to the web
panel opens its tab in the app, never the browser.

## How the app opens the Space's pages

The terminal and the chat are the Space's built-in pages ([panel.md](panel.md#built-in-pages)),
`/?page=terminal` and `/?page=chat&agent=<id>`, each in its tab. A draft goes to the chat by the
address's fragment ([panel.md](panel.md#panel-links)), `#chat=<app>/<agent>&text=…`, which puts the
text in the message field, never sent; the page reads the fragment once it is up, clears it, and
follows a later change without reloading, so a new draft for the agent the Chat tab shows needs no
reload. Quick Chat is the panel's root with that fragment.

Chat cards ([chat-cards.md](chat-cards.md)) come with the page: the Chat tab and Quick Chat are the
panel's `Chat.tsx`, which draws the cards under a reply (`ChatCards.tsx`), asks their state each
time they show, offers Undo on the latest live reply and keeps the token in the page's memory, the
same as in a browser; a peer's agent goes through `/api/peers/<peer>/agents/cards/*` there too. The
client draws no card natively, because nothing native shows an agent's replies: the notification
area lists who is working with the run's one-line status, Home's command box and the floating ball
only open the chat page. A card's link opens a new window (`target=_blank`), which `PanelView`
hands to `AppModel.OpenLink`: an app's address opens in that app's tab, one of the Space's pages in
its place, anything else in the browser. New card styles reach this client with the web panel,
without a release of the app. A native chat surface, when there is one, draws them by the contract.

## How it is built

C# on .NET 10, WPF in its Fluent theme (it follows the system's light or dark mode and accent
colour), WebView2 for the pages, Windows Forms for the notification area icon, and
`Microsoft.Toolkit.Uwp.Notifications` for notifications.

```
desktop/windows/
  AISpace.Core/        what does not need Windows: connections and preferences, address rules,
                       the floating ball's rules (FloatingBallRules.cs), where a window may be
                       (WindowPlacement.cs), which address is which of the Space's pages
                       (SpacePages.cs), the Space check, the API (SpaceApi.cs with its generic
                       JSON calls; partial, an area adds its routes in SpaceApi.<Area>.cs) and
                       live state (catalogue, inbox, runs), deep links, navigation and permission
                       rules, installation strings, the search for an AI Space on this computer and
                       its installer's command (ThisComputer.cs)
  AISpace.Core.Tests/  its tests (xUnit), run on any system
  AISpace/             the app (Windows only): App.xaml.cs (the Mac's AppDelegate), AppModel.cs
                       (the Spaces, their native pages and web tabs, where links go),
                       MainWindow.cs, FloatingBall.cs, IconStore.cs (a Space's icons with its
                       sign-in), Ui.cs (the pieces the native windows and pages are made of),
                       ThisComputerSetup.cs (the first launch), Web/ (WebView2 profiles and
                       PanelView, the Mac's PanelSession), Views/ (the native pages: NativePage.cs
                       the contract, HomePage, InboxPage, ShortcutsPage, SpaceSettingsPage, PetView;
                       welcome, connection, Settings, Quick Chat, the floating ball's window and
                       dial), Shell/ (single instance, notification area, notifications, the
                       shortcut, registration, Win32 calls, the log), Strings*.cs (English, and
                       the Chinese per area), Assets/AISpace.ico (the mark on a transparent
                       ground, drawn by icon.ts)
  Directory.Build.props  shared settings and the version (`bun run set-version` rewrites it)
  build.ts             the build (below)
  icon.ts              draws AISpace.ico from the mark of docs/logo.svg (`bun run windows:icon`)
  strings.test.ts      every interface string has its Chinese (inside `bun run check`)
```

The projects build on Linux too (`EnableWindowsTargeting`), which the checks use. Only on Windows
does the program file get its icon and version information (the SDK warns NETSDK1074 elsewhere),
so releases are built on Windows.

The app is published as one program file: a self-contained, single-file `dotnet publish`
(`PublishSingleFile`, compressed, not trimmed, since WPF does not support trimming), so the
computer needs no .NET. The native libraries WPF and WebView2 load (`WebView2Loader.dll` among
them) are inside it and unpack themselves on the first start into a folder of the user's temporary
files, named after the program file (`%TEMP%\.net\AISpace\` for the installed copy). These publish settings are passed by `build.ts`, not set in the
project, so `dotnet build` and the tests stay a plain build.

| Command | Does |
| --- | --- |
| `bun run windows:test` | the core library's tests (`dotnet test`) and the strings check |
| `bun run windows:build` | `desktop/windows/build/ai-space/AISpace.exe`: the one program file for this machine's CPU, self-contained (no .NET needed on the computer) |
| `bun desktop/windows/build.ts --arch arm64 --out <dir>` | the same for the other CPU |
| `bun release/windows.ts --arch x64` (`bun run release:windows`) | the app as `ai-space-desktop-<version>-windows-x64.exe` in `dist/` ([release.md](release.md)) |

## Installing

Needs Windows 10 1809 or later, or Windows 11, and the Microsoft Edge WebView2 Runtime, which
Windows 11 and an up-to-date Windows 10 have; without it the app offers Microsoft's download.

Download a release's `ai-space-desktop-<version>-windows-<arch>.exe` (or build `AISpace.exe`) and
run it. It runs from where it is, and once asks to install itself for this user, with no
administrator; installing copies only that one file, as `AISpace.exe`:

| Where | What |
| --- | --- |
| `%LOCALAPPDATA%\Programs\AI Space\` | `AISpace.exe`, the app; the folder is replaced whole on every install or update, so an older installation's files go too |
| Start menu › AI Space | the shortcut (it also names the app in notifications) |
| Settings › Apps › Installed apps | the uninstall entry (`HKCU\…\Uninstall\dev.ai-space.windows`) |
| `HKCU\Software\Classes\aispace` | the `aispace://` link handler |
| `HKCU\…\CurrentVersion\Run` › AI Space | start at sign-in (`AISpace.exe --background`), on by default, off in Settings |

Running a newer copy while the installed one runs offers to update it: the running copy quits,
the new one installs itself and starts. Uninstalling from Installed apps removes all of the above,
and on request the saved Spaces, their sign-ins and settings. It never touches a Space: an AI
Space on this computer keeps running with its program, its background service and its workspace,
also one this app had installed ([below](#this-computer)); `space uninstall` removes that.

The release is not signed yet: SmartScreen asks once (More info › Run anyway).

What the app keeps:

| Path | What |
| --- | --- |
| `%APPDATA%\ai-space\connections.json` | the saved Spaces (an unreadable file is set aside as `connections.unreadable.json` and the app says so) |
| `%APPDATA%\ai-space\preferences.json` | keep running, notifications, the shortcut, the window's place, the Quick Chat agent, the floating ball (shown, its place, each Space's sections) |
| `%LOCALAPPDATA%\ai-space-desktop\web\` | WebView2's data, one profile per saved Space: cookies (its sign-in), storage, cache |
| `%LOCALAPPDATA%\ai-space-desktop\inbox-seen\` | which inbox threads were already notified, per Space |
| `%LOCALAPPDATA%\ai-space-desktop\logs\windows.log` | the app's log (Settings › General › Open Log Folder) |

None of it is under `%LOCALAPPDATA%\ai-space`: that directory is AI Space's own program
(`release/install.ps1`), which `space uninstall` deletes whole and the app's uninstaller must
never delete.

## This Computer

AI Space (the service and its web panel) is installed by itself, with one command
([release.md](release.md#one-command-install)); on Windows it runs as a Task Scheduler task of
the user on `127.0.0.1:8700`, without WSL. The app is a client of it and treats it as it treats a
Space on any other machine. What it adds is the first launch (`AISpace.Core/ThisComputer.cs`,
`AISpace/ThisComputerSetup.cs`; the Mac and Linux apps follow the same contract):

With no saved Space the welcome page shows two entries side by side, with nothing under them, and
takes neither by itself. The page's column keeps one width (480 at most), so the mark and the title
stay put while what is under them changes.

- **Connect to Local AI Space**: the AI Space on this computer, looked for only on the click.
- **Connect to a Remote AI Space** opens the address form.

1. **Looking.** The app asks this computer: `GET http://127.0.0.1:<port>/api/space`, two seconds
   at most per port, first the `SPACE_PORT` of the workspace's `.env` (`%SPACE_HOME%\.env`, else
   `%USERPROFILE%\.ai-space\.env`) when that is set, then 8700. Only an answer that says
   `"product": "ai-space"` ([editions.md](editions.md#service-identity)) counts.
2. **Found.** It is saved as This Computer, selected and shown.
3. **Not found.** It is installed first, then connected, with only "Installing AI Space…" and one
   progress bar on the page. The app runs the release's own installer, never a copy inside the
   app: it downloads `https://github.com/ericz-lab/ai-space/releases/latest/download/install.ps1`
   (`release/get.ps1`) to a temporary file (`<base>/install.ps1` when `AI_SPACE_DOWNLOAD` names a
   mirror or a directory, the variable the installer itself honours) and runs it with
   `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy
   Bypass -File <file>`, hidden, with `AI_SPACE_NO_OPEN=1` so no browser opens. It fetches the
   `ai-space-<version>-windows-x64` Server archive, checks it and installs it. The bar follows the
   lines it prints at each step (`AISpace.Core/InstallProgress.cs`,
   [editions.md](editions.md#the-install-progress-bar)); the lines themselves are not shown. When
   it ends with code 0 the app looks again, for up to about 30 seconds, and saves and shows the
   Space. Otherwise the page shows one line of why, Retry, and the end of the output folded under
   Details; when the installer went through but nothing answers yet, Retry only looks again.

The app never carries, updates, stops or uninstalls AI Space. Quitting or uninstalling the app
leaves it running, with its program (`%LOCALAPPDATA%\ai-space`), its task and its workspace
(`%USERPROFILE%\.ai-space`); `space uninstall` removes it, and `space upgrade` updates it
([release.md](release.md#one-command-install)). A Space saved at this computer's address is marked "this
computer" in Settings › Spaces and is otherwise like any other: removing it there forgets it and
changes nothing in the service.

## Trust boundary

The same as the Mac client's ([macos-desktop.md](macos-desktop.md#authentication-and-the-web-boundary)):
each saved Space has its own WebView2 profile, and the native calls (live state, inbox actions,
the native pages' routes, icons) carry that profile's cookies. No operator token is used. A
redirect, 401 or 403 means "sign in". The pages follow the Mac's navigation rules
(`NavigationPolicy`): links that leave the Space open in the browser, a new window never opens a
second web view (a page of the Space or an app's goes to its own place in the main window, anything
else to the browser), only the microphone is
granted (never the camera, location or notifications), to pages of the view's own origin or the
connection's. A remote Space needs https; plain http is accepted for loopback only. Every page
adds `AISpaceWindows/<version>` to the user agent, so a page (the feedback button,
[feedback.md](feedback.md#context)) can tell this client from a browser. The browser's password
saving and its developer tools (outside a debug build) are off.

## What the Mac client has and this one does not (yet)

- Native chat and terminals: the window shows the Space's own pages in tabs (chat cards with
  them, [above](#how-the-app-opens-the-spaces-pages)).
- The desk pet on the desktop: it walks along the bottom of Home only.
- The Share extension.
- Updating itself from the published releases; a newer download replaces the installed copy when
  it is run.
- A signed release.
