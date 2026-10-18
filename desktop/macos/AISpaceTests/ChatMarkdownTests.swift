import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

struct ChatMarkdownTests {
    @Test func tableKeepsColumnsRowsAndInlineFormatting() throws {
        let nodes = ChatMarkdown.parse("""
        当前空间整体正常。

        | 项目 | 状态 |
        | :--- | ---: |
        | 空间主服务 | 正常 |
        | 应用服务 | **47/47 在线** |
        | 定时任务 | 共 114 个，92 个启用 |
        """)
        #expect(nodes.count == 2)
        let table = nodes[1]
        guard case .table(let columns) = table.kind else { Issue.record("expected a native table"); return }
        #expect(columns.count == 2)
        #expect(columns[1].alignment == .right)
        #expect(table.children.count == 4)
        #expect(table.children[0].kind == .tableHeaderRow)
        let status = try #require(table.children[2].children.last)
        #expect(String(status.text.characters) == "47/47 在线")
        #expect(status.text.runs.first?.inlinePresentationIntent?.contains(.stronglyEmphasized) == true)
    }

    @Test func codeIsLiteralAndListsKeepTheirHierarchy() {
        let nodes = ChatMarkdown.parse("""
        ## 标题

        1. first
           - nested
        2. second

        > quote

        ```sh
        echo '**literal** | ---'
        ```
        """)
        #expect(nodes.count == 4)
        #expect(nodes[0].kind == .header(level: 2))
        #expect(nodes[1].kind == .orderedList)
        #expect(nodes[1].children.count == 2)
        #expect(nodes[1].children[0].children.last?.kind == .unorderedList)
        #expect(nodes[2].kind == .blockQuote)
        #expect(String(nodes[3].text.characters).contains("**literal** | ---"))
    }

    @Test func escapedPipesAndIncompleteStreamingRemainReadable() {
        let table = ChatMarkdown.parse("| a | b |\n|---|---|\n| x\\|y | |")
        #expect(String(table[0].children[1].children[0].text.characters) == "x|y")
        for text in ["", "**unfinished", "| 项目 | 状态 |", "```swift\nlet x = 1", "[link](https://example.com)"] {
            let nodes = ChatMarkdown.parse(text)
            #expect(text.isEmpty || !nodes.isEmpty)
        }
    }
}
