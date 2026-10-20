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
 * A question the agent asks while its turn runs (an `approval_request` with `questions`,
 * docs/panel.md#chat): the person picks options or types an answer of their own.
 */
data class ChatQuestion(
    val id: String,
    val header: String = "",
    val question: String = "",
    val options: List<Option> = emptyList(),
    val multiSelect: Boolean = false,
) {
    data class Option(val label: String, val description: String = "")

    companion object : JsonReader<ChatQuestion> {
        override fun from(o: JSONObject): ChatQuestion? {
            val options = o.arr("options")?.let { a ->
                (0 until a.length()).mapNotNull { i ->
                    val option = a.opt(i) as? JSONObject ?: return@mapNotNull null
                    Option(option.str("label") ?: return@mapNotNull null, option.str("description") ?: "")
                }
            } ?: emptyList()
            return ChatQuestion(
                id = o.str("id") ?: return null,
                header = o.str("header") ?: "",
                question = o.str("question") ?: "",
                options = options,
                multiSelect = o.bool("multiSelect") == true,
            )
        }

        /** Question id → the chosen labels or the typed text, as `approval_resolved` reports them. */
        fun answers(o: JSONObject?): Map<String, List<String>>? {
            if (o == null) return null
            return o.keyList().associateWith { key -> o.strings(key) ?: emptyList() }
        }
    }
}

/**
 * An action the agent waits on (docs/runtimes.md#live-chat): what it wants to do and why, or the
 * questions it asks. The person's answer travels through the run, not through the reply.
 */
data class ChatApproval(
    val id: String,
    val tool: String,
    val title: String,
    val detail: String = "",
    val state: ChatApprovalState = ChatApprovalState.Waiting,
    val questions: List<ChatQuestion> = emptyList(),
    val answers: Map<String, List<String>> = emptyMap(),
)

enum class ChatStepKind { Text, Tool, Approval, Steer }

enum class ChatStepState { Running, Succeeded, Failed, Incomplete, Waiting, Allowed, Denied, Cancelled }

/**
 * Ordered, observable work in one turn (src/web/chat-steps.ts): the agent's text and its tool
 * calls as they happened, each call's ID stable from start to result. A live turn adds an action
 * the agent waits for (`title` the tool, `text` what it wants to do, `output` why) and a message the
 * person added while it ran.
 */
data class ChatStep(
    val id: String,
    val kind: ChatStepKind,
    val title: String = "",
    val text: String = "",
    val output: String = "",
    val state: ChatStepState = ChatStepState.Running,
    val questions: List<ChatQuestion> = emptyList(),
    val answers: Map<String, List<String>> = emptyMap(),
) {
    /** The approval this step stands for, with the request's own ID; null for any other kind. */
    val approval: ChatApproval?
        get() = if (kind != ChatStepKind.Approval) null else ChatApproval(
            id = id.removePrefix(APPROVAL),
            tool = title,
            title = text,
            detail = output,
            state = when (state) {
                ChatStepState.Allowed -> ChatApprovalState.Allowed
                ChatStepState.Denied -> ChatApprovalState.Denied
                ChatStepState.Waiting -> ChatApprovalState.Waiting
                else -> ChatApprovalState.Cancelled
            },
            questions = questions,
            answers = answers,
        )

    companion object {
        const val APPROVAL = "approval:"

        /** A restored transcript's ordered steps (`TranscriptStep` on the server), finished. */
        fun history(steps: JSONArray?): List<ChatStep> {
            if (steps == null) return emptyList()
            val out = ArrayList<ChatStep>()
            for (i in 0 until steps.length()) {
                val step = steps.opt(i) as? JSONObject ?: continue
                when (step.str("kind")) {
                    "text" -> out.add(ChatStep("history:$i", ChatStepKind.Text, text = step.str("text") ?: "", state = ChatStepState.Succeeded))
                    "tool" -> out.add(
                        ChatStep(
                            "history:$i", ChatStepKind.Tool,
                            title = step.str("name") ?: "tool",
                            text = step.str("input") ?: "",
                            output = step.str("output") ?: "",
                            state = if (step.bool("failed") == true) ChatStepState.Failed else ChatStepState.Succeeded,
                        ),
                    )
                }
            }
            return out
        }
    }
}

/** How a tool row is drawn: its symbol and its localized title (src/web/chat-steps.ts `toolVariant`). */
enum class ToolVariant { Bash, Read, Write, Edit, Search, Web, Code, Task, Plan, Other }

object ChatTools {
    private val variants = listOf(
        Regex("^(bash|pwsh|shell|exec|exec_command|command|command_execution|local_shell|run_command|terminal)$", RegexOption.IGNORE_CASE) to ToolVariant.Bash,
        Regex("^(read|read_file|read_image|view|notebookread|cat)$", RegexOption.IGNORE_CASE) to ToolVariant.Read,
        Regex("^(write|write_file|create_file)$", RegexOption.IGNORE_CASE) to ToolVariant.Write,
        Regex("^(edit|multiedit|notebookedit|apply_patch|patch|file_change|str_replace)$", RegexOption.IGNORE_CASE) to ToolVariant.Edit,
        Regex("^(grep|glob|ls|list|search|find|toolsearch|codebase_search)$", RegexOption.IGNORE_CASE) to ToolVariant.Search,
        Regex("^(webfetch|websearch|web_fetch|web_search|fetch|browse)$", RegexOption.IGNORE_CASE) to ToolVariant.Web,
        Regex("^(run_code|code)$", RegexOption.IGNORE_CASE) to ToolVariant.Code,
        Regex("^(task|agent|subagent|spawn_agent|send_message|wait_agent)$", RegexOption.IGNORE_CASE) to ToolVariant.Task,
        Regex("^(todowrite|todo_write|update_plan)$", RegexOption.IGNORE_CASE) to ToolVariant.Plan,
    )

    fun variant(name: String): ToolVariant {
        val bare = name.replace(Regex("^mcp__.*__"), "")
        return variants.firstOrNull { it.first.matches(bare) }?.second ?: ToolVariant.Other
    }

    /** An MCP tool's name as a person reads it: `mcp__github__search` → `github · search`. */
    fun title(name: String): String = name.removePrefix("mcp__").replace("__", " · ")

    /** The first non-empty line, so a long command or a patch still reads as one row. */
    fun summary(text: String): String = text.split("\n").map { it.trim() }.firstOrNull { it.isNotEmpty() } ?: ""

    /** Runs of consecutive tool calls become one group, so they stack as a tight list between paragraphs. */
    fun groups(steps: List<ChatStep>): List<List<ChatStep>> {
        val out = ArrayList<MutableList<ChatStep>>()
        for (step in steps) {
            val last = out.lastOrNull()
            if (step.kind == ChatStepKind.Tool && last != null && last.first().kind == ChatStepKind.Tool) last.add(step)
            else out.add(mutableListOf(step))
        }
        return out
    }
}

/**
 * An image the person adds to a turn: base64 bytes on the agent chat route, never a path
 * (docs/panel.md#agent-chat-images). Four at most, 5 MiB each, 10 MiB together.
 */
class ChatImage(val name: String, val mediaType: String, val bytes: ByteArray) {
    val id: String = java.util.UUID.randomUUID().toString()

    fun body(): JSONObject = JSONObject()
        .put("name", name.take(200))
        .put("mediaType", mediaType)
        .put("data", java.util.Base64.getEncoder().encodeToString(bytes))

    companion object {
        const val MAX_COUNT = 4
        const val MAX_BYTES = 5 * 1024 * 1024
        const val MAX_TOTAL = 10 * 1024 * 1024

        fun validate(images: List<ChatImage>): Boolean =
            images.size <= MAX_COUNT && images.all { it.bytes.isNotEmpty() && it.bytes.size <= MAX_BYTES } &&
                images.sumOf { it.bytes.size.toLong() } <= MAX_TOTAL

        /** The format the bytes' signature names: PNG, JPEG, GIF or WebP, as the Space checks them. */
        fun mediaType(bytes: ByteArray): String? {
            fun starts(vararg b: Int) = bytes.size >= b.size && b.indices.all { bytes[it] == b[it].toByte() }
            return when {
                starts(137, 80, 78, 71, 13, 10, 26, 10) -> "image/png"
                starts(255, 216, 255) -> "image/jpeg"
                starts('G'.code, 'I'.code, 'F'.code, '8'.code) -> "image/gif"
                bytes.size >= 12 && starts('R'.code, 'I'.code, 'F'.code, 'F'.code) &&
                    String(bytes, 8, 4, Charsets.US_ASCII) == "WEBP" -> "image/webp"
                else -> null
            }
        }

        fun array(images: List<ChatImage>): JSONArray = JSONArray().also { a -> images.forEach { a.put(it.body()) } }
    }
}

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
    /** The turn's text, tool calls, approvals and added messages, in the order they happened. */
    val steps: List<ChatStep> = emptyList(),
    /** Messages the agent has read that the person added while the turn ran, one per `steer` event. */
    val consumedSteers: List<String> = emptyList(),
    private val streamingStep: String? = null,
    private val serial: Int = 0,
) {
    /** What the agent wrote, without any note. */
    val body: String
        get() = finishedText + (if (streaming.isEmpty()) "" else (if (finishedText.isEmpty()) "" else "\n\n") + streaming)

    val text: String
        get() {
            val note = note ?: return body
            return if (body.isEmpty()) note else body + "\n\n" + note
        }

    /** The approvals and questions the agent asked for, in order. */
    val approvals: List<ChatApproval> get() = steps.mapNotNull { it.approval }

    /** All messages the person added to the turn. */
    val steers: List<String> get() = steps.filter { it.kind == ChatStepKind.Steer }.map { it.text }

    private fun recordText(text: String, final: Boolean): ChatReply {
        val at = streamingStep?.let { id -> steps.indexOfFirst { it.id == id } } ?: -1
        if (at >= 0) {
            val current = steps[at]
            val next = current.copy(
                text = if (final) text else current.text + text,
                state = if (final) ChatStepState.Succeeded else current.state,
            )
            return copy(steps = steps.replaced(at, next), streamingStep = if (final) null else streamingStep)
        }
        val id = "text:${serial + 1}"
        return copy(
            steps = steps + ChatStep(id, ChatStepKind.Text, text = text, state = if (final) ChatStepState.Succeeded else ChatStepState.Running),
            streamingStep = if (final) null else id,
            serial = serial + 1,
        )
    }

    /** The reply with one `data:` line of the run's stream applied; a line that is not an event changes nothing. */
    fun applying(line: String): ChatReply {
        val ev = Json.obj(line) ?: return this
        val type = ev.str("type") ?: return this
        return when (type) {
            "approval_request" -> {
                val id = ev.str("id") ?: return this
                if (steps.any { it.id == ChatStep.APPROVAL + id }) this
                else copy(
                    steps = steps + ChatStep(
                        id = ChatStep.APPROVAL + id,
                        kind = ChatStepKind.Approval,
                        title = ev.str("tool") ?: "tool",
                        text = ev.str("title") ?: "",
                        output = ev.str("detail") ?: "",
                        state = ChatStepState.Waiting,
                        questions = Json.lossy(ev.arr("questions"), ChatQuestion),
                    ),
                    // The turn is not running anything now; it waits for the person's answer.
                    activity = null,
                )
            }
            "approval_resolved" -> {
                val id = ev.str("id") ?: return this
                val at = steps.indexOfFirst { it.id == ChatStep.APPROVAL + id }
                if (at < 0) return this
                val state = when (ev.str("decision")) {
                    "allow" -> ChatStepState.Allowed
                    "deny" -> ChatStepState.Denied
                    else -> ChatStepState.Cancelled
                }
                val answers = ChatQuestion.answers(ev.obj("answers"))
                copy(steps = steps.replaced(at, steps[at].copy(state = state, answers = answers ?: steps[at].answers)))
            }
            "steer" -> {
                val text = ev.str("text") ?: ""
                copy(
                    consumedSteers = consumedSteers + text,
                    steps = steps + ChatStep("steer:${serial + 1}", ChatStepKind.Steer, text = text, state = ChatStepState.Succeeded),
                    serial = serial + 1,
                )
            }
            "system" -> if (ev.str("subtype") == "init") {
                copy(sessionID = ev.str("session_id") ?: sessionID, activity = ChatActivity.Thinking(ev.str("model") ?: ""))
            } else this
            "stream_event" -> {
                val delta = ev.obj("event")?.obj("delta")
                val t = delta?.str("text")
                if (delta?.str("type") == "text_delta" && t != null) recordText(t, final = false).copy(streaming = streaming + t, activity = null) else this
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
                    if (b.str("type") == "text") {
                        val t = b.str("text")
                        if (!t.isNullOrEmpty()) next = next.recordText(t, final = true)
                        continue
                    }
                    if (b.str("type") != "tool_use") continue
                    val id = b.str("id") ?: continue
                    val input = b.obj("input")
                    val hint = detail(input?.let { it.opt("command") ?: it.opt("file_path") ?: it.opt("path") ?: it.opt("query") ?: it.opt("url") } ?: b.opt("input"))
                    val at = next.steps.indexOfFirst { it.id == "tool:$id" }
                    if (at >= 0) {
                        if (hint.isNotEmpty()) next = next.copy(steps = next.steps.replaced(at, next.steps[at].copy(text = hint)))
                        continue
                    }
                    val name = b.str("name") ?: "tool"
                    next = next.copy(
                        tools = next.tools + name,
                        steps = next.steps + ChatStep("tool:$id", ChatStepKind.Tool, title = name, text = hint),
                        activity = ChatActivity.Running(name),
                    )
                }
                next
            }
            "user" -> {
                var next = this
                for (b in blocks(ev.obj("message")?.arr("content"))) {
                    if (b.str("type") != "tool_result") continue
                    val at = next.steps.indexOfFirst { it.id == "tool:" + (b.str("tool_use_id") ?: "") }
                    if (at >= 0) {
                        val state = if (b.bool("is_error") == true) ChatStepState.Failed else ChatStepState.Succeeded
                        next = next.copy(steps = next.steps.replaced(at, next.steps[at].copy(output = detail(b.opt("content")), state = state)))
                    }
                    val running = next.steps.lastOrNull { it.kind == ChatStepKind.Tool && it.state == ChatStepState.Running }
                    next = next.copy(activity = running?.let { ChatActivity.Running(it.title) } ?: ChatActivity.Thinking(""))
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
            "done" -> settled().copy(finished = true, activity = null)
            else -> this
        }
    }

    /**
     * A turn that ended: work still running is over (text done, a tool call without a result
     * incomplete), and an approval nobody answered is not left waiting.
     */
    fun settled(): ChatReply = copy(
        steps = steps.map {
            when (it.state) {
                ChatStepState.Running -> it.copy(state = if (it.kind == ChatStepKind.Tool) ChatStepState.Incomplete else ChatStepState.Succeeded)
                ChatStepState.Waiting -> it.copy(state = ChatStepState.Cancelled)
                else -> it
            }
        },
        streamingStep = null,
    )

    private companion object {
        fun blocks(a: JSONArray?): List<JSONObject> {
            if (a == null) return emptyList()
            val out = ArrayList<JSONObject>()
            for (i in 0 until a.length()) out.add(a.opt(i) as? JSONObject ?: return emptyList())
            return out
        }

        /** A tool's input or result as the rows show it: text as it is, anything else as JSON, 12,000 characters at most. */
        fun detail(value: Any?): String {
            if (value == null || value == JSONObject.NULL) return ""
            if (value is String) return value.take(12000)
            if (value is JSONArray) {
                val texts = (0 until value.length()).mapNotNull { i ->
                    (value.opt(i) as? JSONObject)?.takeIf { it.str("type") == "text" }?.str("text")
                }
                if (texts.isNotEmpty()) return texts.joinToString("\n").take(12000)
                return value.toString(2).take(12000)
            }
            if (value is JSONObject) return value.toString(2).take(12000)
            return value.toString().take(12000)
        }

        fun <T> List<T>.replaced(at: Int, value: T): List<T> = toMutableList().also { it[at] = value }

        /** A value as Swift's `String(describing:)` writes it: a string bare, anything else as JSON. */
        fun describe(v: Any): String = when (v) {
            is String -> v
            JSONObject.NULL -> "<null>"
            else -> v.toString()
        }
    }
}
