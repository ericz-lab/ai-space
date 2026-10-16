package dev.aispace.android.terminal

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.inputmethod.InputMethodManager
import dev.aispace.android.terminal.emulator.TerminalEmulator
import dev.aispace.android.terminal.emulator.TerminalOutput
import dev.aispace.android.terminal.emulator.TextStyle
import dev.aispace.android.terminal.view.TerminalView

/**
 * One shell's screen: the emulator and its scrollback, fed with bytes that come from a socket
 * rather than from a local process (Termux's `TerminalSession` forks one through JNI; this does
 * not). The network side (ticket, WebSocket, docs/terminal.md) lives elsewhere and talks to this
 * class through four things:
 *
 * - [feed]: bytes from the shell (binary frames), and any notice the app writes into the screen.
 * - [onInput]: bytes for the shell, from the keyboard, the accessory keys, a paste or an answer
 *   the emulator gives on its own (cursor position reports and the like). Called on the main thread.
 * - [onResize]: the window size in cells. The first call comes after the first layout of the
 *   view, with the size the view really has: open the shell then, at that size (as the iOS client
 *   does), and send a resize frame for every later call. It is called again only when the size
 *   changes (a rotation, the keyboard, a pinch of the font).
 * - [onTitleChanged]: the title a program set with an escape sequence, if anyone wants it.
 *
 * The session outlives its view: it is kept while its tab exists, so leaving the page and coming
 * back shows the same screen and scrollback. Show it with `TerminalSurface`.
 *
 * Main thread only, except [feed], which may be called from any one thread (bytes from another
 * thread are posted to the main thread in order).
 *
 * @param transcriptRows lines of scrollback kept above the screen.
 */
class RemoteTerminalSession(
    private val onInput: (ByteArray) -> Unit,
    private val onResize: (columns: Int, rows: Int) -> Unit,
    transcriptRows: Int = 3000,
) : TerminalOutput() {

    /** Called with the new title (or null when cleared) when a program sets the window title. */
    var onTitleChanged: ((String?) -> Unit)? = null

    /**
     * The emulator: the screen, the scrollback and the escape sequence parser. It starts at 80x24
     * so bytes that arrive before the view is laid out are kept; the view resizes it.
     * Read by the vendored view; callers have no need for it.
     */
    val emulator: TerminalEmulator = TerminalEmulator(this, 80, 24, transcriptRows, null)

    /** The window size last reported through [onResize], or null before the first layout. */
    var size: Pair<Int, Int>? = null
        private set

    /** The title a program set, if any. */
    val title: String? get() = emulator.title

    /** The view showing this session now, set by `TerminalSurface`. */
    internal var view: TerminalView? = null

    /** The font size the surface shows this session at, in sp; 0 until a surface picks one. */
    internal var fontSp: Float = 0f

    /** Whether the colours were last set for dark (null: never set). */
    internal var paletteDark: Boolean? = null

    private val main = Handler(Looper.getMainLooper())
    private val utf8 = ByteArray(5)
    private var lastBell = 0L

    /**
     * Appends output from the shell to the screen and redraws the view. On the main thread the
     * bytes are processed at once; from another thread they are copied and posted there.
     */
    fun feed(bytes: ByteArray) {
        if (bytes.isEmpty()) return
        if (Looper.myLooper() == Looper.getMainLooper()) {
            append(bytes)
        } else {
            val copy = bytes.copyOf()
            main.post { append(copy) }
        }
    }

    /** Writes text into the screen, as [feed] does with its UTF-8 bytes. */
    fun feed(text: String) = feed(text.toByteArray(Charsets.UTF_8))

    /** Gives the keyboard to the view showing this session, if one is on screen. */
    fun focus() {
        val v = view ?: return
        v.requestFocus()
        v.context.getSystemService(InputMethodManager::class.java)?.showSoftInput(v, 0)
    }

    /**
     * The view's new size in cells: resizes the emulator (reflowing the lines) and reports it
     * through [onResize] when it differs from the last one reported. Called by the view.
     */
    fun updateSize(columns: Int, rows: Int) {
        emulator.resize(columns, rows)
        val next = columns to rows
        if (size != next) {
            size = next
            onResize(columns, rows)
        }
    }

    /** Sends one code point as UTF-8, after an Escape when [prependEscape] (Alt). Called by the view. */
    fun writeCodePoint(prependEscape: Boolean, codePoint: Int) {
        require(codePoint in 0..0x10FFFF && codePoint !in 0xD800..0xDFFF) { "Invalid code point: $codePoint" }
        var n = 0
        if (prependEscape) utf8[n++] = 27
        when {
            codePoint <= 0x7F -> utf8[n++] = codePoint.toByte()
            codePoint <= 0x7FF -> {
                utf8[n++] = (0xC0 or (codePoint shr 6)).toByte()
                utf8[n++] = (0x80 or (codePoint and 0x3F)).toByte()
            }
            codePoint <= 0xFFFF -> {
                utf8[n++] = (0xE0 or (codePoint shr 12)).toByte()
                utf8[n++] = (0x80 or ((codePoint shr 6) and 0x3F)).toByte()
                utf8[n++] = (0x80 or (codePoint and 0x3F)).toByte()
            }
            else -> {
                utf8[n++] = (0xF0 or (codePoint shr 18)).toByte()
                utf8[n++] = (0x80 or ((codePoint shr 12) and 0x3F)).toByte()
                utf8[n++] = (0x80 or ((codePoint shr 6) and 0x3F)).toByte()
                utf8[n++] = (0x80 or (codePoint and 0x3F)).toByte()
            }
        }
        write(utf8, 0, n)
    }

    /** Bytes for the shell, from the view or from the emulator itself. */
    override fun write(data: ByteArray, offset: Int, count: Int) {
        if (count <= 0) return
        onInput(data.copyOfRange(offset, offset + count))
    }

    override fun titleChanged(oldTitle: String?, newTitle: String?) {
        onTitleChanged?.invoke(newTitle)
    }

    /** A program (OSC 52) or the selection's Copy put text on the clipboard. */
    override fun onCopyTextToClipboard(text: String?) {
        if (text.isNullOrEmpty()) return
        val clipboard = view?.context?.getSystemService(ClipboardManager::class.java) ?: return
        clipboard.setPrimaryClip(ClipData.newPlainText(null, text))
    }

    /** The selection's Paste: the clipboard's text, bracketed when the program asked for it. */
    override fun onPasteTextFromClipboard() {
        val context: Context = view?.context ?: return
        val clip = context.getSystemService(ClipboardManager::class.java)?.primaryClip ?: return
        if (clip.itemCount == 0) return
        val text = clip.getItemAt(0).coerceToText(context)?.toString()
        if (!text.isNullOrEmpty()) emulator.paste(text)
    }

    /** A bell is a tap of the haptics, at most a few a second, and silent when nothing is shown. */
    override fun onBell() {
        val now = SystemClock.uptimeMillis()
        if (now - lastBell < 300) return
        lastBell = now
        view?.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
    }

    override fun onColorsChanged() {
        view?.let { applyBackground(it) }
    }

    private fun append(bytes: ByteArray) {
        emulator.append(bytes, bytes.size)
        view?.onScreenUpdated()
    }

    internal fun applyBackground(v: TerminalView) {
        val ground = emulator.mColors.mCurrentColors[TextStyle.COLOR_INDEX_BACKGROUND]
        v.setBackgroundColor(ground)
        (v.parent as? View)?.setBackgroundColor(ground)
        v.invalidate()
    }
}
