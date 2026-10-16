package dev.aispace.android.live

import android.os.Handler
import android.os.Looper
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.aispace.android.R
import dev.aispace.android.core.SpaceApi
import dev.aispace.android.core.SpaceApiError
import dev.aispace.android.core.TerminalControl
import dev.aispace.android.core.TerminalMachine
import dev.aispace.android.core.TerminalNotice
import dev.aispace.android.core.TerminalRoute
import dev.aispace.android.core.TerminalTicket
import dev.aispace.android.terminal.RemoteTerminalSession
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.net.URI
import java.util.UUID

/**
 * One shell on one machine, over the Space's terminal routes (docs/terminal.md): a request for a
 * one-time ticket, then a socket. Binary frames are bytes each way; text frames are the Space's
 * control messages and this side's resizes. A socket that drops is not picked up again: the
 * Space hangs the shell up when its client leaves.
 *
 * Main thread only; the socket's callbacks are posted there in the order they come.
 */
class TerminalSession(private val api: SpaceApi, val machine: TerminalMachine, private val scope: CoroutineScope) {
    enum class State { connecting, open, closed }

    var state by mutableStateOf(State.connecting)
        private set

    /** Bytes from the shell, and the lines this side writes about the session. */
    var onOutput: (ByteArray) -> Unit = {}

    /** The machine asked for its passphrase, or refused the one given. */
    var onPassphrase: (String) -> Unit = {}
    var onClosed: () -> Unit = {}

    /** The shell was asked for (at the window's first size); a session starts once. */
    var started = false
        private set

    private var socket: WebSocket? = null
    private var job: Job? = null
    private var size: Pair<Int, Int>? = null
    private val main = Handler(Looper.getMainLooper())

    /** Opens the shell at this window size. Once: a session that ended stays ended. */
    fun start(cols: Int, rows: Int, passphrase: String?) {
        if (started) return
        started = true
        size = cols to rows
        job = scope.launch { run(passphrase) }
    }

    fun send(bytes: ByteArray) {
        val s = socket ?: return
        if (state != State.open) return
        s.send(bytes.toByteString())
    }

    fun resize(cols: Int, rows: Int) {
        if (size == cols to rows) return
        size = cols to rows
        val s = socket ?: return
        if (state != State.open) return
        s.send(TerminalRoute.resize(cols, rows))
    }

    /** Leaves the session; the Space hangs the shell up. */
    fun close() {
        socket?.close(1000, null)
        job?.cancel()
        finish()
    }

    private suspend fun run(passphrase: String?) {
        val (cols, rows) = size ?: (80 to 24)
        val ticket: String = try {
            val headers = passphrase?.let { mapOf(TerminalRoute.passphraseHeader to it) } ?: emptyMap()
            val answer = api.answer("POST", TerminalRoute.sessions(machine), JSONObject().put("cols", cols).put("rows", rows), headers)
            when (val t = TerminalTicket.read(answer.status, answer.body)) {
                is TerminalTicket.Ticket -> t.ticket
                is TerminalTicket.Passphrase -> {
                    onPassphrase(t.message)
                    fail(t.message)
                    return
                }
                is TerminalTicket.SignIn -> {
                    fail(HubStore.message(SpaceApiError.AuthenticationRequired))
                    return
                }
                is TerminalTicket.Refused -> {
                    fail(t.message)
                    return
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            fail(HubStore.message(e))
            return
        }
        val url: URI? = TerminalRoute.socket(machine, ticket, api.base)
        if (state != State.connecting || url == null) {
            finish()
            return
        }
        socket = api.socket(url, Listener())
    }

    /** The socket's events, handed to the main thread. */
    private inner class Listener : WebSocketListener() {
        /** The first frame is the Space's `ready`; until it comes the socket may still be refused. */
        private var opened = false

        override fun onMessage(webSocket: WebSocket, text: String) {
            main.post {
                if (!current(webSocket)) return@post
                firstFrame(webSocket)
                control(text)
            }
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            val data = bytes.toByteArray()
            main.post {
                if (!current(webSocket)) return@post
                firstFrame(webSocket)
                onOutput(data)
            }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            // Answer the Space's close so the socket finishes.
            webSocket.close(1000, null)
            main.post { if (current(webSocket)) ended(code, reason, null, opened) }
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            main.post { if (current(webSocket)) ended(code, reason, null, opened) }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            main.post { if (current(webSocket)) ended(null, "", t, opened) }
        }

        private fun current(webSocket: WebSocket): Boolean = socket === webSocket && state != State.closed

        private fun firstFrame(webSocket: WebSocket) {
            if (opened) return
            opened = true
            state = State.open
            // The window may have changed while the ticket was on its way.
            size?.let { (c, r) -> webSocket.send(TerminalRoute.resize(c, r)) }
        }
    }

    private fun control(text: String) {
        when (val c = TerminalControl.read(text)) {
            is TerminalControl.Exit -> {
                val how = c.code?.let { HubText.get(R.string.terminal_exited_code, it) } ?: HubText.get(R.string.terminal_exited_signal)
                write(TerminalNotice.dim(how) + (c.detail?.let { TerminalNotice.red(it) } ?: ""))
            }
            is TerminalControl.Error -> write(TerminalNotice.red(c.message))
            is TerminalControl.Closed -> write(
                TerminalNotice.dim(
                    when (c.reason) {
                        "idle" -> HubText.get(R.string.terminal_closed_idle)
                        "killed" -> HubText.get(R.string.terminal_closed_killed)
                        "shutdown" -> HubText.get(R.string.terminal_closed_shutdown)
                        else -> HubText.get(R.string.terminal_closed)
                    },
                ),
            )
            is TerminalControl.Ready, null -> {}
        }
    }

    /**
     * The socket is gone: say why when the Space did not already. [code] is null when no close
     * frame came (iOS's `.invalid` close code).
     */
    private fun ended(code: Int?, reason: String, error: Throwable?, opened: Boolean) {
        if (code == null) {
            write(
                if (opened) TerminalNotice.dim(HubText.get(R.string.terminal_connection_lost))
                else TerminalNotice.red(error?.let { HubStore.message(it) } ?: HubText.get(R.string.terminal_connection_lost)),
            )
        } else if (code != 1000 && reason.isNotEmpty() && reason !in TerminalNotice.knownReasons) {
            write(TerminalNotice.dim(reason))
        }
        finish()
    }

    private fun fail(message: String) {
        write(TerminalNotice.red(message))
        finish()
    }

    private fun finish() {
        if (state == State.closed) return
        state = State.closed
        socket = null
        onClosed()
    }

    private fun write(text: String) {
        onOutput(text.toByteArray(Charsets.UTF_8))
    }
}

/**
 * One session's terminal on screen: the emulator with its scrollback, kept while the session's
 * tab exists, and the wiring between it and the session's socket. Shown with `TerminalSurface`.
 */
class TerminalTab(
    val title: String,
    val session: TerminalSession,
    passphrase: String?,
    /** Where an address the terminal asks to open goes (the system browser). */
    val openLink: (URI) -> Unit,
) {
    val id: UUID = UUID.randomUUID()

    /**
     * The shell opens at the size the view really has: the emulator reports it after its first
     * layout, and every later change goes to the Space as a resize.
     */
    val screen = RemoteTerminalSession(
        onInput = { bytes -> session.send(bytes) },
        onResize = { cols, rows ->
            if (!session.started) session.start(cols, rows, passphrase) else session.resize(cols, rows)
        },
    )

    init {
        session.onOutput = { bytes -> screen.feed(bytes) }
    }

    fun focus() = screen.focus()

    /** Types a line into the shell, as the keyboard would. */
    fun type(line: String) = session.send((line + "\r").toByteArray(Charsets.UTF_8))
}
