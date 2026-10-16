package dev.aispace.android.core

import org.json.JSONObject
import java.net.URI
import java.time.Instant

/*
 * The Space's catalogue as the phone reads it: `GET /api/apps`, `/api/agents`, `/api/widgets`,
 * `/api/peers`, `/api/panel/layout` and `/api/router` (shapes in src/space/panel/view.ts,
 * widgets.ts, layout.ts and src/space/peers/client.ts). Every field the app can live without
 * is optional and a malformed row is skipped, so an older or newer server still decodes.
 */

data class CatalogApp(
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
    val manifestOnly: Boolean? = null,
    val hidden: Boolean? = null,
    val service: Service? = null,
) {
    data class Service(val port: Int? = null, val health: String? = null) {
        companion object : JsonReader<Service> {
            override fun from(o: JSONObject) = Service(o.int("port"), o.str("health"))
        }
    }

    companion object : JsonReader<CatalogApp> {
        override fun from(o: JSONObject): CatalogApp? {
            return CatalogApp(
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
                manifestOnly = o.bool("manifestOnly"),
                hidden = o.bool("hidden"),
                service = o.obj("service")?.let { Service.from(it) },
            )
        }
    }
}

data class CatalogWidget(
    val id: String,
    val peer: String? = null,
    val stale: Boolean? = null,
    val app: String,
    val name: String,
    val title: String,
    val i18n: I18n? = null,
    val icon: String? = null,
    val link: String? = null,
    val kind: String? = null,
    /** The card size the operator or the manifest chose: 1x1, 2x1, 1x2 or 2x2. */
    val size: String? = null,
    val ok: Boolean? = null,
    val items: List<Item>? = null,
    /** A state card instead of the list ([WidgetBlock]); empty or absent means the list. */
    val blocks: List<WidgetBlock>? = null,
    val asOf: String? = null,
    val staleAfterMs: Double? = null,
    val error: String? = null,
) {
    data class Item(val text: String, val url: String? = null, val time: String? = null) {
        companion object : JsonReader<Item> {
            override fun from(o: JSONObject): Item? {
                return Item(o.str("text") ?: return null, o.str("url"), o.str("time"))
            }
        }
    }

    fun displayTitle(lang: String = Lang.current): String = Lang.pick(title, i18n, Lang.title, lang)

    companion object : JsonReader<CatalogWidget> {
        override fun from(o: JSONObject): CatalogWidget? {
            return CatalogWidget(
                id = o.str("id") ?: return null,
                peer = o.str("peer"),
                stale = o.bool("stale"),
                app = o.str("app") ?: return null,
                name = o.str("name") ?: return null,
                title = o.str("title") ?: return null,
                i18n = I18nReader.read(o),
                icon = o.str("icon"),
                link = o.str("link"),
                kind = o.str("kind"),
                size = o.str("size"),
                ok = o.bool("ok"),
                items = o.arr("items")?.let { Json.lossy(it, Item) },
                blocks = o.arr("blocks")?.let { Json.lossy(it, WidgetBlock) },
                asOf = o.str("asOf"),
                staleAfterMs = o.dbl("staleAfterMs"),
                error = o.str("error"),
            )
        }
    }
}

data class PeerStatus(
    val name: String,
    val health: String? = null,
    val asOf: String? = null,
    val error: String? = null,
    val stale: Boolean? = null,
    val apps: Int? = null,
    val agents: Int? = null,
    val widgets: Int? = null,
) {
    val id: String get() = name

    /** A peer whose snapshot is old or whose last refresh failed: its entries are last known, not live. */
    val isOffline: Boolean get() = stale == true || (health != null && health != "ok")

    companion object : JsonReader<PeerStatus> {
        override fun from(o: JSONObject): PeerStatus? {
            return PeerStatus(
                name = o.str("name") ?: return null,
                health = o.str("health"),
                asOf = o.str("asOf"),
                error = o.str("error"),
                stale = o.bool("stale"),
                apps = o.int("apps"),
                agents = o.int("agents"),
                widgets = o.int("widgets"),
            )
        }
    }
}

/** What kind of thing a catalogue entry is; the name is the prefix of the panel's entry key. */
enum class EntryKind {
    app, agent, widget;

    val rawValue: String get() = name
}

/** Whether an entry can be expected to answer. */
enum class Reach {
    /** Its service answered the Space's health probe. */
    up,

    /** Its service did not answer the probe. */
    down,

    /** A service that has not been probed, or an older server that does not say. */
    unknown,

    /** No service of its own: a link to a page elsewhere. */
    link,

    /** It lives on a peer that is not answering; this is the last snapshot. */
    peerOffline,

    /** The operator paused the app. */
    paused,
}

/**
 * One app, agent or widget, keyed the way the panel keys it (`app:<id>`, `agent:<id>`,
 * `widget:<id>`, peer prefix included), so a pin survives a title change.
 */
data class CatalogueEntry(
    val kind: EntryKind,
    /** The layout id: `<name>`, `<app>/<name>`, or the same behind `<peer>/`. */
    val ref: String,
    val title: String,
    val detail: String? = null,
    val i18n: I18n? = null,
    /** An emoji, an http(s) URL, or a path on the Space. */
    val icon: String? = null,
    val peer: String? = null,
    /** The page to open: the app's `url` or the widget's `link`, `{lang}` not yet filled in. */
    val link: String? = null,
    val reach: Reach,
) {
    val id: String get() = key
    val key: String get() = "${kind.name}:$ref"

    fun displayTitle(lang: String = Lang.current): String = Lang.pick(title, i18n, Lang.title, lang)

    fun displayDetail(lang: String = Lang.current): String? =
        Lang.pick(detail ?: "", i18n, Lang.description, lang).ifEmpty { null }

    /** The page with `{lang}` filled in, resolved against the Space when it is a path; http(s) only. */
    fun pageURL(space: URI, lang: String = Lang.current): URI? {
        if (link.isNullOrEmpty()) return null
        val url = Urls.resolve(space, link.replace("{lang}", lang)) ?: return null
        val scheme = Urls.scheme(url)
        return if (scheme == "http" || scheme == "https") url else null
    }
}

/**
 * The raw answers of one refresh, kept on the phone so the last known catalogue can be shown,
 * marked as such, while the Space cannot be reached. The bodies are kept as the text they came as.
 */
data class CataloguePayload(
    val apps: String,
    val agents: String,
    val widgets: String,
    val peers: String? = null,
    val layout: String? = null,
    val router: String? = null,
    val fetchedAt: Instant,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("apps", apps)
        .put("agents", agents)
        .put("widgets", widgets)
        .put("peers", peers ?: JSONObject.NULL)
        .put("layout", layout ?: JSONObject.NULL)
        .put("router", router ?: JSONObject.NULL)
        .put("fetchedAt", fetchedAt.toEpochMilli())

    companion object : JsonReader<CataloguePayload> {
        override fun from(o: JSONObject): CataloguePayload? {
            return CataloguePayload(
                apps = o.str("apps") ?: return null,
                agents = o.str("agents") ?: return null,
                widgets = o.str("widgets") ?: return null,
                peers = o.str("peers"),
                layout = o.str("layout"),
                router = o.str("router"),
                fetchedAt = Instant.ofEpochMilli(o.long("fetchedAt") ?: return null),
            )
        }
    }
}

sealed class CatalogueError(message: String) : Exception(message) {
    /** The answer is not what ai-space sends for this route. */
    data class NotASpace(val route: String) : CatalogueError("not an ai-space answer: $route")
}

data class Catalogue(
    val apps: List<CatalogueEntry> = emptyList(),
    val agents: List<CatalogueEntry> = emptyList(),
    val widgets: List<CatalogWidget> = emptyList(),
    val peers: List<PeerStatus> = emptyList(),
    /** The panel's screens, home first; null while the Space has stored none (the panel seeds them on its first load). */
    val screens: List<PanelScreen>? = null,
    /** `SPACE_DOMAIN` when the Space routes app hostnames itself (docs/router.md). */
    val domain: String? = null,
    val fetchedAt: Instant = Times.distantPast,
) {
    val entries: List<CatalogueEntry> get() = apps + agents + widgets.map { entry(it) }

    /** The panel's screens as a browser shows them: the stored ones, or the home screen it would seed. */
    val panelScreens: List<PanelScreen>
        get() = screens ?: Screens.seed(apps.map { it.ref }, agents.map { it.ref }, widgets.map { it.id })

    /** Entry keys pinned to the panel's home screen, in order. */
    val homePins: List<String> get() = panelScreens.firstOrNull()?.items ?: emptyList()

    fun entry(key: String): CatalogueEntry? = entries.firstOrNull { it.key == key }

    /** An app by its layout id or, failing that, its bare name (the first match, local before peers). */
    fun app(named: String): CatalogueEntry? =
        apps.firstOrNull { it.ref == named } ?: apps.firstOrNull { it.ref.split('/').last() == named }

    fun peer(name: String?): PeerStatus? = name?.let { n -> peers.firstOrNull { it.name == n } }

    companion object {
        /** Reads one refresh; throws [CatalogueError.NotASpace] when a required route's answer is not ai-space's. */
        fun decode(payload: CataloguePayload): Catalogue {
            val appRows = required(payload.apps, "/api/apps") { o ->
                if (!o.isNullOrAbsent("ok") && o.opt("ok") !is Boolean) null else o.arr("apps")?.let { Json.lossy(it, CatalogApp) }
            }
            val agentRows = required(payload.agents, "/api/agents") { o -> o.arr("agents")?.let { Json.lossy(it, AgentInfo) } }
            val widgetRows = required(payload.widgets, "/api/widgets") { o -> o.arr("widgets")?.let { Json.lossy(it, CatalogWidget) } }
            val peers = Json.obj(payload.peers)?.arr("peers")?.let { Json.lossy(it, PeerStatus) } ?: emptyList()
            val offline = peers.filter { it.isOffline }.map { it.name }.toSet()

            var screens: List<PanelScreen>? = null
            Json.obj(payload.layout)?.obj("layout")?.let { layout ->
                screens = layout.arr("screens")?.let { Json.lossy(it, PanelScreen) }
            }
            val domain = Json.obj(payload.router)?.str("domain")?.takeIf { it.isNotEmpty() }?.lowercase()

            return Catalogue(
                apps = appRows
                    .filter { it.hidden != true && it.status != "archived" && !it.url.isNullOrEmpty() }
                    .map { entry(it, offline) },
                agents = agentRows.map { entry(it, offline) },
                widgets = widgetRows,
                peers = peers,
                screens = screens,
                domain = domain,
                fetchedAt = payload.fetchedAt,
            )
        }

        private fun <T> required(text: String, route: String, read: (JSONObject) -> T?): T {
            val o = Json.obj(text) ?: throw CatalogueError.NotASpace(route)
            return read(o) ?: throw CatalogueError.NotASpace(route)
        }

        fun entry(a: CatalogApp, offlinePeers: Set<String> = emptySet()): CatalogueEntry {
            val reach = when {
                a.stale == true || (a.peer != null && a.peer in offlinePeers) -> Reach.peerOffline
                a.status == "paused" -> Reach.paused
                a.service != null -> when (a.service.health) {
                    "ok" -> Reach.up
                    "down" -> Reach.down
                    else -> Reach.unknown
                }
                else -> Reach.link
            }
            return CatalogueEntry(
                kind = EntryKind.app, ref = a.id, title = a.title, detail = a.description, i18n = a.i18n,
                icon = a.icon, peer = a.peer, link = a.url, reach = reach,
            )
        }

        fun entry(a: AgentInfo, offlinePeers: Set<String> = emptySet()): CatalogueEntry = CatalogueEntry(
            kind = EntryKind.agent, ref = a.id, title = a.title, detail = a.description, i18n = a.i18n,
            icon = a.avatar, peer = a.peer, link = null,
            reach = if (a.peer != null && a.peer in offlinePeers) Reach.peerOffline else Reach.unknown,
        )

        fun entry(w: CatalogWidget): CatalogueEntry = CatalogueEntry(
            kind = EntryKind.widget, ref = w.id, title = w.title, detail = null, i18n = w.i18n,
            icon = w.icon, peer = w.peer, link = w.link,
            reach = if (w.stale == true) Reach.peerOffline else if (w.ok == false) Reach.down else Reach.unknown,
        )
    }
}
