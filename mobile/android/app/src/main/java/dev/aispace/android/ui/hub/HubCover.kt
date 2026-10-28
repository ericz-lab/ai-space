package dev.aispace.android.ui.hub

import android.graphics.Bitmap
import android.text.format.DateFormat
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Inventory2
import androidx.compose.material.icons.filled.UnfoldMore
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.aispace.android.AppModel
import dev.aispace.android.HubPage
import dev.aispace.android.R
import dev.aispace.android.core.Connection
import dev.aispace.android.core.InboxThread
import dev.aispace.android.core.ModelChoice
import dev.aispace.android.core.SpaceEvent
import dev.aispace.android.live.CatalogueLoader
import dev.aispace.android.live.HubStore
import dev.aispace.android.live.HubText
import dev.aispace.android.live.IconImages
import dev.aispace.android.live.IconStore
import dev.aispace.android.ui.common.EntryIcon
import dev.aispace.android.ui.terminal.TerminalPage
import dev.aispace.android.ui.theme.AiTheme
import dev.aispace.android.ui.theme.Sheet
import dev.aispace.android.ui.theme.cardPiece
import dev.aispace.android.ui.theme.ThemeTokens
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

/**
 * A page of the Space drawn by the app from the Space's own routes, over the tabs: what the web
 * panel keeps under Settings, the inbox, the chat and the terminal. It sits in a cover, outside
 * the pager, with its own back stack so its rows can lead further in; the system's back pops that
 * stack, then closes the cover through [onClose].
 */
@Composable
fun HubCover(model: AppModel, connection: Connection, page: HubPage, loader: CatalogueLoader, icons: IconStore, artwork: Bitmap?, onClose: () -> Unit) {
    HubText.bind(LocalContext.current)
    val nav = remember(page) { HubNav() }
    nav.onClose = onClose
    BackHandler { nav.back() }
    // The chat and the pages the panel keeps inside its settings sit on the same translucent sheet;
    // the inbox and the terminal are panels of their own, on the ground.
    val sheet = page != HubPage.Inbox && page != HubPage.Terminal
    CompositionLocalProvider(LocalHubNav provides nav, LocalOnSheet provides sheet) {
        Box(Modifier.fillMaxSize().then(if (sheet) Modifier else Modifier.background(AiTheme.tokens.ground))) {
            if (sheet) Sheet(artwork)
            val api = loader.api
            when (page) {
                HubPage.Inbox -> InboxListPage(model, connection, api)
                HubPage.Tasks -> TasksPage(api, icons)
                HubPage.ModelUsage -> ModelUsagePage(api)
                HubPage.AppUsage -> {
                    val catalogue by loader.catalogue.collectAsState()
                    AppUsagePage(api, catalogue)
                }
                HubPage.AppModels -> AppModelsPage(api, icons)
                HubPage.Events -> EventsPage(api)
                HubPage.Packages -> PackagesPage(model, connection, api)
                HubPage.Terminal -> TerminalPage(model.terminal(connection))
                is HubPage.Chat -> {
                    val catalogue by loader.catalogue.collectAsState()
                    val shown = page.agent?.let { key -> AgentChat(model, connection, catalogue, key, icons) { model.hubPage = HubPage.Chat(it.key) } }
                    if (shown != true) AgentsPage(model, connection, loader, icons)
                }
            }
        }
    }
}

// Navigation

/** Where a row of a page leads, inside the cover. */
internal sealed class HubDest {
    data class Task(val id: String) : HubDest()
    data class Event(val event: SpaceEvent) : HubDest()
    data object Capabilities : HubDest()
    data class Inbox(val item: InboxThread) : HubDest()
    data class Agent(val key: String) : HubDest()
}

/** The cover's back stack; empty is the page itself. */
internal class HubNav {
    var onClose: () -> Unit = {}
    private val stack = mutableStateListOf<HubDest>()

    val top: HubDest? get() = stack.lastOrNull()
    val depth: Int get() = stack.size

    fun push(dest: HubDest) {
        stack.add(dest)
    }

    /** Puts [dest] in place of the page on top, or pushes it from the first page. */
    fun replace(dest: HubDest) {
        if (stack.isEmpty()) stack.add(dest) else stack[stack.size - 1] = dest
    }

    /** One page back, or the cover closes from its first page. */
    fun back() {
        if (stack.isEmpty()) onClose() else stack.removeAt(stack.size - 1)
    }

    fun close() = onClose()
}

internal val LocalHubNav = staticCompositionLocalOf { HubNav() }

/** Whether the page is drawn on the translucent sheet, where cards are outlined rather than filled. */
internal val LocalOnSheet = staticCompositionLocalOf { false }

/**
 * A card's surface: on the sheet a faint fill with a hairline edge, as the panel's settings cards
 * (`.setcard`); elsewhere the solid card.
 */
@Composable
internal fun Modifier.card(shape: Shape): Modifier {
    val t = AiTheme.tokens
    return if (LocalOnSheet.current) clip(shape).background(t.text.copy(alpha = 0.02f)).border(1.dp, t.hairline, shape)
    else clip(shape).background(t.solid)
}

// Page frame

/** A page's bar: Close on the cover's first page, Back further in; its own actions at the end. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun HubScaffold(
    title: String,
    actions: @Composable RowScope.() -> Unit = {},
    content: @Composable (PaddingValues) -> Unit,
) {
    val nav = LocalHubNav.current
    val t = AiTheme.tokens
    Scaffold(
        containerColor = Color.Transparent,
        contentColor = t.text,
        topBar = {
            TopAppBar(
                title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleMedium) },
                navigationIcon = {
                    if (nav.depth == 0) {
                        IconButton(onClick = { nav.close() }) { Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.hub_close)) }
                    } else {
                        IconButton(onClick = { nav.back() }) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.hub_back))
                        }
                    }
                },
                actions = actions,
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = Color.Transparent,
                    scrolledContainerColor = Color.Transparent,
                    titleContentColor = t.text,
                    navigationIconContentColor = t.accent,
                    actionIconContentColor = t.accent,
                ),
            )
        },
        content = content,
    )
}

/**
 * A page's list: pulled down, it reads again ([onRefresh]). Rows scroll under the navigation bar,
 * which the list keeps clear at its end.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun HubList(
    padding: PaddingValues,
    onRefresh: suspend () -> Unit,
    state: LazyListState = rememberLazyListState(),
    content: LazyListScope.() -> Unit,
) {
    val scope = rememberCoroutineScope()
    val refresh by rememberUpdatedState(onRefresh)
    var pulling by remember { mutableStateOf(false) }
    PullToRefreshBox(
        isRefreshing = pulling,
        onRefresh = {
            pulling = true
            scope.launch {
                try {
                    refresh()
                } finally {
                    pulling = false
                }
            }
        },
        modifier = Modifier.fillMaxSize().padding(top = padding.calculateTopPadding()),
    ) {
        LazyColumn(
            Modifier.fillMaxSize(),
            state = state,
            contentPadding = PaddingValues(top = 4.dp, bottom = padding.calculateBottomPadding() + 24.dp),
            content = content,
        )
    }
}

/** A group of rows on one card, with a heading above and a note below, as one item of the list. */
internal fun LazyListScope.group(
    key: Any? = null,
    header: String? = null,
    headerContent: (@Composable () -> Unit)? = null,
    footer: (@Composable () -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    item(key = key) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
            SectionHeader(header, headerContent)
            Column(
                Modifier.fillMaxWidth().card(RoundedCornerShape(12.dp)),
                content = content,
            )
            if (footer != null) SectionFooter(footer)
        }
    }
}

/** A group whose rows are items of the list of their own (a long list), one card drawn piece by piece. */
internal fun <T> LazyListScope.groupItems(
    items: List<T>,
    key: (T) -> Any,
    header: String? = null,
    headerContent: (@Composable () -> Unit)? = null,
    footer: (@Composable () -> Unit)? = null,
    row: @Composable (T) -> Unit,
) {
    // An empty list has no section: a page says "nothing yet" under its own header instead.
    if (items.isEmpty()) return
    if (header != null || headerContent != null) {
        item { Box(Modifier.padding(start = 16.dp, end = 16.dp, top = 8.dp)) { SectionHeader(header, headerContent) } }
    }
    itemsIndexed(items, key = { _, item -> key(item) }) { index, item ->
        val first = index == 0
        val last = index == items.size - 1
        val shape: Shape = RoundedCornerShape(
            topStart = if (first) 12.dp else 0.dp, topEnd = if (first) 12.dp else 0.dp,
            bottomStart = if (last) 12.dp else 0.dp, bottomEnd = if (last) 12.dp else 0.dp,
        )
        val t = AiTheme.tokens
        val outlined = LocalOnSheet.current
        Column(
            Modifier.fillMaxWidth()
                .padding(start = 16.dp, end = 16.dp, top = if (first && header == null && headerContent == null) 8.dp else 0.dp, bottom = if (last) 8.dp else 0.dp)
                .then(
                    if (outlined) Modifier.cardPiece(first, last, 12.dp, t.text.copy(alpha = 0.02f), t.hairline)
                    else Modifier.clip(shape).background(t.solid),
                ),
        ) {
            if (!first && !outlined) HorizontalDivider(Modifier.padding(start = 16.dp), color = t.hairline)
            row(item)
        }
    }
    if (footer != null && items.isNotEmpty()) {
        item { Box(Modifier.padding(horizontal = 16.dp)) { SectionFooter(footer) } }
    }
}

@Composable
private fun SectionHeader(header: String?, headerContent: (@Composable () -> Unit)?) {
    if (header == null && headerContent == null) return
    Box(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 6.dp)) {
        if (headerContent != null) {
            headerContent()
        } else if (header != null) {
            Text(header, style = MaterialTheme.typography.labelLarge, color = AiTheme.tokens.secondaryText)
        }
    }
}

@Composable
private fun SectionFooter(footer: @Composable () -> Unit) {
    Box(Modifier.padding(start = 16.dp, end = 16.dp, top = 6.dp)) {
        androidx.compose.material3.ProvideTextStyle(MaterialTheme.typography.bodySmall.copy(color = AiTheme.tokens.secondaryText)) {
            footer()
        }
    }
}

/** A section heading with an app's icon and name. */
@Composable
internal fun AppHeader(icon: String?, title: String, icons: IconImages) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        EntryIcon(icon, Icons.Filled.Inventory2, icons, size = 20.dp)
        Text(title, style = MaterialTheme.typography.labelLarge, color = AiTheme.tokens.secondaryText)
    }
}

/** One row of a card: padded, at least a touch target tall; with [onClick] it leads somewhere. */
@Composable
internal fun Cell(
    onClick: (() -> Unit)? = null,
    enabled: Boolean = true,
    chevron: Boolean = false,
    content: @Composable RowScope.() -> Unit,
) {
    var m = Modifier.fillMaxWidth().heightIn(min = 48.dp)
    if (onClick != null) m = m.clickable(enabled = enabled, onClick = onClick)
    if (!enabled) m = m.alpha(0.45f)
    Row(
        m.padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        content()
        if (chevron) {
            Icon(
                Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = null,
                tint = AiTheme.tokens.secondaryText,
                modifier = Modifier.size(20.dp),
            )
        }
    }
}

/** A name and its value on one row (`LabeledContent`). */
@Composable
internal fun LabeledRow(label: String, value: String) {
    LabeledRow(label) { Text(value, color = AiTheme.tokens.secondaryText, textAlign = TextAlign.End, maxLines = 2, overflow = TextOverflow.Ellipsis) }
}

@Composable
internal fun LabeledRow(label: String, value: @Composable () -> Unit) {
    Cell {
        Text(label, color = AiTheme.tokens.text)
        Spacer(Modifier.weight(1f))
        value()
    }
}

/** Plain text on a row of its own: an empty list, a note. */
@Composable
internal fun NoteCell(text: String, color: Color = AiTheme.tokens.secondaryText) {
    Cell { Text(text, color = color, style = MaterialTheme.typography.bodyMedium) }
}

// Shared pieces

/** What a page says before its rows: that it is reading, or why it could not. */
@Composable
internal fun HubNotice(store: HubStore) {
    val error = store.error
    if (error != null) {
        Warning(stringResource(R.string.hub_unavailable, error))
    } else if (!store.loaded) {
        Cell {
            CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = AiTheme.tokens.accent)
            Text(stringResource(R.string.hub_loading), color = AiTheme.tokens.secondaryText)
        }
    }
    store.saveError?.let { Warning(stringResource(R.string.hub_not_saved, it)) }
}

@Composable
internal fun Warning(text: String) {
    Cell {
        Icon(Icons.Filled.Warning, contentDescription = null, tint = ThemeTokens.warning, modifier = Modifier.size(18.dp))
        Text(text, style = MaterialTheme.typography.bodySmall, color = AiTheme.tokens.text)
    }
}

@Composable
internal fun Dot(color: Color, modifier: Modifier = Modifier, size: Dp = 9.dp) {
    Box(modifier.size(size).clip(CircleShape).background(color))
}

/** A row of figures, each over its name, as the panel's usage cards. */
@Composable
internal fun StatCards(stats: List<Pair<String, String>>) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        for ((value, label) in stats) {
            Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(value, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, color = AiTheme.tokens.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(label, style = MaterialTheme.typography.labelSmall, color = AiTheme.tokens.secondaryText, maxLines = 2, textAlign = TextAlign.Center)
            }
        }
    }
}

/**
 * Small bars, tallest at full height; a day without a value is a tick on the floor. Drawn in one
 * Canvas, one path per colour, never a view per bar.
 */
@Composable
internal fun MiniBars(values: List<Double>, modifier: Modifier, color: Color = AiTheme.tokens.accent) {
    val floor = AiTheme.tokens.hairline
    Canvas(modifier) {
        if (values.isEmpty()) return@Canvas
        val top = maxOf(values.maxOrNull() ?: 0.0, 1.0)
        val step = size.width / values.size
        val bar = step * 0.75f
        val filled = Path()
        val empty = Path()
        val minimum = 1.5f * density
        values.forEachIndexed { i, v ->
            val x = i * step
            val h = if (v > 0) maxOf((v / top).toFloat() * size.height, minimum) else density
            val rect = Rect(x, size.height - h, x + bar, size.height)
            if (v > 0) filled.addRect(rect) else empty.addRect(rect)
        }
        drawPath(empty, floor)
        drawPath(filled, color)
    }
}

/** A small label beside a name: where a row comes from, or what it is. */
@Composable
internal fun Badge(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelSmall,
        fontWeight = FontWeight.Medium,
        color = AiTheme.tokens.secondaryText,
        maxLines = 1,
        modifier = Modifier.clip(RoundedCornerShape(50)).background(AiTheme.tokens.hairline).padding(horizontal = 6.dp, vertical = 2.dp),
    )
}

/** The window or filter of a page, as a segmented control. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun Segmented(options: List<Pair<String, String>>, selected: String, onSelect: (String) -> Unit) {
    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp)) {
        options.forEachIndexed { index, (value, label) ->
            SegmentedButton(
                selected = value == selected,
                onClick = { onSelect(value) },
                shape = SegmentedButtonDefaults.itemShape(index = index, count = options.size),
                icon = {},
                label = { Text(label, maxLines = 1, style = MaterialTheme.typography.labelMedium) },
            )
        }
    }
}

/** A model menu: "none" first, then the choices, and the current value when the Space no longer offers it. */
@Composable
internal fun ModelMenu(
    options: List<ModelChoice>,
    current: String?,
    none: String,
    disabled: Boolean,
    pick: (String?) -> Unit,
    label: @Composable () -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    val shown = if (current.isNullOrEmpty()) none else options.firstOrNull { it.value == current }?.label ?: current
    Box {
        Cell(onClick = { open = true }, enabled = !disabled) {
            Box(Modifier.weight(1f)) { label() }
            Text(shown, color = AiTheme.tokens.accent, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            Icon(Icons.Filled.UnfoldMore, contentDescription = null, tint = AiTheme.tokens.accent, modifier = Modifier.size(16.dp))
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            val choose: (String?) -> Unit = { value ->
                open = false
                if (value != current) pick(value)
            }
            ModelChoiceItem(none, on = current.isNullOrEmpty()) { choose(null) }
            if (!current.isNullOrEmpty() && options.none { it.value == current }) ModelChoiceItem(current, on = true) { choose(current) }
            for (o in options) ModelChoiceItem(o.label, on = o.value == current) { choose(o.value) }
        }
    }
}

@Composable
private fun ModelChoiceItem(text: String, on: Boolean, onClick: () -> Unit) {
    val check: @Composable () -> Unit = { Icon(Icons.Filled.Check, contentDescription = null) }
    DropdownMenuItem(text = { Text(text) }, onClick = onClick, trailingIcon = if (on) check else null)
}

// Formats

/** A date and time as the reader's locale writes them, the date abbreviated. */
internal fun dateTime(instant: Instant, seconds: Boolean = false): String =
    DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, if (seconds) FormatStyle.MEDIUM else FormatStyle.SHORT)
        .withZone(ZoneId.systemDefault())
        .format(instant)

/** A day as its month, abbreviated, and its number. */
internal fun monthDay(date: LocalDate): String =
    DateTimeFormatter.ofPattern(DateFormat.getBestDateTimePattern(Locale.getDefault(), "MMMd")).format(date)

/** A hairline round a field or a bubble. */
internal fun Modifier.hairline(color: Color, shape: Shape): Modifier = this.border(1.dp, color, shape)
