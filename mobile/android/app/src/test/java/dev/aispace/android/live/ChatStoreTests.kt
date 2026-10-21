package dev.aispace.android.live

import dev.aispace.android.core.ChatApprovalState
import dev.aispace.android.core.ChatImage
import dev.aispace.android.core.ChatStepKind
import dev.aispace.android.core.ChatSessionInfo
import dev.aispace.android.core.CookieSource
import dev.aispace.android.core.SpaceApi
import kotlinx.coroutines.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.Assert.*
import java.util.concurrent.TimeUnit

class ChatStoreTests {
    private lateinit var server: MockWebServer
    @Before fun start() { server = MockWebServer(); server.start() }
    @After fun stop() { server.shutdown() }
    private fun store(scope: CoroutineScope) = ChatStore(SpaceApi(server.url("/").toUri(), CookieSource.none), "/agent", scope)
    private suspend fun requests(count: Int) = withTimeout(3000) {
        while (server.requestCount < count) delay(5)
    }
    private suspend fun finished(store: ChatStore) = withTimeout(6000) {
        while (store.isRunning) delay(5)
    }
    private fun history(text: String) = MockResponse().setBody("""{"messages":[{"role":"user","text":"$text"}]}""")
    private fun done() = MockResponse().setBody("data: {\"type\":\"done\"}\n\n")
    private fun turn(events: String, delayMs: Long = 0) = MockResponse()
        .setHeader("x-run-id", "run-1")
        .setBody(events)
        .apply { if (delayMs > 0) setBodyDelay(delayMs, TimeUnit.MILLISECONDS) }

    @Test fun newChatInvalidatesPendingHistory() = runBlocking {
        server.enqueue(history("old").setHeadersDelay(200, TimeUnit.MILLISECONDS))
        val store = store(this)
        val pending = launch { store.open(ChatSessionInfo("old-session")) }
        requests(1)
        store.newChat()
        pending.join()
        assertTrue(pending.isCancelled)
        assertTrue(store.bubbles.isEmpty())
        assertFalse(store.isOpening)
        server.enqueue(done())
        store.draft.value = "new turn"
        store.send()
        finished(store)
        server.takeRequest()
        assertFalse(server.takeRequest().body.readUtf8().contains("sessionId"))
    }

    @Test fun sendingWaitsForTheSelectedHistory() = runBlocking {
        server.enqueue(history("history").setHeadersDelay(200, TimeUnit.MILLISECONDS))
        val store = store(this)
        val pending = launch { store.open(ChatSessionInfo("chosen")) }
        requests(1)
        store.draft.value = "continue"
        assertFalse(store.canSend)
        store.send()
        assertEquals("continue", store.draft.value)
        assertFalse(store.isRunning)
        pending.join()
        assertTrue(store.canSend)
        server.enqueue(done())
        store.send()
        finished(store)
        server.takeRequest()
        assertTrue(server.takeRequest().body.readUtf8().contains("\"sessionId\":\"chosen\""))
    }

    @Test fun theLatestHistorySelectionWins() = runBlocking {
        server.enqueue(history("old").setHeadersDelay(200, TimeUnit.MILLISECONDS))
        server.enqueue(history("new"))
        val store = store(this)
        val old = launch { store.open(ChatSessionInfo("old")) }
        requests(1)
        store.open(ChatSessionInfo("new"))
        old.join()
        assertTrue(old.isCancelled)
        assertEquals("new", store.bubbles.single().text)
        assertFalse(store.isOpening)
    }

    @Test fun transientReconnectFailuresRetryFromTheLastEventWithoutRepeatingTheTurn() = runBlocking {
        server.enqueue(MockResponse().setHeader("x-run-id", "run-1")
            .setBody("id: 7\ndata: {\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"s1\"}\n\n"))
        server.enqueue(MockResponse().setResponseCode(503).setBody("{\"error\":\"try later\"}"))
        server.enqueue(MockResponse().setBody("id: 8\ndata: {\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"recovered\"}]}}\n\nid: 9\ndata: {\"type\":\"done\"}\n\n"))
        val store = store(this)
        store.draft.value = "hello"
        store.send()
        finished(store)
        assertEquals("recovered", store.bubbles.last().text)
        assertEquals(3, server.requestCount)
        assertEquals("POST", server.takeRequest().method)
        repeat(2) {
            val request = server.takeRequest()
            assertEquals("GET", request.method)
            assertEquals("/agent/runs/run-1/events?after=7", request.path)
        }
    }

    @Test fun authenticationFailureDoesNotRetry() = runBlocking {
        server.enqueue(MockResponse().setHeader("x-run-id", "run-1").setBody(""))
        server.enqueue(MockResponse().setResponseCode(401))
        val store = store(this)
        store.draft.value = "hello"
        store.send()
        finished(store)
        assertEquals(2, server.requestCount)
    }

    @Test fun cancelClearsPrivateStateAndInvalidatesPendingSessionLists() = runBlocking {
        server.enqueue(history("private history"))
        val store = store(this)
        store.open(ChatSessionInfo("private-session"))
        server.enqueue(MockResponse().setHeadersDelay(200, TimeUnit.MILLISECONDS)
            .setBody("{\"sessions\":[{\"sid\":\"private-session\"}]}"))
        val pending = launch { store.loadSessions() }
        requests(2)
        store.draft.value = "private draft"
        store.cancel()
        pending.join()
        assertTrue(store.bubbles.isEmpty())
        assertTrue(store.sessions.isEmpty())
        assertEquals("", store.draft.value)
        assertNull(store.error)
        server.enqueue(done())
        store.draft.value = "fresh"
        store.send()
        finished(store)
        repeat(2) { server.takeRequest() }
        assertFalse(server.takeRequest().body.readUtf8().contains("sessionId"))
    }

    @Test fun cancelStopsFollowingAnActiveTurnWithoutStoppingItOnTheServer() = runBlocking {
        server.enqueue(MockResponse().setHeader("x-run-id", "run-1").setBody(""))
        val store = store(this)
        store.draft.value = "hello"
        store.send()
        requests(1)
        delay(100)
        store.cancel()
        delay(1100)
        assertFalse(store.isRunning)
        assertTrue(store.bubbles.isEmpty())
        assertEquals(1, server.requestCount)
    }

    @Test fun everyTurnIsInteractive() = runBlocking {
        server.enqueue(done())
        val store = store(this)
        store.draft.value = "hello"
        store.send()
        finished(store)
        val body = server.takeRequest().body.readUtf8()
        assertTrue(body.contains("\"interactive\":true"))
        assertTrue(body.contains("\"message\":\"hello\""))
    }

    @Test fun aMessageDuringATurnIsSteeredIntoIt() = runBlocking {
        server.enqueue(turn(
            "id: 1\ndata: {\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"s1\"}\n\n" +
                "id: 2\ndata: {\"type\":\"steer\",\"text\":\"more\"}\n\n" +
                "id: 3\ndata: {\"type\":\"done\"}\n\n",
            400,
        ))
        server.enqueue(MockResponse().setBody("{\"ok\":true}"))
        val store = store(this)
        store.draft.value = "hello"
        store.send()
        requests(1)
        delay(100)
        store.draft.value = "more"
        store.send()
        requests(2)
        finished(store)
        assertEquals("POST", server.takeRequest().method)
        val steer = server.takeRequest()
        assertEquals("/agent/runs/run-1/steer", steer.path)
        assertTrue(steer.body.readUtf8().contains("\"message\":\"more\""))
        assertEquals(2, store.bubbles.size)
        assertEquals(listOf("more"), store.bubbles.last().steers)
        assertTrue(store.bubbles.last().pending.isEmpty())
    }

    @Test fun anApprovalIsAnsweredOverTheRun() = runBlocking {
        server.enqueue(turn(
            "id: 1\ndata: {\"type\":\"approval_request\",\"id\":\"codex-0\",\"tool\":\"Bash\",\"title\":\"rm -rf build\",\"detail\":\"the sandbox is read-only\"}\n\n" +
                "id: 2\ndata: {\"type\":\"approval_resolved\",\"id\":\"codex-0\",\"decision\":\"allow\"}\n\n" +
                "id: 3\ndata: {\"type\":\"done\"}\n\n",
            400,
        ))
        server.enqueue(MockResponse().setBody("{\"ok\":true}"))
        val store = store(this)
        store.draft.value = "hello"
        store.send()
        requests(1)
        delay(100)
        assertNull(store.answer("codex-0", allow = true))
        requests(2)
        finished(store)
        server.takeRequest()
        val answer = server.takeRequest()
        assertEquals("/agent/runs/run-1/approvals/codex-0", answer.path)
        assertTrue(answer.body.readUtf8().contains("\"decision\":\"allow\""))
        assertEquals(ChatApprovalState.Allowed, store.bubbles.last().approvals.single().state)
    }

    @Test fun queuedRepliesStayWithTheirMessages() = runBlocking {
        server.enqueue(turn("id: 1\ndata: {\"type\":\"done\"}\n\n", 700))
        server.enqueue(MockResponse().setResponseCode(409).setBody("{\"error\":\"the turn has ended\"}"))
        server.enqueue(MockResponse().setHeader("x-run-id", "run-2").setBody("data: {\"type\":\"done\"}\n\n"))
        server.enqueue(MockResponse().setHeader("x-run-id", "run-3").setBody("data: {\"type\":\"done\"}\n\n"))
        val store = store(this)
        store.draft.value = "hello"
        store.send()
        requests(1)
        delay(100)
        store.draft.value = "one"
        store.send()
        requests(2)
        delay(50)
        store.draft.value = "two"
        store.send()
        finished(store)
        assertEquals(listOf(true, false, true, false, true, false), store.bubbles.map { it.isUser })
        assertEquals(listOf("hello", "one", "two"), store.bubbles.filter { it.isUser }.map { it.text })
    }

    @Test fun aSteerFailureAfterANewChatDoesNotLandInIt() = runBlocking {
        server.enqueue(turn("id: 1\ndata: {\"type\":\"done\"}\n\n", 150))
        server.enqueue(MockResponse().setResponseCode(409).setHeadersDelay(700, TimeUnit.MILLISECONDS).setBody("{\"error\":\"the turn has ended\"}"))
        val store = store(this)
        store.draft.value = "hello"
        store.send()
        requests(1)
        delay(50)
        store.draft.value = "more"
        store.send()
        requests(2)
        finished(store)
        store.newChat()
        delay(900)
        assertTrue(store.bubbles.isEmpty())
        assertEquals(2, server.requestCount)
    }

    @Test fun imagesGoWithTheTurnAndAnImageOnlyMessageCanBeSent() = runBlocking {
        server.enqueue(done())
        val store = store(this)
        assertFalse(store.canSend)
        assertTrue(store.addImage(ChatImage("a.png", "image/png", byteArrayOf(1, 2, 3))))
        assertTrue(store.canSend)
        store.send()
        finished(store)
        assertTrue(store.images.isEmpty())
        assertEquals(1, store.bubbles.first().images.size)
        val body = server.takeRequest().body.readUtf8()
        assertTrue(body.contains("\"images\":[{"))
        assertTrue(body.contains("\"data\":\"AQID\""))
        // org.json writes a slash as `\/`.
        assertTrue(body.contains("\"mediaType\":\"image\\/png\"") || body.contains("\"mediaType\":\"image/png\""))
    }

    @Test fun aFifthImageIsRefused() = runBlocking {
        val store = store(this)
        repeat(4) { assertTrue(store.addImage(ChatImage("a.png", "image/png", byteArrayOf(1)))) }
        assertFalse(store.addImage(ChatImage("e.png", "image/png", byteArrayOf(1))))
        assertEquals(4, store.images.size)
    }

    @Test fun aQuestionIsAnsweredWithTheChosenLabels() = runBlocking {
        server.enqueue(turn(
            "id: 1\ndata: {\"type\":\"approval_request\",\"id\":\"q1\",\"tool\":\"AskUserQuestion\",\"title\":\"Which?\",\"questions\":[{\"id\":\"pick\",\"header\":\"\",\"question\":\"Which?\",\"options\":[{\"label\":\"A\",\"description\":\"\"}],\"multiSelect\":false}]}\n\n" +
                "id: 2\ndata: {\"type\":\"approval_resolved\",\"id\":\"q1\",\"decision\":\"allow\",\"answers\":{\"pick\":[\"A\"]}}\n\n" +
                "id: 3\ndata: {\"type\":\"done\"}\n\n",
            400,
        ))
        server.enqueue(MockResponse().setBody("{\"ok\":true}"))
        val store = store(this)
        store.draft.value = "hello"
        store.send()
        requests(1)
        delay(100)
        assertNull(store.answer("q1", allow = true, answers = mapOf("pick" to listOf("A"))))
        requests(2)
        finished(store)
        server.takeRequest()
        val answer = server.takeRequest().body.readUtf8()
        assertTrue(answer.contains("\"answers\":{\"pick\":[\"A\"]}"))
        val step = store.bubbles.last().steps.single()
        assertEquals(mapOf("pick" to listOf("A")), step.answers)
    }

    @Test fun anEarlierChatShowsItsToolCallsInOrder() = runBlocking {
        server.enqueue(MockResponse().setBody(
            """{"messages":[{"role":"user","text":"list"},{"role":"ai","text":"","tools":[],"steps":[{"kind":"tool","name":"Bash","input":"ls","output":"a","failed":false}]}]}""",
        ))
        val store = store(this)
        store.open(ChatSessionInfo("s"))
        assertEquals(2, store.bubbles.size)
        assertEquals(listOf(ChatStepKind.Tool), store.bubbles.last().steps.map { it.kind })
        assertEquals(listOf("Bash"), store.bubbles.last().tools)
        // A restored reply opens its runs of calls folded; the person's message is not a reply.
        assertTrue(store.bubbles.last().historic)
        assertFalse(store.bubbles.first().historic)
    }

    @Test fun aSettledTurnAsksForTheCatalogue() = runBlocking {
        server.enqueue(done())
        var settled = 0
        val store = ChatStore(SpaceApi(server.url("/").toUri(), CookieSource.none), "/agent", this) { settled += 1 }
        store.draft.value = "hello"
        store.send()
        finished(store)
        assertEquals(1, settled)
    }

    @Test fun aTurnFromUniversalSearchCarriesItsIntent() = runBlocking {
        server.enqueue(done())
        val store = store(this)
        store.draft.value = "today's news"
        store.send(intentID = "news", timezone = "Asia/Tokyo")
        finished(store)
        val body = server.takeRequest().body.readUtf8()
        assertTrue(body.contains("\"intentId\":\"news\""))
        assertTrue(body.contains("\"timezone\":\"Asia\\/Tokyo\"") || body.contains("\"timezone\":\"Asia/Tokyo\""))
    }
}
