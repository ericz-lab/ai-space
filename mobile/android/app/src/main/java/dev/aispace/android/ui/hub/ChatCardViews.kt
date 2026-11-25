package dev.aispace.android.ui.hub

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Undo
import androidx.compose.material.icons.outlined.BarChart
import androidx.compose.material.icons.outlined.CalendarToday
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.EditNote
import androidx.compose.material.icons.outlined.Flag
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.aispace.android.R
import dev.aispace.android.core.Card
import dev.aispace.android.core.CardAgenda
import dev.aispace.android.core.CardApp
import dev.aispace.android.core.CardIcon
import dev.aispace.android.core.CardItemView
import dev.aispace.android.core.CardKind
import dev.aispace.android.core.CardPill
import dev.aispace.android.core.CardRules
import dev.aispace.android.core.CardStyle
import dev.aispace.android.core.CardTag
import dev.aispace.android.core.CardTone
import dev.aispace.android.core.ShownCard
import dev.aispace.android.core.UndoLabel
import dev.aispace.android.live.ChatCardStore
import dev.aispace.android.live.IconImages
import dev.aispace.android.live.Icon as IconRules
import dev.aispace.android.ui.theme.AiTheme
import dev.aispace.android.ui.theme.ThemeTokens
import java.time.LocalDate

/**
 * What the chat's cards need besides the cards: their store, the app heading them, the images, and
 * how an item's link opens (as any link on the Space's pages: an app page in the app).
 */
internal class CardContext(
    val store: ChatCardStore,
    val app: CardApp,
    val appName: String?,
    val icons: IconImages,
    val openLink: (url: String, title: String) -> Unit,
)

/** The widest a card is (docs/chat-cards.md): on a phone the reply's width up to this. */
private val CARD_MAX = 460.dp

/**
 * The cards under an agent's reply (src/web/ChatCards.tsx, v2 styles): each in a narrow solid frame
 * headed by the app that acted. [actionable] is true only for the conversation's latest reply.
 */
@Composable
internal fun ChatCards(bubble: String, cards: List<ShownCard>, actionable: Boolean, context: CardContext) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        cards.forEachIndexed { position, shown ->
            ChatCard(shown, context.store.of(bubble, position), actionable, context)
        }
    }
}

@Composable
private fun ChatCard(shown: ShownCard, state: ChatCardStore.Shown, actionable: Boolean, context: CardContext) {
    val t = AiTheme.tokens
    val card = shown.card
    // Each time the card is shown, the app says what its items are now.
    LaunchedEffect(shown) { context.store.refresh(state, shown) }
    val canUndo = CardRules.canUndo(shown, actionable, state.readOnly)
    val states = state.states
    val open = CardRules.open(card, canUndo, states)
    val style = card.drawnStyle
    val views = card.items.map { CardRules.view(it, states[it.id]) }
    val undo: (List<String>) -> Unit = { ids -> context.store.undo(state, shown, ids) }
    val shape = RoundedCornerShape(t.radiusMedium)
    Column(
        Modifier.widthIn(max = CARD_MAX).fillMaxWidth()
            .then(if (canUndo) Modifier.shadow(8.dp, shape, ambientColor = t.text.copy(alpha = 0.25f), spotColor = t.text.copy(alpha = 0.25f)) else Modifier)
            .clip(shape).background(t.solid).border(1.dp, t.hairline, shape),
    ) {
        CardHead(card, context, open, state.busy) { undo(open) }
        if (card.kind == CardKind.value && card.text != null) {
            HorizontalDivider(color = t.hairline)
            Text(
                card.text, fontSize = 22.sp, fontWeight = FontWeight.SemiBold, color = t.text, style = numeric,
                modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
            )
        }
        if (views.isNotEmpty()) HorizontalDivider(color = t.hairline)
        val itemUndo: (CardItemView) -> (() -> Unit)? = { v ->
            if (CardRules.rowUndo(card, style, CardRules.undoable(canUndo, states[v.id])) && !state.busy) {
                { undo(listOf(v.id)) }
            } else null
        }
        val single = card.items.size <= 1
        when (style) {
            CardStyle.rows -> Divided(views) { RowsItem(it, canUndo, single, itemUndo(it), context) }
            CardStyle.compact -> Divided(views) { CompactItem(it, context) }
            CardStyle.gallery -> Gallery(views, itemUndo, context)
            CardStyle.agenda -> {
                val blocks = CardAgenda.blocks(views.map { it.extras.date })
                Divided(views) { v -> AgendaItem(v, blocks[views.indexOf(v)]?.day, canUndo, single, itemUndo(v), context) }
            }
            CardStyle.stat -> Stats(views, context)
        }
        state.note?.let {
            HorizontalDivider(color = t.hairline)
            Text(
                it, fontSize = 12.sp, color = if (state.readOnly) t.secondaryText else ThemeTokens.danger,
                modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
            )
        }
    }
}

/** The head (`.chat-card-head`): the app's icon and name, the card's title, and the one Undo button. */
@Composable
private fun CardHead(card: Card, context: CardContext, open: List<String>, busy: Boolean, onUndo: () -> Unit) {
    val t = AiTheme.tokens
    Row(
        Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(start = 14.dp, end = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        AppMark(context.app.icon, context.icons)
        context.appName?.let { Text(it, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = t.text, maxLines = 1) }
        Text(
            card.title ?: "", fontSize = 13.sp, fontWeight = FontWeight.Medium, color = t.secondaryText,
            maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
        )
        if (open.isNotEmpty()) {
            val label = when (val l = CardRules.undoLabel(card.items.size, open.size)) {
                UndoLabel.One -> stringResource(R.string.chat_card_undo)
                UndoLabel.All -> stringResource(R.string.chat_card_undo_all)
                is UndoLabel.Rest -> stringResource(R.string.chat_card_undo_rest, l.n)
            }
            val pill = RoundedCornerShape(50)
            Row(
                Modifier.height(32.dp).alpha(if (busy) 0.5f else 1f).clip(pill)
                    .border(1.dp, t.text.copy(alpha = 0.14f), pill)
                    .clickable(enabled = !busy, onClick = onUndo)
                    .padding(start = 10.dp, end = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Icon(Icons.AutoMirrored.Outlined.Undo, contentDescription = null, tint = t.text, modifier = Modifier.size(14.dp))
                Text(label, fontSize = 13.sp, fontWeight = FontWeight.Medium, color = t.text, maxLines = 1)
            }
        }
    }
}

/** The app's icon on a 20 dp plate; nothing when there is none or its image has not loaded. */
@Composable
private fun AppMark(icon: String?, icons: IconImages) {
    val t = AiTheme.tokens
    val shape = RoundedCornerShape(6.dp)
    val emoji = IconRules.emoji(icon)
    if (emoji != null) {
        Box(Modifier.size(20.dp).clip(shape).background(t.text.copy(alpha = 0.07f)), contentAlignment = Alignment.Center) {
            Text(emoji, fontSize = 13.sp)
        }
        return
    }
    val image = rememberImage(icon, icons) ?: return
    Image(image, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.size(20.dp).clip(shape))
}

/** An app-provided image through the client's icon loader (the Space's session for its own addresses). */
@Composable
private fun rememberImage(url: String?, icons: IconImages): ImageBitmap? {
    var image by remember(url, icons) { mutableStateOf(icons.image(url)) }
    LaunchedEffect(url, icons) {
        icons.updates.collect { changed -> if (changed == null) image = null else if (changed == url) image = icons.image(url) }
    }
    return image
}

/** Items one under the other with hairlines between them. */
@Composable
private fun Divided(views: List<CardItemView>, item: @Composable (CardItemView) -> Unit) {
    val t = AiTheme.tokens
    views.forEachIndexed { i, v ->
        if (i > 0) HorizontalDivider(color = t.hairline)
        item(v)
    }
}

private val numeric = TextStyle(fontFeatureSettings = "tnum")

/** The default style: state circle (or icon, or image), title, secondary line, pill, Undo or chevron. */
@Composable
private fun RowsItem(v: CardItemView, canUndo: Boolean, single: Boolean, onUndo: (() -> Unit)?, context: CardContext) {
    val image = v.extras.image
    ItemRow(v, canUndo, single, onUndo, context, leading = {
        if (image != null) Thumb(image, context.icons) else StatusMark(v)
    }) {
        Meta(v, showWhen = true, time = null)
        v.extras.progress?.let { Progress(it.toFloat()) }
    }
}

/** An agenda row: the day block, the state mark, the title and the time with the secondary line. */
@Composable
private fun AgendaItem(v: CardItemView, block: LocalDate?, canUndo: Boolean, single: Boolean, onUndo: (() -> Unit)?, context: CardContext) {
    ItemRow(v, canUndo, single, onUndo, context, leading = {
        DayBlock(block)
        StatusMark(v)
    }) {
        Meta(v, showWhen = false, time = if (v.removed) null else CardAgenda.time(v.extras.date))
    }
}

/**
 * One row of the rows and agenda styles (`.chat-card-row`). Read-only, a row with a link opens it as a
 * whole and ends in a chevron; while the card can act the title is the link.
 */
@Composable
private fun ItemRow(
    v: CardItemView,
    canUndo: Boolean,
    single: Boolean,
    onUndo: (() -> Unit)?,
    context: CardContext,
    leading: @Composable () -> Unit,
    secondary: @Composable () -> Unit,
) {
    val t = AiTheme.tokens
    val url = v.url
    val rowLink = !canUndo && url != null
    Row(
        Modifier.fillMaxWidth()
            .then(if (v.removed) Modifier.background(t.text.copy(alpha = 0.04f)) else Modifier)
            .then(if (rowLink && url != null) Modifier.clickable { context.openLink(url, v.title) } else Modifier)
            .padding(start = 14.dp, end = if (onUndo != null) 10.dp else 14.dp, top = if (single) 12.dp else 10.dp, bottom = if (single) 12.dp else 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        leading()
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            val titleLink = if (!rowLink && url != null) Modifier.clickable { context.openLink(url, v.title) } else Modifier
            Text(
                v.title, fontSize = 14.sp, lineHeight = 19.sp,
                fontWeight = if (v.removed || v.done) FontWeight.Medium else FontWeight.SemiBold,
                color = if (v.removed || v.done) t.secondaryText else t.text,
                textDecoration = if (v.removed) TextDecoration.LineThrough else null,
                modifier = titleLink,
            )
            secondary()
        }
        v.pill?.let { Pill(it) }
        if (onUndo != null) {
            val label = stringResource(R.string.chat_card_undo_item, v.title)
            Box(
                Modifier.size(32.dp).clip(CircleShape).clickable(onClick = onUndo).semantics { contentDescription = label },
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.AutoMirrored.Outlined.Undo, contentDescription = null, tint = t.secondaryText, modifier = Modifier.size(16.dp))
            }
        }
        if (rowLink && v.pill == null) Icon(Icons.Outlined.ChevronRight, contentDescription = null, tint = t.secondaryText, modifier = Modifier.size(16.dp))
    }
}

/** The secondary line: `when` (rows) or the time (agenda), the detail's segments, the tags, the id. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Meta(v: CardItemView, showWhen: Boolean, time: String?) {
    val t = AiTheme.tokens
    val style = numeric.copy(fontSize = 12.sp, lineHeight = 17.sp, color = t.secondaryText)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        if (showWhen) v.extras.`when`?.let { w ->
            Row(Modifier.align(Alignment.CenterVertically), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                Icon(Icons.Outlined.CalendarToday, contentDescription = null, tint = t.secondaryText, modifier = Modifier.size(12.dp))
                Text(w, style = style)
            }
        }
        time?.let { Text(it, style = style, modifier = Modifier.align(Alignment.CenterVertically)) }
        for (segment in v.segments) Text(segment, style = style, modifier = Modifier.align(Alignment.CenterVertically))
        v.extras.tags?.forEach { Tag(it, Modifier.align(Alignment.CenterVertically)) }
        Text("#${v.id}", style = style, modifier = Modifier.align(Alignment.CenterVertically))
    }
}

/** The 18 dp state mark: an empty circle (or the item's icon) while active, a check when done, dashed when undone. */
@Composable
private fun StatusMark(v: CardItemView) {
    val t = AiTheme.tokens
    val icon = v.extras.icon
    when {
        v.done -> Box(Modifier.size(18.dp).clip(CircleShape).background(ThemeTokens.success), contentAlignment = Alignment.Center) {
            Icon(Icons.Outlined.Check, contentDescription = null, tint = Color.White, modifier = Modifier.size(12.dp))
        }
        v.removed -> Box(
            Modifier.size(18.dp).drawBehind {
                val w = 1.5.dp.toPx()
                drawCircle(
                    t.text.copy(alpha = 0.30f), radius = (size.minDimension - w) / 2,
                    style = Stroke(w, pathEffect = PathEffect.dashPathEffect(floatArrayOf(2.5.dp.toPx(), 2.dp.toPx()))),
                )
            },
        )
        icon != null -> Icon(cardIcon(icon), contentDescription = null, tint = t.secondaryText, modifier = Modifier.size(18.dp))
        else -> Box(Modifier.size(18.dp).border(1.5.dp, t.text.copy(alpha = 0.35f), CircleShape))
    }
}

/** The 36 dp image of a row in place of its state mark (v2 11.3). */
@Composable
private fun Thumb(url: String, icons: IconImages) {
    val t = AiTheme.tokens
    val shape = RoundedCornerShape(8.dp)
    val image = rememberImage(url, icons)
    Box(Modifier.size(36.dp).clip(shape).background(t.hairline), contentAlignment = Alignment.Center) {
        if (image != null) Image(image, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        else Icon(Icons.Outlined.Image, contentDescription = null, tint = t.secondaryText, modifier = Modifier.size(16.dp))
    }
}

/** A 3 dp bar under the secondary line, the accent over the hairline. */
@Composable
private fun Progress(fraction: Float) {
    val t = AiTheme.tokens
    Box(Modifier.padding(top = 3.dp).fillMaxWidth().height(3.dp).clip(RoundedCornerShape(50)).background(t.hairline)) {
        Box(Modifier.fillMaxWidth(fraction.coerceIn(0f, 1f)).fillMaxHeight().clip(RoundedCornerShape(50)).background(t.accent))
    }
}

/** The pill at the end of a row: Undone, Changed elsewhere, Done. */
@Composable
private fun Pill(pill: CardPill, modifier: Modifier = Modifier) {
    val t = AiTheme.tokens
    val (text, fg, bg) = when (pill) {
        CardPill.Undone -> Triple(stringResource(R.string.chat_card_undone), t.secondaryText, t.text.copy(alpha = 0.07f))
        CardPill.Changed -> Triple(stringResource(R.string.chat_card_changed), toneText(ThemeTokens.warning), ThemeTokens.warning.copy(alpha = 0.14f))
        CardPill.Done -> Triple(stringResource(R.string.chat_card_done), toneText(ThemeTokens.success), ThemeTokens.success.copy(alpha = 0.14f))
    }
    Text(
        text, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = fg, maxLines = 1,
        modifier = modifier.clip(RoundedCornerShape(50)).background(bg).padding(horizontal = 9.dp, vertical = 3.dp),
    )
}

/** A status colour pulled halfway to the text, so words on its pale tint keep their contrast (`.chat-card-pill.ok`). */
@Composable
private fun toneText(tone: Color): Color = ThemeTokens.mix(tone, AiTheme.tokens.text, 0.5f)

/** A tag: 18 dp high, 7 dp each side, fully rounded, 12 sp, in its tone. */
@Composable
private fun Tag(tag: CardTag, modifier: Modifier = Modifier) {
    val t = AiTheme.tokens
    val tone = when (tag.tone) {
        CardTone.neutral -> null
        CardTone.accent -> t.accent
        CardTone.positive -> ThemeTokens.success
        CardTone.warning -> ThemeTokens.warning
        CardTone.negative -> ThemeTokens.danger
    }
    Box(
        modifier.height(18.dp).clip(RoundedCornerShape(50)).background(tone?.copy(alpha = 0.14f) ?: t.text.copy(alpha = 0.07f)).padding(horizontal = 7.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(tag.text, fontSize = 12.sp, lineHeight = 14.sp, color = tone?.let { toneText(it) } ?: t.secondaryText, maxLines = 1)
    }
}

/** An agenda row's 44 dp day block: the day, the weekday, and the month when it is not this month; empty for a repeated day. */
@Composable
private fun DayBlock(day: LocalDate?) {
    val t = AiTheme.tokens
    val locale = LocalConfiguration.current.locales[0]
    Column(Modifier.width(44.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        if (day != null) {
            Text(day.dayOfMonth.toString(), style = numeric, fontSize = 18.sp, lineHeight = 22.sp, fontWeight = FontWeight.Bold, color = t.text)
            Text(CardAgenda.weekday(day, locale), fontSize = 11.sp, lineHeight = 14.sp, color = t.secondaryText, maxLines = 1)
            if (CardAgenda.showsMonth(day, LocalDate.now())) {
                Text(CardAgenda.month(day, locale), fontSize = 11.sp, lineHeight = 14.sp, color = t.secondaryText, maxLines = 1)
            }
        }
    }
}

/** Compact: one 36 dp line per item, a 6 dp state dot, the title, a short value on the right; the row opens its link. */
@Composable
private fun CompactItem(v: CardItemView, context: CardContext) {
    val t = AiTheme.tokens
    val url = v.url
    Row(
        Modifier.fillMaxWidth().height(36.dp)
            .then(if (url != null) Modifier.clickable { context.openLink(url, v.title) } else Modifier)
            .padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        val dot = Modifier.size(6.dp).clip(CircleShape)
        when {
            v.removed -> Box(dot.border(1.dp, t.secondaryText, CircleShape))
            v.done -> Box(dot.background(ThemeTokens.success))
            else -> Box(dot.background(t.secondaryText))
        }
        Text(
            v.title, fontSize = 14.sp, color = if (v.removed) t.secondaryText else t.text, maxLines = 1, overflow = TextOverflow.Ellipsis,
            textDecoration = if (v.removed) TextDecoration.LineThrough else null, modifier = Modifier.weight(1f),
        )
        (v.extras.value ?: v.extras.`when` ?: v.segments.firstOrNull())?.let {
            Text(it, style = numeric, fontSize = 12.sp, color = t.secondaryText, maxLines = 1)
        }
    }
}

/** Gallery: a grid of 4:3 thumbnails with the title under each, 3 columns, 2 on a card narrower than 360 dp. */
@Composable
private fun Gallery(views: List<CardItemView>, itemUndo: (CardItemView) -> (() -> Unit)?, context: CardContext) {
    BoxWithConstraints(Modifier.fillMaxWidth().padding(12.dp)) {
        val columns = if (maxWidth + 24.dp < 360.dp) 2 else 3
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            for (row in views.chunked(columns)) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (v in row) Box(Modifier.weight(1f)) { GalleryCell(v, itemUndo(v), context) }
                    repeat(columns - row.size) { Spacer(Modifier.weight(1f)) }
                }
            }
        }
    }
}

@Composable
private fun GalleryCell(v: CardItemView, onUndo: (() -> Unit)?, context: CardContext) {
    val t = AiTheme.tokens
    val url = v.url
    val shape = RoundedCornerShape(10.dp)
    val image = rememberImage(v.extras.image, context.icons)
    Column(
        Modifier.fillMaxWidth().then(if (url != null) Modifier.clickable { context.openLink(url, v.title) } else Modifier),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Box(Modifier.fillMaxWidth().aspectRatio(4f / 3f).clip(shape).background(t.hairline)) {
            Box(Modifier.fillMaxSize().alpha(if (v.removed) 0.4f else 1f), contentAlignment = Alignment.Center) {
                if (image != null) Image(image, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                else Icon(Icons.Outlined.Image, contentDescription = null, tint = t.secondaryText, modifier = Modifier.size(22.dp))
            }
            // Only Undone is said on a tile, at its top-left; the undo button is at the top-right.
            if (v.removed) Pill(CardPill.Undone, Modifier.align(Alignment.TopStart).padding(6.dp))
            if (onUndo != null) {
                val label = stringResource(R.string.chat_card_undo_item, v.title)
                Box(
                    Modifier.align(Alignment.TopEnd).padding(6.dp).size(28.dp).clip(CircleShape)
                        .background(t.solid.copy(alpha = 0.78f)).clickable(onClick = onUndo).semantics { contentDescription = label },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.AutoMirrored.Outlined.Undo, contentDescription = null, tint = t.text, modifier = Modifier.size(16.dp))
                }
            }
        }
        Text(
            v.title, fontSize = 13.sp, color = if (v.removed) t.secondaryText else t.text, maxLines = 1, overflow = TextOverflow.Ellipsis,
            textDecoration = if (v.removed) TextDecoration.LineThrough else null,
        )
        (v.extras.`when` ?: v.segments.firstOrNull())?.let {
            Text(it, style = numeric, fontSize = 12.sp, color = t.secondaryText, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** Stat: big values side by side, each at least 96 dp, equal widths, wrapping, hairlines between. */
@Composable
private fun Stats(views: List<CardItemView>, context: CardContext) {
    val t = AiTheme.tokens
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val perRow = (maxWidth / 96.dp).toInt().coerceIn(1, maxOf(1, views.size))
        Column {
            views.chunked(perRow).forEachIndexed { r, row ->
                if (r > 0) HorizontalDivider(color = t.hairline)
                Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
                    row.forEachIndexed { i, v ->
                        if (i > 0) VerticalDivider(color = t.hairline)
                        StatCell(v, context, Modifier.weight(1f).fillMaxHeight())
                    }
                    repeat(perRow - row.size) {
                        VerticalDivider(color = t.hairline)
                        Spacer(Modifier.weight(1f))
                    }
                }
            }
        }
    }
}

@Composable
private fun StatCell(v: CardItemView, context: CardContext, modifier: Modifier) {
    val t = AiTheme.tokens
    val url = v.url
    Column(
        modifier.then(if (url != null) Modifier.clickable { context.openLink(url, v.title) } else Modifier)
            .alpha(if (v.removed) 0.4f else 1f).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        // 22 sp as the web draws it (Material's titleLarge), the nearest step of the type scale to the spec's 24.
        Text(
            v.extras.value ?: "", style = numeric, fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.Bold, color = t.text,
            maxLines = 1, overflow = TextOverflow.Ellipsis, textDecoration = if (v.removed) TextDecoration.LineThrough else null,
        )
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(v.title, fontSize = 12.sp, color = t.secondaryText, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            v.extras.tags?.firstOrNull()?.let { Tag(it) }
        }
    }
}

/** The icon set's symbol for an item's `icon` (v2 11.2). */
private fun cardIcon(icon: CardIcon): ImageVector = when (icon) {
    CardIcon.check -> Icons.Outlined.CheckCircle
    CardIcon.note -> Icons.Outlined.EditNote
    CardIcon.link -> Icons.Outlined.Link
    CardIcon.calendar -> Icons.Outlined.CalendarToday
    CardIcon.image -> Icons.Outlined.Image
    CardIcon.file -> Icons.Outlined.Description
    CardIcon.person -> Icons.Outlined.Person
    CardIcon.chart -> Icons.Outlined.BarChart
    CardIcon.clock -> Icons.Outlined.Schedule
    CardIcon.flag -> Icons.Outlined.Flag
    CardIcon.bell -> Icons.Outlined.Notifications
    CardIcon.folder -> Icons.Outlined.Folder
}

