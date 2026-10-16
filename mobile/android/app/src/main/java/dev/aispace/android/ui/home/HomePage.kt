@file:OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)

package dev.aispace.android.ui.home

import android.text.format.DateUtils
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.outlined.AddBox
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.GridView
import androidx.compose.material.icons.outlined.IndeterminateCheckBox
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.OpenInBrowser
import androidx.compose.material.icons.outlined.RemoveCircleOutline
import androidx.compose.material.icons.outlined.Warning
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MenuDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.PullToRefreshDefaults
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.ClipboardManager
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.aispace.android.AppModel
import dev.aispace.android.MainTab
import dev.aispace.android.R
import dev.aispace.android.core.CatalogWidget
import dev.aispace.android.core.Catalogue
import dev.aispace.android.core.CatalogueEntry
import dev.aispace.android.core.CatalogueSearch
import dev.aispace.android.core.Connection
import dev.aispace.android.core.EntryKind
import dev.aispace.android.core.PanelScreen
import dev.aispace.android.core.Reach
import dev.aispace.android.core.Screens
import dev.aispace.android.core.Urls
import dev.aispace.android.live.CatalogueLoader
import dev.aispace.android.live.IconStore
import dev.aispace.android.live.LoaderStatus
import dev.aispace.android.ui.theme.AiTheme
import dev.aispace.android.ui.theme.ConnectingMark
import dev.aispace.android.ui.theme.ThemeTokens
import dev.aispace.android.ui.theme.glass
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch
import java.net.URI
import kotlin.math.max

/**
 * The launcher, in the two parts the panel has (docs/panel.md#screens). Without a screen it is the Home
 * page: the library of every app, agent and widget of the Space, with one search. With one it is that
 * screen, a page of its own between Home and Settings, with nothing above it: a swipe moves between the
 * pages and a long press on the empty part of the screen brings up its actions.
 *
 * The screens are this phone's (ScreenStore): copied from the panel once, then changed here without
 * touching the Space. Each page is one LazyColumn whose titles, rows of tiles and cards are its own
 * items, so a widget card is made when it is scrolled to.
 */
@Composable
fun HomePage(
    model: AppModel,
    connection: Connection,
    loader: CatalogueLoader,
    icons: IconStore,
    screenID: String?,
    modifier: Modifier = Modifier,
) {
    val catalogue by loader.catalogue.collectAsState()
    val status by loader.status.collectAsState()
    val records by model.screens.records.collectAsState()
    val screens = remember(records, connection.id) { model.screens.screens(connection.id) }
    val env = HomeEnv(model, connection, loader, icons, screens, status, catalogue)
    if (screenID != null) {
        ScreenPage(env, screenID, modifier)
    } else {
        LibraryPage(env, modifier)
    }
}

/** What every part of a page reads, gathered once per composition of the page. */
private class HomeEnv(
    val model: AppModel,
    val connection: Connection,
    val loader: CatalogueLoader,
    val icons: IconStore,
    val screens: List<PanelScreen>,
    val status: LoaderStatus,
    val catalogue: Catalogue?,
) {
    /**
     * A health dot is a claim about now: while the catalogue on show is not this moment's answer (the
     * Space is unreachable or wants a sign-in), running and not answering are unknown.
     */
    fun current(entry: CatalogueEntry): CatalogueEntry {
        if (status == LoaderStatus.Ok || (entry.reach != Reach.up && entry.reach != Reach.down)) return entry
        return entry.copy(reach = Reach.unknown)
    }

    /** A widget's row link, or its own page for null: a page of the Space in the app, anything else as an entry. */
    fun open(link: String?, widget: CatalogueEntry) {
        val url = link?.let { Urls.resolve(connection.url, it) }
        if (url == null || Urls.scheme(url) !in setOf("http", "https")) return model.open(widget)
        model.open(url, widget.displayTitle(), widget.key, connection)
    }
}

/** Whether the status card says anything: not while the catalogue is current, nor while a shown one refreshes. */
private fun showsStatus(status: LoaderStatus, catalogue: Catalogue?): Boolean = when (status) {
    LoaderStatus.Ok -> false
    LoaderStatus.Loading -> catalogue == null
    else -> true
}

// Pages

/** One row of a page's LazyColumn, with the room above it. */
private sealed class PageItem(val key: String, val gap: Dp) {
    class Status(gap: Dp) : PageItem("status", gap)
    class Heading(val title: Int, gap: Dp) : PageItem("heading-$title", gap)
    class Tiles(key: String, val entries: List<CatalogueEntry>, val screen: String?, gap: Dp) : PageItem(key, gap)
    class Widget(val widget: CatalogWidget, val screen: String?, gap: Dp) : PageItem("widget-${widget.id}", gap)
    class NothingInLibrary(gap: Dp) : PageItem("empty-library", gap)
    class NoResults(val query: String, gap: Dp) : PageItem("empty-search", gap)
    class NothingOnScreen(gap: Dp) : PageItem("empty-screen", gap)
}

/** Builds a page's rows: [spacing] between the page's parts, 16 between the rows of one grid. */
private class PageRows(private val spacing: Dp) {
    val items = ArrayList<PageItem>()
    private fun gap(extra: Dp = 0.dp): Dp = if (items.isEmpty()) 0.dp else spacing + extra

    fun status() { items.add(PageItem.Status(gap())) }

    /** A section's title; after another section it stands further from it than from its own rows. */
    fun heading(title: Int, first: Boolean) { items.add(PageItem.Heading(title, gap(if (first) 0.dp else 10.dp))) }

    fun grid(prefix: String, entries: List<CatalogueEntry>, columns: Int, screen: String?) {
        entries.chunked(columns).forEachIndexed { i, row ->
            items.add(PageItem.Tiles("$prefix-$i", row, screen, if (i == 0) gap() else 16.dp))
        }
    }

    fun widget(widget: CatalogWidget, screen: String?) { items.add(PageItem.Widget(widget, screen, gap())) }
    fun add(make: (Dp) -> PageItem) { items.add(make(gap())) }
}

/** How many tiles a row holds: the iPhone's adaptive grid, 76 at least and 12 apart. */
private fun columnsFor(width: Dp): Int = max(1, ((width + 12.dp) / 88.dp).toInt())

@Composable
private fun LibraryPage(env: HomeEnv, modifier: Modifier) {
    val model = env.model
    val focusManager = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val requester = remember { FocusRequester() }
    var searchFocused by remember { mutableStateOf(false) }
    // The keyboard goes on submit, a tap in the catalogue, a scroll, and leaving Home; the query stays.
    val dismiss by rememberUpdatedState {
        if (searchFocused) {
            focusManager.clearFocus(force = true)
            keyboard?.hide()
        }
    }
    LaunchedEffect(model.pager) { model.pager.id.drop(1).collect { dismiss() } }
    LaunchedEffect(model.page?.id, model.hubPage, model.showingWebPanel) { dismiss() }
    DisposableEffect(Unit) { onDispose { keyboard?.hide() } }

    val statusTop = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    val fieldTop = statusTop + 12.dp
    val query = model.query
    Box(modifier.fillMaxSize()) {
        Box(
            Modifier
                .fillMaxSize()
                .pointerInput(Unit) {
                    // Watches without taking: tiles still open and the list still scrolls under it.
                    awaitEachGesture {
                        awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                        dismiss()
                    }
                },
        ) {
            Page(env, top = fieldTop + 48.dp + 12.dp + 12.dp, longPress = null) { columns ->
                val catalogue = env.catalogue
                val visible = showsStatus(env.status, catalogue)
                remember(catalogue, query, columns, visible) {
                    PageRows(12.dp).apply {
                        if (visible) status()
                        if (catalogue != null) library(catalogue, query, columns)
                    }.items
                }
            }
        }
        SearchField(
            model = model,
            focused = searchFocused,
            requester = requester,
            onFocusChange = { searchFocused = it },
            onSubmit = { dismiss() },
            modifier = Modifier.align(Alignment.TopCenter).padding(top = fieldTop),
        )
    }
}

/** Everything the Space has, pinned or not. */
private fun PageRows.library(catalogue: Catalogue, query: String, columns: Int) {
    val apps = CatalogueSearch.filter(catalogue.apps, query)
    val agents = CatalogueSearch.filter(catalogue.agents, query)
    val widgets = catalogue.widgets.filter { CatalogueSearch.matches(Catalogue.entry(it), query) }
    if (apps.isNotEmpty()) {
        heading(R.string.home_apps, first = true)
        grid("apps", apps, columns, null)
    }
    if (agents.isNotEmpty()) {
        heading(R.string.home_agents, first = apps.isEmpty())
        grid("agents", agents, columns, null)
    }
    if (widgets.isNotEmpty()) {
        heading(R.string.home_widgets, first = apps.isEmpty() && agents.isEmpty())
        widgets.distinctBy { it.id }.forEach { widget(it, null) }
    }
    if (apps.isEmpty() && agents.isEmpty() && widgets.isEmpty()) {
        if (query.isEmpty()) add { PageItem.NothingInLibrary(it) } else add { PageItem.NoResults(query, it) }
    }
}

@Composable
private fun ScreenPage(env: HomeEnv, screenID: String, modifier: Modifier) {
    val model = env.model
    val haptics = LocalHapticFeedback.current
    val showsWidgets = model.showsWidgets
    val screen = env.screens.firstOrNull { it.id == screenID }
    val statusTop = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    Page(
        env, top = statusTop + 12.dp, modifier = modifier,
        longPress = {
            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
            model.showingScreenMenu = true
        },
    ) { columns ->
        val catalogue = env.catalogue
        val visible = showsStatus(env.status, catalogue)
        remember(catalogue, screen, columns, visible, showsWidgets) {
            PageRows(22.dp).apply {
                if (visible) status()
                if (catalogue != null && screen != null) screenRows(catalogue, screen, columns, showsWidgets)
            }.items
        }
    }
}

/**
 * One screen: its tiles in one grid, its widget cards below, in the screen's order. A key whose entry is
 * gone is skipped and kept, so it comes back with the entry.
 */
private fun PageRows.screenRows(catalogue: Catalogue, screen: PanelScreen, columns: Int, showsWidgets: Boolean) {
    val byKey = catalogue.entries.associateBy { it.key }
    val tiles = screen.items.mapNotNull { byKey[it] }.filter { it.kind != EntryKind.widget }
    // Settings can leave the widget cards off the screens; they stay pinned and stay in the library.
    val widgets = if (showsWidgets) {
        screen.items.mapNotNull { key -> catalogue.widgets.firstOrNull { "widget:${it.id}" == key } }.distinctBy { it.id }
    } else {
        emptyList()
    }
    if (tiles.isNotEmpty()) grid("tiles", tiles, columns, screen.id)
    widgets.forEach { widget(it, screen.id) }
    if (tiles.isEmpty() && widgets.isEmpty()) add { PageItem.NothingOnScreen(it + 40.dp) }
}

/**
 * A page: one LazyColumn under the status bar, pulled down to refresh the catalogue. [longPress], on a
 * screen, is taken by the empty part of the page only: a tile or a card keeps its own, since it takes
 * the touch first.
 */
@Composable
private fun Page(
    env: HomeEnv,
    top: Dp,
    longPress: (() -> Unit)?,
    modifier: Modifier = Modifier,
    rows: @Composable (columns: Int) -> List<PageItem>,
) {
    val scope = rememberCoroutineScope()
    var refreshing by remember { mutableStateOf(false) }
    val pull = rememberPullToRefreshState()
    val press by rememberUpdatedState(longPress)
    val bottom = WindowInsets.navigationBars.union(WindowInsets.ime).asPaddingValues().calculateBottomPadding()
    val listState = rememberLazyListState()
    Box(
        modifier
            .fillMaxSize()
            .then(
                if (longPress != null) {
                    Modifier.pointerInput(Unit) { detectTapGestures(onLongPress = { press?.invoke() }) }
                } else {
                    Modifier
                },
            ),
    ) {
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = {
                refreshing = true
                scope.launch {
                    try {
                        env.loader.refresh()
                    } finally {
                        refreshing = false
                    }
                }
            },
            state = pull,
            modifier = Modifier.fillMaxSize(),
            indicator = {
                PullToRefreshDefaults.Indicator(
                    state = pull,
                    isRefreshing = refreshing,
                    modifier = Modifier.align(Alignment.TopCenter).padding(top = top - 12.dp),
                )
            },
        ) {
            BoxWithConstraints(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.displayCutout.only(WindowInsetsSides.Horizontal))) {
                val columns = columnsFor(maxWidth - 32.dp)
                val pageItems = rows(columns)
                LazyColumn(
                    state = listState,
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = top, bottom = bottom + 24.dp),
                ) {
                    items(pageItems, key = { it.key }, contentType = { it::class.simpleName }) { item ->
                        Box(Modifier.fillMaxWidth().padding(top = item.gap)) {
                            PageRow(env, item, columns)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun PageRow(env: HomeEnv, item: PageItem, columns: Int) {
    val t = AiTheme.tokens
    when (item) {
        is PageItem.Status -> StatusCard(env.model, env.connection, env.loader, env.status, env.catalogue)
        is PageItem.Heading -> Text(
            stringResource(item.title), style = HomeType.title3, fontWeight = FontWeight.SemiBold, color = t.text,
            modifier = Modifier.semantics { heading() },
        )
        is PageItem.Tiles -> Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.Top,
        ) {
            item.entries.forEach { entry ->
                Box(Modifier.weight(1f)) { MenuTile(env, entry, item.screen) }
            }
            repeat(columns - item.entries.size) { Spacer(Modifier.weight(1f)) }
        }
        is PageItem.Widget -> {
            val entry = Catalogue.entry(item.widget)
            var menu by remember { mutableStateOf(false) }
            WidgetCard(
                widget = item.widget,
                icons = env.icons,
                open = { link -> env.open(link, entry) },
                onLongPress = { menu = true },
                menu = { EntryMenu(env, entry, item.screen, expanded = menu, onDismiss = { menu = false }) },
            )
        }
        is PageItem.NothingInLibrary -> EmptyState(
            Icons.Outlined.GridView,
            stringResource(R.string.home_nothing_here),
            stringResource(R.string.home_nothing_here_detail),
        )
        is PageItem.NoResults -> EmptyState(
            Icons.Filled.Search,
            stringResource(R.string.home_no_results, item.query),
            stringResource(R.string.home_no_results_detail),
        )
        is PageItem.NothingOnScreen -> EmptyState(
            Icons.Outlined.GridView,
            stringResource(R.string.home_screen_empty),
            stringResource(R.string.home_screen_empty_detail),
        ) {
            Button(onClick = { env.model.tab = MainTab.Home }) { Text(stringResource(R.string.home_open_home)) }
        }
    }
}

@Composable
private fun MenuTile(env: HomeEnv, entry: CatalogueEntry, screen: String?) {
    var menu by remember { mutableStateOf(false) }
    Box {
        EntryTile(
            entry = env.current(entry),
            icons = env.icons,
            peer = env.catalogue?.peer(entry.peer),
            onClick = { env.model.open(entry) },
            onLongClick = { menu = true },
        )
        EntryMenu(env, entry, screen, expanded = menu, onDismiss = { menu = false })
    }
}

/** The title of the screen at [index]: Main, then Screen 2, Screen 3… */
@Composable
internal fun screenTitle(index: Int): String =
    if (index == 0) stringResource(R.string.home_screen_main) else stringResource(R.string.home_screen_n, index + 1)

/**
 * What a long press offers: the screens the entry is on, and the ways out to the browser. With several
 * screens, Add to Panel turns the menu into the list of them.
 */
@Composable
private fun EntryMenu(env: HomeEnv, entry: CatalogueEntry, screen: String?, expanded: Boolean, onDismiss: () -> Unit) {
    val model = env.model
    val connection = env.connection
    val screens = env.screens
    val clipboard = LocalClipboardManager.current
    var choosing by remember { mutableStateOf(false) }
    val close = {
        choosing = false
        onDismiss()
    }
    DropdownMenu(expanded = expanded, onDismissRequest = close) {
        if (choosing) {
            ScreenChoices(screens, entry.key) { id ->
                model.togglePin(entry.key, id, connection)
                close()
            }
        } else {
            MainEntryItems(env, entry, screen, close, onChoose = { choosing = true }, clipboard = clipboard)
        }
    }
}

/** Add to Panel with several screens: each screen, ticked where the entry is. */
@Composable
private fun ScreenChoices(screens: List<PanelScreen>, key: String, choose: (String) -> Unit) {
    screens.forEachIndexed { index, s ->
        val on = key in s.items
        DropdownMenuItem(
            text = { Text(screenTitle(index)) },
            onClick = { choose(s.id) },
            leadingIcon = if (on) {
                { Icon(Icons.Filled.Check, contentDescription = null) }
            } else {
                { Spacer(Modifier.size(24.dp)) }
            },
        )
    }
}

@Composable
private fun MainEntryItems(
    env: HomeEnv,
    entry: CatalogueEntry,
    screen: String?,
    close: () -> Unit,
    onChoose: () -> Unit,
    clipboard: ClipboardManager,
) {
    val model = env.model
    val connection = env.connection
    val screens = env.screens
    val danger = MenuDefaults.itemColors(textColor = ThemeTokens.danger, leadingIconColor = ThemeTokens.danger)
    if (screen != null) {
        DropdownMenuItem(
            text = { Text(stringResource(R.string.home_remove_from_screen)) },
            onClick = {
                model.togglePin(entry.key, screen, connection)
                close()
            },
            leadingIcon = { Icon(Icons.Outlined.RemoveCircleOutline, contentDescription = null) },
            colors = danger,
        )
    }
    if (screens.size <= 1) {
        if (screen == null) {
            val on = Screens.isPinned(screens, Screens.home, entry.key)
            DropdownMenuItem(
                text = { Text(stringResource(if (on) R.string.home_remove_from_panel else R.string.home_add_to_panel)) },
                onClick = {
                    model.togglePin(entry.key, Screens.home, connection)
                    close()
                },
                leadingIcon = {
                    Icon(if (on) Icons.Outlined.IndeterminateCheckBox else Icons.Outlined.AddBox, contentDescription = null)
                },
            )
        }
    } else {
        DropdownMenuItem(
            text = { Text(stringResource(R.string.home_add_to_panel)) },
            onClick = onChoose,
            leadingIcon = { Icon(Icons.Outlined.AddBox, contentDescription = null) },
            trailingIcon = { Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null) },
        )
    }
    val url: URI? = entry.pageURL(connection.url)
    if (url != null) {
        DropdownMenuItem(
            text = { Text(stringResource(R.string.home_open_in_browser)) },
            onClick = {
                close()
                model.openInBrowser(url)
            },
            leadingIcon = { Icon(Icons.Outlined.OpenInBrowser, contentDescription = null) },
        )
        DropdownMenuItem(
            text = { Text(stringResource(R.string.home_copy_link)) },
            onClick = {
                clipboard.setText(AnnotatedString(url.toString()))
                close()
            },
            leadingIcon = { Icon(Icons.Outlined.ContentCopy, contentDescription = null) },
        )
    }
}

/** What stands in for a page's content when there is none: a symbol, a title, a line, and maybe a way on. */
@Composable
private fun EmptyState(icon: ImageVector, title: String, description: String, action: (@Composable () -> Unit)? = null) {
    val t = AiTheme.tokens
    Column(
        Modifier.fillMaxWidth().padding(vertical = 24.dp, horizontal = 16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(icon, contentDescription = null, tint = t.secondaryText, modifier = Modifier.size(44.dp))
        Text(title, style = HomeType.title3, fontWeight = FontWeight.SemiBold, color = t.text, textAlign = TextAlign.Center)
        Text(description, style = HomeType.subheadline, color = t.secondaryText, textAlign = TextAlign.Center)
        if (action != null) {
            Spacer(Modifier.height(4.dp))
            action()
        }
    }
}

// Search

/**
 * The library's search: one field over apps, agents and widgets, in a glass capsule. Idle (empty and
 * not being edited) it shows a centred hint; a tap anywhere on it reveals the field.
 */
@Composable
private fun SearchField(
    model: AppModel,
    focused: Boolean,
    requester: FocusRequester,
    onFocusChange: (Boolean) -> Unit,
    onSubmit: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val t = AiTheme.tokens
    val query = model.query
    val idle = query.isEmpty() && !focused
    val search = stringResource(R.string.home_search)
    val label = stringResource(R.string.home_search_label)
    val clear = stringResource(R.string.home_clear)
    val style = TextStyle(fontSize = 19.sp, lineHeight = 24.sp, color = t.text)
    Box(
        modifier
            .padding(horizontal = 24.dp)
            .fillMaxWidth()
            .height(48.dp)
            .glass(24.dp)
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { requester.requestFocus() }
            .padding(horizontal = 18.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Icon(
                Icons.Filled.Search, contentDescription = null, tint = t.text,
                modifier = Modifier.size(22.dp).alpha(if (idle) 0f else 1f),
            )
            BasicTextField(
                value = query,
                onValueChange = { model.query = it },
                modifier = Modifier
                    .weight(1f)
                    .focusRequester(requester)
                    .onFocusChanged { onFocusChange(it.isFocused) }
                    .semantics { contentDescription = label },
                singleLine = true,
                textStyle = style,
                cursorBrush = SolidColor(t.accent),
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.None,
                    autoCorrectEnabled = false,
                    keyboardType = KeyboardType.Text,
                    imeAction = ImeAction.Search,
                ),
                keyboardActions = KeyboardActions(onSearch = { onSubmit() }),
                decorationBox = { inner ->
                    Box(contentAlignment = Alignment.CenterStart) {
                        if (query.isEmpty() && focused) Text(search, style = style, color = t.secondaryText, maxLines = 1)
                        inner()
                    }
                },
            )
            if (query.isNotEmpty()) {
                Icon(
                    Icons.Filled.Cancel, contentDescription = clear, tint = t.secondaryText,
                    modifier = Modifier.size(22.dp).clickable { model.query = "" },
                )
            }
        }
        if (idle) {
            Row(
                Modifier.align(Alignment.Center).clearAndSetSemantics {},
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Icon(Icons.Filled.Search, contentDescription = null, tint = t.text, modifier = Modifier.size(22.dp))
                Text(search, style = style, color = t.text)
            }
        }
    }
}

// Status

/** Where the catalogue stands when it is not simply current. */
@Composable
private fun StatusCard(
    model: AppModel,
    connection: Connection,
    loader: CatalogueLoader,
    status: LoaderStatus,
    catalogue: Catalogue?,
) {
    val t = AiTheme.tokens
    val scope = rememberCoroutineScope()
    val retry = { scope.launch { loader.refresh() }; Unit }
    when (status) {
        LoaderStatus.Ok -> {}
        LoaderStatus.Loading -> if (catalogue == null) {
            val connecting = stringResource(R.string.home_connecting)
            Column(
                Modifier.fillMaxWidth().padding(vertical = 40.dp).clearAndSetSemantics { contentDescription = connecting },
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                ConnectingMark()
                Text(connecting, style = HomeType.subheadline, color = t.secondaryText)
            }
        }
        LoaderStatus.SignInNeeded -> StatusCardBody(
            loader, catalogue, Icons.Outlined.Key, t.accent,
            stringResource(R.string.home_sign_in_to, Urls.host(connection.url) ?: connection.name),
            stringResource(R.string.home_sign_in_detail),
        ) {
            Button(onClick = { model.signIn() }) { Text(stringResource(R.string.home_sign_in)) }
        }
        is LoaderStatus.Unreachable -> StatusCardBody(
            loader, catalogue, Icons.Outlined.WifiOff, ThemeTokens.warning,
            stringResource(R.string.home_unreachable), status.message,
        ) {
            OutlinedButton(onClick = retry) { Text(stringResource(R.string.home_retry)) }
        }
        is LoaderStatus.Incompatible -> StatusCardBody(
            loader, catalogue, Icons.Outlined.Warning, ThemeTokens.danger,
            stringResource(R.string.home_incompatible), status.message,
        ) {
            OutlinedButton(onClick = retry) { Text(stringResource(R.string.home_retry)) }
        }
        else -> {}
    }
}

@Composable
private fun StatusCardBody(
    loader: CatalogueLoader,
    catalogue: Catalogue?,
    icon: ImageVector,
    tint: Color,
    title: String,
    detail: String,
    action: @Composable BoxScope.() -> Unit,
) {
    val t = AiTheme.tokens
    val lastKnown by loader.isLastKnown.collectAsState()
    Column(
        Modifier.fillMaxWidth().glass().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(22.dp))
            Text(title, style = HomeType.headline, color = t.text)
        }
        Text(detail, style = HomeType.subheadline, color = t.secondaryText)
        val at = catalogue?.fetchedAt
        if (lastKnown && at != null) {
            val ago = DateUtils.getRelativeTimeSpanString(at.toEpochMilli(), System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS).toString()
            Text(stringResource(R.string.home_last_known, ago), style = HomeType.footnote, color = t.secondaryText)
        }
        Box(content = action)
    }
}
