package dev.aispace.android.live

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.aispace.android.R
import dev.aispace.android.core.ChatActivity
import dev.aispace.android.core.ChatApproval
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
        /// An approval waiting on the person, or a message they added while the turn ran.
        val approvals: List<ChatApproval> = emptyList(),
        /// Messages the person added while the turn ran, as the reply shows them.
        val steers: List<String> = emptyList(),
        /// Messages added to the running turn that the agent has not read yet.
        val pending: List<String> = emptyList(),
        val live: Boolean = false,
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

    /// Turns written while one runs that it could not take, each tied to the message it answers so
    /// its reply is inserted right after that message.
    private data class QueuedTurn(val bubble: UUID, val text: String)
    private var queue = mutableListOf<QueuedTurn>()
    private var pending = emptyList<String>()
    private var steersSeen = 0
    private var stopRequested = false

    val canSend: Boolean get() = !isOpening && draft.value.trim().isNotEmpty()

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
        if (isOpening || text.isEmpty()) return
        draft.value = ""
        error = null
        // A message written while a turn runs joins that turn (docs/runtimes.md#live-chat); a turn
        // that cannot take it is queued and sent next.
        if (isRunning) {
            if (queue.isNotEmpty() || stopRequested) enqueue(text) else steer(text)
            return
        }
        val bubble = Bubble(isUser = true, text = text)
        bubbles = bubbles + bubble
        start(QueuedTurn(bubble.id, text))
    }

    /** The person's answer to one of the running turn's approvals; null once it reached the Space. */
    suspend fun answer(requestID: String, allow: Boolean): String? {
        val run = runID ?: return HubText.get(R.string.chat_no_turn)
        return try {
            api.send("POST", "$base/runs/${SpacePath.escape(run)}/approvals/${SpacePath.escape(requestID)}", JSONObject().put("decision", if (allow) "allow" else "deny"))
            null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            HubText.get(R.string.chat_answer_failed, HubStore.message(e))
        }
    }

    /** Hands the message to the running turn; when that is refused it becomes the next turn. */
    private fun steer(text: String) {
        val run = runID
        if (run == null) {
            enqueue(text)
            drain()
            return
        }
        val selection = this.selection
        markPending(text, true)
        scope.launch {
            try {
                api.send("POST", "$base/runs/${SpacePath.escape(run)}/steer", JSONObject().put("message", text))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // The person moved to another thread while the answer was on its way: the message
                // belongs to the one that is gone, not to the new one.
                if (selection != this@ChatStore.selection) return@launch
                markPending(text, false)
                enqueue(text)
                drain()
            }
        }
    }

    private fun markPending(text: String, add: Boolean) {
        if (add) {
            pending = pending + text
        } else {
            val at = pending.lastIndexOf(text)
            if (at >= 0) pending = pending.filterIndexed { i, _ -> i != at }
        }
        val live = bubbles.indexOfLast { !it.isUser && it.live }
        if (live >= 0) bubbles = bubbles.toMutableList().also { it[live] = it[live].copy(pending = pending) }
    }

    /// The reply took one added message in: its text names it.
    private fun takePending(text: String) {
        val at = pending.indexOf(text)
        if (at >= 0) pending = pending.filterIndexed { i, _ -> i != at }
    }

    private fun enqueue(text: String) {
        val bubble = Bubble(isUser = true, text = text)
        bubbles = bubbles + bubble
        queue.add(QueuedTurn(bubble.id, text))
    }

    /// Starts the next waiting turn when nothing runs.
    private fun drain() {
        if (isRunning) return
        val next = if (queue.isEmpty()) null else queue.removeAt(0)
        if (next != null) start(next)
    }

    private fun start(turn: QueuedTurn) {
        // A queued turn's reply belongs right after its own message: with two waiting, appending it
        // at the end would separate each message from the turn that answers it.
        val list = bubbles.toMutableList()
        val at = list.indexOfFirst { it.id == turn.bubble }
        val index = if (at >= 0) at + 1 else list.size
        list.add(index, Bubble(isUser = false, text = "", activity = ChatActivity.Starting, live = true))
        bubbles = list
        isRunning = true
        stopRequested = false
        runID = null
        pending = emptyList()
        steersSeen = 0
        val generation = this.generation
        this.turn = scope.launch { follow(turn, index, generation) }
    }

    private suspend fun follow(turn: QueuedTurn, index: Int, generation: Int) {
        var reply = ChatReply()
        var lastSeq = 0
        var tries = 0
        val body = JSONObject().put("message", turn.text).put("interactive", true)
        sessionID?.let { body.put("sessionId", it) }
        fun entered(): String = if (reply.stopped) {
            listOf(reply.text, HubText.get(R.string.chat_stopped)).filter { it.isNotEmpty() }.joinToString("\n\n")
        } else {
            reply.text
        }
        fun show() {
            if (generation != this.generation) return
            val list = bubbles
            if (index !in list.indices) return
            while (steersSeen < reply.consumedSteers.size) {
                takePending(reply.consumedSteers[steersSeen])
                steersSeen += 1
            }
            bubbles = list.toMutableList().also {
                it[index] = it[index].copy(
                    text = entered(),
                    tools = reply.tools,
                    activity = reply.activity,
                    approvals = reply.approvals,
                    steers = reply.steers,
                    pending = pending,
                )
            }
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
            finishTurn(reply, generation, index)
            throw e
        } catch (e: Exception) {
            reply = reply.copy(note = "⚠️ " + HubStore.message(e))
        }
        reply = reply.settled().copy(activity = null)
        show()
        finishTurn(reply, generation, index)
    }

    private fun finishTurn(reply: ChatReply, generation: Int, index: Int) {
        if (generation != this.generation) return
        sessionID = reply.sessionID ?: sessionID
        runID = null
        pending = emptyList()
        if (index in bubbles.indices) {
            val shown = if (reply.stopped) {
                listOf(reply.text, HubText.get(R.string.chat_stopped)).filter { it.isNotEmpty() }.joinToString("\n\n")
            } else {
                reply.text
            }
            bubbles = bubbles.toMutableList().also {
                it[index] = it[index].copy(
                    text = shown,
                    tools = reply.tools,
                    approvals = reply.approvals,
                    steers = reply.steers,
                    pending = emptyList(),
                    activity = null,
                    live = false,
                )
            }
        }
        // A message that could not join this turn goes now, in the order it was written.
        val next = if (queue.isEmpty()) null else queue.removeAt(0)
        if (next != null) start(next) else {
            stopRequested = false
            isRunning = false
        }
    }

    /** Stops the run on the Space; the stream then ends by itself. */
    fun stop() {
        stopRequested = true
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
        queue.clear()
        pending = emptyList()
        stopRequested = false
        draft.value = ""
        bubbles = emptyList()
        sessions = emptyList()
        error = null
    }

    private companion object {
        const val RECONNECTS = 5
    }
}
