package dev.aispace.android.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The same cases as the panel's src/web/terminal-keys.test.ts and the iPhone client's
 * TerminalKeysTests.swift: the three tables must send the same bytes.
 */
class TerminalKeysTests {
    private val ctrl = TerminalKeys.Modifiers(ctrl = true)
    private val alt = TerminalKeys.Modifiers(alt = true)
    private val both = TerminalKeys.Modifiers(ctrl = true, alt = true)

    private fun send(id: String, appCursor: Boolean = false, mods: TerminalKeys.Modifiers = TerminalKeys.Modifiers()): String? =
        TerminalKeys.bytes(TerminalKeys.key(id), appCursor, mods)?.joinToString(" ") { "%02x".format(it.toInt() and 0xff) }

    @Test fun theRowsOrder() {
        assertEquals(
            listOf("esc", "tab", "backTab", "ctrl", "alt", "ctrlC", "pageUp", "pageDown", "home", "end", "tilde", "pipe", "slash", "dash",
                "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10"),
            TerminalKeys.scrolling.map { it.id },
        )
        assertEquals(
            listOf("Esc", "Tab", "⇧Tab", "Ctrl", "Alt", "^C", "PgUp", "PgDn", "Home", "End", "~", "|", "/", "-",
                "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10"),
            TerminalKeys.scrolling.map { it.label },
        )
        assertEquals(listOf("left", "down", "up", "right", "hideKeyboard"), TerminalKeys.fixed.map { it.id })
        assertEquals(listOf("left", "down", "up", "right"), (TerminalKeys.scrolling + TerminalKeys.fixed).filter { it.repeats }.map { it.id })
    }

    @Test fun eachKeysBytesInNormalCursorMode() {
        val expected = linkedMapOf(
            "esc" to "1b", "tab" to "09", "backTab" to "1b 5b 5a", "ctrl" to null, "alt" to null, "ctrlC" to "03",
            "pageUp" to "1b 5b 35 7e", "pageDown" to "1b 5b 36 7e", "home" to "1b 5b 48", "end" to "1b 5b 46",
            "tilde" to "7e", "pipe" to "7c", "slash" to "2f", "dash" to "2d",
            "f1" to "1b 4f 50", "f2" to "1b 4f 51", "f3" to "1b 4f 52", "f4" to "1b 4f 53",
            "f5" to "1b 5b 31 35 7e", "f6" to "1b 5b 31 37 7e", "f7" to "1b 5b 31 38 7e", "f8" to "1b 5b 31 39 7e",
            "f9" to "1b 5b 32 30 7e", "f10" to "1b 5b 32 31 7e",
            "left" to "1b 5b 44", "down" to "1b 5b 42", "up" to "1b 5b 41", "right" to "1b 5b 43", "hideKeyboard" to null,
        )
        for ((id, bytes) in expected) assertEquals(id, bytes, send(id))
    }

    @Test fun arrowsHomeAndEndFollowApplicationCursorMode() {
        assertEquals(
            listOf("1b 4f 41", "1b 4f 42", "1b 4f 43", "1b 4f 44", "1b 4f 48", "1b 4f 46"),
            listOf("up", "down", "right", "left", "home", "end").map { send(it, appCursor = true) },
        )
        assertEquals("1b 5b 35 7e", send("pageUp", appCursor = true))
        assertEquals("1b 4f 50", send("f1", appCursor = true))
        assertEquals("1b 5b 5a", send("backTab", appCursor = true))
    }

    @Test fun stickyCtrlAndAltOnTheRowsKeys() {
        // Special keys take xterm's modifier parameter, in either cursor mode.
        assertEquals("1b 5b 31 3b 35 44", send("left", mods = ctrl))
        assertEquals("1b 5b 31 3b 33 41", send("up", appCursor = true, mods = alt))
        assertEquals("1b 5b 31 3b 37 48", send("home", mods = both))
        assertEquals("1b 5b 35 3b 37 7e", send("pageUp", mods = both))
        assertEquals("1b 5b 31 3b 35 50", send("f1", mods = ctrl))
        assertEquals("1b 5b 31 35 3b 33 7e", send("f5", mods = alt))
        // Fixed bytes: Alt puts an Escape before them, Ctrl leaves them.
        assertEquals("1b 1b", send("esc", mods = alt))
        assertEquals("09", send("tab", mods = ctrl))
        assertEquals("1b 03", send("ctrlC", mods = alt))
        // Characters: Ctrl gives the control code when there is one.
        assertEquals("1f", send("slash", mods = ctrl))
        assertEquals("2d", send("dash", mods = ctrl))
        assertEquals("1b 7e", send("tilde", mods = alt))
        assertEquals("1b 1f", send("slash", mods = both))
    }

    @Test fun controlCodesFollowTermuxsRules() {
        assertEquals(listOf(1, 3, 26, 1, 3, 26), "aczACZ".map { TerminalKeys.controlCode(it) })
        assertEquals(
            listOf(0, 0, 27, 27, 28, 28, 29, 29, 30, 30, 31, 31, 31, 127),
            " 2[3\\4]5^6_7/8".map { TerminalKeys.controlCode(it) },
        )
        for (c in "-~|é") assertNull(TerminalKeys.controlCode(c))
    }
}
