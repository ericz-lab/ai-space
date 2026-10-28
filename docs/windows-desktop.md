# Windows desktop client

Status: written and built; its core library is tested (`dotnet test`) and the app compiles on
every check, but it has not yet been run on a Windows machine. The Client edition connects to
existing Spaces; the Local edition also sets up and runs a Space on this computer, inside WSL 2
([below](#this-computer)). It follows the Mac client ([macos-desktop.md](macos-desktop.md)): the
same parts, the same rules, the same names, and says below where it does less.

## What it is

A window over the Space's web panel with Windows around it. The panel itself, its chat, inbox,
terminal and settings, is the Space's own page; the app adds what a page cannot do.

| Part | What it does |
| --- | --- |
| Window | The Space menu (each saved Space with its state, Add a Space…), Back, Forward and Reload, a tab per open app page next to Home (the panel), then Open in Browser, Inbox with the unread count, Chat and Settings. A middle click or Ctrl+W closes a tab, F5 reloads. Before any Space is saved it shows the welcome page: an address to connect to, the address of a Space on this computer in one click, and in the Local edition the setup ([below](#this-computer)). The window keeps its size and place |
| Pages | Each saved Space has its own WebView2 profile (cookies, storage, cache), so signing in on the panel signs in everything that Space's pages and native calls do. A link to an app of the Space opens in that app's tab, a link off the Space in the default browser. A page that cannot load shows why, with Try Again, Open in Browser and Edit Space… |
| Quick Chat | A small window over every app with one agent's chat (the panel's own, so a conversation there is the same one): Ctrl+Alt+Space by default (Ctrl+Shift+Space, Alt+Shift+Space or off in Settings), the notification area menu, the jump list, a section of the floating ball, or `aispace://chat`. 380 wide as the Mac's, with no title bar: a 40 high header to drag it by (the Space, the agent, Open in Main Window, Close), then the page's chat in its narrow layout, whose header holds the model and the permission choice. The shortcut opens it in the upper middle of the screen, the ball beside itself ([below](#the-floating-ball)). It remembers the agent last used; Escape or Close hides it, and an answer being written goes on |
| Floating ball | A 52 px ball over every app that never takes the keyboard (off until Settings › General turns it on; the notification area menu and its own right-click menu show and hide it) ([below](#the-floating-ball)) |
| Notification area | The icon (the Mac's menu bar extra): a click opens the window; the menu has each Space with its state, a sign-in when it needs one, who is working, the unread threads and its apps, then Quick Chat, Show the Floating Ball, Settings… and Quit AI Space. Its tooltip counts what is unread and who is working |
| Notifications | New unread inbox threads of every saved Space as Windows notifications, with Mark as Read and Done; a click opens the thread. The taskbar button carries a badge while something is unread |
| Links | `aispace://` links as on the Mac (`DeepLink` in `AISpace.Core`): `chat?agent=&text=`, `open?app=`, `inbox`, `show`. A link may fill in a message but never sends it. The jump list has Quick Chat and Inbox |
| Settings | General (notifications, keep running when the window is closed, start at sign-in, the Quick Chat shortcut, the floating ball and its sections, installing, the log), Spaces (add, edit, make default, sign out, remove) and This Computer (the Local edition) |

The app is one copy per Windows session: starting it again (the Start menu, a link, the jump
list) hands what it was started with to the running copy. Closing the window leaves it in the
notification area, so the inbox can reach the person, unless Settings says not to keep running;
Quit AI Space ends it. A Space and its agents keep running wherever they run.

The interface is in English or Chinese, following Windows' display language (`Strings.zh.cs`;
`desktop/windows/strings.test.ts` checks that every string has its Chinese).

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

## How the panel opens a window

The app opens the panel's windows by the address's fragment ([panel.md](panel.md#panel-links)):
`#inbox`, `#terminal`, `#settings`, `#shortcuts`, and `#chat=<app>/<agent>&text=…`, which opens
that agent's chat with the text in the message field, never sent. The panel reads the fragment
once the page is up, clears it, and follows a later change without reloading, so Inbox, Chat and
Quick Chat need no reload.

## How it is built

C# on .NET 10, WPF in its Fluent theme (it follows the system's light or dark mode and accent
colour), WebView2 for the pages, Windows Forms for the notification area icon, and
`Microsoft.Toolkit.Uwp.Notifications` for notifications.

```
desktop/windows/
  AISpace.Core/        what does not need Windows: connections and preferences, address rules,
                       the floating ball's rules (FloatingBallRules.cs),
                       the Space check, the API and live state (catalogue, inbox, runs), deep
                       links, navigation and permission rules, installation strings, WSL commands
                       and the Local edition's answers
  AISpace.Core.Tests/  its tests (xUnit), run on any system
  AISpace/             the app (Windows only): App.xaml.cs (the Mac's AppDelegate), AppModel.cs,
                       MainWindow.cs, FloatingBall.cs, Web/ (WebView2 profiles and PanelView, the
                       Mac's PanelSession), Views/ (welcome, connection, Settings, Quick Chat, the
                       floating ball's window and dial, This Computer), Shell/ (single instance, notification area, notifications, the
                       shortcut, registration, Win32 calls, the log), Local/ (wsl.exe and the
                       Local manager), Strings*.cs (English and Chinese)
  Directory.Build.props  shared settings and the version (`bun run set-version` rewrites it)
  build.ts             the build (below)
  strings.test.ts      every interface string has its Chinese (inside `bun run check`)
```

The projects build on Linux too (`EnableWindowsTargeting`), which the checks use. Only on Windows
does the program file get its icon and version information (the SDK warns NETSDK1074 elsewhere),
so releases are built on Windows.

| Command | Does |
| --- | --- |
| `bun run windows:test` | the core library's tests (`dotnet test`) and the strings check |
| `bun run windows:build` | `desktop/windows/build/ai-space`: `dotnet publish` for this machine's CPU, self-contained (no .NET needed on the computer), and `VERSION.json` |
| `bun desktop/windows/build.ts --arch arm64 --out <dir>` | the same for the other CPU |
| `bun desktop/windows/build.ts --bundle-only --out <dir>` | the Local edition's Linux release for WSL: `bundle.tar.gz` (release/server.ts `stageRelease`, `runtime/bun`, `runtime/space-pty`) and `RELEASE.json`. On Linux only, of the same CPU as the Windows it is for: it carries the Bun that builds it |
| `bun desktop/windows/build.ts --local [--bundle <dir>]` | the Local edition: the app with that release in `local/`, taken from `--bundle` or built here on Linux |
| `bun release/windows.ts --arch x64 --bundle <dir>` (`bun run release:windows`) | both editions as zip files in `dist/` ([release.md](release.md#windows-app)) |

## Installing

Needs Windows 10 1809 or later, or Windows 11, and the Microsoft Edge WebView2 Runtime, which
Windows 11 and an up-to-date Windows 10 have; without it the app offers Microsoft's download.

Unzip a release (or a build) and run `AISpace.exe`. It runs from where it is, and once asks to
install itself for this user, with no administrator:

| Where | What |
| --- | --- |
| `%LOCALAPPDATA%\Programs\AI Space\` | the app, replaced on every install or update |
| Start menu › AI Space | the shortcut (it also names the app in notifications) |
| Settings › Apps › Installed apps | the uninstall entry (`HKCU\…\Uninstall\dev.ai-space.windows`) |
| `HKCU\Software\Classes\aispace` | the `aispace://` link handler |
| `HKCU\…\CurrentVersion\Run` › AI Space | start at sign-in (`AISpace.exe --background`), on by default, off in Settings |

Running a newer copy while the installed one runs offers to update it: the running copy quits,
the new one installs itself and starts. Uninstalling from Installed apps removes all of the above,
and on request the saved Spaces, their sign-ins and settings; it never touches a Space's workspace
or the Local edition's service (remove that first, in Settings › This Computer).

The release is not signed yet: SmartScreen asks once (More info › Run anyway).

What the app keeps:

| Path | What |
| --- | --- |
| `%APPDATA%\ai-space\connections.json` | the saved Spaces (an unreadable file is set aside as `connections.unreadable.json` and the app says so) |
| `%APPDATA%\ai-space\preferences.json` | keep running, notifications, the shortcut, the window's place, the Quick Chat agent, the floating ball (shown, its place, each Space's sections), the Local edition's distribution |
| `%LOCALAPPDATA%\ai-space\web\` | WebView2's data, one profile per saved Space: cookies (its sign-in), storage, cache |
| `%LOCALAPPDATA%\ai-space\inbox-seen\` | which inbox threads were already notified, per Space |
| `%LOCALAPPDATA%\ai-space\logs\windows.log` | the app's log (Settings › General › Open Log Folder) |
| Credential Manager › `ai-space/local-device/…` | the Local edition's device credential |

## This Computer

The Local edition runs the Space on this computer the way the Linux app does
([local.md](local.md#on-windows)): inside a WSL 2 distribution, as a systemd user service that
`space local` installs, starts, stops and updates. The app carries the Linux release in
`local\bundle.tar.gz` and drives it with `wsl.exe`. Settings › This Computer, and the welcome page
before any Space is saved, go through it in order:

1. **WSL.** Without WSL 2 or a WSL 2 distribution it offers Install WSL, which opens Windows' own
   `wsl --install -d Ubuntu-24.04` in a console (it asks for an administrator, and Windows may
   need a restart), then Check Again. A WSL 1 distribution is named with the command that converts
   it. With several distributions it asks which one; distributions that Docker or Rancher Desktop
   run for themselves are left out.
2. **The distribution.** systemd on in `/etc/wsl.conf` (kept as it was otherwise; the
   distribution restarts once) and `loginctl enable-linger`, so the service runs with no terminal
   open.
3. **Set Up.** The release is unpacked in the distribution under
   `~/.local/share/ai-space/windows/bundle/`, once per version, and `space local install
   --device <computer name> --default-model <model>` runs with its own Bun. The agent CLIs
   (`claude`, `codex`) are the ones installed inside the distribution; the card lists what it
   found. A Space already there that the app did not make is offered as Connect to It or Take It
   Over….
4. **Afterwards.** The Space is saved as This Computer at the address the service reports
   (`http://127.0.0.1:8700` by default; WSL forwards it to Windows) and signed in with the device
   credential. Settings shows its version,
   workspace and state, with Start, Stop, Restart, Repair, Open Log, Update When Idle or Update
   Now… while an update waits on work in progress, and Remove Background Service….

WSL stops a distribution a few seconds after its last Windows process leaves, and the service with
it. The app keeps one hidden `wsl.exe` sleeping in the distribution, started at sign-in and left
running when the app quits, as the Mac's LaunchAgent outlives its app. When the app carries a
newer release than the one installed, it updates the service once the Space has no work in
progress, as on the Mac ([local.md](local.md#updates)); a service the person stopped is left
stopped.

## Trust boundary

The same as the Mac client's ([macos-desktop.md](macos-desktop.md#authentication-and-the-web-boundary)):
each saved Space has its own WebView2 profile, and the native calls (live state, inbox actions,
the device sign-in) carry that profile's cookies. No operator token is used. A redirect, 401 or
403 means "sign in". The pages follow the Mac's navigation rules (`NavigationPolicy`): links that
leave the Space open in the browser, new windows never open inside the app, only the microphone is
granted (never the camera, location or notifications), to pages of the view's own origin or the
connection's. A remote Space needs https; plain http is accepted for loopback only. Every page
adds `AISpaceWindows/<version>` to the user agent, so a page (the feedback button,
[feedback.md](feedback.md#context)) can tell this client from a browser. The browser's password
saving and its developer tools (outside a debug build) are off.

## What the Mac client has and this one does not (yet)

- Native views of Home, chat, the inbox and terminals: the window shows the panel's own.
- The Share extension.
- Updating itself from the published releases; a newer download replaces the installed copy when
  it is run.
- A signed release.
