package dev.aispace.android.terminal

import android.annotation.SuppressLint
import android.content.Context
import android.util.Log
import android.util.TypedValue
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.widget.FrameLayout
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardHide
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import dev.aispace.android.R
import dev.aispace.android.terminal.emulator.KeyHandler
import dev.aispace.android.terminal.view.TerminalView
import dev.aispace.android.terminal.view.TerminalViewClient
import dev.aispace.android.terminal.view.textselection.SelectionHandleDrawable
import kotlin.math.roundToInt
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * A session's terminal on screen: the emulator view (Termux's, vendored) in the terminal's own
 * colours, and above the soft keyboard a row of the keys a phone keyboard lacks, as the iOS
 * client has (SwiftTerm's accessory: Esc, Ctrl, Tab, ~ | / -, the arrows and a key that hides the
 * keyboard; Alt and F1–F10 in the row's scrolling part here).
 *
 * - A tap gives the view the keyboard; a long press selects text, with Copy and Paste in the
 *   floating toolbar; a drag scrolls the scrollback; a pinch changes the font size, kept per session.
 * - Ctrl and Alt are sticky: a tap arms them for the next key, from the row or the keyboard.
 * - The view keeps to the area above the keyboard (and above the row), so the window size the
 *   shell is told is the part that can be seen. That needs the window to resize for the IME
 *   (edge-to-edge with `adjustResize`); this composable applies the IME inset itself, and pads
 *   only what an ancestor did not already consume.
 *
 * Switching [session] puts a new view on that session; its screen and scrollback are in the
 * session, so nothing is lost. The selection handles take the theme's accent
 * (`MaterialTheme.colorScheme.primary`).
 *
 * @param dark the dark palette (the iOS client follows the system's appearance; pass the app's).
 */
@Composable
fun TerminalSurface(session: RemoteTerminalSession, dark: Boolean, modifier: Modifier = Modifier) {
    val accent = MaterialTheme.colorScheme.primary
    val modifiers = remember { StickyModifiers() }
    val imeShown = WindowInsets.ime.getBottom(LocalDensity.current) > 0
    // The keyboard belongs to the terminal: it goes with the last tab or the page, not on a tab switch.
    val view = LocalView.current
    DisposableEffect(Unit) {
        onDispose {
            view.context.getSystemService(InputMethodManager::class.java)?.hideSoftInputFromWindow(view.windowToken, 0)
        }
    }
    Column(modifier.background(Color(TerminalPalette.ground(dark))).imePadding()) {
        key(session) {
            AndroidView(
                factory = { context -> TerminalHost(context, session, modifiers) },
                update = {
                    SelectionHandleDrawable.setColor(accent.toArgb())
                    TerminalPalette.apply(session, dark)
                },
                onRelease = { host -> host.release() },
                modifier = Modifier.weight(1f).fillMaxWidth(),
            )
        }
        if (imeShown) AccessoryRow(session, modifiers, dark, accent)
    }
}

/** Ctrl and Alt from the accessory row, each spent by the next key that reads it. */
internal class StickyModifiers {
    var ctrl by mutableStateOf(false)
    var alt by mutableStateOf(false)

    fun takeCtrl(): Boolean = ctrl.also { if (it) ctrl = false }
    fun takeAlt(): Boolean = alt.also { if (it) alt = false }
}

/**
 * Holds the emulator view with the iOS client's 6dp side inset and the ground behind it, and
 * wires it to the session.
 */
@SuppressLint("ViewConstructor")
private class TerminalHost(
    context: Context,
    val session: RemoteTerminalSession,
    modifiers: StickyModifiers,
) : FrameLayout(context) {
    val terminal = TerminalView(context, null)

    init {
        val inset = (6 * resources.displayMetrics.density).roundToInt()
        setPadding(inset, 0, inset, 0)
        terminal.isFocusable = true
        terminal.isFocusableInTouchMode = true
        terminal.setTerminalViewClient(Client(this, modifiers))
        if (session.fontSp == 0f) {
            // As on iOS: 12 on a phone, 13 on a larger screen.
            session.fontSp = if (resources.configuration.smallestScreenWidthDp >= 600) 13f else 12f
        }
        terminal.setTextSize(px(session.fontSp))
        addView(terminal, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        session.view = terminal
        terminal.attachSession(session)
    }

    /** A pinch step: one sp bigger or smaller, between 8 and 24. */
    fun changeFont(bigger: Boolean) {
        val next = (session.fontSp + if (bigger) 1f else -1f).coerceIn(MIN_SP, MAX_SP)
        if (next == session.fontSp) return
        session.fontSp = next
        terminal.setTextSize(px(next))
    }

    fun release() {
        terminal.stopTextSelectionMode()
        if (session.view === terminal) session.view = null
    }

    private fun px(sp: Float): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, sp, resources.displayMetrics).roundToInt()

    companion object {
        const val MIN_SP = 8f
        const val MAX_SP = 24f
    }
}

/** The emulator view's questions, answered for a remote shell on a phone. */
private class Client(private val host: TerminalHost, private val modifiers: StickyModifiers) : TerminalViewClient {
    override fun onScale(scale: Float): Float {
        if (scale < 0.9f || scale > 1.1f) {
            host.changeFont(scale > 1f)
            return 1f
        }
        return scale
    }

    override fun onSingleTapUp(e: MotionEvent) = host.session.focus()
    override fun shouldBackButtonBeMappedToEscape() = false
    override fun shouldEnforceCharBasedInput() = false
    override fun shouldUseCtrlSpaceWorkaround() = false
    override fun isTerminalViewSelected() = true
    override fun copyModeChanged(copyMode: Boolean) {}
    override fun onKeyDown(keyCode: Int, e: KeyEvent, session: RemoteTerminalSession) = false
    override fun onKeyUp(keyCode: Int, e: KeyEvent) = false
    override fun onLongPress(event: MotionEvent) = false
    override fun readControlKey() = modifiers.takeCtrl()
    override fun readAltKey() = modifiers.takeAlt()
    override fun readShiftKey() = false
    override fun readFnKey() = false
    override fun onCodePoint(codePoint: Int, ctrlDown: Boolean, session: RemoteTerminalSession) = false
    override fun onEmulatorSet() {}

    override fun logError(tag: String, message: String) { Log.e(tag, message) }
    override fun logWarn(tag: String, message: String) { Log.w(tag, message) }
    override fun logInfo(tag: String, message: String) { Log.i(tag, message) }
    override fun logDebug(tag: String, message: String) { Log.d(tag, message) }
    override fun logVerbose(tag: String, message: String) { Log.v(tag, message) }
    override fun logStackTraceWithMessage(tag: String, message: String, e: Exception) { Log.e(tag, message, e) }
    override fun logStackTrace(tag: String, e: Exception) { Log.e(tag, "", e) }
}

/** Sends a key through the view's key table (cursor key mode and modifiers included). */
private fun sendKey(session: RemoteTerminalSession, modifiers: StickyModifiers, keyCode: Int) {
    val view = session.view ?: return
    var mod = 0
    if (modifiers.takeCtrl()) mod = mod or KeyHandler.KEYMOD_CTRL
    if (modifiers.takeAlt()) mod = mod or KeyHandler.KEYMOD_ALT
    view.handleKeyCode(keyCode, mod)
}

/** Types a character as the keyboard would; the view applies an armed Ctrl or Alt. */
private fun sendChar(session: RemoteTerminalSession, char: Char) {
    session.view?.inputCodePoint(char.code, false, false)
}

private fun hideKeyboard(session: RemoteTerminalSession) {
    val view = session.view ?: return
    view.context.getSystemService(InputMethodManager::class.java)?.hideSoftInputFromWindow(view.windowToken, 0)
}

@Composable
private fun AccessoryRow(session: RemoteTerminalSession, modifiers: StickyModifiers, dark: Boolean, accent: Color) {
    val colors = KeyColors(
        bar = Color(if (dark) 0xFF16181F else 0xFFE4E5EA),
        key = Color(if (dark) 0xFF2A2E38 else 0xFFFFFFFF),
        text = Color(TerminalPalette.text(dark)),
        accent = accent,
    )
    Row(
        Modifier.fillMaxWidth().height(44.dp).background(colors.bar).padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            Modifier.weight(1f).horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            KeyCap("Esc", colors) { sendKey(session, modifiers, KeyEvent.KEYCODE_ESCAPE) }
            KeyCap("Ctrl", colors, active = modifiers.ctrl, description = stringResource(R.string.terminal_key_ctrl)) {
                modifiers.ctrl = !modifiers.ctrl
            }
            KeyCap("Alt", colors, active = modifiers.alt, description = stringResource(R.string.terminal_key_alt)) {
                modifiers.alt = !modifiers.alt
            }
            KeyCap("Tab", colors) { sendKey(session, modifiers, KeyEvent.KEYCODE_TAB) }
            for (c in "~|/-") KeyCap(c.toString(), colors) { sendChar(session, c) }
            for (n in 1..10) KeyCap("F$n", colors) { sendKey(session, modifiers, KeyEvent.KEYCODE_F1 + n - 1) }
        }
        Row(
            Modifier.padding(start = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            KeyCap("←", colors, description = stringResource(R.string.terminal_key_left), repeat = true) {
                sendKey(session, modifiers, KeyEvent.KEYCODE_DPAD_LEFT)
            }
            KeyCap("↓", colors, description = stringResource(R.string.terminal_key_down), repeat = true) {
                sendKey(session, modifiers, KeyEvent.KEYCODE_DPAD_DOWN)
            }
            KeyCap("↑", colors, description = stringResource(R.string.terminal_key_up), repeat = true) {
                sendKey(session, modifiers, KeyEvent.KEYCODE_DPAD_UP)
            }
            KeyCap("→", colors, description = stringResource(R.string.terminal_key_right), repeat = true) {
                sendKey(session, modifiers, KeyEvent.KEYCODE_DPAD_RIGHT)
            }
            KeyCap(null, colors, description = stringResource(R.string.terminal_key_hide_keyboard)) { hideKeyboard(session) }
        }
    }
}

private class KeyColors(val bar: Color, val key: Color, val text: Color, val accent: Color)

/**
 * One key of the row. A press acts at once (keys are pressed quickly in a row, so no waiting for
 * a tap to be confirmed); with [repeat], holding it repeats like a keyboard's arrow. Pressing
 * does not take focus, so the keyboard stays up. [label] null draws the hide-keyboard icon.
 */
@Composable
private fun KeyCap(
    label: String?,
    colors: KeyColors,
    active: Boolean = false,
    description: String? = null,
    repeat: Boolean = false,
    onPress: () -> Unit,
) {
    val action by rememberUpdatedState(onPress)
    var pressed by remember { mutableStateOf(false) }
    val ground = when {
        active -> colors.accent
        pressed -> colors.accent.copy(alpha = 0.35f)
        else -> colors.key
    }
    Box(
        Modifier
            .height(34.dp)
            .widthIn(min = 38.dp)
            .clip(RoundedCornerShape(6.dp))
            .background(ground)
            .semantics {
                role = Role.Button
                if (description != null) contentDescription = description
                if (active) selected = true
                onClick { action(); true }
            }
            .pointerInput(repeat) {
                detectTapGestures(onPress = {
                    pressed = true
                    coroutineScope {
                        action()
                        val repeater = if (repeat) {
                            launch {
                                delay(400)
                                while (isActive) {
                                    action()
                                    delay(70)
                                }
                            }
                        } else {
                            null
                        }
                        tryAwaitRelease()
                        repeater?.cancel()
                    }
                    pressed = false
                })
            }
            .padding(horizontal = 10.dp),
        contentAlignment = Alignment.Center,
    ) {
        val tint = if (active) Color.White else colors.text
        if (label == null) {
            Icon(Icons.Filled.KeyboardHide, contentDescription = null, tint = tint)
        } else {
            Text(label, color = tint, fontSize = 15.sp, fontFamily = FontFamily.Monospace, maxLines = 1)
        }
    }
}
