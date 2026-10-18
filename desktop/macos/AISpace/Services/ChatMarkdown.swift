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
