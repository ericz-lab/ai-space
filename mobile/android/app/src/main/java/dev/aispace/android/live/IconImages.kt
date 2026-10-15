package dev.aispace.android.live

import android.icu.text.BreakIterator
import androidx.compose.ui.graphics.ImageBitmap
import kotlinx.coroutines.flow.SharedFlow

/**
 * Icons and avatars of one Space as the views read them. `IconStore` implements it: fetched through the
 * Space's API with its session and cached in memory and on disk; an icon a manifest places on another
 * site is fetched plainly, without the session (b357ab9), and its failure is not a sign-in failure.
 */
interface IconImages {
    /**
     * The image of an icon (a route of the Space or an http(s) URL), from memory or disk at once; starts
     * a load when it is missing or older than a day. Null for an emoji, or while nothing is loaded yet.
     */
    fun image(icon: String?): ImageBitmap?

    /**
     * The icon whose image just changed, so only the views showing it draw again (015df11); null when
     * every icon was cleared (sign-out).
     */
    val updates: SharedFlow<String?>
}

object Icon {
    /** A path on the Space or an http(s) URL; anything else is an emoji to draw as text. */
    fun isPath(s: String): Boolean =
        s.startsWith("/") || s.lowercase().startsWith("http://") || s.lowercase().startsWith("https://")

    fun emoji(s: String?): String? {
        if (s.isNullOrEmpty() || isPath(s) || graphemes(s) > 4) return null
        return s
    }

    fun isSVG(data: ByteArray): Boolean {
        val head = String(data, 0, minOf(data.size, 512), Charsets.UTF_8).lowercase()
        return head.contains("<svg") || head.contains("<?xml")
    }

    /** Characters as a person counts them, as Swift's `String.count` does. */
    private fun graphemes(s: String): Int {
        val it = BreakIterator.getCharacterInstance()
        it.setText(s)
        var n = 0
        while (it.next() != BreakIterator.DONE) n++
        return n
    }
}
