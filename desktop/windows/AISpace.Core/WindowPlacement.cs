namespace AISpace.Core;

/// <summary>
/// Where a window may be: wholly on the work area of one monitor (the screen without the taskbar),
/// so its title bar, with Close, Minimize and Maximize, can always be reached. A size larger than
/// that work area is cut down to it; a saved place on a monitor that is gone, or partly off the
/// screen, is moved back onto the monitor it overlaps most (else the first, the primary one).
/// Coordinates are WPF's device-independent pixels, y pointing down.
/// </summary>
public static class WindowPlacement
{
    /// <summary>A new window of <paramref name="width"/> × <paramref name="height"/>, centred on <paramref name="area"/> and no larger than it.</summary>
    public static ScreenRect Centered(double width, double height, ScreenRect area)
    {
        var w = Math.Min(width, area.Width);
        var h = Math.Min(height, area.Height);
        return new ScreenRect(area.X + (area.Width - w) / 2, area.Y + (area.Height - h) / 2, w, h);
    }

    /// <summary>
    /// <paramref name="wanted"/> moved, and shrunk when it must be, onto the work area it overlaps
    /// most. A window smaller than <paramref name="minWidth"/> × <paramref name="minHeight"/> is
    /// grown to that size first, unless the work area itself is smaller.
    /// </summary>
    public static ScreenRect Fit(ScreenRect wanted, IReadOnlyList<ScreenRect> areas, double minWidth = 0, double minHeight = 0)
    {
        if (areas.Count == 0) return wanted;
        var area = AreaFor(wanted, areas);
        var w = Math.Min(Math.Max(wanted.Width, minWidth), area.Width);
        var h = Math.Min(Math.Max(wanted.Height, minHeight), area.Height);
        var x = Math.Clamp(wanted.X, area.X, area.Right - w);
        var y = Math.Clamp(wanted.Y, area.Y, area.Bottom - h);
        return new ScreenRect(x, y, w, h);
    }

    /// <summary>The work area <paramref name="r"/> overlaps most; with no overlap, the one nearest its centre.</summary>
    public static ScreenRect AreaFor(ScreenRect r, IReadOnlyList<ScreenRect> areas)
    {
        var best = areas[0];
        var bestOverlap = 0.0;
        foreach (var a in areas)
        {
            var overlap = Math.Max(0, Math.Min(r.Right, a.Right) - Math.Max(r.X, a.X)) * Math.Max(0, Math.Min(r.Bottom, a.Bottom) - Math.Max(r.Y, a.Y));
            if (overlap > bestOverlap)
            {
                best = a;
                bestOverlap = overlap;
            }
        }
        if (bestOverlap > 0) return best;
        var (cx, cy) = (r.X + r.Width / 2, r.Y + r.Height / 2);
        double Distance(ScreenRect a) => Math.Pow(cx - Math.Clamp(cx, a.X, a.Right), 2) + Math.Pow(cy - Math.Clamp(cy, a.Y, a.Bottom), 2);
        return areas.MinBy(Distance);
    }

    /// <summary>Whether <paramref name="r"/> lies wholly on one of <paramref name="areas"/> (within half a pixel).</summary>
    public static bool IsOnScreen(ScreenRect r, IReadOnlyList<ScreenRect> areas) =>
        areas.Any(a => r.X >= a.X - 0.5 && r.Y >= a.Y - 0.5 && r.Right <= a.Right + 0.5 && r.Bottom <= a.Bottom + 0.5);
}
