package dev.aispace.android.ui.theme

import android.provider.Settings
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameMillis
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.aispace.android.R
import kotlin.math.PI
import kotlin.math.sin

/** The ai-space mark (docs/logo.svg), from its vector drawable. */
@Composable
fun Logo(size: Dp = 72.dp, modifier: Modifier = Modifier) {
    Image(painterResource(R.drawable.ic_logo), contentDescription = null, modifier = modifier.size(size).clearAndSetSemantics {})
}

/**
 * The mark while the Space is being reached: its three circles and then its leaf dip in turn, a signal
 * going round (7fbdfd3). Drawn from the logo's own geometry (a 512 square) so each part moves alone;
 * still when animations are switched off in the system settings.
 */
@Composable
fun ConnectingMark(size: Dp = 64.dp, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val reduceMotion = remember {
        Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    }
    var time by remember { mutableLongStateOf(0L) }
    if (!reduceMotion) {
        LaunchedEffect(Unit) {
            val start = withFrameMillis { it }
            while (true) time = withFrameMillis { it } - start
        }
    }
    Canvas(modifier.size(size).clearAndSetSemantics {}) {
        val unit = this.size.minDimension / 512f
        val seconds = if (reduceMotion) null else time / 1000.0
        MarkGeometry.circles.forEachIndexed { index, center ->
            val d = MarkGeometry.depth(index, seconds).toFloat()
            scale(1 - 0.2f * d, pivot = Offset(center.x * unit, center.y * unit)) {
                drawCircle(MarkGeometry.blue.copy(alpha = 1 - 0.45f * d), radius = 97 * unit, center = Offset(center.x * unit, center.y * unit))
            }
        }
        val d = MarkGeometry.depth(3, seconds).toFloat()
        val leaf = MarkGeometry.leaf
        val pivot = Offset((leaf.left + leaf.width / 2) * unit, (leaf.top + leaf.height / 2) * unit)
        scale(1 - 0.2f * d, pivot = pivot) {
            val r = CornerRadius(71 * unit)
            val path = Path().apply {
                addRoundRect(
                    RoundRect(
                        left = leaf.left * unit, top = leaf.top * unit, right = leaf.right * unit, bottom = leaf.bottom * unit,
                        topLeftCornerRadius = r, topRightCornerRadius = CornerRadius.Zero,
                        bottomRightCornerRadius = r, bottomLeftCornerRadius = CornerRadius.Zero,
                    ),
                )
            }
            drawPath(path, MarkGeometry.cyan.copy(alpha = 1 - 0.45f * d))
        }
    }
}

internal object MarkGeometry {
    val circles = listOf(Offset(159f, 159f), Offset(159f, 353f), Offset(353f, 353f))
    val leaf = androidx.compose.ui.geometry.Rect(Offset(269f, 71f), Size(174f, 175f))
    val blue = Color(0xFF3F63CF)
    val cyan = Color(0xFF2CC8DC)

    /** One round, the time a part takes to dip and return, and the gap between two parts. */
    private const val PERIOD = 1.8
    private const val DIP = 0.7
    private const val STEP = 0.2

    /** How far into its dip a part is, 0 at rest and 1 at the bottom. */
    fun depth(index: Int, time: Double?): Double {
        if (time == null) return 0.0
        val local = (time - index * STEP) % PERIOD
        if (local < 0 || local >= DIP) return 0.0
        return sin(PI * local / DIP)
    }
}
