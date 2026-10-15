package dev.aispace.android.web

import kotlin.math.abs

/**
 * Whether a finger's vertical drag over a page hides or shows the page's floating button: up hides it,
 * down shows it. A change of direction must travel [threshold] (24dp, in the units the translations
 * come in) before it counts, so small finger movements do not make it flicker; a mostly horizontal
 * drag (a swipe back, a carousel) changes nothing.
 */
class BrowserControlGesture(private val threshold: Float = 24f) {
    private var previousY = 0f
    private var distance = 0f

    /** Starts a new drag. */
    fun reset() {
        previousY = 0f
        distance = 0f
    }

    /**
     * The drag's translation so far, from where the finger went down; true to hide, false to show,
     * null for no change yet.
     */
    fun update(x: Float, y: Float): Boolean? {
        val delta = y - previousY
        previousY = y
        if (abs(y) <= abs(x)) {
            distance = 0f
            return null
        }
        if (delta * distance < 0) distance = 0f
        distance += delta
        if (abs(distance) < threshold) return null
        val hidden = distance < 0
        distance = 0f
        return hidden
    }
}
