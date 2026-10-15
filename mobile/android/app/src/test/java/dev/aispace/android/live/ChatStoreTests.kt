package dev.aispace.android.live

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
}
