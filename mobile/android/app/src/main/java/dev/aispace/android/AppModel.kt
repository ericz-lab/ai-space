package dev.aispace.android

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import dev.aispace.android.core.CatalogueCache
import dev.aispace.android.core.CatalogueEntry
import dev.aispace.android.core.ChatRoute
import dev.aispace.android.core.Connection
import dev.aispace.android.core.ConnectionStore
import dev.aispace.android.core.DeepLink
import dev.aispace.android.core.EntryKind
import dev.aispace.android.core.QuickAction
import dev.aispace.android.core.ScreenStore
import dev.aispace.android.core.Screens
import dev.aispace.android.core.SpaceHosts
import dev.aispace.android.core.SpaceState
import dev.aispace.android.live.AppPaths
import dev.aispace.android.live.BackdropStore
import dev.aispace.android.live.CatalogueLoader
import dev.aispace.android.live.ChatStore
import dev.aispace.android.live.IconStore
import dev.aispace.android.live.LoaderStatus
import dev.aispace.android.live.SettingsLoader
import dev.aispace.android.live.TerminalStore
import dev.aispace.android.ui.theme.Appearance
import dev.aispace.android.ui.theme.ThemePreset
import dev.aispace.android.web.SpaceProfile
import dev.aispace.android.web.WebSession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch
import java.net.URI
import java.util.UUID

/** Home is everything the Space has; Panel is this phone's screens; Settings is the Space's settings and the phone's own. */
enum class MainTab { Home, Panel, Settings }

/**
 * The pages the app swipes through, left to right: Home, each screen, Settings. A screen's page is its
 * id; these two are not screen ids (those are letters, digits, - and _ only).
 */
object Pager {
    const val HOME = "#home"
    const val SETTINGS = "#settings"
}

/**
 * The page on show in the pager, as an object of its own. Kept apart from AppModel so a swipe, which
 * changes it, recomposes the pager only and not every page (cdad4b0).
 */
class PagerPosition {
    private val state = MutableStateFlow(Screens.home)
    val id: StateFlow<String> = state.asStateFlow()
    fun move(to: String) { state.value = to }
}

/** A page of the Space drawn by the app, over the tabs (iOS HubPage). */
sealed class HubPage {
    data object Inbox : HubPage()
    data object Tasks : HubPage()
    data object ModelUsage : HubPage()
    data object AppUsage : HubPage()
    data object AppModels : HubPage()
    data object Events : HubPage()
    data object Packages : HubPage()
    data object Terminal : HubPage()
    /** The agents to talk to, or one agent's conversation by its catalogue key. */
    data class Chat(val agent: String?) : HubPage()
}

/** An app's page on show over the tabs. */
class OpenPage(
    /** The catalogue entry it was opened from, when there is one (for the pin to the home screen). */
    val key: String?,
    val title: String,
    val connection: UUID,
    val session: WebSession,
) {
    val id: UUID = UUID.randomUUID()
}

/**
 * The app's state: saved Spaces, the catalogue, web sessions and screens of each, and what is on show.
 * One per process (held by [AISpaceApplication]), so an activity recreated by a rotation or a theme
 * change finds its Spaces, tabs and shells as they were. Leaving a Space keeps its sign-in; signing out
 * or removing it discards it.
 *
 * View state is Compose snapshot state, read by the composables directly; everything here runs on the
 * main thread.
 */
class AppModel(private val context: Context) {
    val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val prefs: SharedPreferences = context.getSharedPreferences("app", Context.MODE_PRIVATE)

    val store = ConnectionStore(AppPaths.connections)
    val screens = ScreenStore(AppPaths.screens)
    private val cache = CatalogueCache(AppPaths.caches)

    var selectedID by mutableStateOf<UUID?>(null)
        private set

    /** Where the pager stands, observed by the pager alone. */
    val pager = PagerPosition()

    /**
     * The page on show: [Pager.HOME], a screen's id, or [Pager.SETTINGS]. The app opens on the first
     * screen of the panel (74344ce); the library is one swipe to its left.
     */
    var pagerID: String
        get() = pager.id.value
        set(value) {
            pager.move(value)
            if (value != Pager.HOME && value != Pager.SETTINGS) homePage = value
        }

    /** This phone's own display choices, kept in the app's preferences. */
    var appearance by mutableStateOf(Appearance.of(prefs.getString("appearance", null)))
        private set
    fun updateAppearance(value: Appearance) {
        appearance = value
        prefs.edit().putString("appearance", value.name).apply()
    }

    /** The theme this phone is drawn in, by the id of one of the panel's presets. */
    var themeID by mutableStateOf(prefs.getString("theme", null) ?: ThemePreset.aurora.id)
        private set
    val theme: ThemePreset get() = ThemePreset.named(themeID)
    fun updateTheme(id: String) {
        themeID = id
        prefs.edit().putString("theme", id).apply()
    }

    /** Draws the app in a theme for this launch without keeping it (DebugLaunch): the saved choice is the operator's. */
    internal fun overrideTheme(id: String) {
        themeID = id
    }

    var showsWidgets by mutableStateOf(!prefs.getBoolean("hidesWidgets", false))
        private set
    fun updateShowsWidgets(value: Boolean) {
        showsWidgets = value
        prefs.edit().putBoolean("hidesWidgets", !value).apply()
    }

    /** The actions on the screens, asked for by a long press on a screen. */
    var showingScreenMenu by mutableStateOf(false)
    var query by mutableStateOf("")

    /**
     * The screen the Panel tab opens on: the one last shown. Not snapshot state, as the page on show is
     * not: it changes with every swipe, and the views read it only when acted on.
     */
    var homePage: String = Screens.home
        private set

    /** The Space's web panel over the tabs: the sign-in, package installs and what the app does not draw. */
    var showingWebPanel by mutableStateOf(false)
    /** A page of the Space drawn by the app, over the tabs. */
    var hubPage by mutableStateOf<HubPage?>(null)
    /** The screen whose entries are being rearranged, in a sheet. */
    var editingScreen by mutableStateOf<String?>(null)
    var confirmingDeleteScreen by mutableStateOf(false)
    var confirmingResetScreens by mutableStateOf(false)
    var page by mutableStateOf<OpenPage?>(null)
    /** Retained web pages, isolated by Space; returning home does not close a tab. */
    val appTabs = mutableStateListOf<OpenPage>()
    var showingAdd by mutableStateOf(false)
    var confirmingSignOut by mutableStateOf(false)

    /** Set when the web panel was opened to sign in, so a finished sign-in closes it again. */
    private var closeWebPanelAfterSignIn = false
    /** A link that arrived before the catalogue of the Space it was opened in did. */
    private var pendingLink: Pair<DeepLink, UUID>? = null

    /** Hands an address to the system browser; every way out of the app goes through here. */
    var openInBrowser: (URI) -> Unit = { url ->
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url.toString())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try { context.startActivity(intent) } catch (_: ActivityNotFoundException) { }
    }

    private val loaders = HashMap<UUID, CatalogueLoader>()
    private val icons = HashMap<UUID, IconStore>()
    private val settings = HashMap<UUID, SettingsLoader>()
    private val chats = HashMap<String, ChatStore>()
    private val terminals = HashMap<UUID, TerminalStore>()
    private val backdrops = HashMap<UUID, BackdropStore>()
    private val panels = HashMap<UUID, WebSession>()
    private val profiles = HashMap<UUID, SpaceProfile>()

    init {
        // Downloads are handed to the share sheet and not kept: what an earlier launch left goes.
        AppPaths.downloads.deleteRecursively()
        selectedID = store.defaultConnection?.id
        // The web profiles of Spaces removed in an earlier launch: WebView keeps a profile it has loaded
        // in this process, so their files go before any profile is loaded, once the first frame is up.
        SpaceProfile.schedule(context) { store.connections.value.map { it.id } }
        screens.records.onEach { publishQuickActions() }.launchIn(scope)
    }

    /** The tab the page on show belongs to; choosing Panel returns to the screen last shown. */
    var tab: MainTab
        get() = when (pagerID) {
            Pager.HOME -> MainTab.Home
            Pager.SETTINGS -> MainTab.Settings
            else -> MainTab.Panel
        }
        set(value) {
            pagerID = when (value) {
                MainTab.Home -> Pager.HOME
                MainTab.Settings -> Pager.SETTINGS
                MainTab.Panel -> {
                    val c = selected
                    if (c != null && screens.screens(c.id).any { it.id == homePage }) homePage else Screens.home
                }
            }
        }

    // Spaces

    val selected: Connection?
        get() = selectedID?.let { store.connection(it) } ?: store.defaultConnection

    /** The Space's own web profile: its cookies, storage and cache, apart from every other Space. */
    fun profile(id: UUID): SpaceProfile = profiles.getOrPut(id) { SpaceProfile(context, id) }

    fun loader(connection: Connection): CatalogueLoader {
        loaders[connection.id]?.let { if (it.connection.url == connection.url) return it }
        val profile = profile(connection.id)
        val l = CatalogueLoader(connection, cache, profile.cookies, scope)
        l.onCatalogue = { catalogue ->
            screens.seed(connection.id, catalogue.panelScreens)
            icons[connection.id]?.retryFailed()
            backdrops[connection.id]?.retryFailed()
            publishQuickActions()
            val pending = pendingLink
            if (pending != null && pending.second == connection.id) {
                pendingLink = null
                // The operator may have moved to another Space while this one was loading.
                if (selected?.id == connection.id) handle(pending.first)
            }
        }
        loaders[connection.id] = l
        icons[connection.id] = IconStore(l.api, AppPaths.icons(connection.id), scope)
        scope.launch { l.refresh() }
        return l
    }

    fun icons(connection: Connection): IconStore {
        icons[connection.id]?.let { return it }
        loader(connection)
        return icons.getValue(connection.id)
    }

    fun settings(connection: Connection): SettingsLoader =
        settings.getOrPut(connection.id) { SettingsLoader(loader(connection).api, scope) }

    /** An agent's conversation, kept while the app runs so leaving the page does not lose it. */
    fun chat(connection: Connection, base: String): ChatStore =
        chats.getOrPut("${connection.id}|$base") { ChatStore(loader(connection).api, base, scope) }

    /** The Space's shells open on this phone, kept while the app runs as the chats are. */
    fun terminal(connection: Connection): TerminalStore =
        terminals.getOrPut(connection.id) {
            TerminalStore(loader(connection).api, scope).also { it.openLink = { url -> openInBrowser(url) } }
        }

    /** The artwork of the themes that have one, as this Space serves it. */
    fun backdrops(connection: Connection): BackdropStore =
        backdrops.getOrPut(connection.id) {
            BackdropStore(context, connection.url, profile(connection.id), AppPaths.backdrops(connection.id), scope)
        }

    fun hosts(connection: Connection): SpaceHosts =
        SpaceHosts.of(connection.url, loaders[connection.id]?.catalogue?.value)

    /** The Space's web panel: what the browser has and the app does not draw. */
    fun panel(connection: Connection): WebSession {
        panels[connection.id]?.let { if (it.space == connection.url) return it }
        val s = WebSession(context, connection.url, null, profile(connection.id)) { hosts(connection) }
        s.openExternally = { openInBrowser(it) }
        // Signing in on the panel is what lets the native catalogue in: refresh it right away.
        s.onStateChange = { state ->
            val loader = loaders[connection.id]
            if (state == SpaceState.Ready && loader != null) {
                if (loader.status.value != LoaderStatus.Ok) scope.launch { loader.refresh() }
                if (closeWebPanelAfterSignIn) {
                    closeWebPanelAfterSignIn = false
                    showingWebPanel = false
                }
            }
        }
        panels[connection.id] = s
        return s
    }

    fun select(id: UUID) {
        if (store.connection(id) == null) return
        page = null
        selectedID = id
        query = ""
        homePage = Screens.home
        tab = MainTab.Panel
        editingScreen = null
        showingWebPanel = false
        hubPage = null
        publishQuickActions()
    }

    // Screens

    /** Pins the entry to the screen, or takes it off when it is there. This phone's layout only. */
    fun togglePin(key: String, screen: String, connection: Connection) {
        val pinned = screens.isPinned(key, connection.id, screen)
        screens.edit(connection.id) { if (pinned) Screens.unpin(it, screen, key) else Screens.pin(it, screen, key) }
    }

    /** A new empty screen after the last one, shown at once. */
    fun addScreen(connection: Connection) {
        val made = Screens.add(screens.screens(connection.id)) ?: return
        screens.edit(connection.id) { made.screens }
        pagerID = made.id
    }

    fun removeScreen(id: String, connection: Connection) {
        if (id == Screens.home) return
        // The page before it comes up, as when a page of the home screen is removed.
        val all = screens.screens(connection.id)
        val index = all.indexOfFirst { it.id == id }
        val before = if (index >= 0) all[maxOf(index - 1, 0)].id else Screens.home
        if (homePage == id) homePage = before
        if (pagerID == id) pagerID = before
        if (editingScreen == id) editingScreen = null
        screens.edit(connection.id) { Screens.remove(it, id) }
    }

    /** Throws this phone's layout away for the panel's as it is now. */
    fun resetScreens(connection: Connection) {
        val catalogue = loaders[connection.id]?.catalogue?.value ?: return
        homePage = Screens.home
        if (tab == MainTab.Panel) pagerID = Screens.home
        editingScreen = null
        screens.reset(connection.id, catalogue.panelScreens)
    }

    fun add(name: String, url: URI) {
        val c = store.add(name, url)
        showingAdd = false
        select(c.id)
    }

    fun remove(id: UUID) {
        discard(id)
        screens.forget(id)
        store.remove(id)
        if (selectedID == id) selectedID = store.defaultConnection?.id
        // The profile's files go once no web view uses it any more.
        scope.launch {
            delay(1000)
            SpaceProfile.delete(context, id)
        }
        publishQuickActions()
    }

    /**
     * Ends the Space's session on this phone: cookies and every other piece of website data of its
     * profile, the saved catalogue and the open pages. The address and the screens stay.
     */
    fun signOut(connection: Connection) {
        val profile = profile(connection.id)
        icons[connection.id]?.clear()
        AppPaths.icons(connection.id).deleteRecursively()
        discardTabs(connection.id)
        terminals[connection.id]?.closeAll()
        panels.remove(connection.id)?.stop()
        val loader = loaders[connection.id]
        loader?.forget()
        settings[connection.id]?.forget()
        showingWebPanel = false
        scope.launch {
            profile.clear()
            // Again, for a refresh that started while the cookies were still there.
            loader?.forget()
            loader?.refresh()
        }
        tab = MainTab.Home
    }

    fun signIn() {
        closeWebPanelAfterSignIn = true
        openWebPanel()
    }

    /** Shows the Space's web panel over the tabs. */
    fun openWebPanel() {
        showingWebPanel = true
        selected?.let { panel(it).recoverIfFailed() }
    }

    /** One cover at a time: the page on show leaves before the next comes up. */
    private fun afterHub(next: () -> Unit) {
        if (hubPage == null) return next()
        hubPage = null
        scope.launch {
            delay(350)
            next()
        }
    }

    fun webPanelFromHub() = afterHub { openWebPanel() }

    /** A link on one of the Space's pages: the page closes and the address opens as any other. */
    fun openFromHub(url: URI, title: String, connection: Connection) = afterHub { open(url, title, null, connection) }

    private fun discard(id: UUID) {
        discardTabs(id)
        panels.remove(id)?.stop()
        loaders.remove(id)?.forget()
        settings.remove(id)
        backdrops.remove(id)
        AppPaths.backdrops(id).deleteRecursively()
        chats.keys.filter { it.startsWith("$id|") }.forEach { chats.remove(it)?.cancel() }
        terminals.remove(id)?.closeAll()
        icons[id]?.clear()
        // A Space can be removed before its icon store has been opened in this launch.
        AppPaths.icons(id).deleteRecursively()
        icons.remove(id)
        profiles.remove(id)
    }

    /** The phone came back to the app: failed pages try again and the catalogue catches up. */
    fun becameActive() {
        val c = selected ?: return
        panels[c.id]?.recoverIfFailed()
        page?.session?.recoverIfFailed()
        loaders[c.id]?.let { l -> scope.launch { l.refresh() } }
    }

    // Opening

    fun open(entry: CatalogueEntry) {
        val connection = selected ?: return
        val url = entry.pageURL(connection.url)
        if (url == null) {
            // An agent has no page: it is talked to.
            if (entry.kind == EntryKind.agent) hubPage = HubPage.Chat(entry.key) else openWebPanel()
            return
        }
        open(url, entry.displayTitle(), entry.key, connection)
    }

    /** A page of the Space opens in the app with the Space's session; any other address is the browser's. */
    fun open(url: URI, title: String, key: String?, connection: Connection) {
        if (!hosts(connection).contains(url)) {
            openInBrowser(url)
            return
        }
        appTabs.firstOrNull { it.connection == connection.id && it.key == key && it.session.home == url }?.let {
            showTab(it.id)
            return
        }
        val session = WebSession(context, connection.url, url, profile(connection.id)) { hosts(connection) }
        session.openExternally = { openInBrowser(it) }
        // An app's host may sit behind its own access rule; a sign-in finished there counts for the catalogue too.
        session.onStateChange = { state ->
            val loader = loaders[connection.id]
            if (state == SpaceState.Ready && loader != null && loader.status.value != LoaderStatus.Ok) {
                scope.launch { loader.refresh() }
            }
        }
        val opened = OpenPage(key, title, connection.id, session)
        appTabs.add(opened)
        page = opened
    }

    fun returnToSpace() {
        page = null
        tab = MainTab.Home
    }

    fun showTab(id: UUID) {
        val next = appTabs.firstOrNull { it.id == id && it.connection == selected?.id } ?: return
        next.session.showControls()
        next.session.recoverIfFailed()
        page = next
    }

    fun closeTab(id: UUID) {
        val index = appTabs.indexOfFirst { it.id == id }
        if (index < 0) return
        val closed = appTabs.removeAt(index)
        closed.session.stop()
        if (page?.id == id) {
            page = appTabs.lastOrNull { it.connection == closed.connection }
            page?.session?.showControls()
        }
    }

    private fun discardTabs(connection: UUID) {
        if (page?.connection == connection) page = null
        appTabs.filter { it.connection == connection }.forEach { it.session.stop() }
        appTabs.removeAll { it.connection == connection }
    }

    /** An `aispace://` link, or a launcher shortcut carrying the Space it was made for. */
    fun handle(intent: Intent?) {
        val data = intent?.data ?: return
        val space = intent.getStringExtra(EXTRA_SPACE)?.let { runCatching { UUID.fromString(it) }.getOrNull() }
        if (space != null) {
            // A shortcut opens the app of the Space it was made for, whichever Space is on show; one for a
            // Space that has been removed since does nothing (b357ab9).
            if (store.connection(space) == null) return
            if (selected?.id != space) select(space)
        }
        DeepLink.parse(data.toString())?.let { handle(it) }
    }

    /**
     * `aispace://` links and launcher shortcuts. A link only ever shows something: it cannot send a
     * message or change the Space, since any web page can open one.
     */
    fun handle(link: DeepLink) {
        val connection = selected ?: return
        when (link) {
            is DeepLink.Show -> {
                page = null
                showingWebPanel = false
                tab = MainTab.Home
            }
            is DeepLink.Inbox -> {
                page = null
                showingWebPanel = false
                hubPage = HubPage.Inbox
            }
            is DeepLink.Chat -> {
                page = null
                showingWebPanel = false
                val entry = link.agent?.let { id -> loaders[connection.id]?.catalogue?.value?.agents?.firstOrNull { it.ref == id } }
                // The text is put in the field, never sent: any web page can open a link.
                val text = link.text
                if (entry != null && text != null) {
                    ChatRoute.base(entry.ref, entry.peer)?.let { base -> chat(connection, base).draft.value = text }
                }
                hubPage = HubPage.Chat(entry?.key)
            }
            is DeepLink.Open -> {
                val catalogue = loaders[connection.id]?.catalogue?.value ?: loader(connection).catalogue.value
                if (catalogue == null) {
                    pendingLink = link to connection.id
                    return
                }
                catalogue.app(link.app)?.let { open(it) }
            }
        }
    }

    /** The first four apps of the home screen of the Space on show, on the app icon's long-press menu. */
    private fun publishQuickActions() {
        val c = selected
        val catalogue = c?.let { loaders[it.id]?.catalogue?.value }
        if (c == null || catalogue == null) {
            ShortcutManagerCompat.removeAllDynamicShortcuts(context)
            return
        }
        val pins = screens.screens(c.id).firstOrNull()?.items ?: emptyList()
        val shortcuts = QuickAction.items(pins, catalogue).mapIndexed { index, action ->
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(action.url.toString()))
                .setClass(context, MainActivity::class.java)
                .putExtra(EXTRA_SPACE, c.id.toString())
            ShortcutInfoCompat.Builder(context, "app-$index")
                .setShortLabel(action.title)
                .setLongLabel(action.subtitle?.let { "${action.title} · $it" } ?: action.title)
                .setIcon(IconCompat.createWithResource(context, R.drawable.ic_shortcut_star))
                .setIntent(intent)
                .build()
        }
        try {
            ShortcutManagerCompat.setDynamicShortcuts(context, shortcuts)
        } catch (_: IllegalArgumentException) {
            // More than the launcher takes: QuickAction.limit keeps under it, but a launcher may take fewer.
        }
    }

    companion object {
        const val EXTRA_SPACE = "dev.aispace.android.space"
    }
}

