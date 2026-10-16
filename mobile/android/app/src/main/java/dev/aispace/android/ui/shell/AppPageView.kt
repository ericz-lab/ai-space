package dev.aispace.android.ui.shell

import android.content.Context
import android.provider.Settings
import android.view.accessibility.AccessibilityManager
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.tappableElement
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.HighlightOff
import androidx.compose.material.icons.filled.LibraryAdd
import androidx.compose.material.icons.filled.LibraryAddCheck
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.OpenInBrowser
import androidx.compose.material.icons.filled.Public
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.edit
import dev.aispace.android.AppModel
import dev.aispace.android.DebugLaunch
import dev.aispace.android.OpenPage
import dev.aispace.android.R
import dev.aispace.android.core.PageControlPlacement
import dev.aispace.android.core.PagePoint
import dev.aispace.android.core.PageSize
import dev.aispace.android.core.Screens
import dev.aispace.android.core.Urls
import dev.aispace.android.ui.theme.AiTheme
import dev.aispace.android.ui.theme.ConnectingMark
import kotlin.math.roundToInt

/** The app page on show over everything, kept by its id so a tab switch makes a new view for the next page. */
@Composable
fun AppBrowser(model: AppModel, page: OpenPage) {
    androidx.compose.runtime.key(page.id) {
        AppPageView(model, page)
    }
}

/**
 * An app's page: its retained web view edge to edge (e54633e: the page runs to the screen's bottom
 * edge, under a gesture bar, with the page's own background behind the system bars), the mark while it
 * connects, a bar naming the host of a sign-in page, and the one floating More button (22a4d0f).
 */
@Composable
fun AppPageView(model: AppModel, page: OpenPage) {
    val session = page.session
    val t = AiTheme.tokens
    val state by session.state.collectAsState()
    val hasContent by session.hasContent.collectAsState()
    val isLoading by session.isLoading.collectAsState()
    val progress by session.progress.collectAsState()
    val currentUrl by session.currentUrl.collectAsState()
    val background by session.pageBackground.collectAsState()
    val controlsHidden by session.controlsHidden.collectAsState()
    val canGoBack by session.canGoBack.collectAsState()
    val reduceMotion = rememberReduceMotion()
    val screenReader = rememberTouchExploration()
    var menuOpen by remember { mutableStateOf(DebugLaunch.takeAppMenu()) }
    val showsSpacePage = currentUrl?.let { session.hosts().contains(it) } ?: false
    val controlsVisible = menuOpen || screenReader || !controlsHidden || state.isFailure

    LaunchedEffect(page.id) { session.showControls() }
    // Back closes the menu, then goes back in the page, then leaves it.
    BackHandler {
        when {
            menuOpen -> menuOpen = false
            canGoBack -> session.goBack()
            else -> model.page = null
        }
    }

    Box(Modifier.fillMaxSize().background(Color(background))) {
        Column(Modifier.fillMaxSize().statusBarsPadding()) {
            // Named once its page is there to be read, not while its redirects pass.
            val host = currentUrl?.let { Urls.host(it) }
            if (hasContent && !showsSpacePage && host != null) SignInBar(host)
            Box(
                Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    // Under a gesture bar the page runs to the edge; three-button navigation is not drawn over.
                    .windowInsetsPadding(WindowInsets.tappableElement.only(WindowInsetsSides.Bottom))
                    .imePadding(),
            ) {
                WebContainer(session, Modifier.fillMaxSize().alpha(if (state.isFailure) 0f else 1f))
                WebFailure(session, Modifier.background(t.ground))
                androidx.compose.animation.AnimatedVisibility(
                    visible = !hasContent && !state.isFailure,
                    enter = fadeIn(tween(if (reduceMotion) 0 else 250)),
                    exit = fadeOut(tween(if (reduceMotion) 0 else 250)),
                ) {
                    // Reaching the app, through its access layer when it has one, draws nothing in the
                    // web view; the mark stands in until a page does (6ee42f8).
                    Column(
                        Modifier.fillMaxSize().background(t.ground).semantics(mergeDescendants = true) {},
                        verticalArrangement = Arrangement.Center,
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        ConnectingMark()
                        Spacer(Modifier.height(14.dp))
                        Text(stringResource(R.string.shell_connecting), fontSize = 15.sp, color = t.secondaryText)
                    }
                }
            }
        }
        if (isLoading) {
            LinearProgressIndicator(
                progress = { progress },
                modifier = Modifier.statusBarsPadding().fillMaxWidth().height(2.dp),
                color = t.accent,
                trackColor = Color.Transparent,
            )
        }
        // The dimming behind an open menu covers the whole screen, the system bars too; the menu
        // itself stays in the safe area.
        val dismissLabel = stringResource(R.string.shell_dismiss_page_controls)
        androidx.compose.animation.AnimatedVisibility(
            visible = menuOpen,
            enter = fadeIn(tween(if (reduceMotion) 0 else 200)),
            exit = fadeOut(tween(if (reduceMotion) 0 else 200)),
        ) {
            Box(
                Modifier
                    .fillMaxSize()
                    .background(Color.Black.copy(alpha = 0.12f))
                    .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { menuOpen = false }
                    .semantics { contentDescription = dismissLabel },
            )
        }
        PageControls(
            model = model,
            page = page,
            menuOpen = menuOpen,
            onMenu = { menuOpen = it },
            visible = controlsVisible,
            reduceMotion = reduceMotion,
            modifier = Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().imePadding(),
        )
        DownloadOutcome(session)
    }
}

/** The floating button and its menu, in the page's safe area. */
@Composable
private fun PageControls(
    model: AppModel,
    page: OpenPage,
    menuOpen: Boolean,
    onMenu: (Boolean) -> Unit,
    visible: Boolean,
    reduceMotion: Boolean,
    modifier: Modifier,
) {
    val context = LocalContext.current
    val prefs = remember { context.getSharedPreferences("app", Context.MODE_PRIVATE) }
    var stored by remember { mutableStateOf(prefs.getString(PLACEMENT_KEY, null) ?: PageControlPlacement().stored) }
    fun store(placement: PageControlPlacement) {
        stored = placement.stored
        prefs.edit { putString(PLACEMENT_KEY, placement.stored) }
    }
    val density = LocalDensity.current
    val moveLabel = stringResource(R.string.shell_move_other_side)
    val controlsLabel = stringResource(R.string.shell_page_controls)
    val expanded = stringResource(R.string.shell_expanded)
    val collapsed = stringResource(R.string.shell_collapsed)

    BoxWithConstraints(modifier) {
        val size = PageSize(maxWidth.value.toDouble(), maxHeight.value.toDouble())
        val placement = PageControlPlacement.fromStored(stored)
        val rest = placement.center(size)
        val above = placement.menuAbove(size)
        val room = placement.menuRoom(size)
        /** The button's centre while a finger is moving it, in dp. */
        var dragCenter by remember { mutableStateOf<PagePoint?>(null) }
        // The settle animates from where the finger let go to the place it snapped to.
        val center = dragCenter ?: rest
        val animatedX by animateFloatAsState(
            center.x.toFloat(),
            if (dragCenter != null || reduceMotion) snap() else spring(dampingRatio = 0.78f, stiffness = 380f),
            label = "x",
        )
        val animatedY by animateFloatAsState(
            center.y.toFloat(),
            if (dragCenter != null || reduceMotion) snap() else spring(dampingRatio = 0.78f, stiffness = 380f),
            label = "y",
        )
        val shown by animateFloatAsState(if (visible) 1f else 0f, tween(if (reduceMotion) 0 else 200), label = "shown")
        val diameter = PageControlPlacement.diameter.dp

        AnimatedVisibility(
            visible = menuOpen,
            enter = fadeIn(tween(if (reduceMotion) 0 else 200)) +
                slideInVertically(tween(if (reduceMotion) 0 else 200)) { if (above) it / 4 else -it / 4 },
            exit = fadeOut(tween(if (reduceMotion) 0 else 200)) +
                slideOutVertically(tween(if (reduceMotion) 0 else 200)) { if (above) it / 4 else -it / 4 },
            modifier = Modifier
                .align(
                    when {
                        placement.side == PageControlPlacement.Side.left && above -> Alignment.BottomStart
                        placement.side == PageControlPlacement.Side.left -> Alignment.TopStart
                        above -> Alignment.BottomEnd
                        else -> Alignment.TopEnd
                    },
                )
                .padding(horizontal = PageControlPlacement.sideMargin.dp)
                .padding(
                    top = if (above) 0.dp else room.inset.dp,
                    bottom = if (above) room.inset.dp else 0.dp,
                ),
        ) {
            PageMenu(
                model = model,
                page = page,
                close = { onMenu(false) },
                modifier = Modifier.widthIn(max = 440.dp).heightIn(max = room.height.dp),
            )
        }

        // A hidden button leaves over the edge it rests against.
        val away = if (placement.side == PageControlPlacement.Side.left) -96f else 96f
        val tracker = remember { VelocityTracker() }
        var translation by remember { mutableStateOf(Offset.Zero) }
        Box(
            Modifier
                .offset {
                    IntOffset(
                        ((animatedX - PageControlPlacement.diameter.toFloat() / 2 + away * (1 - shown)) * density.density).roundToInt(),
                        ((animatedY - PageControlPlacement.diameter.toFloat() / 2) * density.density).roundToInt(),
                    )
                }
                .size(diameter)
                .scale(if (dragCenter == null) 1f else 1.08f)
                .alpha(shown)
                .shadow(8.dp, CircleShape, clip = false)
                .clip(CircleShape)
                .background(AiTheme.tokens.solid.copy(alpha = 0.94f))
                .border(1.dp, AiTheme.tokens.text.copy(alpha = 0.12f), CircleShape)
                .then(
                    if (!visible) {
                        Modifier.clearAndSetSemantics {}
                    } else {
                        Modifier
                            .clickable(role = Role.Button, onClickLabel = null) { onMenu(!menuOpen) }
                            .pointerInput(rest, size) {
                                detectDragGestures(
                                    onDragStart = {
                                        onMenu(false)
                                        translation = Offset.Zero
                                        tracker.resetTracking()
                                    },
                                    onDragEnd = {
                                        // The predicted end lets a flick carry the button across the page.
                                        val v = tracker.calculateVelocity()
                                        val end = PagePoint(
                                            rest.x + (translation.x + v.x * FLING_SECONDS) / density.density,
                                            rest.y + (translation.y + v.y * FLING_SECONDS) / density.density,
                                        )
                                        store(PageControlPlacement.settled(end, size))
                                        dragCenter = null
                                    },
                                    onDragCancel = { dragCenter = null },
                                    onDrag = { change, amount ->
                                        change.consume()
                                        translation += amount
                                        tracker.addPosition(change.uptimeMillis, translation)
                                        dragCenter = PageControlPlacement.clamped(
                                            PagePoint(rest.x + translation.x / density.density, rest.y + translation.y / density.density),
                                            size,
                                        )
                                    },
                                )
                            }
                            .semantics {
                                contentDescription = controlsLabel
                                stateDescription = if (menuOpen) expanded else collapsed
                                customActions = listOf(CustomAccessibilityAction(moveLabel) { store(placement.opposite); true })
                            }
                    },
                ),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Filled.MoreHoriz, contentDescription = null, tint = AiTheme.tokens.text, modifier = Modifier.size(26.dp))
        }
    }
}

/** The page controls: back, forward, reload; the ways out of the page; the open tabs of this Space. */
@Composable
private fun PageMenu(model: AppModel, page: OpenPage, close: () -> Unit, modifier: Modifier) {
    val session = page.session
    val context = LocalContext.current
    val t = AiTheme.tokens
    val canGoBack by session.canGoBack.collectAsState()
    val canGoForward by session.canGoForward.collectAsState()
    val isLoading by session.isLoading.collectAsState()
    val currentUrl by session.currentUrl.collectAsState()
    val records by model.screens.records.collectAsState()
    val shape = RoundedCornerShape(24.dp)
    Column(
        modifier
            .shadow(18.dp, shape, clip = false)
            .clip(shape)
            .background(t.solid.copy(alpha = 0.97f))
            .border(1.dp, t.text.copy(alpha = 0.12f), shape),
    ) {
        Column(
            Modifier
                .weight(1f, fill = false)
                .heightIn(max = 380.dp)
                .verticalScroll(rememberScrollState())
                .padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(page.title, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, color = t.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(
                    (currentUrl ?: session.home).let { Urls.host(it) } ?: "",
                    fontSize = 12.sp, color = t.secondaryText, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
            Row(Modifier.fillMaxWidth().heightIn(min = 44.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                IconButton(onClick = { session.goBack(); close() }, enabled = canGoBack) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.shell_back))
                }
                IconButton(onClick = { session.goForward(); close() }, enabled = canGoForward) {
                    Icon(Icons.AutoMirrored.Filled.ArrowForward, contentDescription = stringResource(R.string.shell_forward))
                }
                Spacer(Modifier.weight(1f))
                if (isLoading) {
                    IconButton(onClick = { session.stopLoading(); close() }) {
                        Icon(Icons.Filled.HighlightOff, contentDescription = stringResource(R.string.shell_stop))
                    }
                } else {
                    IconButton(onClick = { session.reload(); close() }) {
                        Icon(Icons.Filled.Refresh, contentDescription = stringResource(R.string.shell_reload))
                    }
                }
            }
            HorizontalDivider(color = t.text.copy(alpha = 0.1f))
            MenuItem(Icons.Filled.Home, stringResource(R.string.shell_return_to_space)) {
                close()
                model.returnToSpace()
            }
            MenuItem(Icons.Filled.Share, stringResource(R.string.shell_share)) {
                close()
                shareLink(context, session.shareUrl.toString())
            }
            MenuItem(Icons.Filled.OpenInBrowser, stringResource(R.string.shell_open_in_browser)) {
                model.openInBrowser(session.shareUrl)
                close()
            }
            val key = page.key
            val connection = model.store.connection(page.connection)
            if (key != null && connection != null) {
                @Suppress("UNUSED_EXPRESSION") records
                val pinned = model.screens.isPinned(key, page.connection)
                MenuItem(
                    if (pinned) Icons.Filled.LibraryAddCheck else Icons.Filled.LibraryAdd,
                    stringResource(if (pinned) R.string.shell_remove_from_panel else R.string.shell_add_to_panel),
                ) {
                    model.togglePin(key, Screens.home, connection)
                    close()
                }
            }
            MenuItem(Icons.Filled.Close, stringResource(R.string.shell_close_tab), color = Color(0xFFEF4444)) {
                model.closeTab(page.id)
            }
        }
        HorizontalDivider(color = t.text.copy(alpha = 0.1f))
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(stringResource(R.string.shell_open_tabs), fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = t.secondaryText)
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                for (tab in model.appTabs.filter { it.connection == page.connection }) {
                    TabChip(model, tab, current = tab.id == page.id, close = close)
                }
            }
        }
    }
}

@Composable
private fun TabChip(model: AppModel, tab: OpenPage, current: Boolean, close: () -> Unit) {
    val t = AiTheme.tokens
    val closeLabel = stringResource(R.string.shell_close_tab_named, tab.title)
    Row(
        Modifier
            .widthIn(max = 260.dp)
            .clip(RoundedCornerShape(14.dp))
            .background(if (current) t.accent.copy(alpha = 0.16f) else t.text.copy(alpha = 0.06f)),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            Modifier
                .weight(1f, fill = false)
                .heightIn(min = 44.dp)
                .clickable {
                    close()
                    model.showTab(tab.id)
                }
                .semantics { selected = current }
                .padding(start = 12.dp, end = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                if (current) Icons.Filled.CheckCircle else Icons.Filled.Public,
                contentDescription = null,
                tint = if (current) t.accent else t.text,
                modifier = Modifier.size(18.dp),
            )
            Spacer(Modifier.size(6.dp))
            Text(tab.title, color = t.text, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        IconButton(onClick = { model.closeTab(tab.id) }, modifier = Modifier.size(44.dp).semantics { contentDescription = closeLabel }) {
            Icon(Icons.Filled.Close, contentDescription = null, tint = t.text, modifier = Modifier.size(16.dp))
        }
    }
}

@Composable
private fun MenuItem(icon: ImageVector, title: String, color: Color = AiTheme.tokens.text, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 36.dp).clickable(onClick = onClick),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(22.dp))
        Spacer(Modifier.size(14.dp))
        Text(title, color = color, fontSize = 17.sp)
    }
}

/** Whether animations are switched off in the system settings (the closest to Reduce Motion). */
@Composable
fun rememberReduceMotion(): Boolean {
    val context = LocalContext.current
    return remember {
        Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    }
}

/** Whether a screen reader explores the screen by touch (TalkBack), followed while it changes. */
@Composable
fun rememberTouchExploration(): Boolean {
    val context = LocalContext.current
    val manager = remember { context.getSystemService(Context.ACCESSIBILITY_SERVICE) as? AccessibilityManager }
    var enabled by remember { mutableStateOf(manager?.isTouchExplorationEnabled == true) }
    DisposableEffect(manager) {
        val listener = AccessibilityManager.TouchExplorationStateChangeListener { enabled = it }
        manager?.addTouchExplorationStateChangeListener(listener)
        onDispose { manager?.removeTouchExplorationStateChangeListener(listener) }
    }
    return enabled
}

private const val PLACEMENT_KEY = "pageControlPlacement"

/** How far a flick carries the button past where it was let go: its speed for this long. */
private const val FLING_SECONDS = 0.25f
