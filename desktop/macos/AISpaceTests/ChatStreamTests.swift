import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

struct ChatStreamTests {
    @Test func parsesTheRunStream() {
        var p = SSEParser()
        #expect(p.feed(": keepalive") == nil)
        #expect(p.feed("id: 7") == nil)
        #expect(p.feed(#"data: {"type":"done"}"#) == SSEMessage(id: 7, data: #"{"type":"done"}"#))
        #expect(p.feed("data:no-space") == SSEMessage(id: nil, data: "no-space"))
        #expect(p.feed("event: other") == nil)
    }

    @Test func buildsAReplyFromClaudeStyleEvents() {
        var r = ChatReply()
        r.apply(#"{"type":"system","subtype":"init","session_id":"s1","model":"sol"}"#)
        #expect(r.sessionID == "s1" && r.activity == .thinking(model: "sol"))
        r.apply(#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}}"#)
        r.apply(#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}}"#)
        #expect(r.text == "Hello" && r.activity == nil)
        r.apply(#"{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"},{"type":"tool_use","id":"t1","name":"Bash","input":{}}]}}"#)
        r.apply(#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{}}]}}"#)
        #expect(r.text == "Hello" && r.tools == ["Bash"] && r.activity == .running(tool: "Bash"))
        r.apply(#"{"type":"assistant","message":{"content":[{"type":"text","text":"Done."}]}}"#)
        r.apply(#"{"type":"result","session_id":"s2"}"#)
        r.apply(#"{"type":"done"}"#)
        #expect(r.text == "Hello\n\nDone." && r.sessionID == "s2" && r.finished)
    }

    @Test func errorsAndStops() {
        var r = ChatReply()
        r.apply(#"{"type":"error","error":"timeout","status":"timeout"}"#)
        #expect(r.text == "⚠️ timeout" && r.failure == "timeout" && r.body.isEmpty)
        var s = ChatReply()
        s.apply(#"{"type":"error","error":"stopped","status":"stopped"}"#)
        #expect(s.stopped && s.text.isEmpty && s.failure == nil)
        var junk = ChatReply()
        junk.apply("not json")
        #expect(junk == ChatReply())
    }

    @Test func keepsTheWrittenReplyApartFromTheFailure() {
        var r = ChatReply()
        r.apply(#"{"type":"assistant","message":{"content":[{"type":"text","text":"Half"}]}}"#)
        r.apply(#"{"type":"error","error":"runtime exited with 1","status":"error"}"#)
        #expect(r.body == "Half" && r.text == "Half\n\n⚠️ runtime exited with 1" && r.failure == "runtime exited with 1")
    }

    @Test func permissionRefusalsMatchWebToolResultsAndSurviveReplay() {
        var reply = ChatReply()
        reply.apply(#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"shell","name":"Bash"},{"type":"tool_use","id":"edit","name":"Edit"}]}}"#)
        let denied = #"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"shell","is_error":true,"content":"This command requires approval"}]}}"#
        reply.apply(denied)
        reply.apply(denied)
        reply.apply(#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"edit","is_error":true,"content":[{"type":"text","text":"Permission denied"}]}]}}"#)
        reply.apply(#"{"type":"done"}"#)
        #expect(reply.denied == ["Bash", "Edit"])
        #expect(reply.finished && reply.failure == nil)
        #expect(reply.body.isEmpty)
    }

    @Test func ordinaryToolErrorsAndSuccessfulPermissionTextAreNotRefusals() {
        var reply = ChatReply()
        reply.apply(#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"x","is_error":true,"content":"File not found"},{"type":"tool_result","tool_use_id":"y","is_error":false,"content":"permission granted"}]}}"#)
        #expect(reply.denied.isEmpty)
        reply.apply(#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"unknown","is_error":true,"content":"permission denied"}]}}"#)
        #expect(reply.denied == ["tool"])
    }

    @Test func grantUsesWebTiersAndNeverLowersAnExistingGrant() {
        #expect(ChatPermission.readOnly.granting(["Edit"]) == .editFiles)
        #expect(ChatPermission.readOnly.granting(["Bash"]) == .all)
        #expect(ChatPermission.editFiles.granting(["Edit"]) == .all)
        #expect(ChatPermission.all.granting(["Edit"]) == .all)
        #expect(ChatPermission(rawValue: "unrecognized") == nil)
    }

    @Test func requestCapturesPermissionAndResumesTheSameSession() {
        var selected = ChatPermission.readOnly
        let original = ChatTurnRequest(message: "Check status", permission: selected)
        selected = .all
        #expect(original.body(sessionID: nil)["permissionMode"] == nil)
        #expect(original.body(sessionID: nil)["interactive"] as? Bool == true)
        let retry = ChatTurnRequest(message: "Finish the refused step", permission: selected)
        let body = retry.body(sessionID: "same-session")
        #expect(body["permissionMode"] as? String == "bypassPermissions")
        #expect(body["sessionId"] as? String == "same-session")
        #expect(body["message"] as? String == "Finish the refused step")
        #expect(ChatTurnRequest(message: "edit", permission: .editFiles).body(sessionID: nil)["permissionMode"] as? String == "acceptEdits")
        // The read-only tier keeps its old wire value: a Space without live chat reads it as before.
        #expect(ChatPermission.readOnly.rawValue == "")
    }

    @Test func approvalsBecomeWaitingStepsAndResolve() {
        var r = ChatReply()
        r.apply(#"{"type":"approval_request","id":"req-1","tool":"Bash","title":"rm -rf build","detail":"wants to delete the build output"}"#)
        #expect(r.steps.count == 1)
        #expect(r.steps[0].kind == .approval && r.steps[0].state == .waiting)
        #expect(r.steps[0].title == "Bash" && r.steps[0].text == "rm -rf build" && r.steps[0].output == "wants to delete the build output")
        #expect(r.activity == nil)
        r.apply(#"{"type":"approval_resolved","id":"req-1","decision":"allow"}"#)
        #expect(r.steps[0].state == .allowed)
        r.apply(#"{"type":"approval_request","id":"req-2","tool":"Edit","title":"notes.txt"}"#)
        r.apply(#"{"type":"approval_resolved","id":"req-2","decision":"deny"}"#)
        #expect(r.steps[1].state == .denied)
        r.apply(#"{"type":"done"}"#)
        #expect(r.steps.allSatisfy { $0.state != .waiting })
    }

    @Test func anUnansweredApprovalIsCancelledWhenTheTurnEnds() {
        var r = ChatReply()
        r.apply(#"{"type":"approval_request","id":"req-1","tool":"Bash","title":"make"}"#)
        r.endSteps()
        #expect(r.steps[0].state == .cancelled)
    }

    @Test func steerEventsReportTheMessagesTheAgentRead() {
        var r = ChatReply()
        r.apply(#"{"type":"steer","text":"check the logs"}"#)
        #expect(r.consumedSteers == ["check the logs"])
        #expect(r.steps.last?.kind == .steer && r.steps.last?.text == "check the logs")
        // An image-only message replays with no text: the reply reports it without a title.
        r.apply(#"{"type":"steer","text":""}"#)
        #expect(r.consumedSteers == ["check the logs", ""])
    }

    @Test func aQueuedTurnsReplyGoesRightAfterItsOwnMessage() {
        let a = UUID(), b = UUID(), c = UUID()
        // Two messages waiting behind one turn: each reply sits after its own message, so neither
        // message is separated from the turn that answers it.
        #expect(ChatThread.replyIndex(after: b, in: [a, b, c]) == 2)
        #expect(ChatThread.replyIndex(after: c, in: [a, b, c]) == 3)
        #expect(ChatThread.replyIndex(after: UUID(), in: [a, b, c]) == nil)
    }

    @Test func tellsWhyATurnFailed() {
        // What Seoul's codex said on 2026-10-14, and what the Space passed on.
        #expect(ChatFailure("exceeded retry limit, last status: 429 Too Many Requests").kind == .busy)
        #expect(ChatFailure("runtime exited with 1").kind == .exited(1))
        #expect(ChatFailure("  runtime exited with 137\n").detail == "runtime exited with 137")
        #expect(ChatFailure("runtime exited with 137").kind == .exited(137))
        #expect(ChatFailure("Overloaded").kind == .busy)
        #expect(ChatFailure("You've hit your usage limit.").kind == .busy)
        #expect(ChatFailure("Not logged in · Please run /login").kind == .signedOut)
        #expect(ChatFailure("timed out after 600s").kind == .timedOut)
        #expect(ChatFailure("could not run Codex: spawn codex ENOENT").kind == .unavailable)
        #expect(ChatFailure("something odd").kind == .other)
        #expect(ChatFailure("runtime exited with 1").retryable && ChatFailure("429").retryable)
        #expect(!ChatFailure("Not logged in").retryable && !ChatFailure("could not run Codex: x").retryable)
    }
}

/// Codex adapter output uses the shared event contract; no live Claude process is used here.
struct CodexWorkStepsTests {
    @Test func preservesMessagesAndMatchesResultsWithoutDuplicatingSteps() {
        var r = ChatReply()
        r.apply(#"{"type":"assistant","message":{"content":[{"type":"text","text":"Checking the workspace."}]}}"#)
        let start = #"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"shell-1","name":"Bash","input":{"command":"pwd"}}]}}"#
        r.apply(start)
        r.apply(start)
        #expect(r.steps.count == 2)
        #expect(r.steps[1].text == "pwd" && r.steps[1].state == .running)
        r.apply(#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"shell-1","is_error":false,"content":"/workspace"}]}}"#)
        r.apply(#"{"type":"assistant","message":{"content":[{"type":"text","text":"Workspace checked."}]}}"#)
        r.apply(#"{"type":"done"}"#)
        #expect(r.steps.map(\.kind) == [.text, .tool, .text])
        #expect(r.steps[1].state == .succeeded && r.steps[1].output == "/workspace")
        #expect(r.steps[2].text == "Workspace checked.")
    }

    @Test func failedAndInterruptedWorkNeverLooksSuccessful() {
        var r = ChatReply()
        r.apply(#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"a","name":"Bash","input":{"command":"false"}},{"type":"tool_use","id":"b","name":"Edit","input":{"file_path":"notes.txt"}}]}}"#)
        r.apply(#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"a","is_error":true,"content":"command failed"}]}}"#)
        r.apply(#"{"type":"error","status":"stopped"}"#)
        r.apply(#"{"type":"done"}"#)
        #expect(r.steps[0].state == .failed)
        #expect(r.steps[1].state == .incomplete)
        #expect(r.denied.isEmpty)
    }

    @Test func capsLargeResultsAndKeepsParallelStepsIndependent() {
        var r = ChatReply()
        r.apply(#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"a","name":"Bash"},{"type":"tool_use","id":"b","name":"Bash"}]}}"#)
        let event: [String: Any] = ["type": "user", "message": ["content": [["type": "tool_result", "tool_use_id": "b", "content": String(repeating: "x", count: 20000)]]]]
        r.apply(String(data: try! JSONSerialization.data(withJSONObject: event), encoding: .utf8)!)
        #expect(r.steps[0].state == .running)
        #expect(r.steps[1].state == .succeeded && r.steps[1].output.count == 12000)
    }

    @Test func toolRowsPickAKindAcrossRuntimesAndSummarizeToOneLine() {
        #expect(["Bash", "bash", "command_execution", "exec"].map { ChatToolKind(tool: $0) } == [.bash, .bash, .bash, .bash])
        #expect(["Read", "Edit", "MultiEdit", "Write", "Grep", "Glob", "WebFetch", "web_search", "run_code", "Task", "TodoWrite"].map { ChatToolKind(tool: $0) }
            == [.read, .edit, .edit, .write, .search, .search, .web, .web, .code, .task, .plan])
        #expect(ChatToolKind(tool: "mcp__github__search") == .search)
        #expect(ChatToolKind(tool: "mcp__github__create_issue") == .other)
        #expect(ChatToolKind.title("mcp__github__create_issue") == "github · create_issue")
        #expect(ChatToolKind.summary("\n  \n  git status\n  git diff") == "git status")
        #expect(ChatToolKind.summary("") == "")
    }

    @Test func consecutiveToolCallsStackAsOneGroup() {
        let steps = [
            ChatStep(id: "a", kind: .text), ChatStep(id: "b", kind: .tool), ChatStep(id: "c", kind: .tool),
            ChatStep(id: "d", kind: .text), ChatStep(id: "e", kind: .tool),
        ]
        #expect(ChatStepGroup.groups(steps).map(\.id) == ["a", "tools:b", "d", "tools:e"])
        guard case .tools(let run) = ChatStepGroup.groups(steps)[1] else { Issue.record("not a tool group"); return }
        #expect(run.map(\.id) == ["b", "c"])
    }

    @Test func aFoldedRunNamesCommandsOnlyWhenEveryCallInItIsOne() {
        let run = { (names: [String]) in names.enumerated().map { ChatStep(id: "\($0.offset)", kind: .tool, title: $0.element) } }
        #expect(ChatToolKind.allCommands(run(["Bash", "exec_command", "run_command"])))
        #expect(!ChatToolKind.allCommands(run(["Bash", "Read"])))
        #expect(!ChatToolKind.allCommands(run(["Read"])))
        #expect(!ChatToolKind.allCommands([]))
        #expect(!ChatToolKind.allCommands([ChatStep(id: "t", kind: .text, title: "Bash")]))
    }

    @Test func anAgentsQuestionKeepsItsOptionsAndOnceAnsweredTheAnswers() {
        var r = ChatReply()
        r.apply(#"{"type":"approval_request","id":"q1","tool":"AskUserQuestion","title":"Which one?","questions":[{"id":"pick","header":"Asset","question":"Which one?","options":[{"label":"Contract","description":"the signed one"},{"label":"Draft"}],"multiSelect":false}]}"#)
        #expect(r.steps.count == 1 && r.steps[0].kind == .approval && r.steps[0].state == .waiting)
        #expect(r.steps[0].questions == [ChatQuestion(id: "pick", header: "Asset", question: "Which one?",
                                                     options: [.init(label: "Contract", description: "the signed one"), .init(label: "Draft")])])
        r.apply(#"{"type":"approval_resolved","id":"q1","decision":"allow","answers":{"pick":["Contract"]}}"#)
        #expect(r.steps[0].state == .allowed && r.steps[0].answers == ["pick": ["Contract"]])
        var plain = ChatReply()
        plain.apply(#"{"type":"approval_request","id":"a1","tool":"Bash","title":"rm x"}"#)
        #expect(plain.steps[0].questions.isEmpty)
    }

    @Test func aQuestionsAnswerIsTheTypedTextOrThePickedOptions() {
        let one = ChatQuestion(id: "q", question: "?", options: [.init(label: "A"), .init(label: "B")])
        #expect(one.answer(picked: ["A"], typed: "") == ["A"])
        #expect(one.answer(picked: ["A"], typed: "  mine ") == ["mine"])
        #expect(one.answer(picked: [], typed: " ") == [])
        let many = ChatQuestion(id: "q", question: "?", options: [.init(label: "A"), .init(label: "B")], multiSelect: true)
        #expect(many.answer(picked: ["A", "B"], typed: "C") == ["A", "B", "C"])
    }

    @Test func aRestoredTranscriptsStepsDrawAsFinishedTextAndToolRowsInOrder() throws {
        let json = #"{"messages":[{"role":"user","text":"hi"},{"role":"ai","text":"Checking.","tools":[{"name":"Bash","hint":"ls"}],"steps":[{"kind":"text","text":"Checking."},{"kind":"tool","name":"Bash","input":"ls","output":"a","failed":false},{"kind":"tool","name":"Bash","input":"false","output":"","failed":true}]},{"role":"ai","text":"old","tools":[]}]}"#
        let messages = try Hub.rows(ChatHistoryMessage.self, "messages", from: Data(json.utf8))
        #expect(messages.count == 3 && messages[0].isUser && messages[0].chatSteps.isEmpty)
        #expect(messages[1].chatSteps.map { [$0.title, $0.text, $0.output] } == [["", "Checking.", ""], ["Bash", "ls", "a"], ["Bash", "false", ""]])
        #expect(messages[1].chatSteps.map(\.kind) == [.text, .tool, .tool])
        #expect(messages[1].chatSteps.map(\.state) == [.succeeded, .succeeded, .failed])
        #expect(messages[2].chatSteps.isEmpty && messages[2].tools?.isEmpty == true)
    }
}
