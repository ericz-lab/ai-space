import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

/// The Home command box ranks as the web panel's (src/web/omnibox.test.ts has the same cases).
struct OmniboxRulesTests {
    func entry(_ ref: String, _ title: String, zh: String, detail: String) -> CatalogueEntry {
        CatalogueEntry(kind: .app, ref: ref, title: title, detail: detail, i18n: ["zh": LocalizedText(title: zh, description: nil)],
                       icon: nil, peer: nil, link: nil, reach: .up)
    }

    var notes: CatalogueEntry { entry("ai-notes", "AI Notes", zh: "AI 笔记", detail: "Write and search notes") }
    var todo: CatalogueEntry { entry("ai-todo", "Todo", zh: "待办", detail: "Plan the day; notes on tasks") }
    var draw: CatalogueEntry { entry("ai-draw", "Draw", zh: "画板", detail: "Sketch ideas") }

    @Test func namesScoreByHowTheyFit() {
        #expect(OmniboxRules.score("todo", todo) == OmniboxRules.Score.exact)
        #expect(OmniboxRules.score("待", todo) == OmniboxRules.Score.prefix)
        #expect(OmniboxRules.score("notes", notes) == OmniboxRules.Score.word)
        #expect(OmniboxRules.score("记", notes) == OmniboxRules.Score.inside)
        #expect(OmniboxRules.score("tasks", todo) == OmniboxRules.Score.text)
        #expect(OmniboxRules.score("paint", draw) == 0)
        #expect(OmniboxRules.score("  ", draw) == 0)
    }

    @Test func bestNamesComeFirstAndEqualsKeepTheirOrder() {
        #expect(OmniboxRules.rank("notes", [todo, notes]).map(\.ref) == ["ai-notes", "ai-todo"])
        #expect(OmniboxRules.rank("ai", [todo, notes, draw]).map(\.ref) == ["ai-todo", "ai-notes", "ai-draw"])
    }

    @Test func returnOpensATypedNameAndAsksOtherwise() {
        #expect(OmniboxRules.opensByDefault("笔记", notes))
        #expect(!OmniboxRules.opensByDefault("tasks", todo))
        #expect(!OmniboxRules.opensByDefault("帮我记一下明天下午三点开会", nil))
    }
}
