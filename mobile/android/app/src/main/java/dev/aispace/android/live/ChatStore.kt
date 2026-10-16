package dev.aispace.android.live

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.aispace.android.R
import dev.aispace.android.core.ChatActivity
import dev.aispace.android.core.ChatReply
import dev.aispace.android.core.ChatSessionInfo
import dev.aispace.android.core.ChatStored
import dev.aispace.android.core.Hub
import dev.aispace.android.core.SSEMessage
import dev.aispace.android.core.SpaceApi
import dev.aispace.android.core.SpaceApiError
import dev.aispace.android.core.SpacePath
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.IOException
import java.util.UUID

/**
 * One agent's conversation. A turn is a background run on the Space (docs/panel.md#chat): the
 * reply is followed over its event stream and survives the page closing; a stream that breaks
 * is picked up again from the last event seen.
 *
 * Kept by the app model while the app runs, so its [scope] is the app's (main thread); state is
 * Compose snapshot state, and the field's text a [MutableStateFlow] so a link can fill it.
 */
class ChatStore(val api: SpaceApi, val base: String, private val scope: CoroutineScope) {
    data class Bubble(
        val isUser: Boolean,
        val text: String,
        val tools: List<String> = emptyList(),
        val activity: ChatActivity? = null,
        val id: UUID = UUID.randomUUID(),
    )

    val draft = MutableStateFlow("")

    var bubbles by mutableStateOf<List<Bubble>>(emptyList())
        private set
    var isRunning by mutableStateOf(false)
        private set
    var sessions by mutableStateOf<List<ChatSessionInfo>>(emptyList())
        private set
    var error by mutableStateOf<String?>(null)
        private set

    private var sessionID: String? = null
    private var runID: String? = null
    private var turn: Job? = null
    private var history: Job? = null
    // Sign-out invalidates every request; selection changes only invalidate history loads.
    private var generation = 0
    private var selection = 0
    var isOpening by mutableStateOf(false)
        private set

    val canSend: Boolean get() = !isRunning && !isOpening && draft.value.trim().isNotEmpty()

    suspend fun loadSessions() {
        val generation = this.generation
        val data = try {
            api.text("$base/sessions")
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return
        }
        if (generation != this.generation) return
        sessions = try { Hub.rows("sessions", data, ChatSessionInfo) } catch (e: Exception) { emptyList() }
    }

    fun newChat() {
        if (isRunning) return
        selection += 1
        history?.cancel()
        history = null
        isOpening = false
        sessionID = null
        bubbles = emptyList()
        error = null
    }

    /** Shows a stored conversation; the next message continues it. */
    suspend fun open(session: ChatSessionInfo) = coroutineScope {
        if (isRunning) return@coroutineScope
        history?.cancel()
        val selected = ++selection
        val generation = this@ChatStore.generation
        history = currentCoroutineContext()[Job]
        isOpening = true
        fun current() = selected == selection && generation == this@ChatStore.generation
        try {
            val stored = Hub.rows("messages", api.text("$base/sessions/${SpacePath.escape(session.sid)}"), ChatStored)
            if (!current()) return@coroutineScope
            bubbles = stored.mapNotNull { m -> if (m.text.isNullOrEmpty()) null else Bubble(isUser = m.role == "user", text = m.text) }
            sessionID = session.sid
            error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (current()) error = HubStore.message(e)
        } finally {
            if (current()) {
                isOpening = false
                history = null
            }
        }
    }

    fun send() {
        val text = draft.value.trim()
        if (!canSend) return
        draft.value = ""
        error = null
        bubbles = bubbles + Bubble(isUser = true, text = text) + Bubble(isUser = false, text = "", activity = ChatActivity.Starting)
        val index = bubbles.size - 1
        isRunning = true
        runID = null
        val generation = this.generation
        turn = scope.launch { follow(text, index, generation) }
    }

    private suspend fun follow(text: String, index: Int, generation: Int) {
        var reply = ChatReply()
        var lastSeq = 0
        var tries = 0
        val body = JSONObject().put("message", text)
        sessionID?.let { body.put("sessionId", it) }
        fun show() {
            if (generation != this.generation) return
            val list = bubbles
            if (index !in list.indices) return
            val shown = if (reply.stopped) {
                listOf(reply.text, HubText.get(R.string.chat_stopped)).filter { it.isNotEmpty() }.joinToString("\n\n")
            } else {
                reply.text
            }
            bubbles = list.toMutableList().also { it[index] = it[index].copy(text = shown, tools = reply.tools, activity = reply.activity) }
        }
        try {
            val first = api.events("POST", "$base/chat", body)
            runID = first.runId
            var stream: Flow<SSEMessage>? = first.messages
            while (!reply.finished) {
                try {
                    if (stream == null) {
                        val run = runID
                        if (run == null || tries >= RECONNECTS) {
                            reply = reply.copy(note = HubText.get(R.string.chat_connection_lost))
                            break
                        }
                        reply = reply.copy(activity = ChatActivity.Reconnecting)
                        show()
                        delay(1000L shl tries)
                        tries += 1
                        stream = api.events("GET", "$base/runs/${SpacePath.escape(run)}/events?after=$lastSeq").messages
                    }
                    stream.first { message ->
                        message.id?.let { lastSeq = it }
                        reply = reply.applying(message.data)
                        show()
                        reply.finished
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    // Retry a broken stream or a transient failure opening its replacement.
                    // Never repeat the POST: the Space may already be executing that turn.
                    val transient = e is IOException || e is NoSuchElementException ||
                        (e is SpaceApiError.Http && (e.code == 408 || e.code == 429 || e.code in 500..599))
                    if (!transient) throw e
                }
                stream = null
            }
        } catch (e: CancellationException) {
            // Cancelled (the Space was removed): end the turn as it stands, then stop.
            finishTurn(reply, generation)
            throw e
        } catch (e: Exception) {
            reply = reply.copy(note = "⚠️ " + HubStore.message(e))
        }
        reply = reply.copy(activity = null)
        show()
        finishTurn(reply, generation)
    }

    private fun finishTurn(reply: ChatReply, generation: Int) {
        if (generation != this.generation) return
        sessionID = reply.sessionID ?: sessionID
        runID = null
        isRunning = false
    }

    /** Stops the run on the Space; the stream then ends by itself. */
    fun stop() {
        val run = runID ?: return
        scope.launch {
            try {
                api.send("POST", "$base/runs/${SpacePath.escape(run)}/stop", JSONObject())
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // As the panel: a stop that did not reach the Space leaves the run to end on its own.
            }
        }
    }

    /** Clears this phone's conversation on sign-out or removal; the server run itself goes on. */
    fun cancel() {
        generation += 1
        selection += 1
        history?.cancel()
        history = null
        turn?.cancel()
        turn = null
        isOpening = false
        isRunning = false
        sessionID = null
        runID = null
        draft.value = ""
        bubbles = emptyList()
        sessions = emptyList()
        error = null
    }

    private companion object {
        const val RECONNECTS = 5
    }
}
