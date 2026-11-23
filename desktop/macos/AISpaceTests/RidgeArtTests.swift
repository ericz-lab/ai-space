import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

struct RidgeArtTests {
    @Test func theRangeFillsTheGivenSizeWithBinaryDigitsAndIsTheSameEveryTime() {
        let lines = RidgeArt.lines(cols: 120, rows: 30)
        #expect(lines.count == 30)
        #expect(lines.allSatisfy { $0.count == 120 })
        #expect(lines.allSatisfy { $0.allSatisfy { "01 ".contains($0) } })
        #expect(lines == RidgeArt.lines(cols: 120, rows: 30))
    }

    @Test(arguments: [(120, 30), (60, 20), (240, 24)])
    func theSkyIsEmptyAndTheCrestRunsAcrossEveryColumn(cols: Int, rows: Int) {
        let lines = RidgeArt.lines(cols: cols, rows: rows).map { Array($0) }
        #expect(lines[0].allSatisfy { $0 == " " })
        #expect(lines.prefix(rows / 2).contains { $0.contains { $0 != " " } })
        // A wide window shows more peaks, never a gap between them.
        for x in 0..<cols { #expect(lines.contains { $0[x] != " " }) }
    }

    /// The same picture as the Windows client's RidgeArt.cs draws: two of its lines at 240 × 32,
    /// the first 120 columns, a dot for each space.
    @Test func itIsTheWindowsClientsPicture() {
        let lines = RidgeArt.lines(cols: 240, rows: 32).map { String($0.prefix(120)).replacingOccurrences(of: " ", with: ".") }
        #expect(lines[11] == ".......................111................................................0....................................10.......")
        #expect(lines[23] == "...................................................10...00..............................................................")
    }

    @Test func nothingIsDrawnInNoRoom() {
        #expect(RidgeArt.lines(cols: 0, rows: 10).isEmpty)
        #expect(RidgeArt.lines(cols: 10, rows: 0).isEmpty)
    }
}
