package dev.aispace.android.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * One of the panel's themes (PRESETS in src/web/theme.ts) as the phone draws it: the ground, the text,
 * the accent, the three glows and the radius, for light and for dark. The presets that have drawn
 * artwork behind the panel (Orbit, Northern Lights, Paper Cut, Prism) name it; the Space serves it and
 * the backdrop store draws it, over the theme's ground until it has.
 */
@Immutable
data class ThemePreset(
    val id: String,
    val name: String,
    val light: Palette,
    val dark: Palette,
    /** The soft glows over the ground; Simple is flat. */
    val glow: Boolean = true,
    val radius: Dp = 18.dp,
    /** Drawn artwork behind the pages, by the name the Space serves it under (`/backdrops/<name>.html`). */
    val backdrop: String? = null,
) {
    @Immutable
    data class Palette(
        val ground: Long,
        val text: Long,
        val solid: Long,
        val accent: Long,
        val glowA: Long = 0,
        val glowB: Long = 0,
        val glowC: Long = 0,
        /** The secondary text's alpha over [text], at least 4.5:1 on the surfaces (src/web/theme.ts `muted`). */
        val muted: Float = 0.62f,
    )

    companion object {
        private val lightGlow = Triple(0xC7D2FEL, 0xFBCFE8L, 0xA5F3FCL)
        private val darkGlow = Triple(0x2A2872L, 0x5F1642L, 0x134354L)

        private fun light(ground: Long, accent: Long, text: Long = 0x0E1116, solid: Long = 0xFFFFFF, glow: Triple<Long, Long, Long> = lightGlow, muted: Float = 0.62f) =
            Palette(ground, text, solid, accent, glow.first, glow.second, glow.third, muted)

        private fun dark(ground: Long, accent: Long, text: Long = 0xF1F4F8, solid: Long = 0x2C3145, glow: Triple<Long, Long, Long> = darkGlow, muted: Float = 0.66f) =
            Palette(ground, text, solid, accent, glow.first, glow.second, glow.third, muted)

        val aurora = ThemePreset("aurora", "Aurora", light(0xF6F7FB, accent = 0x8B5CF6), dark(0x1C2030, accent = 0x8B5CF6))

        val all: List<ThemePreset> = listOf(
            aurora,
            ThemePreset("simple", "Simple", light(0xF4F5F7, accent = 0x2563EB),
                dark(0x16181D, accent = 0x3B82F6, text = 0xECEEF2, solid = 0x2A2D35), glow = false, radius = 10.dp),
            ThemePreset("warm", "Warm",
                light(0xFAF6F0, accent = 0xC2410C, text = 0x2B2118, solid = 0xFFFAF3, glow = Triple(0xFDE3C4L, 0xFBD0C0L, 0xFEF3C7L), muted = 0.66f),
                dark(0x211A15, accent = 0xF0A46B, text = 0xF6EDE4, solid = 0x3A2F27, glow = Triple(0x5A3418L, 0x5C1F2AL, 0x4A3C12L), muted = 0.64f), radius = 20.dp),
            ThemePreset("orbit", "Orbit", light(0xD3D2F6, accent = 0x5550B8), dark(0x04050E, accent = 0x93A4FF, solid = 0x1C2140), backdrop = "orbit"),
            ThemePreset("northern", "Northern Lights", light(0xF3F1FA, accent = 0x0B7FC9), dark(0x040816, accent = 0x4BE3A8, solid = 0x182540), backdrop = "northern"),
            ThemePreset("papercut", "Paper Cut", light(0xF8F5EF, accent = 0x4D79DE), dark(0x1A2337, accent = 0x7CC4EA, solid = 0x26324C), backdrop = "papercut"),
            ThemePreset("prism", "Prism", light(0xE6E8ED, accent = 0x7257FF), dark(0x12141C, accent = 0xA394FF, solid = 0x242838), backdrop = "prism"),
        )

        fun named(id: String?): ThemePreset = all.firstOrNull { it.id == id } ?: aurora
    }
}

/** An opaque colour from a 0xRRGGBB number, as the presets write them. */
fun rgb(hex: Long): Color = Color(0xFF000000L or (hex and 0xFFFFFFL))

/**
 * The tokens of the theme on show, by the panel's names (src/web/styles.css), so the phone reads as the
 * same product. Read them with `AiTheme.tokens` inside [AISpaceTheme].
 */
@Immutable
data class ThemeTokens(
    val preset: ThemePreset,
    val dark: Boolean,
) {
    private val p get() = if (dark) preset.dark else preset.light
    val accent: Color get() = rgb(p.accent)
    val ground: Color get() = rgb(p.ground)
    val text: Color get() = rgb(p.text)
    val secondaryText: Color get() = rgb(p.text).copy(alpha = p.muted)
    /** A third text level under [secondaryText], for times and footnotes in cards (`--faint`). */
    val faint: Color get() = rgb(p.text).copy(alpha = p.muted * 0.7f)
    val solid: Color get() = rgb(p.solid)
    val glowA: Color get() = rgb(p.glowA)
    val glowB: Color get() = rgb(p.glowB)
    val glowC: Color get() = rgb(p.glowC)
    val hairline: Color get() = if (dark) Color.White.copy(alpha = 0.12f) else Color(14, 17, 22).copy(alpha = 0.08f)
    /** The fill of a glass surface. Android has no material blur under arbitrary views before API 31, and
     *  a live blur is what made the iPhone's launcher drop frames, so glass is a translucent solid. */
    val glass: Color get() = if (dark) rgb(p.solid).copy(alpha = 0.72f) else Color.White.copy(alpha = 0.72f)
    /** `--radius` and the two radii derived from it. */
    val radius: Dp get() = preset.radius
    val radiusMedium: Dp get() = maxOf(preset.radius - 2.dp, 6.dp)
    val radiusSmall: Dp get() = maxOf(preset.radius - 4.dp, 6.dp)

    companion object {
        val link = Color(0xFF6366F1)
        val success = Color(0xFF34C759)
        val warning = Color(0xFFFF9500)
        val danger = Color(0xFFEF4444)
    }
}

val LocalThemeTokens = staticCompositionLocalOf { ThemeTokens(ThemePreset.aurora, dark = false) }

object AiTheme {
    val tokens: ThemeTokens
        @Composable get() = LocalThemeTokens.current
}

/** How the app is drawn on this phone, whatever the panel in a browser is set to. */
enum class Appearance { System, Light, Dark;
    companion object {
        fun of(stored: String?): Appearance = entries.firstOrNull { it.name.equals(stored, ignoreCase = true) } ?: System
    }
}

@Composable
fun isDark(appearance: Appearance): Boolean = when (appearance) {
    Appearance.System -> isSystemInDarkTheme()
    Appearance.Light -> false
    Appearance.Dark -> true
}

/** The app's theme: the preset's tokens, and a Material colour scheme made from them for the stock components. */
@Composable
fun AISpaceTheme(preset: ThemePreset, appearance: Appearance, content: @Composable () -> Unit) {
    val dark = isDark(appearance)
    val tokens = ThemeTokens(preset, dark)
    val scheme = if (dark) {
        darkColorScheme(
            primary = tokens.accent, background = tokens.ground, surface = tokens.solid,
            onBackground = tokens.text, onSurface = tokens.text, surfaceVariant = tokens.solid,
            error = ThemeTokens.danger,
        )
    } else {
        lightColorScheme(
            primary = tokens.accent, background = tokens.ground, surface = tokens.solid,
            onBackground = tokens.text, onSurface = tokens.text, surfaceVariant = tokens.ground,
            error = ThemeTokens.danger,
        )
    }
    CompositionLocalProvider(LocalThemeTokens provides tokens) {
        MaterialTheme(colorScheme = scheme, content = content)
    }
}
