package dev.aispace.android.web

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Port of the iOS AppBrowserTests gesture case. */
class BrowserControlGestureTests {
    @Test
    fun verticalGesturesHaveThresholdsAndIgnoreHorizontalNavigation() {
        var gesture = BrowserControlGesture()
        assertNull(gesture.update(1f, -10f))
        assertEquals(true, gesture.update(2f, -25f))
        assertNull(gesture.update(2f, -22f))
        assertNull(gesture.update(2f, -23f))
        assertEquals(false, gesture.update(1f, 4f))
        gesture = BrowserControlGesture()
        assertNull(gesture.update(90f, -30f))
        assertNull(gesture.update(150f, -60f))
        gesture = BrowserControlGesture()
        assertEquals(false, gesture.update(0f, 30f))
    }

    @Test
    fun resetStartsANewDrag() {
        val gesture = BrowserControlGesture()
        assertNull(gesture.update(0f, -20f))
        gesture.reset()
        assertNull(gesture.update(0f, -20f))
        assertEquals(true, gesture.update(0f, -30f))
    }
}
