package dev.aispace.android.live

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.aispace.android.R
import dev.aispace.android.core.ChatActivity
import dev.aispace.android.core.ChatApproval
import dev.aispace.android.core.ChatImage
import dev.aispace.android.core.ChatReply
import dev.aispace.android.core.ChatSessionInfo
import dev.aispace.android.core.ChatStep
import dev.aispace.android.core.ChatStepKind
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
class ChatStore(
    val api: SpaceApi,
    val base: String,
    private val scope: CoroutineScope,
    /** A turn ended: what the agent did (an app it installed) may have changed the catalogue. */
    private val onSettled: () -> Unit = {},
) {
    data class Bubble(
        val isUser: Boolean,
        /** What the agent wrote with any note after it, or the person's message. */
        val text: String,
        val tools: List<String> = emptyList(),
        val activity: ChatActivity? = null,
        /**
         * The reply's work in order: text, tool calls, approvals and questions, messages the person
         * added while the turn ran.
         */
        val steps: List<ChatStep> = emptyList(),
        /** How the turn ended when that is not the agent's words: an error, or that it was stopped. */
        val note: String? = null,
        /** Messages added to the running turn that the agent has not read yet. */
        val pending: List<String> = emptyList(),
        /** The images the person sent with the message. */
        val images: List<ChatImage> = emptyList(),
        val live: Boolean = false,
        /** A reply restored from a past session's transcript: its runs of calls open folded. */
        val historic: Boolean = false,
        val id: UUID = UUID.randomUUID(),
    ) {
        val approvals: List<ChatApproval> get() = steps.mapNotNull { it.approval }
        val steers: List<String> get() = steps.filter { it.kind == ChatStepKind.Steer }.map { it.text }
    }

    val draft = MutableStateFlow("")

    var bubbles by mutableStateOf<List<Bubble>>(emptyList())
        private set
    var isRunning by mutableStateOf(false)
        private set
    var sessions by mutableStateOf<List<ChatSessionInfo>>(emptyList())
        private set
    var error by mutableStateOf<String?>(null)
        private set
    /** The images to go with the next message (docs/panel.md#agent-chat-images). */
    var images by mutableStateOf<List<ChatImage>>(emptyList())
    var imageError by mutableStateOf<String?>(null)

    /** The session the next message continues; null for a new conversation. */
    var sessionID by mutableStateOf<String?>(null)
        private set
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
    /// A turn started from universal search carries the shortcut intent it was matched to.
    private data class QueuedTurn(
        val bubble: UUID,
        val text: String,
        val images: List<ChatImage> = emptyList(),
        val intentID: String? = null,
        val timezone: String? = null,
    )
    private var queue = mutableListOf<QueuedTurn>()
    private var pending = emptyList<String>()
    private var steersSeen = 0
    private var stopRequested = false

    val canSend: Boolean get() = !isOpening && (draft.value.trim().isNotEmpty() || images.isNotEmpty())

    /** Adds an image to the next message, or says why it cannot go: four at most, 5 MB each, 10 MB together. */
    fun addImage(image: ChatImage): Boolean {
        val next = images + image
        if (!ChatImage.validate(next)) {
            imageError = HubText.get(R.string.chat_image_limits)
            return false
        }
        images = next
        imageError = null
        return true
    }

    fun removeImage(id: String) {
        images = images.filter { it.id != id }
        imageError = null
    }

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
        images = emptyList()
        imageError = null
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
            bubbles = stored.mapNotNull { m ->
                val user = m.role == "user"
                val work = if (user) emptyList() else m.work
                if (m.text.isNullOrEmpty() && work.isEmpty()) null
                else Bubble(isUser = user, text = m.text ?: "", tools = work.filter { it.kind == ChatStepKind.Tool }.map { it.title }, steps = work, historic = !user)
            }
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

    /**
     * Sends the field (and its images). [intentID] and [timezone] name the shortcut intent universal
     * search matched the text to (docs/shortcuts.md); such a turn keeps its own route, so while a
     * turn runs it is queued rather than added to it.
     */
    fun send(intentID: String? = null, timezone: String? = null) {
        val text = draft.value.trim()
        val images = this.images
        if (isOpening || (text.isEmpty() && images.isEmpty())) return
        draft.value = ""
        this.images = emptyList()
        imageError = null
        error = null
        val turn = QueuedTurn(UUID.randomUUID(), text, images, intentID, timezone)
        // A message written while a turn runs joins that turn (docs/runtimes.md#live-chat); a turn
        // that cannot take it is queued and sent next.
        if (isRunning) {
            if (intentID != null || queue.isNotEmpty() || stopRequested) enqueue(turn) else steer(turn)
            return
        }
        bubbles = bubbles + Bubble(isUser = true, text = text, images = images, id = turn.bubble)
        start(turn)
    }

    /**
     * The person's answer to one of the running turn's approvals; null once it reached the Space. A
     * question is answered with allow and its [answers]; without answers it is skipped.
     */
    suspend fun answer(requestID: String, allow: Boolean, answers: Map<String, List<String>>? = null): String? {
        val run = runID ?: return HubText.get(R.string.chat_no_turn)
        val body = JSONObject().put("decision", if (allow) "allow" else "deny")
        if (answers != null) {
            val map = JSONObject()
            for ((id, list) in answers) map.put(id, org.json.JSONArray(list))
            body.put("answers", map)
        }
        return try {
            api.send("POST", "$base/runs/${SpacePath.escape(run)}/approvals/${SpacePath.escape(requestID)}", body)
            null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            HubText.get(R.string.chat_answer_failed, HubStore.message(e))
        }
    }

    /** Hands the message to the running turn; when that is refused it becomes the next turn. */
    private fun steer(turn: QueuedTurn) {
        val run = runID
        if (run == null) {
            enqueue(turn)
            drain()
            return
        }
        val selection = this.selection
        // An image-only message is named by its count, as the panel does.
        val text = turn.text.ifEmpty { "🖼 ×${turn.images.size}" }
        markPending(text, true)
        scope.launch {
            try {
                val body = JSONObject().put("message", turn.text)
                if (turn.images.isNotEmpty()) body.put("images", ChatImage.array(turn.images))
                api.send("POST", "$base/runs/${SpacePath.escape(run)}/steer", body)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // The person moved to another thread while the answer was on its way: the message
                // belongs to the one that is gone, not to the new one.
                if (selection != this@ChatStore.selection) return@launch
                markPending(text, false)
                enqueue(turn)
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

    private fun enqueue(turn: QueuedTurn) {
        bubbles = bubbles + Bubble(isUser = true, text = turn.text, images = turn.images, id = turn.bubble)
        queue.add(turn)
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
        if (turn.images.isNotEmpty()) body.put("images", ChatImage.array(turn.images))
        turn.intentID?.let { body.put("intentId", it) }
        turn.timezone?.let { body.put("timezone", it) }
        sessionID?.let { body.put("sessionId", it) }
        fun entered(): String = shown(reply)
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
                    steps = reply.steps,
                    note = note(reply),
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
            bubbles = bubbles.toMutableList().also {
                it[index] = it[index].copy(
                    text = shown(reply),
                    tools = reply.tools,
                    steps = reply.steps,
                    note = note(reply),
                    pending = emptyList(),
                    activity = null,
                    live = false,
                )
            }
        }
        onSettled()
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
        images = emptyList()
        imageError = null
        bubbles = emptyList()
        sessions = emptyList()
        error = null
    }

    /** The reply as text: the agent's words, its note, and that it was stopped. */
    private fun shown(reply: ChatReply): String = if (reply.stopped) {
        listOf(reply.text, HubText.get(R.string.chat_stopped)).filter { it.isNotEmpty() }.joinToString("\n\n")
    } else {
        reply.text
    }

    /** What the reply says beside the agent's words, drawn after its steps. */
    private fun note(reply: ChatReply): String? =
        listOfNotNull(reply.note, if (reply.stopped) HubText.get(R.string.chat_stopped) else null).joinToString("\n\n").ifEmpty { null }

    private companion object {
        const val RECONNECTS = 5
    }
}
