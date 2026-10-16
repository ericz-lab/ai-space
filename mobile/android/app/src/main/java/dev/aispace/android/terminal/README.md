# dev.aispace.android.terminal

The Terminal page's emulator and view. The iOS client uses SwiftTerm; this client uses the
terminal emulator and view of [Termux](https://github.com/termux/termux-app), vendored as source.

## Source and licence

- `emulator/` is `terminal-emulator/src/main/java/com/termux/terminal/` and `view/` is
  `terminal-view/src/main/java/com/termux/view/` of termux-app at tag **v0.118.1**.
- The termux-app repository is GPLv3 as a whole, but its `LICENSE.md` names these two library
  modules as an exception: they come from Jack Palevich's Terminal Emulator for Android and are
  under the **Apache License 2.0** (text in `LICENSE-APACHE-2.0.txt`). The modules carry no
  LICENSE or NOTICE file of their own and the original files have no header; each vendored file
  now starts with a comment naming its original path and what was changed.
- Changes: packages renamed to `dev.aispace.android.terminal.emulator` / `.view`; Termux's
  `TerminalSession` (a local process forked through JNI), `JNI` and `ByteQueue` left out, with
  `RemoteTerminalSession` in their place; the view and its client take that session; the
  selection handles are drawn in code (`SelectionHandleDrawable`) and the selection toolbar uses
  the system's Copy and Paste strings, so the library's resources are not needed.

## Ours

- `RemoteTerminalSession`: the emulator fed from a socket; `feed`, `onInput`, `onResize`.
- `TerminalSurface`: the Compose wrapper: the view, the accessory keys above the keyboard,
  colours, pinch to zoom, keyboard-aware sizing.
- `TerminalPalette`: the iOS client's terminal colours (from the panel's `src/web/theme.ts`).

To update the vendored code, fetch the same files at a newer tag and reapply the changes above.
