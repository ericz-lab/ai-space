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
        let retry = ChatTurnRequest(message: "Finish the refused step", permission: selected)
        let body = retry.body(sessionID: "same-session")
        #expect(body["permissionMode"] as? String == "bypassPermissions")
        #expect(body["sessionId"] as? String == "same-session")
        #expect(body["message"] as? String == "Finish the refused step")
        #expect(ChatTurnRequest(message: "edit", permission: .editFiles).body(sessionID: nil)["permissionMode"] as? String == "acceptEdits")
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
