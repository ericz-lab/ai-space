package dev.aispace.android.core

import org.json.JSONObject
import java.net.URI
import java.util.Locale

/*
 * The Space API's shapes as the client reads them (src/web/api.ts has the full ones).
 * Every field the app can live without is optional, so a newer or older server still decodes.
 */

/** Manifest text of one language. */
data class LocalizedText(val title: String? = null, val description: String? = null) {
    companion object : JsonReader<LocalizedText> {
        override fun from(o: JSONObject) = LocalizedText(o.str("title"), o.str("description"))
    }
}

/** Manifest text by language tag: `{ "zh": { "title": ..., "description": ... } }`. */
typealias I18n = Map<String, LocalizedText>

object I18nReader {
    /** The `i18n` field of a manifest row; entries that are not objects are left out. */
    fun read(o: JSONObject, key: String = "i18n"): I18n? {
        val m = o.obj(key) ?: return null
        val out = LinkedHashMap<String, LocalizedText>()
        for (k in m.keyList()) {
            val v = m.opt(k) as? JSONObject ?: continue
            out[k] = LocalizedText.from(v)
        }
        return out
    }
}

/**
 * The reader's language. iOS reads the first preferred language; here it is the default locale's
 * language, settable so the app (or a test) can choose. In practice `en` or `zh`.
 */
object Lang {
    /** The primary tag of a language tag: `zh-Hans-CN` is `zh`. */
    fun primary(tag: String): String = tag.split('-', '_').first().lowercase().ifEmpty { "en" }

    fun of(locale: Locale): String = primary(locale.toLanguageTag())

    @Volatile
    var current: String = of(Locale.getDefault())

    /** The text of the language, of another region of it, or the base text. */
    fun pick(base: String, i18n: I18n?, key: (LocalizedText) -> String?, lang: String = current): String {
        if (i18n == null) return base
        i18n[lang]?.let(key)?.let { if (it.isNotEmpty()) return it }
        val match = i18n.entries.firstOrNull { primaryOnly(it.key) == lang }?.value?.let(key)
        if (!match.isNullOrEmpty()) return match
        return base
    }

    /** Pick the title: `Lang.pick(base, i18n, Lang.title)`. */
    val title: (LocalizedText) -> String? = { it.title }
    val description: (LocalizedText) -> String? = { it.description }

    private fun primaryOnly(tag: String) = tag.split('-').first()
}

data class AgentInfo(
    val id: String,
    val peer: String? = null,
    val app: String,
    val name: String,
    val title: String,
    val description: String? = null,
    val i18n: I18n? = null,
    val avatar: String? = null,
    val runtime: String? = null,
) {
    fun displayTitle(lang: String = Lang.current): String = Lang.pick(title, i18n, Lang.title, lang)

    /** The route base of the agent's chat: local, or forwarded to the peer that owns it. */
    val base: String
        get() {
            val prefix = peer?.let { "/api/peers/${SpacePath.escape(it)}" } ?: "/api"
            return "$prefix/agents/${SpacePath.escape(app)}/${SpacePath.escape(name)}"
        }

    companion object : JsonReader<AgentInfo> {
        override fun from(o: JSONObject): AgentInfo? {
            return AgentInfo(
                id = o.str("id") ?: return null,
                peer = o.str("peer"),
                app = o.str("app") ?: return null,
                name = o.str("name") ?: return null,
                title = o.str("title") ?: return null,
                description = o.str("description"),
                i18n = I18nReader.read(o),
                avatar = o.str("avatar"),
                runtime = o.str("runtime"),
            )
        }
    }
}

data class AppInfo(
    val id: String,
    val name: String,
    val peer: String? = null,
    val stale: Boolean? = null,
    val title: String,
    val description: String? = null,
    val i18n: I18n? = null,
    val icon: String? = null,
    val url: String? = null,
    val status: String? = null,
    val hidden: Boolean? = null,
) {
    fun displayTitle(lang: String = Lang.current): String = Lang.pick(title, i18n, Lang.title, lang)

    /** The app's page with `{lang}` filled in, resolved against the Space when it is a path. */
    fun pageURL(space: URI, lang: String = Lang.current): URI? {
        if (url.isNullOrEmpty()) return null
        return Urls.resolve(space, url.replace("{lang}", lang))
    }

    companion object : JsonReader<AppInfo> {
        override fun from(o: JSONObject): AppInfo? {
            return AppInfo(
                id = o.str("id") ?: return null,
                name = o.str("name") ?: return null,
                peer = o.str("peer"),
                stale = o.bool("stale"),
                title = o.str("title") ?: return null,
                description = o.str("description"),
                i18n = I18nReader.read(o),
                icon = o.str("icon"),
                url = o.str("url"),
                status = o.str("status"),
                hidden = o.bool("hidden"),
            )
        }
    }
}

data class AppsResponse(val apps: List<AppInfo>) {
    companion object : JsonReader<AppsResponse> {
        override fun from(o: JSONObject): AppsResponse? {
            return AppsResponse(Json.lossy(o.arr("apps") ?: return null, AppInfo))
        }
    }
}

data class AgentsResponse(val agents: List<AgentInfo>) {
    companion object : JsonReader<AgentsResponse> {
        override fun from(o: JSONObject): AgentsResponse? {
            return AgentsResponse(Json.lossy(o.arr("agents") ?: return null, AgentInfo))
        }
    }
}

data class InboxItem(
    val thread: String,
    val app: String,
    val level: String,
    val title: String? = null,
    val text: String,
    val url: String? = null,
    val count: Int,
    val lastAt: String,
    val unread: Boolean,
    val done: Boolean,
) {
    val id: String get() = thread

    companion object : JsonReader<InboxItem> {
        override fun from(o: JSONObject): InboxItem? {
            return InboxItem(
                thread = o.str("thread") ?: return null,
                app = o.str("app") ?: return null,
                level = o.str("level") ?: return null,
                title = o.str("title"),
                text = o.str("text") ?: return null,
                url = o.str("url"),
                count = o.int("count") ?: return null,
                lastAt = o.str("lastAt") ?: return null,
                unread = o.bool("unread") ?: return null,
                done = o.bool("done") ?: return null,
            )
        }
    }
}

data class InboxSummary(val unread: Int, val open: Int) {
    companion object : JsonReader<InboxSummary> {
        override fun from(o: JSONObject): InboxSummary? {
            return InboxSummary(o.int("unread") ?: return null, o.int("open") ?: return null)
        }
    }
}

data class InboxResponse(val items: List<InboxItem>, val summary: InboxSummary) {
    companion object : JsonReader<InboxResponse> {
        override fun from(o: JSONObject): InboxResponse? {
            return InboxResponse(
                Json.lossy(o.arr("items") ?: return null, InboxItem),
                InboxSummary.from(o.obj("summary") ?: return null) ?: return null,
            )
        }
    }
}

data class ChatRun(
    val id: String,
    val agent: String,
    val message: String,
    val status: String,
    val startedAt: Double,
    val lastSeq: Int,
) {
    companion object : JsonReader<ChatRun> {
        override fun from(o: JSONObject): ChatRun? {
            return ChatRun(
                id = o.str("id") ?: return null,
                agent = o.str("agent") ?: return null,
                message = o.str("message") ?: return null,
                status = o.str("status") ?: return null,
                startedAt = o.dbl("startedAt") ?: return null,
                lastSeq = o.int("lastSeq") ?: return null,
            )
        }
    }
}

data class RunsResponse(val runs: List<ChatRun>) {
    companion object : JsonReader<RunsResponse> {
        override fun from(o: JSONObject): RunsResponse? {
            return RunsResponse(Json.lossy(o.arr("runs") ?: return null, ChatRun))
        }
    }
}
