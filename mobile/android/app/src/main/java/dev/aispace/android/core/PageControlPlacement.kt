package dev.aispace.android.core

/** A page's size in the units the caller draws in (dp on Android). */
data class PageSize(val width: Double, val height: Double) {
    companion object {
        val zero = PageSize(0.0, 0.0)
    }
}

/** A point on a page, in the same units as [PageSize]. */
data class PagePoint(val x: Double, val y: Double) {
    companion object {
        val zero = PagePoint(0.0, 0.0)
    }
}

/**
 * Where an app page's floating button rests: against the left or the right edge, at a height
 * kept as a share of the room it has, so the place survives rotation and a keyboard.
 */
class PageControlPlacement(side: Side = Side.right, vertical: Double = 1.0) {
    enum class Side { left, right }

    val side: Side = side

    /** 0 is the top of the page, 1 the bottom. */
    val vertical: Double = if (vertical.isFinite()) vertical.coerceIn(0.0, 1.0) else 1.0

    /** The stored form is `<side>:<vertical>`. */
    val stored: String get() = "${side.name}:$vertical"

    val opposite: PageControlPlacement
        get() = PageControlPlacement(if (side == Side.left) Side.right else Side.left, vertical)

    /** The button's centre in a page of this size. */
    fun center(size: PageSize): PagePoint {
        val x = sideMargin + diameter / 2
        val (lo, hi) = verticalRange(size)
        return PagePoint(
            x = if (side == Side.left) x else Math.max(x, size.width - x),
            y = lo + (hi - lo) * vertical,
        )
    }

    /** The menu opens on the side of the button that has more room. */
    fun menuAbove(size: PageSize): Boolean = center(size).y >= size.height / 2

    data class MenuRoom(val inset: Double, val height: Double)

    /** The height left for the menu on that side, and how far the page's edge is from it. */
    fun menuRoom(size: PageSize): MenuRoom {
        val y = center(size).y
        val edge = if (menuAbove(size)) size.height - y else y
        val inset = edge + diameter / 2 + menuGap
        return MenuRoom(inset, Math.max(120.0, size.height - inset - verticalMargin))
    }

    override fun equals(other: Any?) = other is PageControlPlacement && other.side == side && other.vertical == vertical
    override fun hashCode() = side.hashCode() * 31 + vertical.hashCode()
    override fun toString() = "PageControlPlacement($stored)"

    companion object {
        const val diameter = 56.0
        const val sideMargin = 20.0
        const val verticalMargin = 12.0

        /** The gap between the button and its menu. */
        const val menuGap = 12.0

        /** The place stored as `<side>:<vertical>`; anything else is the default place. */
        fun fromStored(stored: String): PageControlPlacement {
            val parts = stored.split(":").filter { it.isNotEmpty() }
            if (parts.size != 2) return PageControlPlacement()
            val side = Side.entries.firstOrNull { it.name == parts[0] } ?: return PageControlPlacement()
            val vertical = parseDouble(parts[1]) ?: return PageControlPlacement()
            return PageControlPlacement(side, vertical)
        }

        /** As Swift's `Double(_:)`: also `nan` and `inf`. */
        private fun parseDouble(s: String): Double? = when (s.lowercase()) {
            "nan", "+nan", "-nan" -> Double.NaN
            "inf", "+inf", "infinity", "+infinity" -> Double.POSITIVE_INFINITY
            "-inf", "-infinity" -> Double.NEGATIVE_INFINITY
            else -> if (s.isNotEmpty() && s.last().isDigit() || s.endsWith(".")) s.toDoubleOrNull() else null
        }

        /** A centre the finger may drag the button to: anywhere, but not off the page. */
        fun clamped(point: PagePoint, size: PageSize): PagePoint {
            val half = diameter / 2
            val (lo, hi) = verticalRange(size)
            return PagePoint(
                x = Math.min(Math.max(half, size.width - half), Math.max(half, point.x)),
                y = Math.min(hi, Math.max(lo, point.y)),
            )
        }

        /** The place a released button snaps to: the nearer edge, at the height it was let go. */
        fun settled(point: PagePoint, size: PageSize): PageControlPlacement {
            val (lo, hi) = verticalRange(size)
            val travel = hi - lo
            val y = Math.min(hi, Math.max(lo, point.y))
            return PageControlPlacement(
                if (point.x < size.width / 2) Side.left else Side.right,
                if (travel > 0) (y - lo) / travel else 1.0,
            )
        }

        private fun verticalRange(size: PageSize): Pair<Double, Double> {
            val top = verticalMargin + diameter / 2
            return top to Math.max(top, size.height - top)
        }
    }
}
