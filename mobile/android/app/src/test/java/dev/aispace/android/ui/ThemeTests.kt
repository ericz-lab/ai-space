package dev.aispace.android.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.luminance
import dev.aispace.android.ui.theme.ThemePreset
import dev.aispace.android.ui.theme.ThemeTokens
import org.junit.Assert.assertEquals
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

    /** The dark sheet is the web's `color-mix(color-mix(panel 40%, #05060a) 74%, transparent)` (92f32d5). */
    @Test fun theDarkSheetIsThePanelPulledTowardBlack() {
        val sheet = ThemeTokens(ThemePreset.aurora, dark = true).sheet
        // Aurora's dark panel is rgba(40, 45, 62, .97): mixed with premultiplied alpha, then at 74 %.
        assertEquals(18.74f / 255, sheet.red, 0.01f)
        assertEquals(21.32f / 255, sheet.green, 0.01f)
        assertEquals(30.42f / 255, sheet.blue, 0.01f)
        assertEquals(0.988f * 0.74f, sheet.alpha, 0.01f)
        val light = ThemeTokens(ThemePreset.aurora, dark = false).sheet
        assertEquals(0.94f * 0.8f, light.alpha, 0.01f)
    }

    /** Text keeps its contrast on the sheet, opaque or over the ground and the brightest glow. */
    @Test fun secondaryTextReachesFourAndAHalfToOneOnTheSheet() {
        for (preset in ThemePreset.all) for (dark in listOf(false, true)) {
            val t = ThemeTokens(preset, dark)
            val behind = listOf(t.ground) + if (preset.glow) listOf(t.glowA, t.glowB, t.glowC) else emptyList()
            for (under in behind) {
                val surface = t.sheet.compositeOver(under)
                val ratio = contrast(t.secondaryText.compositeOver(surface), surface)
                assertTrue("${preset.id} ${if (dark) "dark" else "light"} sheet over $under: $ratio", ratio >= 4.5)
            }
            val ratio = contrast(t.secondaryText.compositeOver(t.sheetSolid), t.sheetSolid)
            assertTrue("${preset.id} ${if (dark) "dark" else "light"} solid sheet: $ratio", ratio >= 4.5)
        }
    }
}
