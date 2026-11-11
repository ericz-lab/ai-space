import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

/// Widget cards go where the panel's CSS grid puts them (src/web/styles.css `.widgets`).

struct CardPlacementTests {
    @Test func sizesSpanColumnsAndRows() {
        #expect(CardSpan.of("2x1") == CardSpan(columns: 2, rows: 1))
        #expect(CardSpan.of("2x2") == CardSpan(columns: 2, rows: 2))
        #expect(CardSpan.of(nil) == CardSpan(columns: 1, rows: 1))
    }

    @Test func placesInOrderWhereEachFirstFits() {
        let s = [CardSpan.of("1x1"), CardSpan.of("2x1"), CardSpan.of("1x2"), CardSpan.of("1x1"), CardSpan.of("1x1")]
        let cells = CardPlacement.place(s, columns: 3)
        #expect(cells.map { [$0.row, $0.column] } == [[0, 0], [0, 1], [1, 0], [1, 1], [1, 2]])
        // A wide card that does not fit the rest of a row starts the next one.
        let wide = CardPlacement.place([CardSpan.of("1x1"), CardSpan.of("2x1")], columns: 2)
        #expect(wide.map { [$0.row, $0.column] } == [[0, 0], [1, 0]])
        // A tall card keeps its second row's cell taken.
        let tall = CardPlacement.place([CardSpan.of("1x2"), CardSpan.of("1x1"), CardSpan.of("1x1")], columns: 2)
        #expect(tall.map { [$0.row, $0.column] } == [[0, 0], [0, 1], [1, 1]])
    }
}
