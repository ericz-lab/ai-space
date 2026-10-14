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
