package dev.aispace.android.core

import org.json.JSONObject
import java.time.Instant

/*
 * Settings → Feedback (docs/feedback.md, src/web/FeedbackSettings.tsx): the button app pages show,
 * what happens to what is sent with it, where the Fix Engineer runs and on which model, which apps
 * show the button, and the feedback sent lately. `GET`/`PUT /api/panel/feedback/settings`,
 * `GET /api/panel/feedback`, `POST /api/panel/feedback/fix`; owner only. On a hub, each peer's
 * apps follow these settings too and their feedback shows here as well.
 */

/** The settings as the Space keeps them. Unknown values read as the Space's defaults. */
data class FeedbackSettings(
    val enabled: Boolean = false,
    val appsDefault: Boolean = true,
    /** An app's own choice, "on" or "off"; an app without one follows [appsDefault]. */
    val apps: Map<String, String> = emptyMap(),
    /** "auto" fixes right away, "later" records for a fix together later. */
    val mode: String = "auto",
    /** The machine the Fix Engineer runs on: "" for the Space's own, else a peer's name. */
    val machine: String = "",
    /** A model choice's value; "" is the default chat model. */
    val model: String = "",
    val effort: String = "xhigh",
    val errors: Boolean = true,
) {
    /** Whether an app's pages show the button under these settings. */
    fun shown(app: String): Boolean = enabled && (apps[app]?.let { it == "on" } ?: appsDefault)

    companion object : JsonReader<FeedbackSettings> {
        val modes = listOf("auto", "later")
        val efforts = listOf("high", "xhigh", "max")

        override fun from(o: JSONObject): FeedbackSettings {
            val apps = LinkedHashMap<String, String>()
            o.obj("apps")?.let { a -> for (k in a.keyList()) a.str(k)?.takeIf { it == "on" || it == "off" }?.let { apps[k] = it } }
            return FeedbackSettings(
                enabled = o.bool("enabled") == true,
                appsDefault = o.bool("appsDefault") != false,
                apps = apps,
                mode = if (o.str("mode") == "later") "later" else "auto",
                machine = o.str("machine") ?: "",
                model = o.str("model") ?: "",
                effort = o.str("effort")?.takeIf { it in efforts } ?: "xhigh",
                errors = o.bool("errors") != false,
            )
        }
    }
}

/**
 * A change to the settings, as `PUT /api/panel/feedback/settings` takes it: only the fields set. In
 * [apps], "default" drops an app's own choice.
 */
data class FeedbackPatch(
    val enabled: Boolean? = null,
    val appsDefault: Boolean? = null,
    val apps: Map<String, String>? = null,
    val mode: String? = null,
    val machine: String? = null,
    val model: String? = null,
    val effort: String? = null,
    val errors: Boolean? = null,
) {
    fun toJson(): JSONObject {
        val o = JSONObject()
        enabled?.let { o.put("enabled", it) }
        appsDefault?.let { o.put("appsDefault", it) }
        apps?.let { a -> o.put("apps", JSONObject().also { j -> a.forEach { (k, v) -> j.put(k, v) } }) }
        mode?.let { o.put("mode", it) }
        machine?.let { o.put("machine", it) }
        model?.let { o.put("model", it) }
        effort?.let { o.put("effort", it) }
        errors?.let { o.put("errors", it) }
        return o
    }
}

/** An app with a page, and whether its pages show the button now. */
data class FeedbackApp(val app: String, val title: String, val zh: String? = null, val enabled: Boolean = false) {
    fun displayTitle(lang: String = Lang.current): String = if (lang == "zh" && !zh.isNullOrEmpty()) zh else title

    companion object : JsonReader<FeedbackApp> {
        override fun from(o: JSONObject): FeedbackApp? {
            val app = o.str("app") ?: return null
            return FeedbackApp(app, o.str("title") ?: app, o.str("zh"), o.bool("enabled") == true)
        }
    }
}

/** A peer's apps, which follow these settings; [synced] false while the settings could not be sent on. */
data class FeedbackPeer(
    val name: String,
    val ok: Boolean,
    val error: String? = null,
    val synced: Boolean = false,
    val apps: List<FeedbackApp> = emptyList(),
    val counts: Map<String, Int> = emptyMap(),
) {
    /** Feedback waiting to be fixed there. */
    val later: Int get() = counts["later"] ?: 0

    companion object : JsonReader<FeedbackPeer> {
        override fun from(o: JSONObject): FeedbackPeer? {
            return FeedbackPeer(
                name = o.str("name") ?: return null,
                ok = o.bool("ok") == true,
                error = o.str("error")?.ifEmpty { null },
                synced = o.bool("synced") == true,
                apps = o.arr("apps")?.let { Json.lossy(it, FeedbackApp) } ?: emptyList(),
                counts = Feedback.counts(o.obj("counts")),
            )
        }
    }
}

/** A machine the Fix Engineer may run on: [value] "" is the Space's own, labelled with its name. */
data class FeedbackMachine(val value: String, val label: String) {
    companion object : JsonReader<FeedbackMachine> {
        override fun from(o: JSONObject) = FeedbackMachine(o.str("value") ?: "", o.str("label") ?: "")
    }
}

/** `GET /api/panel/feedback/settings`. */
data class FeedbackView(
    val settings: FeedbackSettings = FeedbackSettings(),
    val apps: List<FeedbackApp> = emptyList(),
    /** Absent from an older Space. */
    val peers: List<FeedbackPeer> = emptyList(),
    val machines: List<FeedbackMachine> = emptyList(),
    val models: List<ModelChoice> = emptyList(),
    val counts: Map<String, Int> = emptyMap(),
    val shortcut: String = "Alt+Shift+F",
) {
    /** Feedback on this Space waiting to be fixed. */
    val later: Int get() = counts["later"] ?: 0

    /** An app's title, here or on a peer; the bare name when it is not listed. */
    fun appTitle(app: String, peer: String? = null, lang: String = Lang.current): String {
        val rows = if (peer.isNullOrEmpty()) apps else peers.firstOrNull { it.name == peer }?.apps ?: emptyList()
        return rows.firstOrNull { it.app == app }?.displayTitle(lang) ?: app
    }

    /**
     * The view with a patch applied the way the Space applies it (`mergeSettings`): an app set to
     * "default" loses its own value, and each app's shown or hidden follows. The page shows a choice
     * at once and saves in the background (FeedbackSettings.tsx `withPatch`).
     */
    fun withPatch(patch: FeedbackPatch): FeedbackView {
        val apps = LinkedHashMap(settings.apps)
        for ((app, v) in patch.apps ?: emptyMap()) if (v == "default") apps.remove(app) else apps[app] = v
        val s = settings.copy(
            enabled = patch.enabled ?: settings.enabled,
            appsDefault = patch.appsDefault ?: settings.appsDefault,
            apps = apps,
            mode = patch.mode ?: settings.mode,
            machine = patch.machine ?: settings.machine,
            model = patch.model ?: settings.model,
            effort = patch.effort ?: settings.effort,
            errors = patch.errors ?: settings.errors,
        )
        fun follow(rows: List<FeedbackApp>) = rows.map { it.copy(enabled = s.shown(it.app)) }
        return copy(settings = s, apps = follow(this.apps), peers = peers.map { if (it.ok) it.copy(apps = follow(it.apps)) else it })
    }

    companion object : JsonReader<FeedbackView> {
        override fun from(o: JSONObject): FeedbackView? {
            return FeedbackView(
                settings = FeedbackSettings.from(o.obj("settings") ?: return null),
                apps = o.arr("apps")?.let { Json.lossy(it, FeedbackApp) } ?: emptyList(),
                peers = o.arr("peers")?.let { Json.lossy(it, FeedbackPeer) } ?: emptyList(),
                machines = o.arr("machines")?.let { Json.lossy(it, FeedbackMachine) } ?: emptyList(),
                models = o.arr("models")?.let { Json.lossy(it, ModelChoice) } ?: emptyList(),
                counts = Feedback.counts(o.obj("counts")),
                shortcut = o.str("shortcut") ?: "Alt+Shift+F",
            )
        }
    }
}

/** One piece of feedback sent lately (`GET /api/panel/feedback`), here or on a peer. */
data class FeedbackItem(
    val id: Int,
    /** The peer it was sent on; null on this Space. */
    val peer: String? = null,
    val app: String,
    val text: String,
    /** later, queued, fixing, review, failed, skipped, recorded, accepted, dropped; a newer Space may send others. */
    val status: String,
    val todoId: Int? = null,
    val todoUrl: String? = null,
    val runMachine: String? = null,
    val note: String? = null,
    /** Milliseconds since 1970. */
    val createdAt: Double? = null,
) {
    /** Unique across this Space and its peers. */
    val key: String get() = "${peer ?: ""}-$id"
    val created: Instant? get() = createdAt?.let { Times.fromMillis(it) }

    /** It can be handed to the Fix Engineer (again): it has a task, and it waits or did not get through. */
    val canFix: Boolean get() = todoId != null && status in listOf("failed", "skipped", "review", "later")

    /** The first line of the note, when it says why a fix did not happen. */
    val reason: String?
        get() = note?.takeIf { status in listOf("failed", "skipped", "recorded") }?.lineSequence()?.firstOrNull()?.take(120)?.ifEmpty { null }

    /** While something is being fixed, the list follows it. */
    val isMoving: Boolean get() = status == "fixing" || status == "queued"

    companion object : JsonReader<FeedbackItem> {
        override fun from(o: JSONObject): FeedbackItem? {
            return FeedbackItem(
                id = o.int("id") ?: return null,
                peer = o.str("peer")?.ifEmpty { null },
                app = o.str("app") ?: return null,
                text = o.str("text") ?: "",
                status = o.str("status") ?: return null,
                todoId = o.int("todoId"),
                todoUrl = o.str("todoUrl")?.ifEmpty { null },
                runMachine = o.str("runMachine")?.ifEmpty { null },
                note = o.str("note"),
                createdAt = o.dbl("createdAt"),
            )
        }
    }
}

object Feedback {
    /** The statuses this client has words for; another is shown as the Space sends it. */
    val statuses = listOf("later", "queued", "fixing", "review", "failed", "skipped", "recorded", "accepted", "dropped")

    internal fun counts(o: JSONObject?): Map<String, Int> {
        if (o == null) return emptyMap()
        val out = LinkedHashMap<String, Int>()
        for (k in o.keyList()) o.int(k)?.let { out[k] = it }
        return out
    }

    /** The body of `POST /api/panel/feedback/fix`: everything waiting, a peer's, or some by id. */
    fun fixBody(peer: String? = null, ids: List<Int>? = null): JSONObject {
        val o = JSONObject()
        if (!peer.isNullOrEmpty()) o.put("peer", peer)
        if (ids != null) o.put("ids", org.json.JSONArray(ids))
        return o
    }
}
