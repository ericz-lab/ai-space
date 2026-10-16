@file:OptIn(ExperimentalMaterial3Api::class)

package dev.aispace.android.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.DragHandle
import androidx.compose.material.icons.filled.RemoveCircle
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import dev.aispace.android.AppModel
import dev.aispace.android.R
import dev.aispace.android.core.CatalogueEntry
import dev.aispace.android.core.Connection
import dev.aispace.android.core.EntryKind
import dev.aispace.android.core.Screens
import dev.aispace.android.live.CatalogueLoader
import dev.aispace.android.live.IconImages
import dev.aispace.android.live.IconStore
import dev.aispace.android.ui.common.EntryIcon
import dev.aispace.android.ui.theme.AiTheme
import dev.aispace.android.ui.theme.ThemeTokens
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

/**
 * One screen's entries as a list to drag into order and delete from. Tiles and widgets are two groups,
 * as the screen draws them apart. Every change is this phone's layout only (ScreenStore).
 */
@Composable
fun ScreenEditorSheet(
    model: AppModel,
    connection: Connection,
    loader: CatalogueLoader,
    icons: IconStore,
    screen: String,
    onDismiss: () -> Unit,
) {
    val t = AiTheme.tokens
    val catalogue by loader.catalogue.collectAsState()
    val records by model.screens.records.collectAsState()
    val screens = remember(records, connection.id) { model.screens.screens(connection.id) }
    val index = screens.indexOfFirst { it.id == screen }.coerceAtLeast(0)
    val items = screens.firstOrNull { it.id == screen }?.items ?: emptyList()
    val byKey = remember(catalogue) { catalogue?.entries?.associateBy { it.key } ?: emptyMap() }
    val entries = items.mapNotNull { byKey[it] }
    val tiles = entries.filter { it.kind != EntryKind.widget }
    val widgets = entries.filter { it.kind == EntryKind.widget }

    val sheetState = rememberModalBottomSheetState()
    val scope = rememberCoroutineScope()
    val done: () -> Unit = {
        scope.launch { sheetState.hide() }.invokeOnCompletion { onDismiss() }
    }
    val move: (List<String>, List<String>) -> Unit = { group, order ->
        model.screens.edit(connection.id) { Screens.reorder(it, screen, group, order) }
    }
    val delete: (String) -> Unit = { key ->
        model.screens.edit(connection.id) { Screens.unpin(it, screen, key) }
    }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState, containerColor = t.ground) {
        Box(Modifier.fillMaxWidth().padding(horizontal = 8.dp)) {
            Text(
                screenTitle(index), style = HomeType.headline, color = t.text, textAlign = TextAlign.Center,
                modifier = Modifier.align(Alignment.Center),
            )
            TextButton(onClick = done, modifier = Modifier.align(Alignment.CenterEnd)) {
                Text(stringResource(R.string.home_done), fontWeight = FontWeight.SemiBold)
            }
        }
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (tiles.isNotEmpty()) EditorGroup(stringResource(R.string.home_apps_and_agents), tiles, icons, move, delete)
            if (widgets.isNotEmpty()) EditorGroup(stringResource(R.string.home_widgets), widgets, icons, move, delete)
            if (entries.isEmpty()) {
                Text(
                    stringResource(R.string.home_screen_empty), style = HomeType.body, color = t.secondaryText,
                    modifier = Modifier.fillMaxWidth().background(t.glass, RoundedCornerShape(t.radiusMedium)).padding(16.dp),
                )
            }
            Text(
                stringResource(R.string.home_screen_editor_footer), style = HomeType.footnote, color = t.secondaryText,
                modifier = Modifier.padding(horizontal = 16.dp),
            )
        }
    }
}

/**
 * A group of entries in their order on the screen. An entry is dragged by its handle; the rows between
 * where it was and where it is held make room for it, and letting go saves the new order.
 */
@Composable
private fun EditorGroup(
    title: String,
    entries: List<CatalogueEntry>,
    icons: IconImages,
    move: (group: List<String>, order: List<String>) -> Unit,
    delete: (String) -> Unit,
) {
    val t = AiTheme.tokens
    val keys = entries.map { it.key }
    val rowHeight = 56.dp
    val rowPx = with(LocalDensity.current) { rowHeight.toPx() }
    var dragging by remember(keys) { mutableStateOf<Int?>(null) }
    var offset by remember(keys) { mutableFloatStateOf(0f) }
    val from = dragging
    val target = from?.let { (it + (offset / rowPx).roundToInt()).coerceIn(0, keys.size - 1) }
    val moveUp = stringResource(R.string.home_move_up)
    val moveDown = stringResource(R.string.home_move_down)
    val remove = stringResource(R.string.home_remove)

    fun reorder(from: Int, to: Int) {
        if (from == to || to !in keys.indices) return
        val order = keys.toMutableList().apply { add(to, removeAt(from)) }
        move(keys, order)
    }

    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            title, style = HomeType.footnote, color = t.secondaryText,
            modifier = Modifier.padding(start = 16.dp, top = 8.dp),
        )
        Column(Modifier.fillMaxWidth().background(t.glass, RoundedCornerShape(t.radiusMedium))) {
            entries.forEachIndexed { i, entry ->
                key(entry.key) {
                    val shift = when {
                        from == null || target == null -> 0f
                        i == from -> offset
                        target > from && i in (from + 1)..target -> -rowPx
                        target < from && i in target until from -> rowPx
                        else -> 0f
                    }
                    val lifted = i == from
                    Box(
                        Modifier
                            .zIndex(if (lifted) 1f else 0f)
                            .graphicsLayer { translationY = shift }
                            .then(if (lifted) Modifier.shadow(8.dp, RoundedCornerShape(t.radiusSmall)) else Modifier)
                            .background(if (lifted) t.solid else Color.Transparent, RoundedCornerShape(t.radiusSmall))
                            .fillMaxWidth()
                            .height(rowHeight)
                            .semantics {
                                customActions = listOfNotNull(
                                    if (i > 0) CustomAccessibilityAction(moveUp) { reorder(i, i - 1); true } else null,
                                    if (i < keys.size - 1) CustomAccessibilityAction(moveDown) { reorder(i, i + 1); true } else null,
                                )
                            },
                    ) {
                        // The line under a row moves with it, so a held row takes exactly one row's room.
                        if (i < entries.size - 1 && !lifted) {
                            HorizontalDivider(
                                color = t.hairline, thickness = 1.dp,
                                modifier = Modifier.align(Alignment.BottomStart).padding(start = 104.dp),
                            )
                        }
                        Row(
                            Modifier.fillMaxWidth().height(rowHeight).padding(end = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            IconButton(onClick = { delete(entry.key) }) {
                                Icon(Icons.Filled.RemoveCircle, contentDescription = remove, tint = ThemeTokens.danger)
                            }
                            EntryIcon(entry.icon, fallbackIcon(entry.kind), icons, size = 32.dp, isRound = entry.kind == EntryKind.agent)
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                                Text(entry.displayTitle(), style = HomeType.body, color = t.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                entry.peer?.let { Text(it, style = HomeType.caption, color = t.secondaryText, maxLines = 1) }
                            }
                            Icon(
                                Icons.Filled.DragHandle,
                                contentDescription = null,
                                tint = t.secondaryText,
                                modifier = Modifier
                                    .size(44.dp)
                                    .padding(10.dp)
                                    .pointerInput(entry.key, i, keys.size) {
                                        detectDragGestures(
                                            onDragStart = {
                                                dragging = i
                                                offset = 0f
                                            },
                                            onDragEnd = {
                                                val start = dragging
                                                if (start != null) {
                                                    val end = (start + (offset / rowPx).roundToInt()).coerceIn(0, keys.size - 1)
                                                    reorder(start, end)
                                                }
                                                dragging = null
                                                offset = 0f
                                            },
                                            onDragCancel = {
                                                dragging = null
                                                offset = 0f
                                            },
                                            onDrag = { change, amount ->
                                                change.consume()
                                                offset = (offset + amount.y).coerceIn(-i * rowPx, (keys.size - 1 - i) * rowPx)
                                            },
                                        )
                                    },
                            )
                        }
                    }
                }
            }
        }
    }
}
