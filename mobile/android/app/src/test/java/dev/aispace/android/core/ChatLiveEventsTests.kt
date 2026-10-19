package dev.aispace.android.core

import org.junit.Assert.*
import org.junit.Test

class ChatLiveEventsTests {
    @Test fun approvalsAndSteersBecomeReplyState() {
        var reply = ChatReply()
            .applying("""{"type":"approval_request","id":"codex-0","tool":"Bash","title":"rm -rf build","detail":"the sandbox is read-only"}""")
        assertEquals(1, reply.approvals.size)
        assertEquals(ChatApprovalState.Waiting, reply.approvals.single().state)
        assertEquals("Bash", reply.approvals.single().tool)
        assertEquals("rm -rf build", reply.approvals.single().title)
        assertEquals("the sandbox is read-only", reply.approvals.single().detail)
        // The turn is not running anything while it waits.
        assertNull(reply.activity)
        reply = reply.applying("""{"type":"approval_resolved","id":"codex-0","decision":"allow"}""")
        assertEquals(ChatApprovalState.Allowed, reply.approvals.single().state)
        reply = reply.applying("""{"type":"steer","text":"more"}""")
        assertEquals(listOf("more"), reply.consumedSteers)
        assertEquals(listOf("more"), reply.steers)
    }

    @Test fun aReplayedApprovalRequestIsNotAddedTwice() {
        var reply = ChatReply()
        repeat(2) { reply = reply.applying("""{"type":"approval_request","id":"codex-0","tool":"Bash","title":"make"}""") }
        assertEquals(1, reply.approvals.size)
    }

    @Test fun anUnansweredApprovalIsCancelledWhenTheTurnEnds() {
        val waiting = ChatReply().applying("""{"type":"approval_request","id":"codex-0","tool":"Bash","title":"make"}""")
        assertEquals(ChatApprovalState.Cancelled, waiting.settled().approvals.single().state)
    }
}
