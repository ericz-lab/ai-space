import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

/// The command box's shortcut offer reads the resolve answer as the Linux client does
/// (desktop/linux/src/core/shortcuts.test.ts has the same cases).
struct ShortcutOfferTests {
    let todo = """
        "action": { "id": "ai-todo/create", "title": "Create todo", "available": AVAILABLE,
          "inputs": [{ "name": "title", "label": "Title" }, { "name": "dueDate", "label": "Date" }],
          "i18n": { "zh-CN": { "title": "新建待办", "inputs": { "title": "标题" } } } }
        """

    func answer(strong: Bool = true, available: Bool = true, agents: String = "[]", ambiguous: Bool = false) -> Data {
        let action = todo.replacingOccurrences(of: "AVAILABLE", with: available ? "true" : "false")
        return Data("""
            { "ok": true, "intents": [{ "kind": "action", "key": "ai-todo/create", "strong": \(strong), \(action),
              "args": { "title": "写周报", "dueDate": "tomorrow", "extra": 1 } }], "agentIntents": \(agents), "ambiguous": \(ambiguous) }
            """.utf8)
    }

    @Test func anActionNamedAtTheStartIsOfferedWithWhatTheSentenceFilled() {
        #expect(ShortcutOffer.from(answer(), lang: "zh", calculator: "计算器") == ShortcutOffer(title: "新建待办", detail: "标题: 写周报 · Date: tomorrow"))
        #expect(ShortcutOffer.from(answer(), lang: "en", calculator: "Calculator") == ShortcutOffer(title: "Create todo", detail: "Title: 写周报 · Date: tomorrow"))
        #expect(ShortcutOffer.from(answer(strong: false), lang: "en", calculator: "Calculator") == nil)
        #expect(ShortcutOffer.from(answer(available: false), lang: "en", calculator: "Calculator") == nil)
        #expect(ShortcutOffer.from(answer(agents: #"[{ "id": "x" }]"#), lang: "en", calculator: "Calculator") == nil)
        #expect(ShortcutOffer.from(answer(ambiguous: true), lang: "en", calculator: "Calculator") == nil)
    }

    @Test func arithmeticIsTheCalculatorAndAnythingElseOffersNothing() {
        let calc = Data(#"{ "intents": [{ "kind": "calc", "key": "calc", "expression": "1+2" }] }"#.utf8)
        #expect(ShortcutOffer.from(calc, lang: "en", calculator: "Calculator") == ShortcutOffer(title: "Calculator", detail: "1+2"))
        #expect(ShortcutOffer.from(Data(#"{ "intents": [] }"#.utf8), lang: "en", calculator: "Calculator") == nil)
        #expect(ShortcutOffer.from(Data(#"{ "intents": [{ "kind": "later" }] }"#.utf8), lang: "en", calculator: "Calculator") == nil)
        #expect(ShortcutOffer.from(Data("nonsense".utf8), lang: "en", calculator: "Calculator") == nil)
    }

    @Test func thePageCarriesTheSentence() {
        #expect(ShortcutOffer.runPath("待办 写周报") == "/?page=shortcuts&run=%E5%BE%85%E5%8A%9E%20%E5%86%99%E5%91%A8%E6%8A%A5")
        #expect(ShortcutOffer.runPath("a&b=c") == "/?page=shortcuts&run=a%26b%3Dc")
    }
}
