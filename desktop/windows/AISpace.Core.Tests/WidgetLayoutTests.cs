using AISpace.Core;
using static AISpace.Core.WidgetLayout;

namespace AISpace.Core.Tests;

/// <summary>The widget area's layout: the cases of src/web/widget-layout.test.ts, so the clients and the web agree.</summary>
public class WidgetLayoutTests
{
    private static void Near(double a, double b, double eps = 1e-6) => Assert.True(Math.Abs(a - b) < eps, $"{a} is not {b}");

    private static Frame F(double w, double h) => new(w, h);

    private static List<List<int>> Rows(IEnumerable<Frame> frames) => BreakRows(frames.Select(f => f.W).ToList());

    /// <summary>Every invariant of a placement: rows fit, cards never overlap, gaps are exactly GAP, rows line up.</summary>
    private static void CheckPlaced(Placed p, IReadOnlyList<Frame> frames, double W)
    {
        foreach (var row in p.Rows)
        {
            Assert.True(row.Sum(i => frames[i].W) <= 1 + 1e-4);
            var boxes = row.Select(i => p.Boxes[i]).ToList();
            for (var k = 1; k < boxes.Count; k++) Near(boxes[k].X - (boxes[k - 1].X + boxes[k - 1].Width), Gap);
            Assert.Single(boxes.Select(b => b.Height).Distinct());
            Assert.Single(boxes.Select(b => b.Y).Distinct());
            Assert.True(boxes[0].X >= -1e-9);
            Assert.True(boxes[^1].X + boxes[^1].Width <= W + 0.2);
            foreach (var b in boxes) Assert.True(b.Width >= Math.Min(MinW, W) - 1e-6);
        }
        for (var r = 1; r < p.Rows.Count; r++)
        {
            var above = p.Boxes[p.Rows[r - 1][0]];
            Near(p.Boxes[p.Rows[r][0]].Y - (above.Y + above.Height), Gap);
        }
    }

    [Fact]
    public void AFractionsWidthAndBackFillTheAreaWithGapBetween()
    {
        foreach (var W in new double[] { 320, 720, 1100, 1440, 2560 })
        {
            Near(PxOf(1, W), W);
            Near(FracOf(PxOf(0.37, W), W), 0.37);
            Near(PxOf(0.5, W) * 2 + Gap, W);
            Near(PxOf(1.0 / 3, W) * 3 + 2 * Gap, W);
            Near(PxOf(0.25, W) + PxOf(0.75, W) + Gap, W);
        }
    }

    [Fact]
    public void TheMinimumWidthIs200OrTheWholeAreaAndNeverUnderTheStoredFloor()
    {
        Near(PxOf(MinFracFor(1100), 1100), MinW);
        Assert.Equal(1, MinFracFor(180));
        Assert.Equal(1, MinFracFor(200));
        Assert.Equal(0.1, MinFracFor(4000));
        Assert.Equal(F(MinFracFor(1100), MinH), Effective(F(0.05, 50), 1100));
        Assert.Equal(F(1, MaxH), Effective(F(3, 5000), 1100));
    }

    [Fact]
    public void DefaultsComeFromTheOldGridAndTheSize()
    {
        Assert.Equal(2, OldColumns(952));
        Assert.Equal(3, OldColumns(1100));
        Assert.Equal(1, OldColumns(300));
        Assert.Equal(F(1.0 / 3, 300), DefaultFrame("1x1", 1100));
        Assert.Equal(F(2.0 / 3, 300), DefaultFrame("2x1", 1100));
        Assert.Equal(F(1, 620), DefaultFrame("2x2", 952));
        Assert.Equal(F(1, 300), DefaultFrame("2x1", 300));
        Assert.Equal(F(1.0 / 3, 300), DefaultFrame("weird", 1100));
        // A stored frame wins over the default.
        Assert.Equal([F(0.5, 400), F(2.0 / 3, 300)], ResolveFrames([new LayoutCard("a", "1x1", F(0.5, 400)), new LayoutCard("b", "2x1")], 1100));
    }

    [Fact]
    public void CardsWrapWhenTheNextOneDoesNotFitWithRoundingSlack()
    {
        Assert.Equal([[0, 1], [2]], BreakRows([0.5, 0.5, 0.5]));
        Assert.Equal([[0, 1, 2], [3]], BreakRows([1.0 / 3, 1.0 / 3, 1.0 / 3, 1]));
        Assert.Equal([[0, 1, 2]], BreakRows([0.333334, 0.333334, 0.333334]));
        Assert.Equal([[0], [1, 2]], BreakRows([0.6, 0.5, 0.4]));
        Assert.Empty(BreakRows([]));
    }

    [Fact]
    public void RowsTakeTheirTallestCardAreGapApartAndNeverOverlapAtAnyWidth()
    {
        Frame[] frames = [F(0.5, 300), F(0.25, 420), F(0.6, 200), F(0.4, 260), F(1, 500), F(0.3, 140)];
        foreach (var W in new double[] { 400, 720, 952, 1100, 1440 })
        {
            var eff = frames.Select(f => Effective(f, W)).ToArray();
            foreach (var align in new[] { WidgetAlign.Start, WidgetAlign.Center })
            {
                var p = Place(eff, W, align);
                CheckPlaced(p, eff, W);
                Assert.Equal(p.Rows.Sum(row => p.Boxes[row[0]].Height) + Gap * (p.Rows.Count - 1), p.Height);
            }
        }
        var placed = Place(frames, 1100);
        Assert.Equal([[0, 1], [2, 3], [4], [5]], placed.Rows.Select(r => r.ToList()).ToList());
        Assert.Equal(420, placed.Boxes[0].Height);
        // Centred: the free space of a short row is split on both sides.
        var c = Place(frames, 1100, WidgetAlign.Center);
        Near(c.Boxes[0].X, (1100 - (0.75 * 1120 - 20)) / 2);
        Near(c.Boxes[2].X, 0);
    }

    [Fact]
    public void ABoundaryMovesTheNeighbourTakesTheDifferenceBothStayAboveTheMinimum()
    {
        const double W = 1100;
        Frame[] frames = [F(0.5, 300), F(0.5, 300), F(1, 300)];
        var output = SetWidth(frames, W, 0, PxOf(0.5, W) + 112);
        Near(output[0].W, 0.6);
        Near(output[1].W, 0.4);
        Near(output[0].W + output[1].W, 1);
        Assert.Equal(frames[2], output[2]);
        CheckPlaced(Place(output, W), output, W);
        var squeezed = SetWidth(frames, W, 0, 5000);
        Near(PxOf(squeezed[1].W, W), MinW);
        var tiny = SetWidth(frames, W, 0, 10);
        Near(PxOf(tiny[0].W, W), MinW);
        Near(tiny[0].W + tiny[1].W, 1);
    }

    [Fact]
    public void TheLastCardOfARowGrowsIntoTheFreeSpaceAndNoFurtherAndCanAlwaysShrink()
    {
        const double W = 1100;
        Frame[] frames = [F(0.5, 300), F(0.25, 300)];
        Near(SetWidth(frames, W, 1, 5000)[1].W, 0.5);
        Near(SetWidth(frames, W, 1, PxOf(0.4, W))[1].W, 0.4);
        Near(PxOf(SetWidth(frames, W, 1, 0)[1].W, W), MinW);
        Assert.Equal(frames[0], SetWidth(frames, W, 1, 5000)[0]);
    }

    [Fact]
    public void WithShiftOnlyThisCardChangesAndTheNextOnesReflow()
    {
        const double W = 1100;
        Frame[] frames = [F(0.5, 300), F(0.5, 300)];
        var output = SetWidth(frames, W, 0, PxOf(0.7, W), reflow: true);
        Near(output[0].W, 0.7);
        Assert.Equal(0.5, output[1].W);
        Assert.Equal([[0], [1]], Rows(output));
        Assert.Equal(1, SetWidth(frames, W, 0, 99999, reflow: true)[0].W);
    }

    [Fact]
    public void ARowsHeightIsSetOnEveryCardOfTheRowWithinBounds()
    {
        Frame[] frames = [F(0.5, 300), F(0.5, 200), F(1, 250)];
        Assert.Equal([412, 412, 250], SetRowHeight(frames, 1, 412.4).Select(f => f.H));
        Assert.Equal([MinH, MinH, 250], SetRowHeight(frames, 0, 10).Select(f => f.H));
        Assert.Equal(MaxH, SetRowHeight(frames, 2, 9999)[2].H);
    }

    [Fact]
    public void TheNearestCandidateWithin8pxWinsNothingBeyond()
    {
        Assert.Equal(105, SnapTo(100, [93, 105, 200]));
        Assert.Null(SnapTo(100, [91, 109]));
        Assert.Equal(92, SnapTo(100, [92, 108]));
    }

    [Fact]
    public void EdgeCandidatesAreTheDivisionsAndTheEdgesOfCardsInOtherRows()
    {
        const double W = 1100;
        Frame[] frames = [F(0.5, 300), F(0.5, 300), F(0.3, 300), F(0.7, 300)];
        var p = Place(frames, W);
        var c = EdgeCandidates(p, W, 0);
        foreach (var f in new[] { 1.0 / 4, 1.0 / 3, 1.0 / 2, 2.0 / 3, 3.0 / 4, 1 }) Assert.Contains(c, x => Math.Abs(x - PxOf(f, W)) < 1e-6);
        // The other row's boundary: its right edge, and its neighbour's left edge less the gap (the same line).
        Assert.Contains(c, x => Math.Abs(x - PxOf(0.3, W)) < 1e-6);
        // Not the card's own row.
        Assert.Single(c, x => Math.Abs(x - PxOf(0.5, W)) < 1e-6);
        Assert.Equal([444], HeightCandidates(Place(SetRowHeight(frames, 2, 444), W), 0));
    }

    private static readonly Frame[] Messy = [F(0.47, 310), F(0.51, 296), F(0.29, 500), F(0.33, 330), F(0.31, 480), F(0.9, 200)];

    [Fact]
    public void AlignSnapsEveryBoundaryToATwelfthKeepsMinsGroupsCloseHeightsAndIsIdempotent()
    {
        const double W = 1100;
        var a = AlignTwelfths(Messy, W);
        foreach (var row in Rows(a))
        {
            double cum = 0;
            foreach (var i in row)
            {
                cum += a[i].W;
                Near(cum * 12, Math.Round(cum * 12));
                Assert.True(a[i].W >= MinFracFor(W) - 1e-9);
            }
        }
        Assert.Equal([310, 310, 500, 500, 500, 200], a.Select(f => f.H));
        CheckPlaced(Place(a, W), a, W);
        Assert.Equal(a, AlignTwelfths(a, W));
        Assert.Equal(a.Select(Tidy), AlignTwelfths(a.Select(Tidy).ToArray(), W).Select(Tidy));
    }

    [Fact]
    public void AlignKeepsACardAtTheMinimumWhenTheNearestTwelfthWouldCutIt()
    {
        const double W2 = 720;
        var lo = MinFracFor(W2);
        var a = AlignTwelfths([F(lo, 300), F(lo, 300), F(1 - 2 * lo, 300)], W2);
        foreach (var f in a) Assert.True(f.W >= lo - 1e-9);
        Assert.Equal(a, AlignTwelfths(a, W2));
    }

    [Fact]
    public void SplitEvenlyFillsEveryRowWithEqualWidthsAndGivesRowsTheMedianHeight()
    {
        const double W = 1100;
        var s = SplitEvenly(Messy);
        Assert.Equal(Rows(Messy), Rows(s));
        foreach (var row in Rows(s))
        {
            foreach (var i in row) Near(s[i].W, 1.0 / row.Count);
        }
        Assert.Equal([310], s.Select(f => f.H).Distinct());
        Assert.Equal(s, SplitEvenly(s));
        CheckPlaced(Place(s, W), s, W);
        Assert.Equal(s.Select(Tidy), SplitEvenly(s.Select(Tidy).ToArray()).Select(Tidy));
        Assert.Empty(SplitEvenly([]));
    }

    [Fact]
    public void TheNearestClassicSizeIsJudgedInAn1100pxArea()
    {
        Assert.Equal("1x1", NearestSize(F(1.0 / 3, 300)));
        Assert.Equal("2x1", NearestSize(F(FracOf(560, 1100), 479)));
        Assert.Equal("1x2", NearestSize(F(FracOf(559, 1100), 480)));
        Assert.Equal("2x2", NearestSize(F(1, 900)));
    }

    [Fact]
    public void TheSizeClassFollowsTheDrawnBoxWithA16pxBand()
    {
        Assert.Equal("1x1", SizeClass(null, 559, 479));
        Assert.Equal("2x2", SizeClass(null, 560, 480));
        Assert.Equal("2x2", SizeClass("2x2", 550, 470));
        Assert.Equal("1x1", SizeClass("2x2", 543, 463));
        Assert.Equal("1x1", SizeClass("1x1", 555, 475));
        Assert.Equal("2x1", SizeClass("2x1", 550, 475));
    }

    [Fact]
    public void OnlyTheChangedCardsAreWrittenEachWithItsNearestSizeWithTheWriteThatUndoesIt()
    {
        List<LayoutCard> cards = [new("a/w", "1x1"), new("b/w", "1x1", F(0.5, 300)), new("c/w", "2x1")];
        Frame[] before = [F(0.5, 300), F(0.5, 300), F(1, 300)];
        var after = SetWidth(before, 1100, 0, PxOf(0.7, 1100));
        var (write, undo) = FramesWrite(cards, before, after)!.Value;
        Assert.Equal(["a/w", "b/w"], write.Frames!.Keys);
        Assert.Equal(new Dictionary<string, string> { ["a/w"] = "2x1", ["b/w"] = "1x1" }, write.Sizes);
        Assert.Equal(new Dictionary<string, Frame?> { ["a/w"] = null, ["b/w"] = F(0.5, 300) }, undo.Frames);
        Assert.Equal(new Dictionary<string, string> { ["a/w"] = "1x1", ["b/w"] = "1x1" }, undo.Sizes);
        Assert.Null(FramesWrite(cards, before, before));
        var applied = ApplyWrite(cards, write);
        Assert.Equal("2x1", applied[0].Size);
        Assert.Equal(F(0.7, 300), applied[0].Frame);
        Assert.Equal(cards, ApplyWrite(applied, undo));
        // A size alone drops the frame, as the server does.
        Assert.Equal(new LayoutCard("a/w", "1x2"), ApplyWrite(applied, new LayoutWrite { Sizes = new() { ["a/w"] = "1x2" } })[0]);
    }

    [Fact]
    public void StoredFramesAreRoundedAndWithinTheServersBounds()
    {
        Assert.Equal(F(0.123457, 334), Tidy(F(0.123456789, 333.6)));
        Assert.Equal(F(0.1, MinH), Tidy(F(0.01, 50)));
    }

    [Fact]
    public void RowsPerPageAllWhenTheyFitElseTheMostWhoseEveryPageFitsAboveThePager()
    {
        Assert.Equal(5, RowsThatFit(234, [32, 32, 32, 32, 56], 2, 1, 26));
        Assert.Equal(5, RowsThatFit(200, [30, 30, 30, 30, 30, 30, 30, 30, 30], 2, 1, 26));
        // Mixed heights: a page must fit with its tallest rows.
        Assert.Equal(2, RowsThatFit(130, [30, 30, 30, 60, 30, 30], 2, 1, 26));
        // Two columns: a grid row is as tall as its taller cell.
        Assert.Equal(10, RowsThatFit(200, Enumerable.Repeat(30.0, 20).ToList(), 2, 2, 26));
        Assert.Equal(1, RowsThatFit(10, [30, 30, 30, 30], 2, 1, 26));
        Assert.Equal(2, RowsThatFit(-50, [30, 30, 30, 30], 2, 2, 26));
        Assert.Equal(1, RowsThatFit(100, [], 2, 1, 26));
    }

    // Beyond the web's file: the drag and the writes the area makes, which the web keeps in WidgetArea.tsx.

    [Fact]
    public void ADragSnapsToADivisionShowsItsGuideAndAltTurnsSnappingOff()
    {
        const double W = 1100;
        Frame[] frames = [F(0.3, 300), F(0.7, 300), F(1, 300)];
        var drag = new ResizeDrag(frames, W, WidgetAlign.Start, 0, ResizeEdge.X);
        // 0.3 is 316px; the half is 540px: 220px of travel lands 5px short of it, which snaps.
        var (snapped, guides) = drag.At(219, 0, shift: false, alt: false);
        Near(PxOf(snapped[0].W, W), PxOf(0.5, W));
        Near(snapped[0].W + snapped[1].W, 1);
        Assert.Equal([PxOf(0.5, W)], guides.X);
        Assert.Empty(guides.Y);
        var (free, none) = drag.At(219, 0, shift: false, alt: true);
        Near(PxOf(free[0].W, W), PxOf(0.3, W) + 219);
        Assert.False(none.Any);
        // The bottom edge snaps to another row's height and marks both rows.
        var tall = new ResizeDrag([F(0.5, 300), F(0.5, 300), F(1, 444)], W, WidgetAlign.Start, 0, ResizeEdge.Y);
        var (h, g) = tall.At(500, 140, shift: false, alt: false);
        Assert.Equal(444, h[0].H);
        Assert.Equal(444, h[1].H);
        Assert.Equal([444, 444 + Gap + 444], g.Y);
        // The corner does both; Shift re-flows instead of moving the neighbour.
        var corner = new ResizeDrag(frames, W, WidgetAlign.Start, 0, ResizeEdge.XY);
        var (both, _) = corner.At(400, 100, shift: true, alt: true);
        Near(PxOf(both[0].W, W), PxOf(0.3, W) + 400);
        Assert.Equal(0.7, both[1].W);
        Assert.Equal(400, both[0].H);
    }

    [Fact]
    public void ACentredLastCardGrowsTwiceThePointersTravel()
    {
        const double W = 1100;
        Frame[] frames = [F(0.25, 300), F(0.25, 300)];
        var drag = new ResizeDrag(frames, W, WidgetAlign.Center, 1, ResizeEdge.X);
        var start = Place(frames, W, WidgetAlign.Center).Boxes[1].Width;
        var (f, _) = drag.At(30, 0, shift: false, alt: true);
        Near(PxOf(f[1].W, W), start + 60);
        // Snapping: the row's width lands on the area's three quarters (row 540 + 2 * 136 = 812, 8 short of 820).
        var (s, guides) = drag.At(136, 0, shift: false, alt: false);
        Near(RowWidth(s, [0, 1], W), PxOf(0.75, W));
        Assert.Single(guides.X);
    }

    [Fact]
    public void TheKeysMoveAnEdge8pxOr1pxWithShiftAndOnlyAlongTheirAxis()
    {
        const double W = 1100;
        Frame[] frames = [F(0.5, 300), F(0.5, 300)];
        var right = KeyStep(frames, W, WidgetAlign.Start, 0, ResizeEdge.X, 1, 0, fine: false)!;
        Near(PxOf(right[0].W, W), PxOf(0.5, W) + 8);
        Near(right[0].W + right[1].W, 1);
        var fine = KeyStep(frames, W, WidgetAlign.Start, 0, ResizeEdge.XY, -1, 0, fine: true)!;
        Near(PxOf(fine[0].W, W), PxOf(0.5, W) - 1);
        Assert.Equal(308, KeyStep(frames, W, WidgetAlign.Start, 1, ResizeEdge.Y, 0, 1, fine: false)![0].H);
        Assert.Null(KeyStep(frames, W, WidgetAlign.Start, 0, ResizeEdge.X, 0, 1, fine: false));
        Assert.Null(KeyStep(frames, W, WidgetAlign.Start, 0, ResizeEdge.Y, 1, 0, fine: false));
    }

    [Fact]
    public void ResetRemovesTheFramesAndCenterTogglesEachWithItsUndo()
    {
        List<LayoutCard> cards = [new("a/w", "1x1"), new("b/w", "2x1", F(0.5, 300))];
        var (write, undo) = ResetWrite(cards)!.Value;
        Assert.Equal(new Dictionary<string, Frame?> { ["b/w"] = null }, write.Frames);
        Assert.Null(write.Sizes);
        Assert.Equal(new Dictionary<string, Frame?> { ["b/w"] = F(0.5, 300) }, undo.Frames);
        Assert.Equal(new Dictionary<string, string> { ["b/w"] = "2x1" }, undo.Sizes);
        Assert.Null(ResetWrite([new("a/w", "1x1")]));
        var (center, back) = CenterWrite(WidgetAlign.Start);
        Assert.Equal(WidgetAlign.Center, center.Align);
        Assert.Equal(WidgetAlign.Start, back.Align);
    }

    [Fact]
    public void AWriteIsTheBodyTheServerReadsWithRemovedFramesAsNull()
    {
        var write = new LayoutWrite { Frames = new() { ["a/w"] = F(0.5, 300), ["b/w"] = null }, Sizes = new() { ["a/w"] = "1x1" }, Align = WidgetAlign.Center };
        var json = System.Text.Json.JsonSerializer.Serialize(write.ToJson(), SpaceApi.Json);
        Assert.Equal("""{"frames":{"a/w":{"w":0.5,"h":300},"b/w":null},"sizes":{"a/w":"1x1"},"widgetAlign":"center"}""", json);
        Assert.Equal("""{"sizes":{"a/w":"1x1"}}""", System.Text.Json.JsonSerializer.Serialize(write.SizesOnly()!.ToJson(), SpaceApi.Json));
        Assert.Null(new LayoutWrite { Frames = new() { ["b/w"] = null } }.SizesOnly());
        Assert.True(OneColumn(700));
        Assert.False(OneColumn(701));
    }
}
