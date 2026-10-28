# AI Space for Windows

A small Windows client of an existing Space: the **floating ball** and **Quick Chat**, in a tray
app. It is a port of the Mac client's floating ball (`desktop/macos/AISpace/Desktop/FloatingBall.swift`
and `Services/FloatingBallRules.swift`); the rules are the same, and the Mac stays the reference.

> **Status:** it compiles and its tests pass on Linux (the .NET SDK builds WPF with
> `EnableWindowsTargeting`), but it has **not been run on Windows yet**. Treat the first run on
> Windows 10/11 as its acceptance test: the checklist is at the end.

## What it does

- **The ball.** A 52 px round window that stays above every app (topmost, a tool window: no
  taskbar button, not in Alt+Tab, and clicking it does not take the keyboard from the app you are
  in). Drag it anywhere; it stays inside the screen it was left on and comes back there next time.
- **The dial.** Rest the pointer on the ball and four sections open around it: top Keep, right
  Space Assistant, bottom Todo, left Design Studio by default. A click on a section opens Quick
  Chat on its agent; an app with no agent of its own lends Space Assistant, with "Save this to
  Keep:" already in the draft. An empty section (set to None) opens Settings.
- **Drop a picture.** Drag one picture (a file from Explorer, or image data from another app) onto
  a section to open Quick Chat there with the picture attached; on the middle it goes to Space
  Assistant. More than one file, or a file that is not a picture, is refused with a notification.
- **Quick Chat.** Pick an agent, type, Enter sends (Shift+Enter for a new line), Ctrl+V pastes a
  picture, Ctrl+N starts a new conversation, Esc hides it. Replies stream in; Stop ends the run;
  tool approvals are answered with Allow/Deny. It talks to the same Space APIs as the other
  clients: `GET /api/apps`, `GET /api/agents`, `POST /api/agents/<app>/<name>/chat` (or
  `/api/peers/<peer>/agents/...` for a peer's agent), `runs/<id>/stop`, `runs/<id>/approvals/<id>`.
- **Settings.** The Space's address and a device token, show/hide the ball, and what each section
  opens (Default, None, any app or agent of the Space). Each Space address keeps its own sections.
- **Tray icon.** Click for Quick Chat; right-click for Quick Chat, Show the floating ball,
  Settings, Quit.

## Signing in

The app signs in with a **device credential**, as the Linux Local edition does
([docs/auth.md](../../docs/auth.md)). On the Space's machine run:

```sh
space auth device-add windows
```

and paste the printed `spd_…` token into Settings with the Space's address. The token is stored in
`%APPDATA%\AI Space\preferences.json` protected for the current Windows user (DPAPI).

## Layout

| Path | What |
| --- | --- |
| `Core/` | Platform-neutral (.NET 8): `FloatingBallRules.cs` (the Mac's rules: place, sections, dial position, slots, drop offers), `Catalogue.cs`, `SpaceClient.cs` (HTTP + SSE), `Chat.cs` (stream events, images, approvals), `Conversation.cs`, `Preferences.cs` |
| `Core.Tests/` | xunit tests for all of `Core/` |
| `App/` | WPF (`net8.0-windows`): `App.cs` (entry, single instance, tray, catalogue refresh), `BallWindow.cs`, `QuickChatWindow.cs`, `SettingsWindow.cs`, `Native.cs` (the few Win32 calls), `Strings.cs` (en/zh) |

Everything is code (no XAML), so it builds the same on any OS.

## Build and test

Needs the [.NET 8 SDK](https://dotnet.microsoft.com/download) (any OS for building and testing;
Windows to run).

```sh
cd desktop/windows
dotnet test Core.Tests          # the rules, catalogue, chat stream, preferences
dotnet build App                # the app (on Linux/macOS too)
dotnet publish App -c Release -r win-x64 --self-contained false -o out
```

From the repository root: `bun run windows:test`, `bun run windows:build`. CI runs both on Linux.
`out\AISpace.exe` is the app; it needs the .NET 8 Desktop Runtime (or publish with
`--self-contained true`). To start it with Windows, put a shortcut to it in
`shell:startup`.

## Limits

- Not run on Windows yet (see the status above).
- No installer, no auto-update, no code signing.
- Only the ball and Quick Chat: the library, the Space's pages, terminals and the inbox live in
  the web panel (open the Space's address in a browser).
- Markdown in replies is shown as plain text.
- A picture dragged straight out of a browser arrives as a "virtual file" with no data: it is
  refused. Save it first, or copy and paste it into Quick Chat.

## First run on Windows: checklist

1. The tray icon appears; Settings opens on first start; Check says "Connected".
2. The ball is at the right edge, a third of the way down, above every window; it has no taskbar
   button and is not in Alt+Tab; clicking it leaves the current app focused.
3. Rest on it: the dial opens around it (inside the screen near edges); leaving closes it.
4. Click each section: Quick Chat opens on the right agent; Keep shows "Save this to Keep:".
5. Drag the ball to another monitor, quit, start: it comes back there.
6. Drop a PNG from Explorer on a section and on the middle; drop two files; drop a `.txt`.
7. Send a message, stop one, answer an approval; Ctrl+V a screenshot; Esc hides; the tray reopens.
8. Per-monitor DPI: move the ball between a 100% and a 150% screen.
