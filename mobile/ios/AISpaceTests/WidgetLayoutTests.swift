import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

/// The stepless widget layout, case for case as the web panel's src/web/widget-layout.test.ts, so the
/// web and every native client place the same cards in the same boxes. The Mac and the iPhone both run it.

private typealias L = WidgetLayout
private func F(_ w: Double, _ h: Double) -> WidgetFrame { WidgetFrame(w: w, h: h) }
private func near(_ a: Double, _ b: Double, _ eps: Double = 1e-6) -> Bool { abs(a - b) < eps }

/// Every invariant of a placement: rows fit, cards never overlap, gaps are exactly the gap, rows line up.
private func checkPlaced(_ p: WidgetPlaced, _ frames: [WidgetFrame], _ W: Double) {
    for row in p.rows {
        let s = row.reduce(0) { $0 + frames[$1].w }
        #expect(s <= 1 + 1e-4)
        let boxes = row.map { p.boxes[$0] }
        for k in 1..<max(boxes.count, 1) where k < boxes.count {
            #expect(near(boxes[k].x - (boxes[k - 1].x + boxes[k - 1].width), L.gap))
        }
        #expect(Set(boxes.map(\.height)).count == 1)
        #expect(Set(boxes.map(\.y)).count == 1)
        #expect(boxes[0].x >= -1e-9)
        #expect(boxes.last!.x + boxes.last!.width <= W + 0.2)
        for b in boxes { #expect(b.width >= min(L.minW, W) - 1e-6) }
    }
    for r in 1..<max(p.rows.count, 1) where r < p.rows.count {
        let above = p.boxes[p.rows[r - 1][0]]
        #expect(near(p.boxes[p.rows[r][0]].y - (above.y + above.height), L.gap))
    }
}

struct WidgetLayoutTests {
    @Test func fractionsAndPixels() {
        for W in [320.0, 720, 1100, 1440, 2560] {
            #expect(near(L.px(1, W), W))
            #expect(near(L.fraction(L.px(0.37, W), W), 0.37))
            #expect(near(L.px(0.5, W) * 2 + L.gap, W))
            #expect(near(L.px(1.0 / 3, W) * 3 + 2 * L.gap, W))
            #expect(near(L.px(0.25, W) + L.px(0.75, W) + L.gap, W))
        }
    }

    @Test func minimumWidthAndBounds() {
        #expect(near(L.px(L.minFrac(1100), 1100), L.minW))
        #expect(L.minFrac(180) == 1)
        #expect(L.minFrac(200) == 1)
        #expect(L.minFrac(4000) == 0.1)
        #expect(L.effective(F(0.05, 50), 1100) == F(L.minFrac(1100), L.minH))
        #expect(L.effective(F(3, 5000), 1100) == F(1, L.maxH))
    }

    @Test func defaultsFromSizes() {
        #expect(L.oldColumns(952) == 2)
        #expect(L.oldColumns(1100) == 3)
        #expect(L.oldColumns(300) == 1)
        #expect(L.defaultFrame("1x1", 1100) == F(1.0 / 3, 300))
        #expect(L.defaultFrame("2x1", 1100) == F(2.0 / 3, 300))
        #expect(L.defaultFrame("2x2", 952) == F(1, 620))
        #expect(L.defaultFrame("2x1", 300) == F(1, 300))
        #expect(L.defaultFrame("weird", 1100) == F(1.0 / 3, 300))
        // A stored frame wins over the default.
        #expect(L.resolveFrames([("1x1", F(0.5, 400)), ("2x1", nil)], 1100) == [F(0.5, 400), F(2.0 / 3, 300)])
    }

    @Test func rowsWrapWithRoundingSlack() {
        #expect(L.breakRows([0.5, 0.5, 0.5]) == [[0, 1], [2]])
        #expect(L.breakRows([1.0 / 3, 1.0 / 3, 1.0 / 3, 1]) == [[0, 1, 2], [3]])
        #expect(L.breakRows([0.333334, 0.333334, 0.333334]) == [[0, 1, 2]])
        #expect(L.breakRows([0.6, 0.5, 0.4]) == [[0], [1, 2]])
        #expect(L.breakRows([]) == [])
    }

    @Test func placementAtAnyWidth() {
        let frames = [F(0.5, 300), F(0.25, 420), F(0.6, 200), F(0.4, 260), F(1, 500), F(0.3, 140)]
        for W in [400.0, 720, 952, 1100, 1440] {
            let eff = frames.map { L.effective($0, W) }
            for align in [WidgetAlign.start, .center] {
                let p = L.place(eff, W, align)
                checkPlaced(p, eff, W)
                #expect(p.height == p.rows.reduce(0) { $0 + p.boxes[$1[0]].height } + L.gap * Double(p.rows.count - 1))
            }
        }
        let p = L.place(frames, 1100)
        #expect(p.rows == [[0, 1], [2, 3], [4], [5]])
        #expect(p.boxes[0].height == 420)
        // Centred: the free space of a short row is split on both sides.
        let c = L.place(frames, 1100, .center)
        #expect(near(c.boxes[0].x, (1100 - (0.75 * 1120 - 20)) / 2))
        #expect(near(c.boxes[2].x, 0))
    }

    @Test func aBoundaryMovesBetweenTwoCards() {
        let W = 1100.0
        let frames = [F(0.5, 300), F(0.5, 300), F(1, 300)]
        let out = L.setWidth(frames, W, 0, L.px(0.5, W) + 112)
        #expect(near(out[0].w, 0.6))
        #expect(near(out[1].w, 0.4))
        #expect(near(out[0].w + out[1].w, 1))
        #expect(out[2] == frames[2])
        checkPlaced(L.place(out, W), out, W)
        let squeezed = L.setWidth(frames, W, 0, 5000)
        #expect(near(L.px(squeezed[1].w, W), L.minW))
        let tiny = L.setWidth(frames, W, 0, 10)
        #expect(near(L.px(tiny[0].w, W), L.minW))
        #expect(near(tiny[0].w + tiny[1].w, 1))
    }

    @Test func theLastCardGrowsIntoTheFreeSpaceOnly() {
        let W = 1100.0
        let frames = [F(0.5, 300), F(0.25, 300)]
        #expect(near(L.setWidth(frames, W, 1, 5000)[1].w, 0.5))
        #expect(near(L.setWidth(frames, W, 1, L.px(0.4, W))[1].w, 0.4))
        #expect(near(L.px(L.setWidth(frames, W, 1, 0)[1].w, W), L.minW))
        #expect(L.setWidth(frames, W, 1, 5000)[0] == frames[0])
    }

    @Test func shiftChangesOnlyThisCard() {
        let W = 1100.0
        let frames = [F(0.5, 300), F(0.5, 300)]
        let out = L.setWidth(frames, W, 0, L.px(0.7, W), reflow: true)
        #expect(near(out[0].w, 0.7))
        #expect(out[1].w == 0.5)
        #expect(L.breakRows(out.map(\.w)) == [[0], [1]])
        #expect(L.setWidth(frames, W, 0, 99999, reflow: true)[0].w == 1)
    }

    @Test func aRowsHeightIsSetOnEveryCardOfTheRow() {
        let frames = [F(0.5, 300), F(0.5, 200), F(1, 250)]
        #expect(L.setRowHeight(frames, 1, 412.4).map(\.h) == [412, 412, 250])
        #expect(L.setRowHeight(frames, 0, 10).map(\.h) == [L.minH, L.minH, 250])
        #expect(L.setRowHeight(frames, 2, 9999)[2].h == L.maxH)
    }

    @Test func snappingToTheNearestCandidate() {
        #expect(L.snap(100, [93, 105, 200]) == 105)
        #expect(L.snap(100, [91, 109]) == nil)
        #expect(L.snap(100, [92, 108]) == 92)
    }

    @Test func edgeCandidatesAreDivisionsAndOtherRowsEdges() {
        let W = 1100.0
        let frames = [F(0.5, 300), F(0.5, 300), F(0.3, 300), F(0.7, 300)]
        let p = L.place(frames, W)
        let c = L.edgeCandidates(p, W, 0)
        for f in [1.0 / 4, 1.0 / 3, 1.0 / 2, 2.0 / 3, 3.0 / 4, 1] { #expect(c.contains { near($0, L.px(f, W)) }) }
        // The other row's boundary: its right edge, and its neighbour's left edge less the gap (the same line).
        #expect(c.contains { near($0, L.px(0.3, W)) })
        // Not the card's own row.
        #expect(c.filter { near($0, L.px(0.5, W)) }.count == 1)
        #expect(L.heightCandidates(L.place(L.setRowHeight(frames, 2, 444), W), 0) == [444])
    }

    private static let messy = [F(0.47, 310), F(0.51, 296), F(0.29, 500), F(0.33, 330), F(0.31, 480), F(0.9, 200)]

    @Test func alignSnapsBoundariesToTwelfths() {
        let W = 1100.0
        let a = L.alignTwelfths(Self.messy, W)
        for row in L.breakRows(a.map(\.w)) {
            var cum = 0.0
            for i in row {
                cum += a[i].w
                #expect(near(cum * 12, (cum * 12).rounded()))
                #expect(a[i].w >= L.minFrac(W) - 1e-9)
            }
        }
        #expect(a.map(\.h) == [310, 310, 500, 500, 500, 200])
        checkPlaced(L.place(a, W), a, W)
        #expect(L.alignTwelfths(a, W) == a)
        #expect(L.alignTwelfths(a.map(L.tidy), W).map(L.tidy) == a.map(L.tidy))
    }

    @Test func alignKeepsACardAtTheMinimum() {
        let W = 720.0
        let lo = L.minFrac(W)
        let a = L.alignTwelfths([F(lo, 300), F(lo, 300), F(1 - 2 * lo, 300)], W)
        for f in a { #expect(f.w >= lo - 1e-9) }
        #expect(L.alignTwelfths(a, W) == a)
    }

    @Test func splitEvenlyFillsRowsWithTheMedianHeight() {
        let W = 1100.0
        let s = L.splitEvenly(Self.messy)
        #expect(L.breakRows(s.map(\.w)) == L.breakRows(Self.messy.map(\.w)))
        for row in L.breakRows(s.map(\.w)) { for i in row { #expect(near(s[i].w, 1 / Double(row.count))) } }
        #expect(Set(s.map(\.h)) == [310])
        #expect(L.splitEvenly(s) == s)
        checkPlaced(L.place(s, W), s, W)
        #expect(L.splitEvenly(s.map(L.tidy)).map(L.tidy) == s.map(L.tidy))
        #expect(L.splitEvenly([]) == [])
    }

    @Test func nearestClassicSizeIn1100() {
        #expect(L.nearestSize(F(1.0 / 3, 300)) == "1x1")
        #expect(L.nearestSize(F(L.fraction(560, 1100), 479)) == "2x1")
        #expect(L.nearestSize(F(L.fraction(559, 1100), 480)) == "1x2")
        #expect(L.nearestSize(F(1, 900)) == "2x2")
    }

    @Test func sizeClassWithHysteresis() {
        #expect(L.sizeClass(nil, 559, 479) == "1x1")
        #expect(L.sizeClass(nil, 560, 480) == "2x2")
        #expect(L.sizeClass("2x2", 550, 470) == "2x2")
        #expect(L.sizeClass("2x2", 543, 463) == "1x1")
        #expect(L.sizeClass("1x1", 555, 475) == "1x1")
        #expect(L.sizeClass("2x1", 550, 475) == "2x1")
    }

    @Test func onlyChangedCardsAreWrittenWithTheirUndo() {
        let cards = [LayoutCard(id: "a/w", size: "1x1"), LayoutCard(id: "b/w", size: "1x1", frame: F(0.5, 300)), LayoutCard(id: "c/w", size: "2x1")]
        let before = [F(0.5, 300), F(0.5, 300), F(1, 300)]
        let after = L.setWidth(before, 1100, 0, L.px(0.7, 1100))
        let r = L.framesWrite(cards, before, after)!
        #expect(Set(r.write.frames!.keys) == ["a/w", "b/w"])
        #expect(r.write.sizes == ["a/w": "2x1", "b/w": "1x1"])
        #expect(r.undo == LayoutWrite(frames: ["a/w": nil, "b/w": F(0.5, 300)], sizes: ["a/w": "1x1", "b/w": "1x1"]))
        #expect(L.framesWrite(cards, before, before) == nil)
        let applied = L.applyWrite(cards, r.write)
        #expect(applied[0].size == "2x1" && applied[0].frame == F(0.7, 300))
        #expect(L.applyWrite(applied, r.undo) == cards)
        // A size alone drops the frame, as the server does.
        #expect(L.applyWrite(applied, LayoutWrite(sizes: ["a/w": "1x2"]))[0] == LayoutCard(id: "a/w", size: "1x2"))
    }

    @Test func storedFramesAreRoundedAndBounded() {
        #expect(L.tidy(F(0.123456789, 333.6)) == F(0.123457, 334))
        #expect(L.tidy(F(0.01, 50)) == F(0.1, L.minH))
    }

    @Test func rowsPerPage() {
        #expect(L.rowsThatFit(234, [32, 32, 32, 32, 56], gap: 2, cols: 1, pagerH: 26) == 5)
        #expect(L.rowsThatFit(200, [30, 30, 30, 30, 30, 30, 30, 30, 30], gap: 2, cols: 1, pagerH: 26) == 5)
        // Mixed heights: a page must fit with its tallest rows.
        #expect(L.rowsThatFit(130, [30, 30, 30, 60, 30, 30], gap: 2, cols: 1, pagerH: 26) == 2)
        // Two columns: a grid row is as tall as its taller cell.
        #expect(L.rowsThatFit(200, Array(repeating: 30, count: 20), gap: 2, cols: 2, pagerH: 26) == 10)
        #expect(L.rowsThatFit(10, [30, 30, 30, 30], gap: 2, cols: 1, pagerH: 26) == 1)
        #expect(L.rowsThatFit(-50, [30, 30, 30, 30], gap: 2, cols: 2, pagerH: 26) == 2)
        #expect(L.rowsThatFit(100, [], gap: 2, cols: 1, pagerH: 26) == 1)
    }

    // Beyond the web's cases: what the native clients send and read.

    @Test func theWriteAsTheLayoutRouteTakesIt() throws {
        let w = LayoutWrite(frames: ["a/w": F(0.5, 300), "b/w": nil], sizes: ["a/w": "1x1"], widgetAlign: .center)
        let data = try JSONSerialization.data(withJSONObject: w.json, options: [.sortedKeys])
        #expect(String(decoding: data, as: UTF8.self) == #"{"frames":{"a\/w":{"h":300,"w":0.5},"b\/w":null},"sizes":{"a\/w":"1x1"},"widgetAlign":"center"}"#)
        #expect(w.sizesOnly == LayoutWrite(sizes: ["a/w": "1x1"]))
        #expect(LayoutWrite(widgetAlign: .start).sizesOnly == nil)
    }
}
