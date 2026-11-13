import SwiftUI

/// An agent's text with its Markdown blocks laid out: headings, lists (ordered and nested),
/// quotes, code blocks and tables, as the panel and the Mac draw them. Foundation parses the
/// Markdown (`ChatMarkdown`, shared with the Mac client); SwiftUI draws the inline styles.
struct ChatMarkdownText: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(ChatMarkdown.parse(text)) { ChatMarkdownBlock(node: $0) }
        }
        .textSelection(.enabled)
        .foregroundStyle(Theme.text)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct ChatMarkdownBlock: View {
    let node: ChatMarkdownNode
    var ordered = false

    var body: some View {
        switch node.kind {
        case .header(let level):
            Text(node.text).font(level == 1 ? .title3.weight(.semibold) : level == 2 ? .headline : .subheadline.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
        case .codeBlock:
            ScrollView(.horizontal, showsIndicators: false) {
                Text(verbatim: String(node.text.characters).trimmingCharacters(in: .newlines)).font(.footnote.monospaced())
                    .fixedSize(horizontal: true, vertical: false).padding(10)
            }
            .background(Theme.solid, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.hairline))
        case .thematicBreak:
            Divider()
        case .blockQuote:
            HStack(alignment: .top, spacing: 10) {
                Rectangle().fill(Theme.accent.opacity(0.5)).frame(width: 3)
                children
            }
            .fixedSize(horizontal: false, vertical: true)
        case .orderedList, .unorderedList:
            VStack(alignment: .leading, spacing: 4) {
                ForEach(node.children) { ChatMarkdownBlock(node: $0, ordered: node.kind == .orderedList) }
            }
        case .listItem(let ordinal):
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(verbatim: ordered ? "\(ordinal)." : "•").foregroundStyle(.secondary)
                children
            }
        case .table(let columns):
            // Fit the reply's width with the text wrapping; scroll sideways only when the
            // columns at their minimum width do not fit.
            ViewThatFits(in: .horizontal) {
                tableGrid(columns, fit: true)
                ScrollView(.horizontal, showsIndicators: false) { tableGrid(columns, fit: false) }
            }
        default:
            if !node.text.characters.isEmpty {
                Text(node.text).lineSpacing(2).fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if !node.children.isEmpty { children }
        }
    }

    private var children: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(node.children) { ChatMarkdownBlock(node: $0) }
        }
    }

    private static let minColumn: CGFloat = 64
    private static let maxColumn: CGFloat = 220

    /// Every cell gets a definite width, so its text wraps there and the row grows; measured with
    /// no width (in a sideways scroll view), the text took one line wider than its cell and drew
    /// over the cells beside and below it. Fitting, a column takes up to what its longest cell
    /// needs, and its ideal width is the minimum, which is what `ViewThatFits` measures.
    /// Scrolling, a column is as wide as its longest cell needs, up to `maxColumn`.
    private func tableGrid(_ columns: [PresentationIntent.TableColumn], fit: Bool) -> some View {
        let widths = node.tableColumnWidths(columns.count, character: 7.5, minimum: Self.minColumn)
        return Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
            ForEach(node.children) { row in
                GridRow(alignment: .top) {
                    ForEach(Array(columns.enumerated()), id: \.offset) { index, column in
                        Text(row.tableCell(index)).font(.footnote).fontWeight(row.kind == .tableHeaderRow ? .semibold : .regular)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(minWidth: Self.minColumn, idealWidth: fit ? Self.minColumn : min(widths[index], Self.maxColumn),
                                   maxWidth: fit ? widths[index] : min(widths[index], Self.maxColumn), alignment: alignment(column))
                            .padding(.horizontal, 8).padding(.vertical, 6)
                            .background(row.kind == .tableHeaderRow ? Theme.solid : Color.clear)
                    }
                }
                Divider().gridCellColumns(columns.count).gridCellUnsizedAxes(.horizontal)
            }
        }
    }

    private func alignment(_ column: PresentationIntent.TableColumn) -> Alignment {
        switch column.alignment {
        case .center: return .center
        case .right: return .trailing
        default: return .leading
        }
    }
}
