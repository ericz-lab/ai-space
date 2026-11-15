package dev.aispace.android.core

/**
 * The terminal's key row above the soft keyboard: the keys a phone keyboard lacks, as one table
 * the three phone clients share. The panel's `src/web/terminal-keys.ts` and the iPhone client's
 * `Core/TerminalKeys.swift` hold the same rows, the same byte rules and the same tests; change
 * all three together (docs/terminal.md, Keys on a phone).
 *
 * A key is only what goes to the shell: nothing here knows the socket, the screen or the view.
 * - The row is two parts: keys that scroll (left), and the arrows and hide-keyboard that stay (right).
 * - Arrows, Home and End follow the terminal's application cursor mode (DECCKM): `ESC O A`
 *   instead of `ESC [ A` while a full-screen program has asked for it.
 * - Ctrl and Alt are sticky: a tap arms them for the next key, from the row or the keyboard. On a
 *   key of the row they become xterm's modifier parameter (`ESC [ 1 ; 5 A` for Ctrl+Up); on a
 *   character Ctrl gives its control code (Termux's rules) and Alt puts an Escape before it.
 */
object TerminalKeys {
    sealed interface Kind {
        /** Fixed bytes; Alt puts an Escape before them, Ctrl leaves them as they are. */
        class Bytes(val bytes: ByteArray) : Kind
        /** A character, as the keyboard would type it. */
        class Text(val char: Char) : Kind
        /** `ESC [ x`, or `ESC O x` in application cursor mode: the arrows, Home and End. */
        class Cursor(val final: Char) : Kind
        /** `ESC O x`: F1 to F4. */
        class Ss3(val final: Char) : Kind
        /** `ESC [ n ~`: Page Up and Down, F5 to F10. */
        class Tilde(val code: Int) : Kind
        /** Ctrl or Alt: arms the next key. */
        enum class Modifier : Kind { CTRL, ALT }
        /** Puts the keyboard away. */
        data object HideKeyboard : Kind
    }

    /**
     * One key of the row. [label] is what it shows (the hide-keyboard key draws an icon);
     * [repeats]: held down, it repeats like a keyboard's arrow.
     */
    class Key(val id: String, val label: String, val kind: Kind, val repeats: Boolean = false)

    data class Modifiers(val ctrl: Boolean = false, val alt: Boolean = false)

    /** A held key repeats after this long, then at this interval (milliseconds). */
    const val REPEAT_DELAY_MS = 400L
    const val REPEAT_INTERVAL_MS = 70L

    private fun raw(vararg b: Int) = ByteArray(b.size) { b[it].toByte() }

    /** The part that scrolls, in the order a phone needs them most: Claude Code's Esc, Tab and Shift+Tab first. */
    val scrolling: List<Key> = listOf(
        Key("esc", "Esc", Kind.Bytes(raw(0x1b))),
        Key("tab", "Tab", Kind.Bytes(raw(0x09))),
        Key("backTab", "⇧Tab", Kind.Bytes(raw(0x1b, 0x5b, 0x5a))),
        Key("ctrl", "Ctrl", Kind.Modifier.CTRL),
        Key("alt", "Alt", Kind.Modifier.ALT),
        Key("ctrlC", "^C", Kind.Bytes(raw(0x03))),
        Key("pageUp", "PgUp", Kind.Tilde(5)),
        Key("pageDown", "PgDn", Kind.Tilde(6)),
        Key("home", "Home", Kind.Cursor('H')),
        Key("end", "End", Kind.Cursor('F')),
        Key("tilde", "~", Kind.Text('~')),
        Key("pipe", "|", Kind.Text('|')),
        Key("slash", "/", Kind.Text('/')),
        Key("dash", "-", Kind.Text('-')),
    ) + "PQRS".mapIndexed { i, c -> Key("f${i + 1}", "F${i + 1}", Kind.Ss3(c)) } +
        listOf(15, 17, 18, 19, 20, 21).mapIndexed { i, n -> Key("f${i + 5}", "F${i + 5}", Kind.Tilde(n)) }

    /** The part that stays at the right: the arrows (held, they repeat) and hide-keyboard. */
    val fixed: List<Key> = listOf(
        Key("left", "←", Kind.Cursor('D'), repeats = true),
        Key("down", "↓", Kind.Cursor('B'), repeats = true),
        Key("up", "↑", Kind.Cursor('A'), repeats = true),
        Key("right", "→", Kind.Cursor('C'), repeats = true),
        Key("hideKeyboard", "", Kind.HideKeyboard),
    )

    fun key(id: String): Key = (scrolling + fixed).first { it.id == id }

    /**
     * A character's control code under Ctrl, as Termux's view gives it
     * (`TerminalView.inputCodePoint`), or null when Ctrl leaves it as it is.
     */
    fun controlCode(char: Char): Int? = when (char) {
        in 'a'..'z', in 'A'..'Z' -> char.code and 0x1f
        ' ', '2' -> 0
        '[', '3' -> 27
        '\\', '4' -> 28
        ']', '5' -> 29
        '^', '6' -> 30
        '_', '7', '/' -> 31
        '8' -> 127
        else -> null
    }

    /**
     * What a key of the row sends, or null for Ctrl, Alt and hide-keyboard, which send nothing.
     * @param appCursor the terminal's application cursor mode (`TerminalEmulator.isCursorKeysApplicationMode`).
     * @param mods the sticky modifiers this key spends.
     */
    fun bytes(key: Key, appCursor: Boolean, mods: Modifiers = Modifiers()): ByteArray? {
        // xterm's modifier parameter: 1 plus 2 for Alt and 4 for Ctrl (Shift, 1, is not on the row).
        val m = 1 + (if (mods.alt) 2 else 0) + (if (mods.ctrl) 4 else 0)
        val esc = if (mods.alt) "\u001b" else ""
        val text = when (val k = key.kind) {
            is Kind.Bytes -> return if (mods.alt) raw(0x1b) + k.bytes else k.bytes.copyOf()
            is Kind.Text -> esc + ((if (mods.ctrl) controlCode(k.char) else null)?.toChar() ?: k.char)
            is Kind.Cursor -> if (m > 1) "\u001b[1;$m${k.final}" else "\u001b${if (appCursor) 'O' else '['}${k.final}"
            is Kind.Ss3 -> if (m > 1) "\u001b[1;$m${k.final}" else "\u001bO${k.final}"
            is Kind.Tilde -> if (m > 1) "\u001b[${k.code};$m~" else "\u001b[${k.code}~"
            is Kind.Modifier, Kind.HideKeyboard -> return null
        }
        return text.toByteArray(Charsets.UTF_8)
    }
}
