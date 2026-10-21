package dev.aispace.android.ui.shell

import android.app.Activity
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat
import dev.aispace.android.AppModel
import dev.aispace.android.HubPage
import dev.aispace.android.Pager
import dev.aispace.android.R
import dev.aispace.android.core.Connection
import dev.aispace.android.core.Screens
import dev.aispace.android.ui.home.HomePage
import dev.aispace.android.ui.home.ScreenEditorSheet
import dev.aispace.android.ui.hub.HubCover
import dev.aispace.android.ui.settings.SettingsPage
import dev.aispace.android.ui.theme.AISpaceTheme
import dev.aispace.android.ui.theme.AiTheme
import dev.aispace.android.ui.theme.Sheet
import dev.aispace.android.ui.theme.SpaceBackdrop
import dev.aispace.android.ui.theme.ThemeTokens
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlin.math.abs

/** The app: the connect page while no Space is saved, else the Space's pages and what lies over them. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RootView(model: AppModel) {
    AISpaceTheme(model.theme, model.appearance) {
        val t = AiTheme.tokens
        // Read so a change to the saved Spaces makes the view again (model.selected reads the store).
        val connections by model.store.connections.collectAsState()
        val selected = connections.let { model.selected }
        Box(Modifier.fillMaxSize().background(t.ground)) {
            if (selected != null) {
                key(selected.id) { MainTabs(model, selected) }
            } else {
                ConnectView(model, isFirst = true)
            }
        }
        if (model.showingAdd) {
            ModalBottomSheet(
                onDismissRequest = { model.showingAdd = false },
                sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
                containerColor = t.ground,
                dragHandle = null,
            ) {
                ConnectView(model, isFirst = false, modifier = Modifier.heightIn(min = 560.dp))
            }
        }
        SystemBars(model)
    }
}

/** Light or dark system bar icons: by the app page's own background while one is on show, else the theme. */
@Composable
private fun SystemBars(model: AppModel) {
    val view = LocalView.current
    val tokens = AiTheme.tokens
    val page = model.page
    val background = page?.session?.pageBackground?.collectAsState()?.value
    val dark = if (background != null) Color(background).luminance() < 0.5f else tokens.dark
    SideEffect {
        val window = (view.context.findActivity() as? Activity)?.window ?: return@SideEffect
        WindowCompat.getInsetsController(window, view).apply {
            isAppearanceLightStatusBars = !dark
            isAppearanceLightNavigationBars = !dark
        }
    }
}

/**
 * The pages side by side, swiped through as on a phone's home screen: Home, each screen of the panel,
 * Settings. The pager alone follows [AppModel.pager] (cdad4b0): a swipe does not recompose the pages,
 * and the neighbour is composed before the swipe reaches it.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MainTabs(model: AppModel, connection: Connection) {
    val t = AiTheme.tokens
    val loader = remember(connection) { model.loader(connection) }
    val icons = remember(connection) { model.icons(connection) }
    val settings = remember(connection) { model.settings(connection) }
    val backdrops = remember(connection) { model.backdrops(connection) }
    val catalogue by loader.catalogue.collectAsState()
    val records by model.screens.records.collectAsState()
    val all = remember(records, connection.id) { model.screens.screens(connection.id) }
    val pages = remember(all) { listOf(Pager.HOME) + all.map { it.id } + listOf(Pager.SETTINGS) }
    val currentPages by rememberUpdatedState(pages)
    val state = rememberPagerState(initialPage = pages.indexOf(model.pagerID).coerceAtLeast(0)) { currentPages.size }

    // The model moves the pager (a new screen, a link, a tab): it scrolls to that page.
    LaunchedEffect(state) {
        model.pager.id.collect { id ->
            val index = currentPages.indexOf(id)
            if (index >= 0 && index != state.currentPage && !state.isScrollInProgress) state.animateScrollToPage(index)
        }
    }
    // A swipe moves the model; the page is named by id, so a screen added or removed keeps its place.
    LaunchedEffect(state) {
        snapshotFlow { state.settledPage }.distinctUntilChanged().collect { index ->
            val id = currentPages.getOrNull(index) ?: return@collect
            if (id != model.pagerID) model.pagerID = id
        }
    }
    LaunchedEffect(pages) {
        val index = pages.indexOf(model.pagerID)
        if (index >= 0 && index != state.currentPage) state.scrollToPage(index)
    }
    BackHandler(enabled = model.pagerID != Screens.home && model.page == null && !model.showingWebPanel && model.hubPage == null) {
        model.pagerID = Screens.home
    }

    var windowSize by remember { mutableStateOf(IntSize.Zero) }
    val version by backdrops.version.collectAsState()
    Box(Modifier.fillMaxSize().onSizeChanged { windowSize = it }) {
        // One continuous backdrop for Home, the screens and Settings, the status bar included.
        val name = t.preset.backdrop
        val artwork = if (name != null) {
            @Suppress("UNUSED_EXPRESSION") version
            backdrops.image(name, t.dark, windowSize.width, windowSize.height)
        } else null
        SpaceBackdrop(artwork)
        // Settings is a translucent sheet over the backdrop (as the panel's settings): drawn behind the
        // pager where the Settings page is, so the blur stays still while the page slides over it.
        val settingsAt = pages.lastIndex
        val settingsNear by remember(settingsAt) {
            derivedStateOf { abs(state.currentPage + state.currentPageOffsetFraction - settingsAt) < 1f }
        }
        if (settingsNear) {
            val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
            Sheet(
                artwork,
                Modifier.drawWithContent {
                    val edge = (settingsAt - state.currentPage - state.currentPageOffsetFraction) * size.width
                    if (rtl) clipRect(right = size.width - edge) { this@drawWithContent.drawContent() }
                    else clipRect(left = edge) { this@drawWithContent.drawContent() }
                },
            )
        }
        HorizontalPager(
            state = state,
            beyondViewportPageCount = 1,
            key = { index -> currentPages.getOrNull(index) ?: index },
            modifier = Modifier.fillMaxSize(),
        ) { index ->
            when (val id = currentPages.getOrNull(index)) {
                null -> Box(Modifier.fillMaxSize())
                Pager.HOME -> HomePage(model, connection, loader, icons, screenID = null, modifier = Modifier.fillMaxSize())
                Pager.SETTINGS -> SettingsPage(model, connection, loader, settings, icons, modifier = Modifier.fillMaxSize())
                else -> HomePage(model, connection, loader, icons, screenID = id, modifier = Modifier.fillMaxSize())
            }
        }
        // One status-bar scrim outside the pager, so neighbouring pages never overlap theirs.
        val top = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
        Box(
            Modifier
                .fillMaxWidth()
                .height(top)
                .clearAndSetSemantics {}
                .background(Brush.verticalGradient(0f to t.ground.copy(alpha = 0.85f), 0.5f to t.ground.copy(alpha = 0.85f), 1f to t.ground.copy(alpha = 0f))),
        )

        // Covers over the pages: a page of the Space, the web panel, an app's page.
        var lastHub by remember { mutableStateOf<HubPage?>(null) }
        model.hubPage?.let { if (lastHub != it) lastHub = it }
        AnimatedVisibility(model.hubPage != null, enter = coverIn(), exit = coverOut()) {
            lastHub?.let { page -> HubCover(model, connection, page, loader, icons, artwork, onClose = { model.hubPage = null }) }
        }
        AnimatedVisibility(model.showingWebPanel, enter = coverIn(), exit = coverOut()) {
            WebPanelView(model, connection, remember(connection) { model.panel(connection) })
        }
        var lastPage by remember { mutableStateOf(model.page) }
        model.page?.let { if (lastPage?.id != it.id) lastPage = it }
        AnimatedVisibility(model.page != null, enter = coverIn(), exit = coverOut()) {
            // A closed tab's web view is gone: while its cover leaves, nothing is drawn in it.
            lastPage?.takeIf { p -> model.appTabs.any { it.id == p.id } }?.let { AppBrowser(model, it) }
        }
    }

    if (model.showingScreenMenu) ScreenMenu(model, connection, all.map { it.id }, hasCatalogue = catalogue != null)
    if (model.confirmingDeleteScreen) {
        AlertDialog(
            onDismissRequest = { model.confirmingDeleteScreen = false },
            title = { Text(stringResource(R.string.shell_delete_screen_title)) },
            text = { Text(stringResource(R.string.shell_delete_screen_message)) },
            confirmButton = {
                TextButton(onClick = {
                    model.confirmingDeleteScreen = false
                    model.removeScreen(model.homePage, connection)
                }) { Text(stringResource(R.string.shell_delete_screen), color = ThemeTokens.danger) }
            },
            dismissButton = { TextButton(onClick = { model.confirmingDeleteScreen = false }) { Text(stringResource(R.string.shell_cancel)) } },
        )
    }
    if (model.confirmingResetScreens) {
        AlertDialog(
            onDismissRequest = { model.confirmingResetScreens = false },
            title = { Text(stringResource(R.string.shell_replace_title)) },
            text = { Text(stringResource(R.string.shell_replace_message)) },
            confirmButton = {
                TextButton(onClick = {
                    model.confirmingResetScreens = false
                    model.resetScreens(connection)
                }) { Text(stringResource(R.string.shell_replace), color = ThemeTokens.danger) }
            },
            dismissButton = { TextButton(onClick = { model.confirmingResetScreens = false }) { Text(stringResource(R.string.shell_cancel)) } },
        )
    }
    model.editingScreen?.let { id ->
        ScreenEditorSheet(model, connection, loader, icons, screen = id, onDismiss = { model.editingScreen = null })
    }
}

private fun coverIn() = slideInVertically(tween(300)) { it } + fadeIn(tween(300))
private fun coverOut() = slideOutVertically(tween(300)) { it } + fadeOut(tween(300))

/** The actions on the screens, asked for by a long press on one (iOS: a confirmation dialog). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ScreenMenu(model: AppModel, connection: Connection, ids: List<String>, hasCatalogue: Boolean) {
    val t = AiTheme.tokens
    val index = ids.indexOf(model.homePage).coerceAtLeast(0)
    val title = if (index == 0) stringResource(R.string.shell_screen_main) else stringResource(R.string.shell_screen_n, index + 1)
    fun close() { model.showingScreenMenu = false }
    ModalBottomSheet(
        onDismissRequest = { close() },
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = t.solid,
    ) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(bottom = 12.dp)) {
            Text(
                title, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = t.secondaryText, textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp),
            )
            MenuRow(stringResource(R.string.shell_new_screen), enabled = ids.size < Screens.limit) {
                close()
                model.addScreen(connection)
            }
            MenuRow(stringResource(R.string.shell_edit_screen)) {
                close()
                model.editingScreen = model.homePage
            }
            MenuRow(stringResource(R.string.shell_copy_layout), enabled = hasCatalogue) {
                close()
                model.confirmingResetScreens = true
            }
            if (model.homePage != Screens.home) {
                MenuRow(stringResource(R.string.shell_delete_screen), color = ThemeTokens.danger) {
                    close()
                    model.confirmingDeleteScreen = true
                }
            }
        }
    }
}

@Composable
private fun MenuRow(title: String, enabled: Boolean = true, color: Color = AiTheme.tokens.text, onClick: () -> Unit) {
    Box(
        Modifier.fillMaxWidth().heightIn(min = 52.dp).clickable(enabled = enabled, onClick = onClick).padding(horizontal = 24.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        Text(title, fontSize = 17.sp, color = if (enabled) color else color.copy(alpha = 0.38f))
    }
}
