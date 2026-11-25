package dev.aispace.android.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TerminalTabRulesTests {
    private data class Tab(val id: Int, val name: String)

    @Test fun anOpenSessionIsAskedAboutAndAClosedOneIsNot() {
        assertTrue(TerminalTabRules.asksBeforeEnding(closed = false))
        assertFalse(TerminalTabRules.asksBeforeEnding(closed = true))
    }

    @Test fun aSessionOpenedAgainTakesThePlaceOfItsTab() {
        val tabs = listOf(Tab(1, "a"), Tab(2, "b"), Tab(3, "c"))
        assertEquals(listOf(Tab(1, "a"), Tab(4, "b again"), Tab(3, "c")), TerminalTabRules.place(Tab(4, "b again"), 2, tabs) { it.id })
        // A tab that is gone, or none named, puts the new one at the end.
        assertEquals(tabs + Tab(5, "e"), TerminalTabRules.place(Tab(5, "e"), 9, tabs) { it.id })
        assertEquals(tabs + Tab(5, "e"), TerminalTabRules.place(Tab(5, "e"), null as Int?, tabs) { it.id })
    }
}
