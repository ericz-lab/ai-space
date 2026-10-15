package dev.aispace.android.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PageControlPlacementTests {
    private val page = PageSize(400.0, 800.0)

    @Test fun restsAtTheBottomRightUntilMoved() {
        val placement = PageControlPlacement()
        assertEquals(PagePoint(352.0, 760.0), placement.center(page))
        assertEquals(PagePoint(48.0, 40.0), PageControlPlacement(PageControlPlacement.Side.left, 0.0).center(page))
    }

    @Test fun snapsToTheNearerEdgeAndKeepsItsHeight() {
        val left = PageControlPlacement.settled(PagePoint(199.0, 400.0), page)
        assertEquals(PageControlPlacement.Side.left, left.side)
        assertEquals(PagePoint(48.0, 400.0), left.center(page))
        val right = PageControlPlacement.settled(PagePoint(200.0, 400.0), page)
        assertEquals(PagePoint(352.0, 400.0), right.center(page))
        // A release beyond the page rests at its margin.
        assertEquals(PageControlPlacement(PageControlPlacement.Side.left, 0.0), PageControlPlacement.settled(PagePoint(-80.0, -50.0), page))
        assertEquals(PageControlPlacement(), PageControlPlacement.settled(PagePoint(900.0, 2000.0), page))
    }

    @Test fun keepsItsShareOfTheHeightWhenThePageChangesSize() {
        val placement = PageControlPlacement.settled(PagePoint(10.0, 400.0), page)
        assertEquals(PagePoint(48.0, 200.0), placement.center(PageSize(800.0, 400.0)))
        // A page too small for the button's travel still gets a finite place.
        assertEquals(PagePoint(48.0, 40.0), PageControlPlacement().center(PageSize.zero))
        assertEquals(1.0, PageControlPlacement.settled(PagePoint.zero, PageSize.zero).vertical, 0.0)
    }

    @Test fun aDraggedButtonStaysOnThePage() {
        assertEquals(PagePoint(28.0, 760.0), PageControlPlacement.clamped(PagePoint(-20.0, 900.0), page))
        assertEquals(PagePoint(372.0, 40.0), PageControlPlacement.clamped(PagePoint(500.0, 0.0), page))
        assertEquals(PagePoint(200.0, 300.0), PageControlPlacement.clamped(PagePoint(200.0, 300.0), page))
    }

    @Test fun theMenuOpensWhereThereIsRoom() {
        val bottom = PageControlPlacement()
        assertTrue(bottom.menuAbove(page))
        assertEquals(80.0, bottom.menuRoom(page).inset, 0.0)
        assertEquals(708.0, bottom.menuRoom(page).height, 0.0)
        val top = PageControlPlacement(PageControlPlacement.Side.left, 0.0)
        assertFalse(top.menuAbove(page))
        assertEquals(80.0, top.menuRoom(page).inset, 0.0)
        // A short page keeps a usable menu.
        assertEquals(120.0, bottom.menuRoom(PageSize(400.0, 150.0)).height, 0.0)
    }

    @Test fun storesAndRestoresItsPlace() {
        val placement = PageControlPlacement(PageControlPlacement.Side.left, 0.25)
        assertEquals(placement, PageControlPlacement.fromStored(placement.stored))
        assertEquals(PageControlPlacement(), PageControlPlacement.fromStored(""))
        assertEquals(PageControlPlacement(), PageControlPlacement.fromStored("middle:0.5"))
        assertEquals(1.0, PageControlPlacement.fromStored("left:9").vertical, 0.0)
        assertEquals(1.0, PageControlPlacement.fromStored("left:nan").vertical, 0.0)
        assertEquals(PageControlPlacement(PageControlPlacement.Side.right, 0.25), placement.opposite)
    }
}
