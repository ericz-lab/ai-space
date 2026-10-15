package dev.aispace.android.core

import java.net.URI
import java.util.UUID

/**
 * Home-screen shortcuts (the launcher's long-press menu): the first apps of the home screen, each
 * as an `aispace://open` link that goes through the same handler as a link from another app
 * ([DeepLink]). Plain data; the ShortcutManager glue lives with the app.
 */
data class QuickAction(val title: String, val subtitle: String?, val url: URI) {
    /**
     * What a shortcut carries (its intent extras): the link, and the Space whose app it opens.
     * The link alone names an app, and the Space on show after a cold start is the default one,
     * which need not be the one the items were made for.
     */
    fun userInfo(space: UUID): Map<String, String> = mapOf("url" to url.toString(), "space" to space.toString().uppercase())

    data class Target(val url: URI, val space: UUID?)

    companion object {
        const val type = "dev.aispace.android.open"

        /** Launchers show about four; more are dropped. */
        const val limit = 4

        fun items(pins: List<String>, catalogue: Catalogue, lang: String = Lang.current): List<QuickAction> =
            pins.asSequence()
                .mapNotNull { catalogue.entry(it) }
                .filter { it.kind == EntryKind.app }
                .take(limit)
                .mapNotNull { e -> link(e.ref)?.let { QuickAction(e.displayTitle(lang), e.peer, it) } }
                .toList()

        /** What a shortcut item brings back, or null when it carries no link. */
        fun target(userInfo: Map<String, Any?>?): Target? {
            val text = userInfo?.get("url") as? String ?: return null
            val url = Urls.parse(text) ?: return null
            val space = (userInfo["space"] as? String)?.let { runCatching { UUID.fromString(it) }.getOrNull() }
            return Target(url, space)
        }

        /** `aispace://open?app=<app>`. */
        fun link(app: String): URI? = Urls.parse("${DeepLink.scheme}://open?app=${Urls.encodeQueryValue(app)}")
    }
}
