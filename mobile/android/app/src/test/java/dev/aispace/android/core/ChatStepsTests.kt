package dev.aispace.android.core

import org.junit.Assert.*
import org.junit.Test

/** The ordered work of a turn, as src/web/chat-steps.test.ts checks it. */
class ChatStepsTests {
    private fun tool(id: String, command: String = "pwd") =
        """{"type":"assistant","message":{"content":[{"type":"tool_use","id":"$id","name":"Bash","input":{"command":"$command"}}]}}"""
    private fun result(id: String, text: String, error: Boolean = false) =
        """{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"$id","content":"$text","is_error":$error}]}}"""

    @Test fun textAndRepeatedToolsKeepTheirOrderAndSeparateResults() {
        var r = ChatReply()
        for (line in listOf(
            """{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"Look"}}}""",
            """{"type":"assistant","message":{"content":[{"type":"text","text":"Looking."}]}}""",
            tool("a"), tool("b"),
            result("a", "/home"),
            result("b", "denied", error = true),
            """{"type":"assistant","message":{"content":[{"type":"text","text":"Done."}]}}""",
            """{"type":"done"}""",
        )) r = r.applying(line)
        assertEquals(
            listOf(
                listOf("Text", "", "Looking.", "", "Succeeded"),
                listOf("Tool", "Bash", "pwd", "/home", "Succeeded"),
                listOf("Tool", "Bash", "pwd", "denied", "Failed"),
                listOf("Text", "", "Done.", "", "Succeeded"),
            ),
            r.steps.map { listOf(it.kind.name, it.title, it.text, it.output, it.state.name) },
        )
        assertEquals(listOf("Bash", "Bash"), r.tools)
        assertEquals("Looking.\n\nDone.", r.text)
    }

    @Test fun aToolWithoutAResultIsIncompleteWhenTheTurnEnds() {
        val r = ChatReply().applying(tool("a")).applying("""{"type":"done"}""")
        assertEquals(ChatStepState.Incomplete, r.steps.single().state)
    }

    @Test fun aToolResultMovesTheActivityOn() {
        val r = ChatReply().applying(tool("a")).applying(tool("b")).applying(result("a", "ok"))
        assertEquals(ChatActivity.Running("Bash"), r.activity)
        assertEquals(ChatActivity.Thinking(""), r.applying(result("b", "ok")).activity)
    }

    @Test fun approvalsAndSteersAreStepsInOrder() {
        val r = ChatReply()
            .applying(tool("a"))
            .applying("""{"type":"approval_request","id":"r1","tool":"Edit","title":"b.txt"}""")
            .applying("""{"type":"steer","text":"also c"}""")
            .applying("""{"type":"done"}""")
        assertEquals(listOf(ChatStepKind.Tool, ChatStepKind.Approval, ChatStepKind.Steer), r.steps.map { it.kind })
        assertEquals(ChatApprovalState.Cancelled, r.approvals.single().state)
        assertEquals("r1", r.approvals.single().id)
    }

    @Test fun anAgentsQuestionKeepsItsOptionsAndTheAnswers() {
        var r = ChatReply().applying(
            """{"type":"approval_request","id":"q1","tool":"AskUserQuestion","title":"Which one?","questions":[{"id":"pick","header":"Asset","question":"Which one?","options":[{"label":"Contract","description":"the signed one"}],"multiSelect":false}]}""",
        )
        val question = r.steps.single().questions.single()
        assertEquals(ChatQuestion("pick", "Asset", "Which one?", listOf(ChatQuestion.Option("Contract", "the signed one")), false), question)
        assertEquals(ChatApprovalState.Waiting, r.approvals.single().state)
        r = r.applying("""{"type":"approval_resolved","id":"q1","decision":"allow","answers":{"pick":["Contract"]}}""")
        assertEquals(ChatStepState.Allowed, r.steps.single().state)
        assertEquals(mapOf("pick" to listOf("Contract")), r.steps.single().answers)
    }

    @Test fun aRestoredTranscriptDrawsItsStepsFinishedInOrder() {
        val stored = Hub.rows(
            "messages",
            """{"messages":[{"role":"ai","text":"Checking.","tools":[{"name":"Bash","hint":"ls"}],"steps":[{"kind":"text","text":"Checking."},{"kind":"tool","name":"Bash","input":"ls","output":"a","failed":false},{"kind":"tool","name":"Bash","input":"false","output":"","failed":true}]}]}""",
            ChatStored,
        ).single()
        assertEquals(
            listOf(
                listOf("Text", "", "Checking.", "", "Succeeded"),
                listOf("Tool", "Bash", "ls", "a", "Succeeded"),
                listOf("Tool", "Bash", "false", "", "Failed"),
            ),
            stored.work.map { listOf(it.kind.name, it.title, it.text, it.output, it.state.name) },
        )
    }

    @Test fun anOlderTranscriptShowsItsToolsWithoutInventingResults() {
        val stored = Hub.rows("messages", """{"messages":[{"role":"ai","text":"Hi","tools":[{"name":"Read","hint":"a.txt"}]}]}""", ChatStored).single()
        assertEquals(listOf(Triple("Read", "a.txt", ChatStepState.Incomplete)), stored.work.map { Triple(it.title, it.text, it.state) })
    }

    @Test fun toolRowsPickAVariantAcrossRuntimesAndSummarizeToOneLine() {
        assertEquals(List(4) { ToolVariant.Bash }, listOf("Bash", "bash", "command_execution", "exec").map(ChatTools::variant))
        assertEquals(
            listOf(ToolVariant.Read, ToolVariant.Edit, ToolVariant.Edit, ToolVariant.Write, ToolVariant.Search, ToolVariant.Search, ToolVariant.Web, ToolVariant.Web, ToolVariant.Code, ToolVariant.Task, ToolVariant.Plan),
            listOf("Read", "Edit", "MultiEdit", "Write", "Grep", "Glob", "WebFetch", "web_search", "run_code", "Task", "TodoWrite").map(ChatTools::variant),
        )
        assertEquals(ToolVariant.Search, ChatTools.variant("mcp__files__search"))
        assertEquals(ToolVariant.Other, ChatTools.variant("mcp__github__create_issue"))
        assertEquals("github · create_issue", ChatTools.title("mcp__github__create_issue"))
        assertEquals("cd app", ChatTools.summary("\n  cd app\nbun test"))
        val steps = listOf(
            ChatStep("1", ChatStepKind.Text), ChatStep("2", ChatStepKind.Tool), ChatStep("3", ChatStepKind.Tool),
            ChatStep("4", ChatStepKind.Text), ChatStep("5", ChatStepKind.Tool),
        )
        assertEquals(listOf(listOf("1"), listOf("2", "3"), listOf("4"), listOf("5")), ChatTools.groups(steps).map { g -> g.map { it.id } })
    }

    @Test fun aFoldedRunNamesCommandsOnlyWhenEveryCallInItIsOne() {
        fun run(vararg names: String) = names.mapIndexed { i, name -> ChatStep("$i", ChatStepKind.Tool, title = name, state = ChatStepState.Succeeded) }
        assertTrue(ChatTools.allCommands(run("Bash", "exec_command", "run_command")))
        assertFalse(ChatTools.allCommands(run("Bash", "Read")))
        assertFalse(ChatTools.allCommands(run("Read")))
        assertFalse(ChatTools.allCommands(emptyList()))
        assertFalse(ChatTools.allCommands(listOf(ChatStep("t", ChatStepKind.Text))))
    }

    @Test fun chatImagesAreCheckedByTheirSignatureAndTheSpacesLimits() {
        fun bytes(vararg b: Int) = ByteArray(b.size) { b[it].toByte() }
        assertEquals("image/png", ChatImage.mediaType(bytes(137, 80, 78, 71, 13, 10, 26, 10, 0)))
        assertEquals("image/jpeg", ChatImage.mediaType(bytes(255, 216, 255, 224)))
        assertEquals("image/gif", ChatImage.mediaType("GIF89a".toByteArray()))
        assertEquals("image/webp", ChatImage.mediaType("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ".toByteArray()))
        assertNull(ChatImage.mediaType("ftypheic".toByteArray()))
        val small = ChatImage("a.png", "image/png", ByteArray(10))
        assertTrue(ChatImage.validate(List(4) { small }))
        assertFalse(ChatImage.validate(List(5) { small }))
        assertFalse(ChatImage.validate(listOf(ChatImage("big.png", "image/png", ByteArray(ChatImage.MAX_BYTES + 1)))))
        val four = ChatImage("b.png", "image/png", ByteArray(4 * 1024 * 1024))
        assertFalse(ChatImage.validate(List(3) { four }))
        val body = small.body()
        assertEquals("image/png", body.getString("mediaType"))
        assertEquals("AAAAAAAAAAAAAA==", body.getString("data"))
    }
}
