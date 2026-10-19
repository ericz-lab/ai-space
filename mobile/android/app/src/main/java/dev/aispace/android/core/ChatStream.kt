package dev.aispace.android.core

import org.json.JSONArray
import org.json.JSONObject

data class SSEMessage(val id: Int?, val data: String)

/**
 * Reads the lines of a server-sent event stream as src/space/agents/runtime.ts writes them:
 * an optional `id: <seq>` line, then one `data:` line per event; `:` lines are keep-alives.
 * One parser per stream; not thread-safe.
 */
class SSEParser {
    private var id: Int? = null

    fun feed(line: String): SSEMessage? {
        if (line.isEmpty()) {
            id = null
            return null
        }
        if (line.startsWith(":")) return null
        val colon = line.indexOf(':')
        val field = if (colon < 0) line else line.substring(0, colon)
        var value = if (colon < 0) "" else line.substring(colon + 1)
        if (value.startsWith(" ")) value = value.substring(1)
        return when (field) {
            "id" -> {
                id = value.toIntOrNull()
                null
            }
            "data" -> {
                val message = SSEMessage(id, value)
                id = null
                message
            }
            else -> null
        }
    }
}

/** What a chat turn shows while it runs. */
sealed class ChatActivity {
    data object Starting : ChatActivity()
    data object Reconnecting : ChatActivity()
    data class Thinking(val model: String) : ChatActivity()
    data class Running(val tool: String) : ChatActivity()
}

enum class ChatApprovalState { Waiting, Allowed, Denied, Cancelled }

/**
 * An action the agent waits on (docs/runtimes.md#live-chat): what it wants to do and why. The
 * person's answer travels through the run, not through the reply.
 */
data class ChatApproval(
    val id: String,
    val tool: String,
    val title: String,
    val detail: String = "",
    val state: ChatApprovalState = ChatApprovalState.Waiting,
)

/**
 * One chat turn's reply, built from the run's events the way the panel's Chat.tsx reads them:
 * Claude-style stream-json, which every runtime adapter emits, followed by `error` and `done`.
 * Immutable: [applying] returns the reply with one more event in it.
 */
data class ChatReply(
    val sessionID: String? = null,
    val finishedText: String = "",
    val streaming: String = "",
    val tools: List<String> = emptyList(),
    val activity: ChatActivity? = ChatActivity.Starting,
    val note: String? = null,
    val stopped: Boolean = false,
    val finished: Boolean = false,
    val approvals: List<ChatApproval> = emptyList(),
    /** Messages the agent has read that the person added while the turn ran, one per `steer` event. */
    val consumedSteers: List<String> = emptyList(),
    /** All messages the person added to the turn, for the reply to show after the text. */
    val steers: List<String> = emptyList(),
    private val seenTools: Set<String> = emptySet(),
) {
    val text: String
        get() {
            val body = finishedText + (if (streaming.isEmpty()) "" else (if (finishedText.isEmpty()) "" else "\n\n") + streaming)
            val note = note ?: return body
            return if (body.isEmpty()) note else body + "\n\n" + note
        }

    /** The reply with one `data:` line of the run's stream applied; a line that is not an event changes nothing. */
    fun applying(line: String): ChatReply {
        val ev = Json.obj(line) ?: return this
        val type = ev.str("type") ?: return this
        return when (type) {
            "approval_request" -> {
                val id = ev.str("id") ?: return this
                if (approvals.any { it.id == id }) this
                else copy(
                    approvals = approvals + ChatApproval(
                        id = id,
                        tool = ev.str("tool") ?: "tool",
                        title = ev.str("title") ?: "",
                        detail = ev.str("detail") ?: "",
                    ),
                    // The turn is not running anything now; it waits for the person's answer.
                    activity = null,
                )
            }
            "approval_resolved" -> {
                val id = ev.str("id") ?: return this
                val state = when (ev.str("decision")) {
                    "allow" -> ChatApprovalState.Allowed
                    "deny" -> ChatApprovalState.Denied
                    else -> ChatApprovalState.Cancelled
                }
                copy(approvals = approvals.map { if (it.id == id) it.copy(state = state) else it })
            }
            "steer" -> {
                val text = ev.str("text") ?: ""
                copy(consumedSteers = consumedSteers + text, steers = steers + text)
            }
            "system" -> if (ev.str("subtype") == "init") {
                copy(sessionID = ev.str("session_id") ?: sessionID, activity = ChatActivity.Thinking(ev.str("model") ?: ""))
            } else this
            "stream_event" -> {
                val delta = ev.obj("event")?.obj("delta")
                val t = delta?.str("text")
                if (delta?.str("type") == "text_delta" && t != null) copy(streaming = streaming + t, activity = null) else this
            }
            "assistant" -> {
                val blocks = blocks(ev.obj("message")?.arr("content"))
                var next = this
                val text = blocks.filter { it.str("type") == "text" }.mapNotNull { it.str("text") }.joinToString("")
                if (text.isNotEmpty()) {
                    next = next.copy(
                        finishedText = next.finishedText + (if (next.finishedText.isEmpty()) "" else "\n\n") + text,
                        streaming = "",
                        activity = null,
                    )
                }
                for (b in blocks) {
                    if (b.str("type") != "tool_use") continue
                    val id = b.str("id") ?: continue
                    if (id in next.seenTools) continue
                    val name = b.str("name") ?: "tool"
                    next = next.copy(seenTools = next.seenTools + id, tools = next.tools + name, activity = ChatActivity.Running(name))
                }
                next
            }
            "result" -> {
                var next = copy(sessionID = ev.str("session_id") ?: sessionID)
                if (ev.bool("is_error") == true && finishedText.isEmpty() && streaming.isEmpty()) {
                    next = next.copy(note = describe(ev.opt("result") ?: ev.opt("subtype") ?: "error"))
                }
                next
            }
            "error" -> if (ev.str("status") == "stopped") {
                copy(stopped = true)
            } else {
                copy(note = "⚠️ " + describe(ev.opt("error") ?: "error"))
            }
            "done" -> copy(finished = true, activity = null)
            else -> this
        }
    }

    /** A turn that ended: an approval nobody answered is not left waiting. */
    fun settled(): ChatReply = copy(
        approvals = approvals.map { if (it.state == ChatApprovalState.Waiting) it.copy(state = ChatApprovalState.Cancelled) else it },
    )

    private companion object {
        fun blocks(a: JSONArray?): List<JSONObject> {
            if (a == null) return emptyList()
            val out = ArrayList<JSONObject>()
            for (i in 0 until a.length()) out.add(a.opt(i) as? JSONObject ?: return emptyList())
            return out
        }

        /** A value as Swift's `String(describing:)` writes it: a string bare, anything else as JSON. */
        fun describe(v: Any): String = when (v) {
            is String -> v
            JSONObject.NULL -> "<null>"
            else -> v.toString()
        }
    }
}
