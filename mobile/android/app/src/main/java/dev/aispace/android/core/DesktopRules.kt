package dev.aispace.android.core

import org.json.JSONObject
import java.net.URI

/**
 * Which inbox threads deserve a notification: unread ones that are new or changed since the last
 * look. The first look at a connection only records what is there, so connecting never floods
 * the screen with old messages. Mutable; not thread-safe.
 */
class InboxSeen(
    lastAt: Map<String, String> = emptyMap(),
    seeded: Boolean = false,
) {
    val lastAt: MutableMap<String, String> = LinkedHashMap(lastAt)
    var seeded: Boolean = seeded
        private set

    fun fresh(items: List<InboxItem>): List<InboxItem> {
        val out = ArrayList<InboxItem>()
        for (item in items) {
            if (seeded && item.unread && !item.done && lastAt[item.thread] != item.lastAt) out.add(item)
            lastAt[item.thread] = item.lastAt
        }
        // Forget threads that are gone so the record does not grow without bound.
        val present = items.map { it.thread }.toSet()
        if (lastAt.size > 2000) lastAt.keys.retainAll(present)
        seeded = true
        return out
    }

    fun toJson(): JSONObject = JSONObject().put("lastAt", JSONObject(HashMap<String, Any>(lastAt))).put("seeded", seeded)

    override fun equals(other: Any?) = other is InboxSeen && other.lastAt == lastAt && other.seeded == seeded
    override fun hashCode() = lastAt.hashCode() * 31 + seeded.hashCode()

    companion object : JsonReader<InboxSeen> {
        override fun from(o: JSONObject): InboxSeen {
            val m = LinkedHashMap<String, String>()
            o.obj("lastAt")?.let { obj -> for (k in obj.keyList()) obj.str(k)?.let { m[k] = it } }
            return InboxSeen(m, o.bool("seeded") ?: false)
        }
    }
}

/** Which app, if any, a link belongs to: such links open as that app's own window. */
object AppRoutes {
    fun app(url: URI, apps: List<AppInfo>, space: URI): AppInfo? {
        val scheme = Urls.scheme(url)
        if (scheme != "http" && scheme != "https") return null
        var best: AppInfo? = null
        var bestLength = 0
        for (app in apps) {
            val page = app.pageURL(space) ?: continue
            if (!ConnectionRules.sameOrigin(page, url)) continue
            var length = 0
            if (ConnectionRules.sameOrigin(page, space)) {
                // An app served from the panel's own origin owns its path, never the panel's root.
                val pagePath = page.path ?: ""
                val prefix = pagePath.removeSuffix("/")
                val path = url.path ?: ""
                if (prefix.isEmpty() || !(path == prefix || path.startsWith("$prefix/"))) continue
                length = prefix.length
            }
            if (best == null || length > bestLength) {
                best = app
                bestLength = length
            }
        }
        return best
    }
}

/**
 * `aispace://` links, for shortcuts and other apps. A link may fill in a message but never
 * sends it: any web page can open such a link, so sending always waits for the operator.
 */
sealed class DeepLink {
    data class Chat(val agent: String?, val text: String?) : DeepLink()
    data class Open(val app: String) : DeepLink()
    data object Inbox : DeepLink()
    data object Show : DeepLink()

    companion object {
        const val scheme = "aispace"

        /** The link of a URL text, or null when it is not one this app takes. */
        fun parse(url: String): DeepLink? {
            Urls.parse(url)?.let { return parse(it) }
            // `aispace://` alone has no authority, which `URI` refuses; it shows the app.
            val lower = url.trim().lowercase()
            return if (lower == "$scheme://" || lower == "$scheme:") Show else null
        }

        fun parse(url: URI): DeepLink? {
            if (url.scheme?.lowercase() != scheme) return null
            val items = Urls.queryItems(url.rawQuery)
            fun q(name: String): String? = items.firstOrNull { it.first == name }?.second?.ifEmpty { null }
            val host = (url.host ?: url.rawAuthority?.substringAfter("@")?.substringBefore(":"))?.lowercase() ?: ""
            return when (host) {
                "chat" -> Chat(agent = q("agent"), text = q("text")?.let { prefix(it, 20_000) })
                "open" -> q("app")?.let { Open(it) }
                "inbox" -> Inbox
                "", "show" -> Show
                else -> null
            }
        }

        private fun prefix(s: String, n: Int): String {
            if (s.length <= n) return s
            val end = if (Character.isHighSurrogate(s[n - 1])) n - 1 else n
            return s.substring(0, end)
        }
    }
}
