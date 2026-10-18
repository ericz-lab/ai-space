import SwiftUI

struct ChatMarkdownView: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(ChatMarkdown.parse(text)) { MarkdownBlock(node: $0) }
        }
        .textSelection(.enabled)
        .foregroundStyle(Theme.text)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct MarkdownBlock: View {
    let node: ChatMarkdownNode
    var ordered = false

    var body: some View {
        switch node.kind {
        case .header(let level):
            Text(node.text).font(.system(size: level == 1 ? 24 : level == 2 ? 20 : 17, weight: .semibold))
                .fixedSize(horizontal: false, vertical: true)
        case .codeBlock:
            ScrollView(.horizontal) {
                Text(verbatim: String(node.text.characters)).font(.callout.monospaced())
                    .fixedSize(horizontal: true, vertical: false).padding(10)
            }
            .background(Theme.solid, in: RoundedRectangle(cornerRadius: 8))
        case .thematicBreak:
            Divider()
        case .blockQuote:
            HStack(alignment: .top, spacing: 10) {
                Rectangle().fill(Theme.accent.opacity(0.5)).frame(width: 3)
                children
            }.fixedSize(horizontal: false, vertical: true)
        case .orderedList, .unorderedList:
            VStack(alignment: .leading, spacing: 6) {
                ForEach(node.children) { child in MarkdownBlock(node: child, ordered: node.kind == .orderedList) }
            }
        case .listItem(let ordinal):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(ordered ? "\(ordinal)." : "•").foregroundStyle(.secondary)
                children
            }
        case .table(let columns):
            ScrollView(.horizontal) {
                Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                    ForEach(node.children) { row in
                        GridRow(alignment: .top) {
                            ForEach(Array(columns.enumerated()), id: \.offset) { index, column in
                                Text(cell(row, index)).fontWeight(row.kind == .tableHeaderRow ? .semibold : .regular)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .frame(minWidth: 80, maxWidth: 280, alignment: alignment(column))
                                    .padding(.horizontal, 10).padding(.vertical, 8)
                                    .background(row.kind == .tableHeaderRow ? Theme.solid : Color.clear)
                            }
                        }
                        Divider().gridCellColumns(columns.count).gridCellUnsizedAxes(.horizontal)
                    }
                }
            }
        default:
            if !node.text.characters.isEmpty {
                Text(node.text).lineSpacing(4).fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if !node.children.isEmpty { children }
        }
    }

    private var children: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(node.children) { MarkdownBlock(node: $0) }
        }
    }

    private func cell(_ row: ChatMarkdownNode, _ index: Int) -> AttributedString {
        row.children.first { $0.kind == .tableCell(columnIndex: index) }?.text ?? AttributedString()
    }

    private func alignment(_ column: PresentationIntent.TableColumn) -> Alignment {
        switch column.alignment {
        case .center: return .center
        case .right: return .trailing
        default: return .leading
        }
    }
}
