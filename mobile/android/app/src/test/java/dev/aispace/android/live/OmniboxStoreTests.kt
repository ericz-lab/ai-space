package dev.aispace.android.live

import dev.aispace.android.core.CookieSource
import dev.aispace.android.core.Hub
import dev.aispace.android.core.JSONValue
import dev.aispace.android.core.ShortcutAction
import dev.aispace.android.core.SpaceApi
import dev.aispace.android.core.SpaceApiError
import dev.aispace.android.core.OmniboxTests
import kotlinx.coroutines.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.net.URI

class OmniboxStoreTests {
    private val api = SpaceApi(URI("https://space.example/"), CookieSource.none)

    @Test fun aTransportRetryKeepsTheOriginalRequestAndCannotSubmitTwice() = runBlocking {
        val action = Hub.decode(OmniboxTests.ACTION, ShortcutAction)
        val bodies = ArrayList<JSONObject>()
        val execution = ShortcutExecution(api, action, mapOf("title" to JSONValue.Str("Report")), this, send = { _, body ->
            bodies.add(body)
            if (bodies.size == 1) throw IOException("connection lost")
            """{"run":{"id":7,"title":"Report","status":"ok","effect":"write","createdAt":"2026-10-17T00:00:00.000Z"}}"""
        })
        execution.submit()
        execution.submit()
        while (execution.busy) delay(5)
        assertEquals(1, bodies.size)
        assertNotNull(execution.error)
        execution.values = execution.values + ("title" to "Changed after timeout")
        execution.submit()
        while (execution.busy) delay(5)
        assertEquals(2, bodies.size)
        assertEquals(bodies[0].getString("requestId"), bodies[1].getString("requestId"))
        assertEquals("Report", bodies[1].getJSONObject("args").getString("title"))
        assertEquals("seoul", bodies[1].getString("peer"))
        assertEquals(7L, execution.run?.id)
        assertFalse(execution.canSubmit)
    }

    @Test fun aRejectedCalendarInputCanBeCorrected() = runBlocking {
        val action = Hub.decode(OmniboxTests.ACTION, ShortcutAction)
        val execution = ShortcutExecution(api, action, mapOf("title" to JSONValue.Str("Report"), "date" to JSONValue.Str("invalid")), this, send = { _, _ ->
            throw SpaceApiError.Http(400, "Invalid date")
        })
        execution.submit()
        while (execution.busy) delay(5)
        assertFalse(execution.hasSubmitted)
        assertTrue(execution.canSubmit)
        assertNotNull(execution.error)
    }

    @Test fun aLateResolutionCannotReplaceNewText() = runBlocking {
        var firstStarted = false
        val store = OmniboxStore(api) { _, body ->
            val text = body.getString("text")
            if (text == "old") {
                firstStarted = true
                delay(350)
            }
            """{"intents":[],"agentIntents":[{"id":"$text","title":"$text","agent":"news/curator","available":true}],"ambiguous":false}"""
        }
        val old = launch { store.resolve("old") }
        while (!firstStarted) delay(5)
        store.resolve("new")
        old.join()
        assertEquals("new", store.resolvedText)
        assertEquals("new", store.resolution?.agentIntents?.first()?.id)
        assertFalse(store.resolving)
        store.resolve("")
        assertNull(store.resolution)
    }

    @Test fun cancellingDuringThePauseAsksNothing() = runBlocking {
        var calls = 0
        val store = OmniboxStore(api) { _, _ ->
            calls += 1
            "{}"
        }
        val job = launch { store.resolve("todo") }
        delay(20)
        job.cancelAndJoin()
        assertEquals(0, calls)
        assertNull(store.error)
    }

    @Test fun aCalculationIsPreviewedAtOnce() = runBlocking {
        val paths = ArrayList<String>()
        val store = OmniboxStore(api) { path, _ ->
            paths.add(path)
            if (path.endsWith("/resolve")) """{"intents":[{"kind":"calc","key":"calc","expression":"2+2"}],"agentIntents":[],"ambiguous":false}"""
            else """{"result":{"kind":"value","value":4,"text":"4"}}"""
        }
        store.resolve("2+2")
        assertEquals("4", store.preview?.text)
        store.resolve("2+2")
        assertEquals(listOf("/api/shortcuts/resolve", "/api/shortcuts/preview", "/api/shortcuts/resolve"), paths)
    }
}
