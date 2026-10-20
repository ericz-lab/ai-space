import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

struct ChatRowsTests {
    @Test func namesToolKindsAsThePanelDoes() {
        #expect(ChatRows.tool("Bash") == .bash)
        #expect(ChatRows.tool("exec_command") == .bash)
        #expect(ChatRows.tool("Read") == .read)
        #expect(ChatRows.tool("apply_patch") == .edit)
        #expect(ChatRows.tool("WebSearch") == .web)
        #expect(ChatRows.tool("TodoWrite") == .plan)
        #expect(ChatRows.tool("mcp__github__search") == .search)
        #expect(ChatRows.tool("mcp__github__create_issue") == .other)
        #expect(ChatRows.plainName("mcp__github__create_issue") == "github · create_issue")
    }

    @Test func summarizesACallByItsFirstLine() {
        #expect(ChatRows.summary("\n  git status\nmore") == "git status")
        #expect(ChatRows.summary("") == "")
        let short = ChatStep(id: "tool:1", kind: .tool, title: "Bash", text: "ls", state: .succeeded)
        #expect(!ChatRows.expandable(short))
        var withOutput = short
        withOutput.output = "a\nb"
        #expect(ChatRows.expandable(withOutput))
        #expect(ChatRows.expandable(ChatStep(id: "tool:2", kind: .tool, title: "Edit", text: "*** Begin Patch\n+x", state: .succeeded)))
    }

    @Test func stacksConsecutiveToolCalls() {
        let steps = [
            ChatStep(id: "t1", kind: .text, text: "Looking", state: .succeeded),
            ChatStep(id: "a", kind: .tool, title: "Read"),
            ChatStep(id: "b", kind: .tool, title: "Bash"),
            ChatStep(id: "t2", kind: .text, text: "Done", state: .succeeded),
            ChatStep(id: "c", kind: .tool, title: "Edit"),
        ]
        let groups = ChatRows.groups(steps)
        #expect(groups.map(\.id) == ["t1", "tools:a", "t2", "tools:c"])
        if case .tools(let run) = groups[1] { #expect(run.map(\.id) == ["a", "b"]) } else { Issue.record("expected a run of tools") }
    }

    @Test func restoresAStoredConversationsSteps() throws {
        let body = #"""
        {"ok":true,"messages":[
          {"role":"user","text":"fix it"},
          {"role":"ai","text":"Done","tools":[{"name":"Bash","hint":"ls"}],"steps":[
            {"kind":"text","text":"Checking"},
            {"kind":"tool","name":"Bash","input":"ls","output":"a.txt","failed":false},
            {"kind":"tool","name":"Edit","input":"a.txt","output":"denied","failed":true},
            {"kind":"text","text":"Done"}]},
          {"role":"ai","text":"Old reply","tools":[{"name":"Read","hint":"README.md"}]},
          {"role":"ai","text":"Odd","tools":"not a list","steps":[{"nope":1}]}
        ]}
        """#
        let stored = try Hub.rows(ChatStored.self, "messages", from: Data(body.utf8))
        #expect(stored.count == 4)
        let steps = ChatRows.steps(of: stored[1])
        #expect(steps.map(\.kind) == [.text, .tool, .tool, .text])
        #expect(steps[1].title == "Bash" && steps[1].text == "ls" && steps[1].output == "a.txt" && steps[1].state == .succeeded)
        #expect(steps[2].state == .failed)
        let old = ChatRows.steps(of: stored[2])
        #expect(old.map(\.kind) == [.tool, .text])
        #expect(old[0].text == "README.md" && old[0].state == .incomplete)
        #expect(old[1].text == "Old reply")
        #expect(ChatRows.steps(of: stored[3]).isEmpty)
        #expect(ChatRows.steps(of: stored[0]).isEmpty)
    }

    @Test func readsQuestionsAndTheirAnswers() {
        let asked = #"{"type":"approval_request","id":"q1","tool":"AskUserQuestion","title":"Which source?","questions":[{"id":"src","header":"Source","question":"Which source?","options":[{"label":"CSV","description":"the export"},{"label":"API","description":""}],"multiSelect":false}]}"#
        guard case .asked(let step, let questions)? = ChatRows.questionEvent(asked) else { Issue.record("no question read"); return }
        #expect(step == "approval:q1")
        #expect(questions.map(\.id) == ["src"])
        #expect(questions[0].options.map(\.label) == ["CSV", "API"])
        #expect(!questions[0].multiple)
        #expect(ChatRows.questionEvent(#"{"type":"approval_resolved","id":"q1","decision":"allow","answers":{"src":["CSV"]}}"#) == .answered(step: "approval:q1", answers: ["src": ["CSV"]]))
        // An ordinary approval is not a question.
        #expect(ChatRows.questionEvent(#"{"type":"approval_request","id":"a1","tool":"Bash","title":"rm -rf build"}"#) == nil)
        #expect(ChatRows.questionEvent(#"{"type":"approval_resolved","id":"a1","decision":"deny"}"#) == nil)
    }

    @Test func answersAsThePanelSendsThem() {
        let one = ChatRows.Question(id: "a", question: "Pick", options: [.init(label: "X")])
        #expect(ChatRows.answer(to: one, picked: ["X"], typed: "") == ["X"])
        #expect(ChatRows.answer(to: one, picked: ["X"], typed: " my own ") == ["my own"])
        let many = ChatRows.Question(id: "b", question: "Pick", options: [.init(label: "X"), .init(label: "Y")], multiSelect: true)
        #expect(ChatRows.answer(to: many, picked: ["X", "Y"], typed: "Z") == ["X", "Y", "Z"])
        #expect(ChatRows.approvalBody(allow: true, answers: ["a": ["X"]])["answers"] as? [String: [String]] == ["a": ["X"]])
        #expect(ChatRows.approvalBody(allow: false, answers: nil)["decision"] as? String == "deny")
        #expect(ChatRows.approvalBody(allow: false, answers: nil)["answers"] == nil)
        #expect(ChatRows.approvalBody(allow: true)["decision"] as? String == "allow")
    }
}
