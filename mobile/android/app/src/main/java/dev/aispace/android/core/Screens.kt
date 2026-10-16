package dev.aispace.android.core

import org.json.JSONArray
import org.json.JSONObject

/**
 * A screen as the panel defines it (docs/panel.md#screens, src/space/panel/layout.ts): entry
 * keys pinned to it, in order. The phone copies the Space's screens once and then keeps its own
 * ([ScreenStore]).
 */
data class PanelScreen(val id: String, val name: String = "", val items: List<String> = emptyList()) {
    fun toJson(): JSONObject = JSONObject().put("id", id).put("name", name).put("items", JSONArray(items))

    companion object : JsonReader<PanelScreen> {
        override fun from(o: JSONObject): PanelScreen? {
            return PanelScreen(id = o.str("id") ?: return null, name = o.str("name") ?: "", items = o.strings("items") ?: emptyList())
        }
    }
}

/**
 * The operations of src/web/screens.ts, as pure functions over the whole list. A key whose entry
 * is gone keeps its place through every one of them.
 */
object Screens {
    const val home = "home"

    /** As many as the panel allows (MAX_SCREENS in layout.ts). */
    const val limit = 20

    /** The panel's own tiles, in the order a seeded home screen has them. */
    val builtins = listOf("inbox", "terminal", "settings")

    /** How many entries of each kind a first home screen takes (SEED in screens.ts). */
    const val seedApps = 8
    const val seedAgents = 4
    const val seedWidgets = 4

    /** The home screen of a Space that has stored no screens yet, as the panel seeds it. */
    fun seed(apps: List<String>, agents: List<String>, widgets: List<String>): List<PanelScreen> {
        val items = apps.take(seedApps).map { "app:$it" } + builtins.map { "builtin:$it" } +
            agents.take(seedAgents).map { "agent:$it" } + widgets.take(seedWidgets).map { "widget:$it" }
        return listOf(PanelScreen(id = home, items = items))
    }

    private fun map(screens: List<PanelScreen>, id: String, change: (PanelScreen) -> PanelScreen): List<PanelScreen> =
        screens.map { if (it.id == id) change(it) else it }

    /** Adds the entry at the end of the screen; an entry already there stays where it is. */
    fun pin(screens: List<PanelScreen>, id: String, key: String): List<PanelScreen> =
        map(screens, id) { if (key in it.items) it else it.copy(items = it.items + key) }

    fun unpin(screens: List<PanelScreen>, id: String, key: String): List<PanelScreen> =
        map(screens, id) { s -> s.copy(items = s.items.filter { it != key }) }

    fun isPinned(screens: List<PanelScreen>, id: String, key: String): Boolean =
        screens.firstOrNull { it.id == id }?.items?.contains(key) ?: false

    /**
     * Puts the entries of a group (the tiles, or the widgets, which a screen draws apart) in a
     * new order; entries outside the group keep their places, and a key of the group that the
     * new order leaves out stays where it was.
     */
    fun reorder(screens: List<PanelScreen>, id: String, group: List<String>, order: List<String>): List<PanelScreen> {
        if (group.toSet() != order.toSet() || group.size != order.size) return screens
        val inGroup = group.toSet()
        return map(screens, id) { s ->
            val next = order.iterator()
            s.copy(items = s.items.map { if (it in inGroup && next.hasNext()) next.next() else it })
        }
    }

    data class Added(val screens: List<PanelScreen>, val id: String)

    /** A new empty screen at the end, with an id no other screen has; null at the limit. */
    fun add(screens: List<PanelScreen>): Added? {
        if (screens.size >= limit) return null
        var n = screens.size
        while (screens.any { it.id == "s$n" }) n++
        return Added(screens + PanelScreen(id = "s$n"), "s$n")
    }

    /** The home screen cannot be deleted; deleting a screen leaves its entries in the library. */
    fun remove(screens: List<PanelScreen>, id: String): List<PanelScreen> =
        if (id == home) screens else screens.filter { it.id != id }

    /**
     * Screens carry no names: they are Main, Screen 2, Screen 3… by position. (Home is the tab
     * with the library.) A view with string resources may word it itself.
     */
    fun title(index: Int, lang: String = Lang.current): String =
        if (lang == "zh") (if (index == 0) "主屏" else "屏幕 ${index + 1}")
        else (if (index == 0) "Main" else "Screen ${index + 1}")
}
