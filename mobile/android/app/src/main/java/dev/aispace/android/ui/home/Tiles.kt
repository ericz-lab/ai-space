package dev.aispace.android.ui.home

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.WifiOff
import androidx.compose.material.icons.outlined.CropSquare
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Widgets
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shadow
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.aispace.android.R
import dev.aispace.android.core.CatalogWidget
import dev.aispace.android.core.CatalogueEntry
import dev.aispace.android.core.EntryKind
import dev.aispace.android.core.Lang
import dev.aispace.android.core.PeerStatus
import dev.aispace.android.core.Reach
import dev.aispace.android.core.Times
import dev.aispace.android.core.WidgetLayout
import dev.aispace.android.live.IconImages
import dev.aispace.android.ui.common.EntryIcon
import dev.aispace.android.ui.theme.AiTheme
import dev.aispace.android.ui.theme.ThemeTokens
import dev.aispace.android.ui.theme.glass

/** The symbol an entry shows while its icon loads: a person for an agent, a tile for anything else. */
internal fun fallbackIcon(kind: EntryKind): ImageVector = when (kind) {
    EntryKind.agent -> Icons.Filled.Person
    EntryKind.widget -> Icons.Outlined.Widgets
    EntryKind.app -> Icons.Outlined.CropSquare
}

/**
 * An app or agent on Home or a screen: its icon (an app's a rounded square, an agent's a circle), its
 * name, and under it the peer it lives on or why it will not answer. Only what is wrong is marked.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun EntryTile(
    entry: CatalogueEntry,
    icons: IconImages,
    @Suppress("UNUSED_PARAMETER") peer: PeerStatus?,
    onClick: () -> Unit,
    onLongClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val t = AiTheme.tokens
    val title = entry.displayTitle()
    val note = tileNote(entry)
    val state = tileState(entry, note)
    val dimmed = entry.reach == Reach.peerOffline || entry.reach == Reach.paused
    // Over drawn artwork a name gets an edge in the ground colour to stay readable.
    val edge = if (t.preset.backdrop != null) {
        Shadow(color = t.ground.copy(alpha = 0.9f), offset = Offset.Zero, blurRadius = with(LocalDensity.current) { 2.dp.toPx() })
    } else {
        null
    }
    Column(
        modifier
            .fillMaxWidth()
            .combinedClickable(onLongClick = onLongClick, onClick = onClick)
            .clearAndSetSemantics {
                contentDescription = title
                if (state.isNotEmpty()) stateDescription = state
                role = Role.Button
            },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box {
            EntryIcon(
                entry.icon, fallbackIcon(entry.kind), icons,
                modifier = Modifier.alpha(if (dimmed) 0.5f else 1f),
                isRound = entry.kind == EntryKind.agent,
            )
            TileBadge(entry.reach, Modifier.align(Alignment.TopEnd).offset(x = 4.dp, y = (-4).dp))
        }
        Text(
            title,
            style = HomeType.caption.copy(shadow = edge),
            fontWeight = FontWeight.Medium,
            color = t.text,
            textAlign = TextAlign.Center,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.fillMaxWidth(),
        )
        if (note != null) {
            Text(note, style = HomeType.caption2, color = t.secondaryText, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** The line under the title: the peer the entry lives on, or why it will not answer. */
@Composable
private fun tileNote(entry: CatalogueEntry): String? = when (entry.reach) {
    Reach.down -> stringResource(R.string.home_not_answering)
    Reach.paused -> stringResource(R.string.home_paused)
    Reach.peerOffline -> entry.peer?.let { stringResource(R.string.home_peer_offline, it) } ?: stringResource(R.string.home_offline)
    else -> entry.peer
}

@Composable
private fun tileState(entry: CatalogueEntry, note: String?): String = when (entry.reach) {
    Reach.up -> stringResource(R.string.home_running)
    Reach.unknown, Reach.link -> entry.peer ?: ""
    else -> note ?: ""
}

/** Only what is wrong is marked: a tile without a badge is one that answers. */
@Composable
private fun TileBadge(reach: Reach, modifier: Modifier) {
    val t = AiTheme.tokens
    when (reach) {
        Reach.down -> Box(
            modifier.size(12.dp).background(ThemeTokens.danger, CircleShape).border(2.dp, t.solid, CircleShape),
        )
        Reach.peerOffline -> BadgeSymbol(Icons.Filled.WifiOff, modifier)
        Reach.paused -> BadgeSymbol(Icons.Filled.Pause, modifier)
        else -> {}
    }
}

@Composable
private fun BadgeSymbol(symbol: ImageVector, modifier: Modifier) {
    val t = AiTheme.tokens
    Box(
        modifier.size(18.dp).background(Color.Gray, CircleShape).border(2.dp, t.solid, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Icon(symbol, contentDescription = null, tint = Color.White, modifier = Modifier.size(10.dp))
    }
}

/**
 * A widget of the Space as a card: its state card when the app sends blocks, its latest rows
 * otherwise, as the Space last read them from the app. A widget drawn by the app itself (an embedded
 * page) opens in the app's page instead. A long press anywhere on the card brings up [menu], which is
 * anchored under the card's header.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun WidgetCard(
    widget: CatalogWidget,
    icons: IconImages,
    /** Opens a row's link, or the widget's own page for null. */
    open: (String?) -> Unit,
    onLongPress: () -> Unit,
    modifier: Modifier = Modifier,
    menu: @Composable () -> Unit = {},
) {
    val t = AiTheme.tokens
    val longPress by rememberUpdatedState(onLongPress)
    Column(
        modifier
            .fillMaxWidth()
            .alpha(if (widget.stale == true) 0.6f else 1f)
            .glass()
            // The parts of the card that are not buttons take the long press too.
            .pointerInput(Unit) { detectTapGestures(onLongPress = { longPress() }) },
    ) {
        Box {
            Row(
                Modifier
                    .fillMaxWidth()
                    .combinedClickable(onLongClick = onLongPress, onClick = { open(null) })
                    .padding(horizontal = 14.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                EntryIcon(widget.icon, Icons.Outlined.Widgets, icons, size = 28.dp)
                Row(
                    Modifier.weight(1f),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Text(
                        Lang.pick(widget.title, widget.i18n, Lang.title), style = HomeType.subheadline, fontWeight = FontWeight.SemiBold,
                        color = t.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false),
                    )
                    widget.peer?.let { Text(it, style = HomeType.caption, color = t.secondaryText, maxLines = 1) }
                }
                Icon(
                    Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null,
                    tint = t.secondaryText.copy(alpha = 0.5f), modifier = Modifier.size(18.dp),
                )
            }
            menu()
        }
        HorizontalDivider(color = t.hairline, thickness = 1.dp)
        Box(Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
            WidgetRows(widget, open, onLongPress)
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun WidgetRows(widget: CatalogWidget, open: (String?) -> Unit, onLongPress: () -> Unit) {
    val t = AiTheme.tokens
    val blocks = widget.blocks
    val items = widget.items
    when {
        widget.ok == false -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Icon(Icons.Outlined.ErrorOutline, contentDescription = null, tint = t.secondaryText, modifier = Modifier.size(15.dp))
            Text(widget.error ?: stringResource(R.string.home_not_answering), style = HomeType.footnote, color = t.secondaryText)
        }
        widget.kind == "embed" ->
            Text(stringResource(R.string.home_widget_embed), style = HomeType.footnote, color = t.secondaryText)
        !blocks.isNullOrEmpty() -> Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            WidgetBlocksView(blocks, widget.size, open = { open(it) }, onLongPress = onLongPress)
            val asOf = widget.asOf?.let { Times.parse(it) }
            if (widget.stale == true) {
                Text(stringResource(R.string.home_widget_last_known), style = HomeType.caption, color = t.secondaryText)
            } else if (asOf != null && WidgetLayout.isOutdated(widget.asOf, widget.staleAfterMs)) {
                Text(stringResource(R.string.home_widget_updated, Times.ago(asOf)), style = HomeType.caption, color = t.secondaryText)
            }
        }
        !items.isNullOrEmpty() -> Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            items.take(4).forEach { item ->
                Row(
                    Modifier.fillMaxWidth().combinedClickable(onLongClick = onLongPress, onClick = { open(item.url) }),
                    verticalAlignment = Alignment.Top,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(
                        item.text, style = HomeType.subheadline, color = t.text, maxLines = 2, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    item.time?.let { Times.parse(it) }?.let { date ->
                        Text(Times.ago(date), style = HomeType.caption, color = t.secondaryText, maxLines = 1, modifier = Modifier.padding(top = 2.dp))
                    }
                }
            }
            if (widget.stale == true) {
                Text(stringResource(R.string.home_widget_last_known), style = HomeType.caption, color = t.secondaryText)
            }
        }
        else -> Text(stringResource(R.string.home_widget_nothing), style = HomeType.footnote, color = t.secondaryText)
    }
}
