package dev.aispace.android.ui.theme

import android.graphics.Bitmap
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.semantics.clearAndSetSemantics

/**
 * The panel's aurora: three soft glows over the ground colour, or the ground alone in a flat theme.
 * Each glow is a radial gradient fading to nothing, made once per size in a draw cache: a blur this wide
 * drawn live is redrawn on every frame anything over it moves (cdad4b0 on iOS halved GPU time by
 * turning it into one picture).
 */
@Composable
fun Backdrop(modifier: Modifier = Modifier) {
    val t = AiTheme.tokens
    if (!t.preset.glow) {
        Box(modifier.fillMaxSize().background(t.ground))
        return
    }
    Box(
        modifier
            .fillMaxSize()
            .clearAndSetSemantics {}
            .drawWithCache {
                val w = size.width
                val h = size.height
                fun glow(color: Color, diameter: Float, cx: Float, cy: Float): Brush {
                    // The iOS glow is a circle blurred by 70 points at 0.9 opacity: its edge reaches about
                    // half a radius past the circle, so the gradient fades out over 1.5 radii.
                    val r = diameter / 2 * 1.5f
                    return Brush.radialGradient(
                        0f to color.copy(alpha = 0.9f), 0.45f to color.copy(alpha = 0.75f), 1f to color.copy(alpha = 0f),
                        center = Offset(cx, cy), radius = r,
                    )
                }
                val a = glow(t.glowA, w * 0.9f, w * 0.12f, h * 0.08f)
                val b = glow(t.glowB, w * 0.8f, w * 0.95f, h * 0.32f)
                val c = glow(t.glowC, w * 0.85f, w * 0.3f, h * 0.92f)
                onDrawBehind {
                    drawRect(t.ground)
                    drawRect(a)
                    drawRect(b)
                    drawRect(c)
                }
            },
    )
}

/**
 * What is behind the pages of a Space: the theme's glows, or its artwork once the Space has sent it.
 * [artwork] is the bitmap the backdrop store has for the theme (kept on disk, so the next launch shows
 * it at once — a2e99bb), or null while there is none.
 */
@Composable
fun SpaceBackdrop(artwork: Bitmap?, modifier: Modifier = Modifier) {
    val t = AiTheme.tokens
    if (t.preset.backdrop == null) {
        Backdrop(modifier)
        return
    }
    Box(modifier.fillMaxSize().background(t.ground).clearAndSetSemantics {}) {
        AnimatedVisibility(visible = artwork != null, enter = fadeIn(), exit = fadeOut()) {
            if (artwork != null) {
                Box(Modifier.fillMaxSize()) {
                    Image(artwork.asImageBitmap(), contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                    ArtworkVeil()
                }
            }
        }
    }
}

/**
 * The artwork is the setting, not the subject: a soft veil in the ground colour over its middle, where
 * the tiles and cards are, so bright lines in it stop crossing the content (src/web/styles.css
 * `[data-backdrop] .aurora::after`, an ellipse of 62 % × 70 % of the page centred at 50 % / 58 %).
 */
@Composable
private fun ArtworkVeil() {
    val t = AiTheme.tokens
    Box(
        Modifier.fillMaxSize().drawWithCache {
            val w = size.width
            val h = size.height
            val rx = w * 0.62f
            val ry = h * 0.70f
            val center = Offset(w * 0.5f, h * 0.58f)
            val ground = t.ground
            val brush = if (t.dark) {
                Brush.radialGradient(
                    0f to ground.copy(alpha = 0.68f), 0.72f to ground.copy(alpha = 0.25f), 1f to Color.Transparent,
                    center = center, radius = rx,
                )
            } else {
                Brush.radialGradient(0f to ground.copy(alpha = 0.42f), 0.75f to Color.Transparent, center = center, radius = rx)
            }
            // The gradient is a circle of radius rx, stretched vertically into the ellipse.
            val stretch = ry / rx
            val top = center.y - center.y / stretch
            val bottom = center.y + (h - center.y) / stretch
            onDrawBehind {
                scale(1f, stretch, pivot = center) {
                    drawRect(brush, topLeft = Offset(0f, top), size = Size(w, bottom - top))
                }
            }
        },
    )
}

/**
 * A glass surface as the panel draws its cards: translucent, hairline border, soft shadow. The shadow is
 * the platform's elevation shadow, drawn by the render thread from the outline alone, so it does not
 * draw the card's texts and charts again (the cost 14a6384 removed on iOS).
 */
fun Modifier.glass(radius: Dp, fill: Color, hairline: Color, elevation: Dp = 6.dp): Modifier {
    val shape = RoundedCornerShape(radius)
    return this
        .shadow(elevation, shape, clip = false, ambientColor = Color(0xFF1F2687).copy(alpha = 0.10f), spotColor = Color(0xFF1F2687).copy(alpha = 0.10f))
        .background(fill, shape)
        .border(1.dp, hairline, shape)
}

/** [glass] with the theme's own tokens. */
@Composable
fun Modifier.glass(radius: Dp? = null): Modifier {
    val t = AiTheme.tokens
    return glass(radius ?: t.radius, t.glass, t.hairline)
}

/**
 * [glass] without a visible border, as the panel now draws its widget cards and search fields
 * (src/web/styles.css `.widget`, `.omni-bar`, `.lib-search`). A widget card ([neutral]) is laid over a
 * share of the ground colour when the theme has artwork, so a coloured backdrop does not tint every
 * card alike.
 */
@Composable
fun Modifier.borderlessGlass(radius: Dp? = null, neutral: Boolean = false): Modifier {
    val t = AiTheme.tokens
    val ground = neutral && t.preset.backdrop != null
    val fill = if (ground) t.glass.compositeOver(t.ground.copy(alpha = if (t.dark) 0.52f else 0.40f)) else t.glass
    return glass(radius ?: t.radius, fill, Color.Transparent)
}
