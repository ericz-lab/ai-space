// The terminal's key row on a phone: the keys a soft keyboard lacks, as one table the three phone
// clients share. The iPhone client's `Core/TerminalKeys.swift` and the Android client's
// `core/TerminalKeys.kt` hold the same rows, the same byte rules and the same tests; change all
// three together (docs/terminal.md#keys-on-a-phone).
//
// A key is only what goes to the shell: nothing here knows the socket, the screen or the page.
// - The row is two parts: keys that scroll (left), and the arrows and hide-keyboard that stay (right).
// - Arrows, Home and End follow the terminal's application cursor mode (DECCKM): `ESC O A` instead
//   of `ESC [ A` while a full-screen program has asked for it.
// - Ctrl and Alt are sticky: a tap arms them for the next key, from the row or the keyboard. On a
//   key of the row they become xterm's modifier parameter (`ESC [ 1 ; 5 A` for Ctrl+Up); on a
//   character Ctrl gives its control code (Termux's rules) and Alt puts an Escape before it.

export type KeyId =
  | "esc"
  | "tab"
  | "backTab"
  | "ctrl"
  | "alt"
  | "ctrlC"
  | "pageUp"
  | "pageDown"
  | "home"
  | "end"
  | "tilde"
  | "pipe"
  | "slash"
  | "dash"
  | `f${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10}`
  | "left"
  | "down"
  | "up"
  | "right"
  | "hideKeyboard";

export type KeyKind =
  /** Fixed bytes; Alt puts an Escape before them, Ctrl leaves them as they are. */
  | { type: "bytes"; bytes: number[] }
  /** A character, as the keyboard would type it. */
  | { type: "text"; char: string }
  /** `ESC [ x`, or `ESC O x` in application cursor mode: the arrows, Home and End. */
  | { type: "cursor"; final: string }
  /** `ESC O x`: F1 to F4. */
  | { type: "ss3"; final: string }
  /** `ESC [ n ~`: Page Up and Down, F5 to F10. */
  | { type: "tilde"; code: number }
  /** Ctrl or Alt: arms the next key. */
  | { type: "modifier"; which: "ctrl" | "alt" }
  /** Puts the keyboard away. */
  | { type: "hideKeyboard" };

export type TerminalKey = {
  id: KeyId;
  /** What the key shows; the hide-keyboard key draws an icon instead. */
  label: string;
  kind: KeyKind;
  /** Held down, it repeats like a keyboard's arrow. */
  repeats: boolean;
};

export type Modifiers = { ctrl: boolean; alt: boolean };
export const NO_MODIFIERS: Modifiers = { ctrl: false, alt: false };

/** A held key repeats after this long, then at this interval. */
export const REPEAT_DELAY_MS = 400;
export const REPEAT_INTERVAL_MS = 70;

const key = (id: KeyId, label: string, kind: KeyKind, repeats = false): TerminalKey => ({ id, label, kind, repeats });
const F_SS3 = ["P", "Q", "R", "S"];
const F_TILDE = [15, 17, 18, 19, 20, 21];

/** The part that scrolls, in the order a phone needs them most: Claude Code's Esc, Tab and Shift+Tab first. */
export const SCROLLING_KEYS: readonly TerminalKey[] = [
  key("esc", "Esc", { type: "bytes", bytes: [0x1b] }),
  key("tab", "Tab", { type: "bytes", bytes: [0x09] }),
  key("backTab", "⇧Tab", { type: "bytes", bytes: [0x1b, 0x5b, 0x5a] }),
  key("ctrl", "Ctrl", { type: "modifier", which: "ctrl" }),
  key("alt", "Alt", { type: "modifier", which: "alt" }),
  key("ctrlC", "^C", { type: "bytes", bytes: [0x03] }),
  key("pageUp", "PgUp", { type: "tilde", code: 5 }),
  key("pageDown", "PgDn", { type: "tilde", code: 6 }),
  key("home", "Home", { type: "cursor", final: "H" }),
  key("end", "End", { type: "cursor", final: "F" }),
  key("tilde", "~", { type: "text", char: "~" }),
  key("pipe", "|", { type: "text", char: "|" }),
  key("slash", "/", { type: "text", char: "/" }),
  key("dash", "-", { type: "text", char: "-" }),
  ...F_SS3.map((final, i) => key(`f${i + 1}` as KeyId, `F${i + 1}`, { type: "ss3", final })),
  ...F_TILDE.map((code, i) => key(`f${i + 5}` as KeyId, `F${i + 5}`, { type: "tilde", code })),
];

/** The part that stays at the right: the arrows (held, they repeat) and hide-keyboard. */
export const FIXED_KEYS: readonly TerminalKey[] = [
  key("left", "←", { type: "cursor", final: "D" }, true),
  key("down", "↓", { type: "cursor", final: "B" }, true),
  key("up", "↑", { type: "cursor", final: "A" }, true),
  key("right", "→", { type: "cursor", final: "C" }, true),
  key("hideKeyboard", "", { type: "hideKeyboard" }),
];

/**
 * A character's control code under Ctrl, as Termux's view gives it (`TerminalView.inputCodePoint`),
 * or null when Ctrl leaves it as it is.
 */
export function controlCode(char: string): number | null {
  const c = char.codePointAt(0);
  if (c === undefined || char.length !== String.fromCodePoint(c).length) return null;
  if ((c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a)) return c & 0x1f;
  switch (char) {
    case " ":
    case "2":
      return 0;
    case "[":
    case "3":
      return 27;
    case "\\":
    case "4":
      return 28;
    case "]":
    case "5":
      return 29;
    case "^":
    case "6":
      return 30;
    case "_":
    case "7":
    case "/":
      return 31;
    case "8":
      return 127;
  }
  return null;
}

/** xterm's modifier parameter: 1 plus 2 for Alt and 4 for Ctrl (Shift, 1, is not on the row). */
const modifierParam = (m: Modifiers) => 1 + (m.alt ? 2 : 0) + (m.ctrl ? 4 : 0);
const ESC = "\x1b";

/**
 * What a key of the row sends, or null for Ctrl, Alt and hide-keyboard, which send nothing.
 * @param appCursor the terminal's application cursor mode (xterm.js `modes.applicationCursorKeysMode`).
 * @param mods the sticky modifiers this key spends.
 */
export function keySequence(k: TerminalKey, appCursor: boolean, mods: Modifiers = NO_MODIFIERS): string | null {
  const m = modifierParam(mods);
  switch (k.kind.type) {
    case "bytes":
      return (mods.alt ? ESC : "") + String.fromCharCode(...k.kind.bytes);
    case "text": {
      const ctrl = mods.ctrl ? controlCode(k.kind.char) : null;
      return (mods.alt ? ESC : "") + (ctrl === null ? k.kind.char : String.fromCharCode(ctrl));
    }
    case "cursor":
      if (m > 1) return `${ESC}[1;${m}${k.kind.final}`;
      return `${ESC}${appCursor ? "O" : "["}${k.kind.final}`;
    case "ss3":
      return m > 1 ? `${ESC}[1;${m}${k.kind.final}` : `${ESC}O${k.kind.final}`;
    case "tilde":
      return m > 1 ? `${ESC}[${k.kind.code};${m}~` : `${ESC}[${k.kind.code}~`;
    case "modifier":
    case "hideKeyboard":
      return null;
  }
}

/**
 * Text from the keyboard with the armed modifiers applied: Ctrl turns the first character into its
 * control code (when it has one), Alt puts an Escape before the text. An escape sequence (an
 * arrow from a hardware keyboard, a reply the terminal gives on its own) passes untouched, and
 * [spent] says whether the modifiers were used, so they stay armed for the next key otherwise.
 */
export function typedSequence(text: string, mods: Modifiers): { data: string; spent: boolean } {
  if (!text || text.startsWith(ESC) || (!mods.ctrl && !mods.alt)) return { data: text, spent: false };
  let data = text;
  if (mods.ctrl) {
    const first = String.fromCodePoint(text.codePointAt(0)!);
    const code = controlCode(first);
    if (code !== null) data = String.fromCharCode(code) + text.slice(first.length);
  }
  return { data: (mods.alt ? ESC : "") + data, spent: true };
}

export const ALL_KEYS: readonly TerminalKey[] = [...SCROLLING_KEYS, ...FIXED_KEYS];
export const keyById = (id: KeyId): TerminalKey => ALL_KEYS.find((k) => k.id === id)!;
