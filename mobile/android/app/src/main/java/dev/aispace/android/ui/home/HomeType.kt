package dev.aispace.android.ui.home

import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * The iPhone's text styles at their default sizes, so Home, the screens and Settings read as on iOS.
 * Each carries its own line height: Material's body style would give a 12sp caption a 24sp line.
 */
internal object HomeType {
    val caption2 = TextStyle(fontSize = 11.sp, lineHeight = 13.sp)
    val caption = TextStyle(fontSize = 12.sp, lineHeight = 16.sp)
    val footnote = TextStyle(fontSize = 13.sp, lineHeight = 18.sp)
    val subheadline = TextStyle(fontSize = 15.sp, lineHeight = 20.sp)
    val body = TextStyle(fontSize = 17.sp, lineHeight = 22.sp)
    val headline = TextStyle(fontSize = 17.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold)
    val title3 = TextStyle(fontSize = 20.sp, lineHeight = 25.sp)
    val title = TextStyle(fontSize = 28.sp, lineHeight = 34.sp)
}

/** Figures that line up: `.monospacedDigit()`. */
internal fun TextStyle.tabular(): TextStyle = copy(fontFeatureSettings = "tnum")
