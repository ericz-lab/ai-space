import { describe, expect, test } from "bun:test";
import { FIXED_KEYS, type KeyId, NO_MODIFIERS, SCROLLING_KEYS, controlCode, keyById, keySequence, typedSequence } from "./terminal-keys.ts";

// The same cases as the iPhone client's TerminalKeysTests.swift and the Android client's
// TerminalKeysTests.kt: the three tables must send the same bytes.

const hex = (s: string | null) => (s === null ? null : [...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join(" "));
const send = (id: KeyId, appCursor = false, mods = NO_MODIFIERS) => hex(keySequence(keyById(id), appCursor, mods));
const CTRL = { ctrl: true, alt: false };
const ALT = { ctrl: false, alt: true };
const BOTH = { ctrl: true, alt: true };

describe("terminal key row", () => {
  test("the row's order: Claude Code's keys first, arrows and hide-keyboard fixed at the right", () => {
    expect(SCROLLING_KEYS.map((k) => k.id)).toEqual(["esc", "tab", "backTab", "ctrl", "alt", "ctrlC", "pageUp", "pageDown", "home", "end", "tilde", "pipe", "slash", "dash", "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10"]);
    expect(SCROLLING_KEYS.map((k) => k.label)).toEqual(["Esc", "Tab", "⇧Tab", "Ctrl", "Alt", "^C", "PgUp", "PgDn", "Home", "End", "~", "|", "/", "-", "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10"]);
    expect(FIXED_KEYS.map((k) => k.id)).toEqual(["left", "down", "up", "right", "hideKeyboard"]);
    expect([...SCROLLING_KEYS, ...FIXED_KEYS].filter((k) => k.repeats).map((k) => k.id)).toEqual(["left", "down", "up", "right"]);
  });

  test("each key's bytes in normal cursor mode", () => {
    const expected: Record<KeyId, string | null> = {
      esc: "1b",
      tab: "09",
      backTab: "1b 5b 5a",
      ctrl: null,
      alt: null,
      ctrlC: "03",
      pageUp: "1b 5b 35 7e",
      pageDown: "1b 5b 36 7e",
      home: "1b 5b 48",
      end: "1b 5b 46",
      tilde: "7e",
      pipe: "7c",
      slash: "2f",
      dash: "2d",
      f1: "1b 4f 50",
      f2: "1b 4f 51",
      f3: "1b 4f 52",
      f4: "1b 4f 53",
      f5: "1b 5b 31 35 7e",
      f6: "1b 5b 31 37 7e",
      f7: "1b 5b 31 38 7e",
      f8: "1b 5b 31 39 7e",
      f9: "1b 5b 32 30 7e",
      f10: "1b 5b 32 31 7e",
      left: "1b 5b 44",
      down: "1b 5b 42",
      up: "1b 5b 41",
      right: "1b 5b 43",
      hideKeyboard: null,
    };
    for (const [id, bytes] of Object.entries(expected)) expect([id, send(id as KeyId)]).toEqual([id, bytes]);
  });

  test("arrows, Home and End follow application cursor mode; the rest do not", () => {
    expect(["up", "down", "right", "left", "home", "end"].map((id) => send(id as KeyId, true))).toEqual(["1b 4f 41", "1b 4f 42", "1b 4f 43", "1b 4f 44", "1b 4f 48", "1b 4f 46"]);
    expect(send("pageUp", true)).toBe("1b 5b 35 7e");
    expect(send("f1", true)).toBe("1b 4f 50");
    expect(send("backTab", true)).toBe("1b 5b 5a");
  });

  test("sticky Ctrl and Alt on the row's keys", () => {
    // Special keys take xterm's modifier parameter, in either cursor mode.
    expect(send("left", false, CTRL)).toBe("1b 5b 31 3b 35 44");
    expect(send("up", true, ALT)).toBe("1b 5b 31 3b 33 41");
    expect(send("home", false, BOTH)).toBe("1b 5b 31 3b 37 48");
    expect(send("pageUp", false, BOTH)).toBe("1b 5b 35 3b 37 7e");
    expect(send("f1", false, CTRL)).toBe("1b 5b 31 3b 35 50");
    expect(send("f5", false, ALT)).toBe("1b 5b 31 35 3b 33 7e");
    // Fixed bytes: Alt puts an Escape before them, Ctrl leaves them.
    expect(send("esc", false, ALT)).toBe("1b 1b");
    expect(send("tab", false, CTRL)).toBe("09");
    expect(send("ctrlC", false, ALT)).toBe("1b 03");
    // Characters: Ctrl gives the control code when there is one.
    expect(send("slash", false, CTRL)).toBe("1f");
    expect(send("dash", false, CTRL)).toBe("2d");
    expect(send("tilde", false, ALT)).toBe("1b 7e");
    expect(send("slash", false, BOTH)).toBe("1b 1f");
  });

  test("control codes follow Termux's rules", () => {
    expect(["a", "c", "z", "A", "C", "Z"].map(controlCode)).toEqual([1, 3, 26, 1, 3, 26]);
    expect([" ", "2", "[", "3", "\\", "4", "]", "5", "^", "6", "_", "7", "/", "8"].map(controlCode)).toEqual([0, 0, 27, 27, 28, 28, 29, 29, 30, 30, 31, 31, 31, 127]);
    expect(["-", "~", "|", "é", "", "ab"].map(controlCode)).toEqual([null, null, null, null, null, null]);
  });

  test("keyboard text with the armed modifiers", () => {
    expect(typedSequence("c", CTRL)).toEqual({ data: "\x03", spent: true });
    expect(typedSequence("C", CTRL)).toEqual({ data: "\x03", spent: true });
    expect(typedSequence("x", ALT)).toEqual({ data: "\x1bx", spent: true });
    expect(typedSequence("c", BOTH)).toEqual({ data: "\x1b\x03", spent: true });
    // Only the first character takes Ctrl; one without a control code goes as it is.
    expect(typedSequence("ab", CTRL)).toEqual({ data: "\x01b", spent: true });
    expect(typedSequence("é", CTRL)).toEqual({ data: "é", spent: true });
    // Nothing armed, an escape sequence, or nothing typed: untouched, and the modifiers stay armed.
    expect(typedSequence("c", NO_MODIFIERS)).toEqual({ data: "c", spent: false });
    expect(typedSequence("\x1b[A", CTRL)).toEqual({ data: "\x1b[A", spent: false });
    expect(typedSequence("", ALT)).toEqual({ data: "", spent: false });
  });
});
