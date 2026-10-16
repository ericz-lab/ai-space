package dev.aispace.android.terminal

import dev.aispace.android.terminal.emulator.TerminalColors
import dev.aispace.android.terminal.emulator.TextStyle

/**
 * The terminal's colours: the ground and text of the panel's terminal (`terminal` and
 * `terminalText` in src/web/theme.ts), and its ANSI sets, the darker one on a light ground so
 * program output keeps its contrast. The same values as the iOS client's `TerminalPalette`.
 */
internal object TerminalPalette {
    fun ground(dark: Boolean): Int = argb(if (dark) 0x0B0D12 else 0xFBFBFD)
    fun text(dark: Boolean): Int = argb(if (dark) 0xE6E8EE else 0x1D1D1F)

    private val lightANSI = intArrayOf(
        0x1D1D1F, 0xDC2626, 0x16A34A, 0xB45309, 0x2563EB, 0x9333EA, 0x0E7490, 0xE5E5EA,
        0x6E6E73, 0xEF4444, 0x22C55E, 0xD97706, 0x3B82F6, 0xA855F7, 0x0891B2, 0xFFFFFF,
    )

    /** xterm.js's defaults, with the ground as black and the three the panel changes. */
    private val darkANSI = intArrayOf(
        0x0B0D12, 0xCC0000, 0x4E9A06, 0xC4A000, 0x3465A4, 0x75507B, 0x06989A, 0xD1D5DB,
        0x6B7280, 0xEF2929, 0x8AE234, 0xFCE94F, 0x729FCF, 0xAD7FA8, 0x34E2E2, 0xF9FAFB,
    )

    /**
     * Puts the palette into the emulator's colour scheme and resets the session's colours to it
     * when the appearance changed since they were last set. The scheme is shared by every
     * emulator (Termux keeps it static), so each surface applies it to the session it shows. A
     * reset also drops colours a program set with OSC 4, which only happens on a theme switch.
     */
    fun apply(session: RemoteTerminalSession, dark: Boolean) {
        val scheme = TerminalColors.COLOR_SCHEME.mDefaultColors
        val ansi = if (dark) darkANSI else lightANSI
        for (i in ansi.indices) scheme[i] = argb(ansi[i])
        scheme[TextStyle.COLOR_INDEX_FOREGROUND] = text(dark)
        scheme[TextStyle.COLOR_INDEX_BACKGROUND] = ground(dark)
        scheme[TextStyle.COLOR_INDEX_CURSOR] = text(dark)
        if (session.paletteDark != dark) {
            session.paletteDark = dark
            session.emulator.mColors.reset()
        }
        session.view?.let { session.applyBackground(it) }
    }

    private fun argb(rgb: Int): Int = (0xFF shl 24) or (rgb and 0xFFFFFF)
}
