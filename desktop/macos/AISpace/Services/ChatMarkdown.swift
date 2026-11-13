import Foundation

/// Foundation parses Markdown (including GFM tables); SwiftUI Text only draws its inline
/// attributes. Preserve the presentation tree so block structure is laid out by native views.
struct ChatMarkdownNode: Identifiable {
    var id: Int
    var kind: PresentationIntent.Kind
    var text = AttributedString()
    var children: [ChatMarkdownNode] = []

    fileprivate mutating func append(_ path: ArraySlice<PresentationIntent.IntentType>, text: AttributedString) {
        guard let component = path.first else { self.text += text; return }
        if children.last?.id != component.identity {
            children.append(ChatMarkdownNode(id: component.identity, kind: component.kind))
        }
        children[children.count - 1].append(path.dropFirst(), text: text)
    }

    /// For a table row: the cell in column `index`, empty when the row has fewer cells.
    func tableCell(_ index: Int) -> AttributedString {
        children.first { $0.kind == .tableCell(columnIndex: index) }?.text ?? AttributedString()
    }

    /// For a table: how wide each column's longest cell is on one line, estimated from its
    /// characters (a CJK character or an emoji counts as two `character` widths), and at least
    /// `minimum`. A view gives a column up to this, so short columns keep their width and long
    /// ones share the rest and wrap; a low estimate only wraps a line a little early.
    func tableColumnWidths(_ count: Int, character: CGFloat, minimum: CGFloat) -> [CGFloat] {
        (0..<count).map { index -> CGFloat in
            let longest = children.map { row -> Int in
                String(row.tableCell(index).characters).unicodeScalars.reduce(0) { $0 + ($1.value >= 0x2E80 ? 2 : 1) }
            }.max() ?? 0
            return max(minimum, CGFloat(longest) * character)
        }
    }
}

enum ChatMarkdown {
    static func parse(_ source: String) -> [ChatMarkdownNode] {
        guard let parsed = try? AttributedString(markdown: source, options: .init(interpretedSyntax: .full)) else {
            return [ChatMarkdownNode(id: 0, kind: .paragraph, text: AttributedString(source))]
        }
        var root = ChatMarkdownNode(id: -1, kind: .paragraph)
        for run in parsed.runs {
            var fragment = AttributedString(parsed[run.range])
            fragment.presentationIntent = nil
            if let intent = run.presentationIntent {
                root.append(Array(intent.components.reversed())[...], text: fragment)
            } else {
                // Keep unstructured text visible, including partially streamed Markdown.
                if root.children.last?.id != -2 { root.children.append(ChatMarkdownNode(id: -2, kind: .paragraph)) }
                root.children[root.children.count - 1].text += fragment
            }
        }
        return root.children
    }
}
