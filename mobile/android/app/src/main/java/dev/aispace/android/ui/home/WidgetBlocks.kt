package dev.aispace.android.ui.home

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.aispace.android.R
import dev.aispace.android.core.BlockFormat
import dev.aispace.android.core.BlockTone
import dev.aispace.android.core.Times
import dev.aispace.android.core.WidgetBlock
import dev.aispace.android.core.WidgetLayout
import dev.aispace.android.ui.theme.AiTheme
import dev.aispace.android.ui.theme.ThemeTokens
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/*
 * A widget's blocks as a state card, as the panel draws them (src/web/WidgetBlocks.tsx): the first
 * block is the hero, the rest compact rows, as many as the card's size holds.
 *
 * Every chart here is one Canvas drawing one path per colour, never a composable per bar or point: a
 * view per bar made a card with a chart many times heavier to lay out and to scroll (0efce18 on iOS).
 */

@Composable
internal fun WidgetBlocksView(
    blocks: List<WidgetBlock>,
    size: String?,
    /** Opens a block's link. */
    open: (String) -> Unit,
    /** The card's own long press, so a linked block does not swallow it. */
    onLongPress: () -> Unit,
) {
    val hero = blocks.firstOrNull() ?: return
    val rows = blocks.drop(1).take(WidgetLayout.rows(size))
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Linked(hero, open, onLongPress) { BlockHero(hero) }
        if (rows.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                rows.forEach { block -> Linked(block, open, onLongPress) { BlockRow(block) } }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun Linked(block: WidgetBlock, open: (String) -> Unit, onLongPress: () -> Unit, content: @Composable () -> Unit) {
    val url = block.url
    if (!url.isNullOrEmpty()) {
        Box(Modifier.combinedClickable(onLongClick = onLongPress, onClick = { open(url) })) { content() }
    } else {
        content()
    }
}

/**
 * A tone's colour; neutral is the secondary text. The status colours are pulled a little toward the
 * text, so a green number reads as a value rather than a light (src/web/styles.css `--tone-*`).
 */
internal fun BlockTone.color(t: ThemeTokens): Color = when (this) {
    BlockTone.positive -> lerp(t.text, ThemeTokens.success, 0.82f)
    BlockTone.negative -> lerp(t.text, ThemeTokens.danger, 0.84f)
    BlockTone.warning -> lerp(t.text, ThemeTokens.warning, 0.84f)
    BlockTone.neutral -> t.secondaryText
}

/** The first block, drawn large: its label, its value, and what its type adds. */
@Composable
internal fun BlockHero(block: WidgetBlock) {
    val t = AiTheme.tokens
    val value = block.shown()
    val tone = block.effectiveTone
    Column(
        Modifier.fillMaxWidth().semantics(mergeDescendants = true) {},
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(block.label.text(), style = HomeType.caption, color = t.secondaryText, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (block.type == WidgetBlock.Kind.status) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Box(Modifier.size(10.dp).background(tone?.color(t) ?: t.secondaryText, CircleShape))
                Text(value ?: "", style = HomeType.headline, color = t.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            block.time?.let { Times.parse(it) }?.let { date ->
                Text(Times.ago(date), style = HomeType.caption.tabular(), color = t.faint)
            }
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                val color = when {
                    value == null -> t.secondaryText
                    block.type == WidgetBlock.Kind.gauge && tone != null && tone != BlockTone.neutral -> tone.color(t)
                    else -> t.text
                }
                ShrinkingText(
                    value ?: stringResource(R.string.home_no_data),
                    style = HomeType.title, minScale = 0.6f, color = color,
                    modifier = Modifier.weight(1f, fill = false).alignByBaseline(),
                )
                val delta = block.delta
                if (block.type == WidgetBlock.Kind.metric && delta != null) {
                    BlockDelta(delta, showsLabel = true, modifier = Modifier.alignByBaseline())
                }
            }
        }
        when (block.type) {
            WidgetBlock.Kind.trend -> Spark(block, 48.dp)
            WidgetBlock.Kind.progress -> ProgressBar(block)
            WidgetBlock.Kind.gauge -> GaugeScale(block)
            else -> {}
        }
        val caption = block.caption?.text()
        if (!caption.isNullOrEmpty()) {
            Text(caption, style = HomeType.caption, color = t.faint, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** A block after the first, on one line: label left, value right, its drawing below. */
@Composable
internal fun BlockRow(block: WidgetBlock) {
    val t = AiTheme.tokens
    val value = block.shown()
    val tone = block.effectiveTone
    val toned = (block.type == WidgetBlock.Kind.gauge || block.type == WidgetBlock.Kind.metric) && tone != null && tone != BlockTone.neutral
    Column(Modifier.fillMaxWidth().semantics(mergeDescendants = true) {}, verticalArrangement = Arrangement.spacedBy(5.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (block.type == WidgetBlock.Kind.status) {
                Box(Modifier.size(7.dp).background(tone?.color(t) ?: t.secondaryText, CircleShape))
            }
            Text(
                block.label.text(), style = HomeType.subheadline, color = t.text.copy(alpha = 0.78f), maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).padding(end = 2.dp),
            )
            Text(
                value ?: stringResource(R.string.home_no_data),
                style = HomeType.subheadline.tabular(), fontWeight = FontWeight.Medium,
                color = if (value == null) t.secondaryText else if (toned) tone!!.color(t) else t.text,
                maxLines = 1,
            )
            val delta = block.delta
            if (block.type == WidgetBlock.Kind.metric && delta != null) BlockDelta(delta, showsLabel = false)
            if (block.type == WidgetBlock.Kind.status) {
                block.time?.let { Times.parse(it) }?.let { date ->
                    Text(Times.ago(date), style = HomeType.caption.tabular(), color = t.faint, maxLines = 1)
                }
            }
        }
        when (block.type) {
            WidgetBlock.Kind.trend -> Spark(block, 22.dp)
            WidgetBlock.Kind.progress -> ProgressBar(block)
            WidgetBlock.Kind.gauge -> GaugeScale(block)
            else -> {}
        }
    }
}

/** A change is coloured only when the app says whether it is good or bad: up is not always good. */
@Composable
internal fun BlockDelta(delta: WidgetBlock.Delta, showsLabel: Boolean, modifier: Modifier = Modifier) {
    val t = AiTheme.tokens
    val arrow = if (delta.value > 0) "▲ " else if (delta.value < 0) "▼ " else ""
    val label = if (showsLabel) delta.label?.text() ?: "" else ""
    Text(
        arrow + BlockFormat.string(abs(delta.value), delta.number) + (if (label.isEmpty()) "" else " $label"),
        style = HomeType.caption.tabular(), fontWeight = FontWeight.Medium,
        color = delta.tone?.color(t) ?: t.secondaryText, maxLines = 1, modifier = modifier,
    )
}

/**
 * One line of text that shrinks to [minScale] of its size before it is cut, as SwiftUI's
 * `minimumScaleFactor` does. It is drawn only once it fits, so it does not flash large.
 */
@Composable
private fun ShrinkingText(text: String, style: TextStyle, minScale: Float, color: Color, modifier: Modifier = Modifier) {
    var scale by remember(text) { mutableFloatStateOf(1f) }
    var ready by remember(text) { mutableStateOf(false) }
    Text(
        text,
        modifier = modifier.drawWithContent { if (ready) drawContent() },
        style = style.tabular().copy(fontSize = style.fontSize * scale, lineHeight = style.lineHeight * scale),
        fontWeight = FontWeight.SemiBold, color = color,
        maxLines = 1, softWrap = false, overflow = TextOverflow.Clip,
        onTextLayout = { result ->
            if (result.hasVisualOverflow && scale > minScale) scale = max(minScale, scale - 0.1f) else ready = true
        },
    )
}

/**
 * A trend's points as a line or bars. A line breaks at a missing point rather than bridging it, and
 * each unbroken run has a faint area down to the floor; a signed or bar trend is drawn from zero, on a
 * zero line, with the latest bar at full strength and the ones before it quieter. One path per colour
 * and strength, built once per size.
 */
@Composable
internal fun Spark(block: WidgetBlock, height: Dp) {
    val t = AiTheme.tokens
    val points = block.points ?: emptyList()
    val values = points.mapNotNull { it.v }
    if (values.isEmpty()) {
        Text(stringResource(R.string.home_no_history), style = HomeType.caption, color = t.secondaryText, modifier = Modifier.fillMaxWidth())
        return
    }
    val bar = block.style == "bar"
    val signed = block.signed == true
    val fromZero = signed || bar
    val lo = if (fromZero) min(0.0, values.min()) else values.min()
    val hi = if (fromZero) max(0.0, values.max()) else values.max()
    val span = if (hi - lo == 0.0) 1.0 else hi - lo
    val accent = t.accent
    val baselineColor = t.text.copy(alpha = 0.18f)
    val positive = BlockTone.positive.color(t)
    val negative = BlockTone.negative.color(t)
    val latest = points.indexOfLast { it.v != null }
    Spacer(
        Modifier
            .fillMaxWidth()
            .height(height)
            .clearAndSetSemantics {}
            .drawWithCache {
                val w = size.width
                val h = size.height
                val step = w / max(points.size, 2)
                fun y(v: Double): Float = h - ((v - lo) / span).toFloat() * h
                if (!bar) {
                    val line = Path()
                    val area = Path()
                    var run = ArrayList<Offset>()
                    fun close() {
                        if (run.size > 1) {
                            area.moveTo(run.first().x, h)
                            run.forEach { area.lineTo(it.x, it.y) }
                            area.lineTo(run.last().x, h)
                            area.close()
                        }
                        run = ArrayList()
                    }
                    points.forEachIndexed { i, point ->
                        val v = point.v
                        if (v == null) {
                            close()
                        } else {
                            val at = Offset(i * step + step / 2, y(v))
                            if (run.isNotEmpty()) line.lineTo(at.x, at.y) else line.moveTo(at.x, at.y)
                            run.add(at)
                        }
                    }
                    close()
                    val stroke = Stroke(width = 2.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round)
                    onDrawBehind {
                        drawPath(area, accent.copy(alpha = 0.14f))
                        drawPath(line, accent, style = stroke)
                    }
                } else {
                    val zero = y(0.0)
                    val minimum = 1.dp.toPx()
                    val corner = CornerRadius(step * 0.12f)
                    // The bars at or above zero, those below it, or all of them for null; the latest
                    // bar alone, or every bar before it.
                    fun bars(positive: Boolean?, last: Boolean): Path {
                        val path = Path()
                        points.forEachIndexed { i, point ->
                            val v = point.v ?: return@forEachIndexed
                            if (positive != null && (v >= 0) != positive) return@forEachIndexed
                            if ((i == latest) != last) return@forEachIndexed
                            val top = y(v)
                            path.addRoundRect(
                                RoundRect(
                                    Rect(
                                        offset = Offset(i * step + step * 0.15f, min(top, zero)),
                                        size = Size(max(step * 0.7f, minimum), max(abs(top - zero), minimum)),
                                    ),
                                    corner,
                                ),
                            )
                        }
                        return path
                    }
                    val baseline = Path().apply {
                        moveTo(0f, zero)
                        lineTo(w, zero)
                    }
                    val hairStroke = Stroke(width = 1.dp.toPx())
                    val fills = if (signed) {
                        listOf(bars(true, false) to positive.copy(alpha = 0.6f), bars(false, false) to negative.copy(alpha = 0.6f), bars(true, true) to positive, bars(false, true) to negative)
                    } else {
                        listOf(bars(null, false) to accent.copy(alpha = 0.6f), bars(null, true) to accent)
                    }
                    onDrawBehind {
                        for ((path, color) in fills) drawPath(path, color)
                        drawPath(baseline, baselineColor, style = hairStroke)
                    }
                }
            },
    )
}

/** A progress bar: a capsule track and a capsule over the leading share of it, in one drawing. */
@Composable
internal fun ProgressBar(block: WidgetBlock) {
    val t = AiTheme.tokens
    val tone = block.tone
    val fill = if (tone != null && tone != BlockTone.neutral) tone.color(t) else t.accent
    val track = t.hairline
    val fraction = block.fraction.toFloat()
    Canvas(Modifier.fillMaxWidth().height(6.dp).clearAndSetSemantics {}) {
        val h = size.height
        drawRoundRect(track, cornerRadius = CornerRadius(h / 2))
        val width = size.width * fraction
        if (width > 0f) {
            drawRoundRect(fill, size = Size(width, h), cornerRadius = CornerRadius(min(width, h) / 2))
        }
    }
}

/** A gauge's scale: its zones in their tones, and a marker where the value is. */
@Composable
internal fun GaugeScale(block: WidgetBlock) {
    val t = AiTheme.tokens
    val zones = block.zones ?: emptyList()
    // Each zone's share of the scale, as (start, end, colour).
    val segments = remember(block) {
        var from = block.min ?: 0.0
        zones.map { z ->
            val s = Triple(block.position(from), block.position(min(z.to, block.max ?: 100.0)), z.tone)
            from = z.to
            s
        }
    }
    val colours = segments.map { it.third.color(t).copy(alpha = 0.85f) }
    val track = t.hairline
    val marker = t.text
    val edge = t.solid
    val position = block.value?.let { block.position(it).toFloat() }
    Canvas(Modifier.fillMaxWidth().height(18.dp).clearAndSetSemantics {}) {
        val w = size.width
        val barTop = (size.height - 6.dp.toPx()) / 2
        val barHeight = 6.dp.toPx()
        val capsule = Path().apply {
            addRoundRect(RoundRect(0f, barTop, w, barTop + barHeight, CornerRadius(barHeight / 2)))
        }
        if (segments.isEmpty()) {
            drawPath(capsule, track)
        } else {
            clipPath(capsule) {
                segments.forEachIndexed { i, s ->
                    val start = (w * s.first).toFloat()
                    val width = max((w * (s.second - s.first)).toFloat(), 0f)
                    drawRect(colours[i], topLeft = Offset(start, barTop), size = Size(width, barHeight))
                }
            }
        }
        if (position != null) {
            // A round marker ringed in the card's colour, so it stands off the zone under it.
            val center = Offset(w * position, size.height / 2)
            drawCircle(edge, radius = 6.dp.toPx() + 3.dp.toPx(), center = center)
            drawCircle(marker, radius = 6.dp.toPx(), center = center)
        }
    }
}
