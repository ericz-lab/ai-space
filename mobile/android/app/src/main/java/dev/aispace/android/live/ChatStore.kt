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
import dev.aispace.android.core.SpacePath
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import org.json.JSONObject
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

    val canSend: Boolean get() = !isRunning && draft.value.trim().isNotEmpty()

    suspend fun loadSessions() {
        val data = try {
            api.text("$base/sessions")
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return
        }
        sessions = try { Hub.rows("sessions", data, ChatSessionInfo) } catch (e: Exception) { emptyList() }
    }

    fun newChat() {
        if (isRunning) return
        sessionID = null
        bubbles = emptyList()
        error = null
    }

    /** Shows a stored conversation; the next message continues it. */
    suspend fun open(session: ChatSessionInfo) {
        if (isRunning) return
        try {
            val stored = Hub.rows("messages", api.text("$base/sessions/${SpacePath.escape(session.sid)}"), ChatStored)
            bubbles = stored.mapNotNull { m -> if (m.text.isNullOrEmpty()) null else Bubble(isUser = m.role == "user", text = m.text) }
            sessionID = session.sid
            error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = HubStore.message(e)
        }
    }

    fun send() {
        val text = draft.value.trim()
        if (text.isEmpty() || isRunning) return
        draft.value = ""
        error = null
        bubbles = bubbles + Bubble(isUser = true, text = text) + Bubble(isUser = false, text = "", activity = ChatActivity.Starting)
        val index = bubbles.size - 1
        isRunning = true
        runID = null
        turn = scope.launch { follow(text, index) }
    }

    private suspend fun follow(text: String, index: Int) {
        var reply = ChatReply()
        var lastSeq = 0
        var tries = 0
        val body = JSONObject().put("message", text)
        sessionID?.let { body.put("sessionId", it) }
        fun show() {
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
            var stream: Flow<SSEMessage> = first.messages
            while (!reply.finished) {
                try {
                    stream.first { message ->
                        message.id?.let { lastSeq = it }
                        reply = reply.applying(message.data)
                        show()
                        reply.finished
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    // The stream ended (NoSuchElementException) or broke: follow the run again below.
                }
                if (reply.finished) break
                // The stream ended without the run saying it was done: follow the run again.
                val run = runID
                if (run == null || tries >= RECONNECTS) {
                    reply = reply.copy(note = HubText.get(R.string.chat_connection_lost))
                    break
                }
                tries += 1
                reply = reply.copy(activity = ChatActivity.Reconnecting)
                show()
                delay(1000)
                stream = api.events("GET", "$base/runs/${SpacePath.escape(run)}/events?after=$lastSeq").messages
            }
        } catch (e: CancellationException) {
            // Cancelled (the Space was removed): end the turn as it stands, then stop.
            finishTurn(reply)
            throw e
        } catch (e: Exception) {
            reply = reply.copy(note = "⚠️ " + HubStore.message(e))
        }
        reply = reply.copy(activity = null)
        show()
        finishTurn(reply)
    }

    private fun finishTurn(reply: ChatReply) {
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

    /** Stops following the turn on this phone (the Space was signed out of or removed); the run itself goes on. */
    fun cancel() {
        turn?.cancel()
        turn = null
    }

    private companion object {
        const val RECONNECTS = 5
    }
}
