import Foundation

/// How many columns and rows of the card grid a widget takes, from its size ("2x1": two columns, one row).
struct CardSpan: Equatable {
    let columns: Int
    let rows: Int

    static func of(_ size: String?) -> CardSpan {
        switch size {
        case "2x1": return CardSpan(columns: 2, rows: 1)
        case "1x2": return CardSpan(columns: 1, rows: 2)
        case "2x2": return CardSpan(columns: 2, rows: 2)
        default: return CardSpan(columns: 1, rows: 1)
        }
    }
}

/// Where the widget cards go on the grid, as the panel's CSS grid places them (src/web/styles.css
/// `.widgets`): in order, each at the first free spot at or after the previous card's, row by row.
enum CardPlacement {
    struct Cell: Equatable {
        let row: Int
        let column: Int
        let span: CardSpan
    }

    /// `spans` wider than `columns` must be narrowed by the caller.
    static func place(_ spans: [CardSpan], columns: Int) -> [Cell] {
        var taken = Set<[Int]>()
        var out: [Cell] = []
        var row = 0, column = 0
        for span in spans {
            var r = row, c = column
            while true {
                if c + span.columns > columns { r += 1; c = 0; continue }
                let cells = (r..<(r + span.rows)).flatMap { y in (c..<(c + span.columns)).map { [y, $0] } }
                if cells.allSatisfy({ !taken.contains($0) }) {
                    cells.forEach { taken.insert($0) }
                    out.append(Cell(row: r, column: c, span: span))
                    (row, column) = (r, c + span.columns)
                    break
                }
                c += 1
            }
        }
        return out
    }
}
