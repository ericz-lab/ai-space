package dev.aispace.android.live

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.aispace.android.core.Hub
import dev.aispace.android.core.JSONValue
import dev.aispace.android.core.JsonReader
import dev.aispace.android.core.ShortcutAction
import dev.aispace.android.core.ShortcutResolution
import dev.aispace.android.core.ShortcutResult
import dev.aispace.android.core.ShortcutRun
import dev.aispace.android.core.SpaceApi
import dev.aispace.android.core.SpaceApiError
import dev.aispace.android.core.obj
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.TimeZone
import java.util.UUID

/** The phone's time zone, which calendar inputs and the resolver read dates in (docs/time.md). */
internal fun zone(): String = TimeZone.getDefault().id

private val resultReader = JsonReader { o -> o.obj("result")?.let { ShortcutResult.from(it) } }
private val runReader = JsonReader { o -> o.obj("run")?.let { ShortcutRun.from(it) } }

/**
 * Universal search on the first screen (docs/shortcuts.md), the iPhone's OmniboxStore: what the
 * Space's resolver makes of the text, a calculation's or conversion's answer shown at once, and the
 * recent runs. Kept per Space by the app model; state is Compose snapshot state on the main thread.
 */
class OmniboxStore(
    val api: SpaceApi,
    /** Posts one request; the API's own call unless a test supplies the answers. */
    private val send: suspend (String, JSONObject) -> String = { path, body -> api.send("POST", path, body) },
) {
    var resolution by mutableStateOf<ShortcutResolution?>(null)
        private set
    var resolvedText by mutableStateOf("")
        private set
    var resolving by mutableStateOf(false)
        private set
    var preview by mutableStateOf<ShortcutResult?>(null)
        private set
    var error by mutableStateOf<String?>(null)

    private var generation = 0
    private val previews = HashMap<String, Pair<Long, ShortcutResult>>()

    fun clear() {
        generation += 1
        resolution = null
        resolvedText = ""
        preview = null
        error = null
        resolving = false
        previews.clear()
    }

    /** Resolves [text] after a short pause; a newer call, or the caller going away, drops the answer. */
    suspend fun resolve(text: String) {
        generation += 1
        val generation = generation
        resolution = null
        preview = null
        resolvedText = ""
        error = null
        resolving = text.isNotBlank()
        if (!resolving) return
        fun current() = generation == this.generation
        try {
            delay(180)
            val result = Hub.decode(send("/api/shortcuts/resolve", JSONObject().put("text", text).put("timezone", zone())), ShortcutResolution)
            if (!current()) return
            resolution = result
            resolvedText = text
            val intent = result.intents.firstOrNull() ?: return
            if (intent.kind != "calc" && intent.kind != "convert") return
            previews[text]?.let { (at, cached) ->
                if (System.currentTimeMillis() - at < 60_000) {
                    preview = cached
                    return
                }
            }
            val action = intent.action
            val body = JSONObject().put("action", action?.id ?: "space/calc").put("timezone", zone())
            if (intent.kind == "calc") body.put("args", JSONObject().put("expression", intent.expression ?: text))
            else if (action != null) body.put("args", action.payload(action.initial(intent.args ?: emptyMap())))
            action?.peer?.let { body.put("peer", it) }
            val answer = Hub.decode(send("/api/shortcuts/preview", body), resultReader)
            if (!current()) return
            preview = answer
            if (previews.size >= 64) previews.clear()
            previews[text] = System.currentTimeMillis() to answer
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (current()) error = HubStore.message(e)
        } finally {
            if (current()) resolving = false
        }
    }
}

/**
 * One action run from universal search: its form, the run it made and how that run goes. The
 * exact body and request ID are kept after a failed send, so trying again cannot run a write twice.
 */
class ShortcutExecution(
    val api: SpaceApi,
    val action: ShortcutAction?,
    args: Map<String, JSONValue> = emptyMap(),
    private val scope: CoroutineScope,
    private val send: suspend (String, JSONObject) -> String = { path, body -> api.send("POST", path, body) },
    private val get: suspend (String) -> String = { path -> api.text(path) },
) {
    val timezone: String = zone()
    var values by mutableStateOf(action?.initial(args) ?: emptyMap())
    var run by mutableStateOf<ShortcutRun?>(null)
        private set
    var busy by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    private val requestID = UUID.randomUUID().toString()
    private var submittedBody by mutableStateOf<JSONObject?>(null)
    private var work: Job? = null

    val hasSubmitted: Boolean get() = submittedBody != null
    val canSubmit: Boolean get() = !busy && run == null && action?.available == true && action.valid(values)
    val canRetry: Boolean
        get() {
            val run = run ?: return false
            if (busy || run.effect == "run") return false
            return run.status == "error" || (run.status == "unknown" && action?.idempotent == true)
        }

    fun submit() {
        val action = action ?: return
        if (!canSubmit) return
        val body = submittedBody ?: JSONObject()
            .put("action", action.id)
            .put("args", action.payload(values))
            .put("timezone", timezone)
            .put("requestId", requestID)
            .also { b -> action.peer?.let { b.put("peer", it) } }
        submittedBody = body
        perform("/api/shortcuts/runs", body)
    }

    fun retry() {
        val run = run ?: return
        if (!canRetry) return
        perform("/api/shortcuts/runs/${run.id}/retry", JSONObject())
    }

    private fun perform(path: String, body: JSONObject) {
        busy = true
        error = null
        work = scope.launch {
            try {
                run = Hub.decode(send(path, body), runReader)
                follow()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // A rejected input made no run: the form can be corrected and sent again.
                if (e is SpaceApiError.Http && e.code == 400 && run == null) submittedBody = null
                error = HubStore.message(e)
            } finally {
                busy = false
            }
        }
    }

    private suspend fun follow() {
        while (currentCoroutineContext().isActive) {
            val current = run ?: return
            if (current.status != "running") return
            delay(1500)
            run = Hub.decode(get("/api/shortcuts/runs/${current.id}"), runReader)
        }
    }

    fun cancel() {
        work?.cancel()
        work = null
    }
}
