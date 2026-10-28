package dev.aispace.android.live

import android.content.Context
import android.content.res.Resources
import androidx.annotation.StringRes
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.aispace.android.R
import dev.aispace.android.core.AppLabel
import dev.aispace.android.core.AppModelRows
import dev.aispace.android.core.AppUsageRow
import dev.aispace.android.core.CapabilityApp
import dev.aispace.android.core.DecodingException
import dev.aispace.android.core.EventDelivery
import dev.aispace.android.core.Feedback
import dev.aispace.android.core.FeedbackItem
import dev.aispace.android.core.FeedbackPatch
import dev.aispace.android.core.FeedbackView
import dev.aispace.android.core.Hub
import dev.aispace.android.core.InboxFilter
import dev.aispace.android.core.InboxPage
import dev.aispace.android.core.InboxSummary
import dev.aispace.android.core.InboxThread
import dev.aispace.android.core.Json
import dev.aispace.android.core.JsonReader
import dev.aispace.android.core.int
import dev.aispace.android.core.ModelCall
import dev.aispace.android.core.ModelChoice
import dev.aispace.android.core.ModelUsage
import dev.aispace.android.core.PackageCatalogue
import dev.aispace.android.core.PeerAppModels
import dev.aispace.android.core.PeerStatus
import dev.aispace.android.core.SpaceApi
import dev.aispace.android.core.SpaceApiError
import dev.aispace.android.core.SpaceEvent
import dev.aispace.android.core.SpaceLink
import dev.aispace.android.core.SpacePath
import dev.aispace.android.core.SpaceTask
import dev.aispace.android.core.TaskRun
import dev.aispace.android.core.obj
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.text.Collator

/**
 * The texts the stores write themselves (an error's words, a note in a chat reply, a line in a
 * terminal), from the app's resources. Bound by the Space's pages before any store speaks
 * (`HubCover`); the application's resources, so no activity is held.
 */
object HubText {
    @Volatile
    private var resources: Resources? = null

    fun bind(context: Context) {
        resources = context.applicationContext.resources
    }

    fun get(@StringRes id: Int, vararg args: Any): String {
        val r = resources ?: return ""
        return if (args.isEmpty()) r.getString(id) else r.getString(id, *args)
    }
}

/**
 * What one of the Space's pages has read, asked from the Space with its session each time the
 * page comes up and when it is pulled down. Nothing is kept on the phone.
 *
 * State is Compose snapshot state, changed on the main thread only: every store is driven from a
 * main-thread scope (the page's, or the app's for the terminal).
 */
open class HubStore(val api: SpaceApi, protected val scope: CoroutineScope) {
    var isLoading by mutableStateOf(false)
        private set

    /** The first answer has arrived. */
    var loaded by mutableStateOf(false)
        private set

    /** Why the last read failed, until one succeeds. */
    var error by mutableStateOf<String?>(null)
        private set

    /** Why the last change was not taken, until the next one is. */
    var saveError by mutableStateOf<String?>(null)

    var isSaving by mutableStateOf(false)
        private set

    /** A refresh was asked for while one was on its way (the window or filter changed): read again after it. */
    private var again = false

    /** Subclasses read their routes here. */
    protected open suspend fun load() {}

    suspend fun refresh() {
        if (isLoading) {
            again = true
            return
        }
        isLoading = true
        try {
            do {
                again = false
                try {
                    load()
                    error = null
                    loaded = true
                } catch (e: CancellationException) {
                    // The page that asked went away; nothing was learnt.
                    throw e
                } catch (e: Exception) {
                    error = message(e)
                }
            } while (again)
        } finally {
            isLoading = false
        }
    }

    /** Starts a refresh in the store's scope, for a change of window or filter (coalesced by [refresh]). */
    fun refreshLater() {
        scope.launch { refresh() }
    }

    /** One change to the Space; the page reads again after it. */
    suspend fun save(work: suspend () -> Unit) {
        if (isSaving) return
        isSaving = true
        try {
            work()
            saveError = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            saveError = message(e)
        } finally {
            isSaving = false
        }
    }

    /** Names and icons of every app, headless and hidden ones too; a failure leaves the bare names. */
    var labels by mutableStateOf<Map<String, AppLabel>>(emptyMap())
        private set
    private var askedLabels = false

    /** Asked once, beside the page's own rows, which do not wait for it. */
    fun loadLabels() {
        scope.launch { fetchLabels() }
    }

    /** For a page that orders its rows by these names: it waits, so the rows do not move under the reader. */
    suspend fun fetchLabels() {
        if (askedLabels) return
        askedLabels = true
        val apps = try {
            Hub.rows("apps", api.text("/api/apps?all=1"), AppLabel)
        } catch (e: CancellationException) {
            askedLabels = false
            throw e
        } catch (e: Exception) {
            askedLabels = false
            return
        }
        labels = AppLabel.index(apps)
    }

    fun title(app: String): String = labels[app]?.displayTitle() ?: app

    companion object {
        fun message(error: Throwable): String = when (error) {
            is SpaceApiError.AuthenticationRequired -> HubText.get(R.string.hub_error_sign_in)
            is SpaceApiError.Http -> "${error.msg} (HTTP ${error.code})"
            is SpaceApiError.InvalidResponse, is DecodingException -> HubText.get(R.string.hub_error_unreadable)
            else -> error.localizedMessage ?: error.toString()
        }

        /** Titles in the reader's order, case and accents aside (`localizedCaseInsensitiveCompare`). */
        val titleOrder: Comparator<String> = Collator.getInstance().apply { strength = Collator.SECONDARY }.let { c ->
            Comparator { a, b -> c.compare(a, b) }
        }

        /** A route's answer as a [T], or null when it does not decode. */
        internal fun <T> decodeOrNull(text: String, reader: JsonReader<T>): T? =
            try { Hub.decode(text, reader) } catch (e: Exception) { null }
    }
}

class TasksStore(api: SpaceApi, scope: CoroutineScope) : HubStore(api, scope) {
    var tasks by mutableStateOf<List<SpaceTask>>(emptyList())
        private set
    var options by mutableStateOf<List<ModelChoice>>(emptyList())
        private set
    var runs by mutableStateOf<Map<String, List<TaskRun>>>(emptyMap())
        private set
    var runErrors by mutableStateOf<Map<String, String>>(emptyMap())
        private set

    override suspend fun load() {
        if (options.isEmpty()) {
            scope.launch {
                val text = try { api.text("/api/tasks/models") } catch (e: CancellationException) { throw e } catch (e: Exception) { return@launch }
                options = try { Hub.rows("models", text, ModelChoice) } catch (e: Exception) { emptyList() }
            }
        }
        coroutineScope {
            val names = async { fetchLabels() }
            val fresh = Hub.rows("tasks", api.text("/api/tasks"), SpaceTask)
            names.await()
            tasks = fresh
        }
    }

    /** The tasks by app, apps by title, tasks by name. */
    val groups: List<Pair<String, List<SpaceTask>>>
        get() = tasks.groupBy { it.app }
            .map { (app, list) -> app to list.sortedBy { it.name } }
            .sortedWith { a, b -> HubStore.titleOrder.compare(title(a.first), title(b.first)) }

    fun task(id: String): SpaceTask? = tasks.firstOrNull { it.id == id }

    suspend fun loadRuns(id: String) {
        try {
            val rows = Hub.rows("runs", api.text("/api/tasks/${SpacePath.escape(id)}/runs?limit=20"), TaskRun)
            runs = runs + (id to rows)
            runErrors = runErrors - id
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            runErrors = runErrors + (id to HubStore.message(e))
        }
    }

    /** Sets the model the task runs on from its next run, or returns it to its default with null. */
    suspend fun setModel(id: String, value: String?) {
        save {
            val answer = api.send("PATCH", "/api/panel/tasks/${SpacePath.escape(id)}/model", JSONObject().put("model", value ?: JSONObject.NULL))
            val fresh = HubStore.decodeOrNull(answer, JsonReader<SpaceTask> { o -> o.obj("task")?.let { SpaceTask.from(it) } })
            if (fresh != null) tasks = tasks.map { if (it.id == id) fresh else it }
        }
    }
}

class ModelUsageStore(api: SpaceApi, scope: CoroutineScope) : HubStore(api, scope) {
    var window by mutableStateOf("24h")
        private set
    var usage by mutableStateOf<ModelUsage?>(null)
        private set
    var calls by mutableStateOf<List<ModelCall>>(emptyList())
        private set

    fun choose(window: String) {
        if (window == this.window) return
        this.window = window
        refreshLater()
    }

    override suspend fun load() {
        loadLabels()
        val asked = window
        coroutineScope {
            val recent = async {
                try { api.text("/api/model/calls?limit=30") } catch (e: CancellationException) { throw e } catch (e: Exception) { null }
            }
            val fresh = Hub.decode(api.text("/api/model/usage?window=$asked"), ModelUsage)
            val c = recent.await()
            // The window changed while this one was on its way.
            if (asked != window) return@coroutineScope
            usage = fresh
            calls = c?.let { try { Hub.rows("calls", it, ModelCall) } catch (e: Exception) { null } } ?: emptyList()
        }
    }

    companion object {
        val windows = listOf("5h", "24h", "7d", "30d")
    }
}

class AppUsageStore(api: SpaceApi, scope: CoroutineScope) : HubStore(api, scope) {
    var window by mutableStateOf("30d")
        private set
    var kind by mutableStateOf("all")
        private set
    var rows by mutableStateOf<List<AppUsageRow>>(emptyList())
        private set

    /** The same entries over 30 days, for the trend, whatever the window. */
    var month by mutableStateOf<Map<String, AppUsageRow>>(emptyMap())
        private set

    fun choose(window: String = this.window, kind: String = this.kind) {
        if (window == this.window && kind == this.kind) return
        this.window = window
        this.kind = kind
        refreshLater()
    }

    override suspend fun load() {
        val w = window
        val k = kind
        val q = if (k == "all") "" else "&kind=$k"
        val fresh = Hub.rows("usage", api.text("/api/usage?window=$w$q"), AppUsageRow)
        var thirty = fresh
        if (w != "30d") {
            val text = try { api.text("/api/usage?window=30d$q") } catch (e: CancellationException) { throw e } catch (e: Exception) { null }
            if (text != null) thirty = try { Hub.rows("usage", text, AppUsageRow) } catch (e: Exception) { emptyList() }
        }
        if (w != window || k != kind) return
        rows = fresh
        val map = LinkedHashMap<String, AppUsageRow>()
        for (r in thirty) map.putIfAbsent(r.id, r)
        month = map
    }

    val opens: Int get() = rows.sumOf { it.opens }
    val activeMs: Double get() = rows.sumOf { it.activeMs ?: 0.0 }

    companion object {
        val windows = listOf("7d", "30d", "90d", "all")
        val kinds = listOf("all", "app", "agent", "builtin")
    }
}

class AppModelsStore(api: SpaceApi, scope: CoroutineScope) : HubStore(api, scope) {
    var apps by mutableStateOf<List<AppModelRows>>(emptyList())
        private set
    var options by mutableStateOf<List<ModelChoice>>(emptyList())
        private set

    /** On a hub, each peer's apps, by name; each read on its own so a slow peer holds up only its part. */
    var peers by mutableStateOf<List<PeerAppModels>>(emptyList())
        private set

    override suspend fun load() {
        coroutineScope {
            val names = async { fetchLabels() }
            val peerNames = async {
                try { Hub.rows("peers", api.text("/api/peers"), PeerStatus).map { it.name }.sorted() } catch (e: CancellationException) { throw e } catch (e: Exception) { emptyList() }
            }
            val data = api.text("/api/model/apps")
            names.await()
            options = try { Hub.rows("options", data, ModelChoice) } catch (e: Exception) { emptyList() }
            apps = Hub.rows("apps", data, AppModelRows)
            val listed = peerNames.await()
            // A peer read before keeps its rows while it is read again.
            peers = listed.map { name -> peers.firstOrNull { it.peer == name } ?: PeerAppModels(name) }
            for (name in listed) scope.launch { loadPeer(name) }
        }
    }

    private suspend fun loadPeer(name: String) {
        val fresh = try {
            PeerAppModels.answer(name, api.text(PeerAppModels.path(name)))
        } catch (e: CancellationException) {
            throw e
        } catch (e: SpaceApiError.Http) {
            PeerAppModels.failure(name, e.code, e.msg)
        } catch (e: Exception) {
            PeerAppModels(name, error = HubStore.message(e))
        }
        peers = peers.map { if (it.peer == name) fresh else it }
    }

    /** An app's title: by its id (`<peer>/<app>` on a peer), else its bare name. */
    fun title(app: String, peer: String?): String = labels[peer?.let { "$it/$app" } ?: app]?.displayTitle() ?: app

    /** The app's icon: the hub's label, else the peer's own icon route. */
    fun icon(app: String, peer: String?): String? =
        labels[peer?.let { "$it/$app" } ?: app]?.icon ?: peer?.let { PeerAppModels.iconPath(it, app) }

    /** The apps by title. */
    val sorted: List<AppModelRows>
        get() = apps.sortedWith { a, b -> HubStore.titleOrder.compare(title(a.app), title(b.app)) }

    fun sorted(peer: PeerAppModels): List<AppModelRows> =
        (peer.apps ?: emptyList()).sortedWith { a, b -> HubStore.titleOrder.compare(title(a.app, peer.peer), title(b.app, peer.peer)) }

    /**
     * Sets the panel's override for an app's calls, or for one tag of them; null clears it. A peer's
     * app is saved on the peer, through the hub.
     */
    suspend fun setModel(app: String, tag: String?, value: String?, peer: String? = null) {
        save {
            val body = JSONObject().put("model", value ?: JSONObject.NULL)
            if (tag != null) body.put("tag", tag)
            val answer = api.send("PATCH", PeerAppModels.savePath(app, peer), body)
            val fresh = HubStore.decodeOrNull(answer, AppModelRows)
            if (fresh != null) {
                if (peer == null) apps = apps.map { if (it.app == app) fresh else it }
                else peers = peers.map { if (it.peer == peer) it.replacing(fresh) else it }
            }
        }
    }
}

class EventsStore(api: SpaceApi, scope: CoroutineScope) : HubStore(api, scope) {
    var events by mutableStateOf<List<SpaceEvent>>(emptyList())
        private set
    var capabilities by mutableStateOf<List<CapabilityApp>>(emptyList())
        private set
    var deliveries by mutableStateOf<Map<Int, List<EventDelivery>>>(emptyMap())
        private set
    var deliveryErrors by mutableStateOf<Map<Int, String>>(emptyMap())
        private set

    override suspend fun load() {
        events = Hub.rows("events", api.text("/api/events?limit=100"), SpaceEvent)
        val data = try { api.text("/api/capabilities") } catch (e: CancellationException) { throw e } catch (e: Exception) { null }
        if (data != null) {
            capabilities = (try { Hub.rows("apps", data, CapabilityApp) } catch (e: Exception) { emptyList() }).filter { !it.isEmpty }
        }
    }

    suspend fun loadDeliveries(id: Int) {
        try {
            val rows = Hub.rows("deliveries", api.text("/api/events/$id"), EventDelivery)
            deliveries = deliveries + (id to rows)
            deliveryErrors = deliveryErrors - id
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            deliveryErrors = deliveryErrors + (id to HubStore.message(e))
        }
    }
}

class PackagesStore(api: SpaceApi, scope: CoroutineScope) : HubStore(api, scope) {
    var catalogue by mutableStateOf<PackageCatalogue?>(null)
        private set
    var links by mutableStateOf<List<SpaceLink>>(emptyList())
        private set

    override suspend fun load() {
        catalogue = Hub.decode(api.text("/api/panel/package-catalogue"), PackageCatalogue)
        val data = try { api.text("/api/panel/connections") } catch (e: CancellationException) { throw e } catch (e: Exception) { null }
        if (data != null) links = try { Hub.rows("connections", data, SpaceLink) } catch (e: Exception) { emptyList() }
    }

    /** Turns a connection on or off. The connection itself stays. */
    suspend fun setEnabled(link: SpaceLink, on: Boolean) {
        save { api.send("PATCH", "/api/panel/connections/${SpacePath.escape(link.id)}", JSONObject().put("enabled", on)) }
        refresh()
    }

    /** Shares one of this Space's packages over a connection, or stops sharing it. */
    suspend fun setShared(link: SpaceLink, app: String, on: Boolean) {
        val apps = (link.apps ?: emptyList()).filter { it != app } + (if (on) listOf(app) else emptyList())
        save { api.send("PATCH", "/api/panel/connections/${SpacePath.escape(link.id)}", JSONObject().put("apps", JSONArray(apps))) }
        refresh()
    }
}

class InboxStore(api: SpaceApi, scope: CoroutineScope) : HubStore(api, scope) {
    var filter by mutableStateOf(InboxFilter.all)
        private set
    var items by mutableStateOf<List<InboxThread>>(emptyList())
        private set
    var summary by mutableStateOf<InboxSummary?>(null)
        private set

    fun choose(filter: InboxFilter) {
        if (filter == this.filter) return
        this.filter = filter
        refreshLater()
    }

    override suspend fun load() {
        val asked = filter
        val body = Hub.decode(api.text("/api/inbox?${asked.query}&limit=200"), InboxPage)
        if (asked != filter) return
        items = body.items ?: emptyList()
        summary = body.summary ?: summary
    }

    fun item(thread: String): InboxThread? = items.firstOrNull { it.thread == thread }

    suspend fun mark(thread: String, read: Boolean? = null, done: Boolean? = null) {
        val body = JSONObject().put("threads", JSONArray(listOf(thread)))
        if (read != null) body.put("read", read)
        if (done != null) body.put("done", done)
        // Shown at once; the next read says what the Space kept.
        items = items.map { item ->
            if (item.thread != thread) item
            else item.copy(unread = if (read != null) !read else item.unread, done = done ?: item.done)
        }
        save { api.send("POST", "/api/inbox/mark", body) }
        refresh()
    }

    suspend fun readAll() {
        save { api.send("POST", "/api/inbox/read-all", JSONObject()) }
        refresh()
    }
}

/**
 * Settings → Feedback (src/web/FeedbackSettings.tsx). A switch or menu shows its new value at once
 * and stays usable while the change is saved; only the answer to the newest save is kept, so a
 * slower earlier one cannot undo a later choice.
 */
class FeedbackStore(api: SpaceApi, scope: CoroutineScope) : HubStore(api, scope) {
    var view by mutableStateOf<FeedbackView?>(null)
        private set
    var items by mutableStateOf<List<FeedbackItem>>(emptyList())
        private set

    /** What the last fix asked for started, until the next one. */
    var notice by mutableStateOf<String?>(null)
        private set
    var isFixing by mutableStateOf(false)
        private set
    private var saves = 0

    override suspend fun load() {
        coroutineScope {
            val recent = async {
                try { api.text("/api/panel/feedback?limit=20") } catch (e: CancellationException) { throw e } catch (e: Exception) { null }
            }
            val fresh = Hub.decode(api.text("/api/panel/feedback/settings"), FeedbackView)
            val r = recent.await()
            view = fresh
            if (r != null) items = try { Hub.rows("items", r, FeedbackItem) } catch (e: Exception) { items }
        }
    }

    /** While something is being fixed or queued, the page reads again now and then. */
    val isMoving: Boolean get() = items.any { it.isMoving }

    fun save(patch: FeedbackPatch) {
        val n = ++saves
        view = view?.withPatch(patch)
        saveError = null
        scope.launch {
            try {
                val answer = api.send("PUT", "/api/panel/feedback/settings", patch.toJson())
                if (n == saves) HubStore.decodeOrNull(answer, FeedbackView)?.let { view = it }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                saveError = HubStore.message(e)
                refresh()
            }
        }
    }

    /** Hands waiting feedback to the Fix Engineer now: everything here, a peer's, or some by id. */
    suspend fun fix(peer: String? = null, ids: List<Int>? = null) {
        if (isFixing) return
        isFixing = true
        try {
            val answer = api.send("POST", "/api/panel/feedback/fix", Feedback.fixBody(peer, ids))
            val queued = Json.obj(answer)?.int("queued") ?: 0
            notice = HubText.get(R.string.feedback_started, queued)
            saveError = null
            refresh()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            saveError = HubStore.message(e)
        } finally {
            isFixing = false
        }
    }
}
