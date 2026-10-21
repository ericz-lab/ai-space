package dev.aispace.android.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.luminance
import dev.aispace.android.ui.theme.ThemePreset
import dev.aispace.android.ui.theme.ThemeTokens
import org.junit.Assert.assertTrue
import org.junit.Test

class ThemeTests {
    private fun contrast(a: Color, b: Color): Double {
        val (hi, lo) = listOf(a.luminance().toDouble(), b.luminance().toDouble()).sortedDescending()
        return (hi + 0.05) / (lo + 0.05)
    }

    /** Secondary text stays readable on every surface of every preset and mode (src/web/theme.test.ts). */
    @Test fun secondaryTextReachesFourAndAHalfToOneOnEverySurface() {
        for (preset in ThemePreset.all) for (dark in listOf(false, true)) {
            val t = ThemeTokens(preset, dark)
            for ((name, surface) in listOf("ground" to t.ground, "solid" to t.solid, "glass" to t.glass.compositeOver(t.ground))) {
                val ratio = contrast(t.secondaryText.compositeOver(surface), surface)
                assertTrue("${preset.id} ${if (dark) "dark" else "light"} on $name: $ratio", ratio >= 4.5)
            }
        }
    }
}
