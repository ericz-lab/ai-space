using System.Text.Json.Nodes;

namespace AISpace.Core;

/// <summary>A card's frame: <c>W</c> a fraction of the widget area's width, <c>H</c> a height in px (device-independent units here).</summary>
public readonly record struct Frame(double W, double H);

/// <summary>Where a short row's free space goes: at its end, or on both sides.</summary>
public enum WidgetAlign
{
    Start,
    Center,
}

/// <summary>A card's box in the area, and the row it is on.</summary>
public readonly record struct Box(double X, double Y, double Width, double Height, int Row);

/// <summary>Every card's box, the rows as card indices, and the area's height.</summary>
public sealed record Placed(IReadOnlyList<Box> Boxes, IReadOnlyList<IReadOnlyList<int>> Rows, double Height);

/// <summary>Which edge of a card is dragged: the right one, the bottom one, or the corner (both).</summary>
public enum ResizeEdge
{
    X,
    Y,
    XY,
}

/// <summary>The snap lines to show while an edge is dragged: vertical ones at <c>X</c>, horizontal ones at <c>Y</c>, in the area's coordinates.</summary>
public sealed record Guides(IReadOnlyList<double> X, IReadOnlyList<double> Y)
{
    public bool Any => X.Count > 0 || Y.Count > 0;
}

/// <summary>What the layout knows of a widget: its id, its classic size, and its frame when one is stored.</summary>
public sealed record LayoutCard(string Id, string Size, Frame? Frame = null);

/// <summary>
/// A write to the panel's layout (<c>PUT /api/panel/layout</c>): frames by widget id (<c>null</c>
/// removes one), the classic sizes alongside, the alignment. Each part is left out when null.
/// </summary>
public sealed record LayoutWrite
{
    public Dictionary<string, Frame?>? Frames { get; init; }
    public Dictionary<string, string>? Sizes { get; init; }
    public WidgetAlign? Align { get; init; }

    /// <summary>The body as the server reads it; a removed frame is written as <c>null</c>.</summary>
    public JsonObject ToJson()
    {
        var o = new JsonObject();
        if (Frames is not null)
        {
            var f = new JsonObject();
            foreach (var (id, frame) in Frames) f[id] = frame is { } v ? new JsonObject { ["w"] = v.W, ["h"] = v.H } : null;
            o["frames"] = f;
        }
        if (Sizes is not null)
        {
            var s = new JsonObject();
            foreach (var (id, size) in Sizes) s[id] = size;
            o["sizes"] = s;
        }
        if (Align is { } a) o["widgetAlign"] = WidgetLayout.AlignName(a);
        return o;
    }

    /// <summary>
    /// The same write for a server that refuses <c>frames</c>: the sizes only (a size written alone
    /// drops a frame there, which that server does not have anyway). Null when nothing is left.
    /// </summary>
    public LayoutWrite? SizesOnly() => Sizes is { Count: > 0 } s ? new LayoutWrite { Sizes = s } : null;
}

/// <summary>
/// The widget area's layout without WPF (src/web/widget-layout.ts, docs/panel.md#resize-a-widget),
/// the same rules, constants and cases as the web panel's, the Mac's and Linux's: a flow of cards
/// with a fixed gap, wrapped into rows. A card <c>w</c> wide is <c>w * (W + GAP) - GAP</c> px in an
/// area <c>W</c> wide, so fractions that sum to 1 fill a row exactly with <c>GAP</c> between the
/// cards at any width. Every card of a row takes the row's height, the largest <c>h</c> in it, and
/// rows are <c>GAP</c> apart. WPF's units are device-independent, so the web's px map 1:1.
/// </summary>
public static class WidgetLayout
{
    public const double Gap = 20, MinW = 200, MinH = 140, MaxH = 900;
    /// <summary>The smallest fraction the server keeps (src/space/panel/layout.ts).</summary>
    public const double MinFrac = 0.1;
    /// <summary>At this width or below (the web's <c>max-width: 700px</c>) the area is one column of cards sized by their content.</summary>
    public const double OneColumnBelow = 700;
    /// <summary>The old grid's column and the height a card without a frame gets per row.</summary>
    public const double OldColumn = 320, RowH = 300;
    /// <summary>How close an edge has to come to a candidate to snap to it.</summary>
    public const double SnapPx = 8;
    /// <summary>The equal divisions of the area an edge snaps to.</summary>
    public static readonly double[] Divisions = [1.0 / 4, 1.0 / 3, 1.0 / 2, 2.0 / 3, 3.0 / 4, 1];
    /// <summary>Row sums may exceed 1 by this much (stored fractions are rounded) and still fit.</summary>
    private const double Eps = 1e-4;
    /// <summary>The size class thresholds and the band around them that keeps a dragged card from flickering.</summary>
    public const double WideAt = 560, TallAt = 480, Hysteresis = 16;
    /// <summary>The reference area the nearest classic size is judged in.</summary>
    private const double ReferenceW = 1100;
    /// <summary>Rows whose heights are within this of each other take the tallest of them (Align).</summary>
    private const double HeightGroup = 24;

    /// <summary>JavaScript's <c>Math.round</c>: halves go up, not to even.</summary>
    internal static double JsRound(double v) => Math.Floor(v + 0.5);

    public static string AlignName(WidgetAlign a) => a == WidgetAlign.Center ? "center" : "start";

    public static WidgetAlign? ParseAlign(string? s) => s switch { "center" => WidgetAlign.Center, "start" => WidgetAlign.Start, _ => null };

    public static double PxOf(double w, double W) => w * (W + Gap) - Gap;

    public static double FracOf(double px, double W) => (px + Gap) / (W + Gap);

    /// <summary>The smallest fraction a card can be in an area <paramref name="W"/> wide: 200px, or the whole area when it is narrower.</summary>
    public static double MinFracFor(double W) => W <= MinW ? 1 : Math.Min(1, Math.Max(MinFrac, FracOf(MinW, W)));

    public static double ClampH(double h) => Math.Min(MaxH, Math.Max(MinH, JsRound(double.IsFinite(h) ? h : RowH)));

    private static double Clamp(double v, double lo, double hi) => Math.Min(hi, Math.Max(lo, v));

    /// <summary>Whether the area is one column of cards sized by their content: the page is this narrow.</summary>
    public static bool OneColumn(double viewport) => viewport <= OneColumnBelow;

    /// <summary>The number of 320px+ columns the old grid had in an area <paramref name="W"/> wide.</summary>
    public static int OldColumns(double W) => Math.Max(1, (int)Math.Floor((W + Gap) / (OldColumn + Gap)));

    /// <summary>A classic size's columns and rows; anything else is 1x1.</summary>
    public static (int Cols, int Rows) SpanOf(string? size) => size switch
    {
        "1x1" => (1, 1),
        "2x1" => (2, 1),
        "1x2" => (1, 2),
        "2x2" => (2, 2),
        _ => (1, 1),
    };

    /// <summary>The frame of a card without one: its size's columns of the old grid at this width, and its rows' height.</summary>
    public static Frame DefaultFrame(string? size, double W)
    {
        var n = OldColumns(W);
        var (cols, rows) = SpanOf(size);
        return new Frame((double)Math.Min(cols, n) / n, rows == 1 ? RowH : 2 * RowH + Gap);
    }

    /// <summary>A frame as drawn in an area <paramref name="W"/> wide: at least the minimum width, the height within its bounds.</summary>
    public static Frame Effective(Frame f, double W) => new(Clamp(double.IsFinite(f.W) ? f.W : 1, MinFracFor(W), 1), ClampH(f.H));

    /// <summary>The frames of an area's cards as drawn: the stored frame, else the default from the size.</summary>
    public static Frame[] ResolveFrames(IEnumerable<(string? Size, Frame? Frame)> cards, double W) =>
        cards.Select(c => Effective(c.Frame ?? DefaultFrame(c.Size, W), W)).ToArray();

    public static Frame[] ResolveFrames(IEnumerable<LayoutCard> cards, double W) => ResolveFrames(cards.Select(c => ((string?)c.Size, c.Frame)), W);

    /// <summary>Rows of card indices: a card goes on the current row while the row's fractions stay at most 1.</summary>
    public static List<List<int>> BreakRows(IReadOnlyList<double> ws)
    {
        var rows = new List<List<int>>();
        var cur = new List<int>();
        double used = 0;
        for (var i = 0; i < ws.Count; i++)
        {
            if (cur.Count > 0 && used + ws[i] > 1 + Eps)
            {
                rows.Add(cur);
                cur = [];
                used = 0;
            }
            cur.Add(i);
            used += ws[i];
        }
        if (cur.Count > 0) rows.Add(cur);
        return rows;
    }

    private static List<List<int>> RowsOf(IReadOnlyList<Frame> frames) => BreakRows(frames.Select(f => f.W).ToList());

    /// <summary>The px width a row's cards take, gaps between them included.</summary>
    public static double RowWidth(IReadOnlyList<Frame> frames, IReadOnlyList<int> row, double W) => Math.Min(W, row.Sum(i => frames[i].W) * (W + Gap) - Gap);

    /// <summary>Where every card goes; <paramref name="frames"/> are as drawn (<see cref="Effective"/>).</summary>
    public static Placed Place(IReadOnlyList<Frame> frames, double W, WidgetAlign align = WidgetAlign.Start)
    {
        var rows = RowsOf(frames);
        var boxes = new Box[frames.Count];
        double y = 0;
        for (var r = 0; r < rows.Count; r++)
        {
            var row = rows[r];
            var height = row.Max(i => frames[i].H);
            var x = align == WidgetAlign.Center ? Math.Max(0, (W - RowWidth(frames, row, W)) / 2) : 0;
            foreach (var i in row)
            {
                var width = Math.Min(W, PxOf(frames[i].W, W));
                boxes[i] = new Box(x, y, width, height, r);
                x += width + Gap;
            }
            y += height + Gap;
        }
        return new Placed(boxes, rows, Math.Max(0, y - Gap));
    }

    /// <summary>
    /// Card <paramref name="i"/> set to <paramref name="px"/> wide. The default moves the boundary
    /// with the next card of its row, which takes or gives the difference (both stay above the
    /// minimum); the last card of a row grows into the row's free space and no further.
    /// <paramref name="reflow"/> (Shift) changes this card only and lets the cards after it wrap.
    /// </summary>
    public static Frame[] SetWidth(IReadOnlyList<Frame> frames, double W, int i, double px, bool reflow = false)
    {
        var output = frames.ToArray();
        var lo = MinFracFor(W);
        var want = FracOf(px, W);
        if (reflow)
        {
            output[i] = output[i] with { W = Clamp(want, lo, 1) };
            return output;
        }
        var row = RowsOf(frames).First(r => r.Contains(i));
        var k = row.IndexOf(i);
        if (k + 1 < row.Count)
        {
            var next = row[k + 1];
            var pair = frames[i].W + frames[next].W;
            output[i] = output[i] with { W = Clamp(want, lo, Math.Max(lo, pair - lo)) };
            output[next] = output[next] with { W = pair - output[i].W };
            return output;
        }
        var free = Math.Max(0, 1 - row.Sum(j => frames[j].W));
        output[i] = output[i] with { W = Clamp(want, lo, Math.Max(lo, frames[i].W + free)) };
        return output;
    }

    /// <summary>Every card in card <paramref name="i"/>'s row set to <paramref name="h"/> px tall.</summary>
    public static Frame[] SetRowHeight(IReadOnlyList<Frame> frames, int i, double h)
    {
        var row = RowsOf(frames).First(r => r.Contains(i));
        return frames.Select((f, j) => row.Contains(j) ? f with { H = ClampH(h) } : f).ToArray();
    }

    /// <summary>The nearest candidate within <paramref name="within"/> px of <paramref name="value"/>, or null.</summary>
    public static double? SnapTo(double value, IEnumerable<double> candidates, double within = SnapPx)
    {
        double? best = null;
        foreach (var c in candidates)
        {
            if (Math.Abs(c - value) <= within && (best is null || Math.Abs(c - value) < Math.Abs(best.Value - value))) best = c;
        }
        return best;
    }

    /// <summary>
    /// Where card <paramref name="i"/>'s right edge may snap, measured from its row's left edge: the
    /// area's equal divisions, and the edges of the cards in other rows (a right edge, and a left edge
    /// less the gap, so the card after this one lines up with it). In a centred area the other rows'
    /// edges are taken relative to this row's offset at the start of the drag.
    /// </summary>
    public static List<double> EdgeCandidates(Placed placed, double W, int i)
    {
        var me = placed.Boxes[i];
        var off = placed.Boxes[placed.Rows[me.Row][0]].X;
        var output = Divisions.Select(f => PxOf(f, W)).ToList();
        for (var j = 0; j < placed.Boxes.Count; j++)
        {
            var b = placed.Boxes[j];
            if (b.Row == me.Row || j == i) continue;
            output.Add(b.X + b.Width - off);
            output.Add(b.X - Gap - off);
        }
        return output.Where(x => x > 0 && x <= W + 0.5).ToList();
    }

    /// <summary>The heights of the rows other than card <paramref name="i"/>'s, which its row's height may snap to.</summary>
    public static List<double> HeightCandidates(Placed placed, int i)
    {
        var me = placed.Boxes[i].Row;
        return placed.Rows.Where((_, r) => r != me).Select(row => placed.Boxes[row[0]].Height).Distinct().ToList();
    }

    /// <summary>
    /// Align: in every row each boundary moves to the nearest twelfth of the area (every card kept
    /// above the minimum), and rows whose heights are within 24px of each other take the tallest of them.
    /// </summary>
    public static Frame[] AlignTwelfths(IReadOnlyList<Frame> frames, double W)
    {
        var output = frames.ToArray();
        var lo = MinFracFor(W);
        var rows = RowsOf(frames);
        foreach (var row in rows)
        {
            double prev = 0, cum = 0;
            for (var k = 0; k < row.Count; k++)
            {
                var i = row[k];
                cum += frames[i].W;
                var rest = row.Count - 1 - k;
                var min = prev + lo;
                var max = Math.Max(min, 1 - rest * lo);
                var c = JsRound(cum * 12) / 12;
                if (c < min - 1e-9) c = Math.Ceiling(min * 12 - 1e-9) / 12;
                if (c > max + 1e-9) c = Math.Floor(max * 12 + 1e-9) / 12;
                c = Clamp(c, min, max);
                output[i] = output[i] with { W = c - prev };
                prev = c;
            }
        }
        var heights = rows.Select(row => row.Max(i => frames[i].H)).ToList();
        // A stable sort, tallest first, as the web's Array.prototype.sort.
        var order = heights.Select((h, r) => (h, r)).OrderByDescending(x => x.h).ToList();
        var top = double.PositiveInfinity;
        foreach (var (h, r) in order)
        {
            if (top - h > HeightGroup) top = h;
            foreach (var i in rows[r]) output[i] = output[i] with { H = top };
        }
        return output;
    }

    /// <summary>Split evenly: the cards of every row get equal widths that fill it, every row the median height.</summary>
    public static Frame[] SplitEvenly(IReadOnlyList<Frame> frames)
    {
        var output = frames.ToArray();
        var rows = RowsOf(frames);
        if (rows.Count == 0) return output;
        var heights = rows.Select(row => row.Max(i => frames[i].H)).OrderBy(h => h).ToList();
        var mid = heights.Count >> 1;
        var median = heights.Count % 2 == 1 ? heights[mid] : JsRound((heights[mid - 1] + heights[mid]) / 2);
        foreach (var row in rows)
        {
            foreach (var i in row) output[i] = new Frame(1.0 / row.Count, median);
        }
        return output;
    }

    /// <summary>A frame as stored: rounded, within the server's bounds.</summary>
    public static Frame Tidy(Frame f) => new(JsRound(Clamp(f.W, MinFrac, 1) * 1e6) / 1e6, ClampH(f.H));

    public static bool SameFrame(Frame? a, Frame? b) => a is { } x && b is { } y && Math.Abs(x.W - y.W) < 1e-6 && Math.Abs(x.H - y.H) < 0.5;

    /// <summary>The classic size closest to a frame, for clients that only know <c>sizes</c>: judged in a 1100px area.</summary>
    public static string NearestSize(Frame f)
    {
        var cols = PxOf(f.W, ReferenceW) >= WideAt ? 2 : 1;
        var rows = f.H >= TallAt ? 2 : 1;
        return $"{cols}x{rows}";
    }

    /// <summary>
    /// The size class a card's inner layout follows (<c>1x1</c>, <c>2x1</c>, <c>1x2</c>, <c>2x2</c>),
    /// from its drawn box: wide at 560px, tall at 480px. Once wide or tall it stays so until 16px
    /// below, so a dragged edge near a threshold does not flip the layout back and forth.
    /// </summary>
    public static string SizeClass(string? prev, double width, double height)
    {
        var (pc, pr) = prev is null ? (0, 0) : SpanOf(prev);
        var wide = pc == 2 ? width >= WideAt - Hysteresis : width >= WideAt;
        var tall = pr == 2 ? height >= TallAt - Hysteresis : height >= TallAt;
        return $"{(wide ? 2 : 1)}x{(tall ? 2 : 1)}";
    }

    /// <summary>
    /// The write that takes an area from <paramref name="before"/> to <paramref name="after"/> (frames
    /// as drawn), with the one that undoes it. Only the cards whose frame changed are written; each
    /// also gets its nearest classic size. Null when nothing changed.
    /// </summary>
    public static (LayoutWrite Write, LayoutWrite Undo)? FramesWrite(IReadOnlyList<LayoutCard> cards, IReadOnlyList<Frame> before, IReadOnlyList<Frame> after)
    {
        var wf = new Dictionary<string, Frame?>();
        var ws = new Dictionary<string, string>();
        var uf = new Dictionary<string, Frame?>();
        var us = new Dictionary<string, string>();
        for (var i = 0; i < cards.Count; i++)
        {
            if (SameFrame(before[i], after[i])) continue;
            var c = cards[i];
            var f = Tidy(after[i]);
            wf[c.Id] = f;
            ws[c.Id] = NearestSize(f);
            uf[c.Id] = c.Frame;
            us[c.Id] = c.Size;
        }
        return wf.Count > 0 ? (new LayoutWrite { Frames = wf, Sizes = ws }, new LayoutWrite { Frames = uf, Sizes = us }) : null;
    }

    /// <summary>Reset: every framed card of the area back to its size's default, and the write that puts the frames back. Null when none has a frame.</summary>
    public static (LayoutWrite Write, LayoutWrite Undo)? ResetWrite(IReadOnlyList<LayoutCard> cards)
    {
        var framed = cards.Where(c => c.Frame is not null).ToList();
        if (framed.Count == 0) return null;
        return (new LayoutWrite { Frames = framed.ToDictionary(c => c.Id, _ => (Frame?)null) },
            new LayoutWrite { Frames = framed.ToDictionary(c => c.Id, c => c.Frame), Sizes = framed.ToDictionary(c => c.Id, c => c.Size) });
    }

    /// <summary>Center: the alignment toggled, and the write that puts it back.</summary>
    public static (LayoutWrite Write, LayoutWrite Undo) CenterWrite(WidgetAlign align) =>
        (new LayoutWrite { Align = align == WidgetAlign.Center ? WidgetAlign.Start : WidgetAlign.Center }, new LayoutWrite { Align = align });

    /// <summary>
    /// A layout write applied to the cards (frames and sizes), as the server stores it: a size written
    /// without a frame for the same widget drops its frame (a client that only knows sizes).
    /// </summary>
    public static (string Size, Frame? Frame)? Applied(string id, string size, Frame? frame, LayoutWrite write)
    {
        var hasFrame = write.Frames is not null && write.Frames.ContainsKey(id);
        var newSize = write.Sizes?.GetValueOrDefault(id);
        if (!hasFrame && string.IsNullOrEmpty(newSize)) return null;
        var f = hasFrame ? write.Frames![id] : null;
        return (string.IsNullOrEmpty(newSize) ? size : newSize, f);
    }

    public static List<LayoutCard> ApplyWrite(IEnumerable<LayoutCard> cards, LayoutWrite write) =>
        cards.Select(c => Applied(c.Id, c.Size, c.Frame, write) is { } a ? c with { Size = a.Size, Frame = a.Frame } : c).ToList();

    /// <summary>
    /// How many compact rows a card of a fixed height shows per page: the most rows such that every
    /// page (its rows laid out in <paramref name="cols"/> columns, a grid row as tall as its tallest
    /// cell, <paramref name="gap"/> apart) fits in the <paramref name="avail"/> px under the hero; all
    /// of them when they fit at once, else with the pager's <paramref name="pagerH"/> kept free. Never
    /// fewer than one row per column.
    /// </summary>
    public static int RowsThatFit(double avail, IReadOnlyList<double> heights, double gap, int cols, double pagerH)
    {
        var total = heights.Count;
        var c = Math.Max(1, cols);
        if (total == 0) return 1;
        double PageHeight(IReadOnlyList<double> rows)
        {
            double h = 0;
            for (var k = 0; k < rows.Count; k += c) h += rows.Skip(k).Take(c).Max() + (k > 0 ? gap : 0);
            return h;
        }
        bool Fits(int n, double room)
        {
            for (var k = 0; k < total; k += n)
            {
                if (PageHeight(heights.Skip(k).Take(n).ToList()) > room + 0.5) return false;
            }
            return true;
        }
        if (Fits(total, avail)) return total;
        for (var n = total - 1; n > c; n--)
        {
            if (Fits(n, avail - pagerH)) return n;
        }
        return c;
    }

    /// <summary>
    /// The handles from the keyboard: one press moves the edge 8px (1px with Shift), the width through
    /// <see cref="SetWidth"/> (the boundary with the next card), the height through <see cref="SetRowHeight"/>.
    /// <paramref name="dx"/> and <paramref name="dy"/> are -1, 0 or 1; an arrow along the other axis
    /// of a one-axis handle does nothing (null).
    /// </summary>
    public static Frame[]? KeyStep(IReadOnlyList<Frame> frames, double W, WidgetAlign align, int i, ResizeEdge edge, int dx, int dy, bool fine)
    {
        var step = fine ? 1 : 8;
        if (dx != 0 && edge == ResizeEdge.Y || dy != 0 && edge == ResizeEdge.X || dx == 0 && dy == 0) return null;
        var b = Place(frames, W, align).Boxes[i];
        var f = frames.ToArray();
        if (dx != 0) f = SetWidth(f, W, i, b.Width + dx * step);
        if (dy != 0) f = SetRowHeight(f, i, b.Height + dy * step);
        return f;
    }
}

/// <summary>
/// One drag of a card's edge (WidgetArea.tsx <c>startResize</c>): what the area looks like when the
/// pointer has moved by (<c>dx</c>, <c>dy</c>) from where it was pressed. The width goes through
/// <see cref="WidgetLayout.SetWidth"/> (the boundary with the next card, or the row's free space;
/// Shift re-flows), the height sets the row's; both snap unless Alt is held, and the guides say where.
/// Everything is taken from the area as it was when the drag started.
/// </summary>
public sealed class ResizeDrag
{
    private readonly Frame[] _base;
    private readonly double _w;
    private readonly WidgetAlign _align;
    private readonly int _i;
    private readonly ResizeEdge _edge;
    private readonly Box _b0;
    private readonly double _off0, _used0;
    private readonly bool _last;
    private readonly List<double> _relEdges, _absEdges, _heights;

    public ResizeDrag(IReadOnlyList<Frame> frames, double W, WidgetAlign align, int i, ResizeEdge edge)
    {
        _base = frames.ToArray();
        _w = W;
        _align = align;
        _i = i;
        _edge = edge;
        var p0 = WidgetLayout.Place(_base, W, align);
        _b0 = p0.Boxes[i];
        var row = p0.Rows[_b0.Row];
        _off0 = p0.Boxes[row[0]].X;
        _last = row[^1] == i;
        _used0 = WidgetLayout.RowWidth(_base, row, W);
        _relEdges = WidgetLayout.EdgeCandidates(p0, W, i);
        // A centred row whose width changes keeps its middle: its right end moves half as far as the
        // card grows, so the card grows twice the pointer's travel and snaps on the area's own lines.
        _absEdges = [];
        for (var j = 0; j < p0.Boxes.Count; j++)
        {
            var b = p0.Boxes[j];
            if (b.Row == _b0.Row || j == i) continue;
            _absEdges.Add(b.X + b.Width);
            _absEdges.Add(b.X - WidgetLayout.Gap);
        }
        _heights = WidgetLayout.HeightCandidates(p0, i);
    }

    public IReadOnlyList<Frame> Base => _base;

    public (Frame[] Frames, Guides Guides) At(double dx, double dy, bool shift, bool alt)
    {
        var f = _base;
        var snappedX = false;
        double? snappedH = null;
        if (_edge != ResizeEdge.Y)
        {
            double want;
            if ((_last || shift) && _align == WidgetAlign.Center)
            {
                want = _b0.Width + 2 * dx;
                if (!alt)
                {
                    var used = _used0 + 2 * dx;
                    var options = _absEdges.Select(x => 2 * x - _w).Concat(WidgetLayout.Divisions.Select(d => WidgetLayout.PxOf(d, _w)));
                    if (WidgetLayout.SnapTo(used, options, 2 * WidgetLayout.SnapPx) is { } s)
                    {
                        want = _b0.Width + (s - _used0);
                        snappedX = true;
                    }
                }
            }
            else
            {
                want = _b0.Width + dx;
                if (!alt)
                {
                    var left = _b0.X - _off0;
                    if (WidgetLayout.SnapTo(left + want, _relEdges) is { } s)
                    {
                        want = s - left;
                        snappedX = true;
                    }
                }
            }
            f = WidgetLayout.SetWidth(f, _w, _i, want, shift);
        }
        if (_edge != ResizeEdge.X)
        {
            var h = _b0.Height + dy;
            if (!alt && WidgetLayout.SnapTo(h, _heights) is { } s)
            {
                h = s;
                snappedH = h;
            }
            f = WidgetLayout.SetRowHeight(f, _i, h);
        }
        var p = WidgetLayout.Place(f, _w, _align);
        var b = p.Boxes[_i];
        var gx = new List<double>();
        var gy = new List<double>();
        if (snappedX) gx.Add(b.X + b.Width);
        if (snappedH is { } sh)
        {
            gy.Add(b.Y + b.Height);
            foreach (var r in p.Rows)
            {
                var rb = p.Boxes[r[0]];
                if (rb.Row != b.Row && rb.Height == sh) gy.Add(rb.Y + rb.Height);
            }
        }
        return (f, new Guides(gx, gy));
    }
}
