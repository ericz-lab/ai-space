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
            ScrollView(.horizontal, showsIndicators: false) {
                Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                    ForEach(node.children) { row in
                        GridRow(alignment: .top) {
                            ForEach(Array(columns.enumerated()), id: \.offset) { index, column in
                                Text(cell(row, index)).font(.footnote).fontWeight(row.kind == .tableHeaderRow ? .semibold : .regular)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .frame(minWidth: 64, maxWidth: 220, alignment: alignment(column))
                                    .padding(.horizontal, 8).padding(.vertical, 6)
                                    .background(row.kind == .tableHeaderRow ? Theme.solid : Color.clear)
                            }
                        }
                        Divider().gridCellColumns(columns.count).gridCellUnsizedAxes(.horizontal)
                    }
                }
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
