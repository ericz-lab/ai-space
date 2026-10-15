package dev.aispace.android.core

import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.ResponseBody
import okhttp3.Protocol
import okhttp3.EventListener
import okhttp3.Call
import okio.Buffer
import okio.ForwardingSource
import okio.buffer
import java.io.IOException
import java.util.concurrent.atomic.AtomicReference
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.net.URI
import java.util.concurrent.TimeUnit

class SpaceApiTests {
    private lateinit var server: MockWebServer
    private lateinit var base: URI

    @Before fun start() {
        server = MockWebServer()
        server.start()
        base = server.url("/").toUri()
    }

    @After fun stop() {
        server.shutdown()
    }

    private fun api(cookies: CookieSource = CookieSource.none) = SpaceApi(base, cookies)

    private fun origin() = base.toString().removeSuffix("/")

    private suspend fun failure(block: suspend () -> Unit): SpaceApiError? = try {
        block()
        null
    } catch (e: SpaceApiError) {
        e
    }

    @Test fun responseBodiesAreReadOffTheCallerThread() = runBlocking {
        val caller = Thread.currentThread()
        val reader = AtomicReference<Thread>()
        val client = OkHttpClient.Builder().addInterceptor { chain ->
            val source = object : ForwardingSource(Buffer().writeUtf8("answer")) {
                override fun read(sink: Buffer, byteCount: Long): Long {
                    reader.set(Thread.currentThread())
                    return super.read(sink, byteCount)
                }
            }.buffer()
            val body = object : ResponseBody() {
                override fun contentType() = null
                override fun contentLength() = 6L
                override fun source() = source
            }
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1)
                .code(200).message("OK").body(body).build()
        }.build()
        assertEquals("answer", SpaceApi(base, CookieSource.none, client).text("/api/apps"))
        assertTrue(reader.get() != null && reader.get() !== caller)
    }

    @Test fun cancellationClosesACallWhileItsBodyIsStillArriving() = runBlocking {
        val headers = CompletableDeferred<Unit>()
        val failed = CompletableDeferred<Unit>()
        val client = OkHttpClient.Builder().eventListener(object : EventListener() {
            override fun responseHeadersEnd(call: Call, response: Response) { headers.complete(Unit) }
            override fun callFailed(call: Call, ioe: IOException) { failed.complete(Unit) }
        }).build()
        server.enqueue(MockResponse().setBody("slow answer").setBodyDelay(2, TimeUnit.SECONDS))
        val pending = launch { SpaceApi(base, CookieSource.none, client).text("/api/apps") }
        withTimeout(1500) {
            headers.await()
            pending.cancelAndJoin()
            failed.await()
        }
        assertTrue(pending.isCancelled)
    }

    @Test fun aRedirectIsASignInAndIsNotFollowed() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(302).addHeader("Location", "https://team.cloudflareaccess.com/login"))
        assertEquals(SpaceApiError.AuthenticationRequired, failure { api().text("/api/apps") })
        assertEquals(1, server.requestCount)
    }

    @Test fun unauthorizedAndForbiddenAreASignIn() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(401))
        server.enqueue(MockResponse().setResponseCode(403).setBody("""{"ok":false,"error":"forbidden"}"""))
        assertEquals(SpaceApiError.AuthenticationRequired, failure { api().text("/api/apps") })
        assertEquals(SpaceApiError.AuthenticationRequired, failure { api().data("/api/apps/todo/icon") })
    }

    @Test fun otherFailuresCarryTheServersText() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"ok":false,"error":"bad agent"}"""))
        server.enqueue(MockResponse().setResponseCode(500).setBody("oops"))
        assertEquals(SpaceApiError.Http(400, "bad agent"), failure { api().send("POST", "/api/agents/x/chat", JSONObject()) })
        assertEquals(SpaceApiError.Http(500, "internal server error"), failure { api().text("/api/apps") })
    }

    @Test fun anAnswerOfAnotherShapeIsInvalid() = runBlocking {
        server.enqueue(MockResponse().setBody("[1,2]"))
        assertEquals(SpaceApiError.InvalidResponse, failure { api().get("/api/terminal", TerminalStatus) })
        server.enqueue(MockResponse().setBody("""{"ok":true,"enabled":true,"shell":"/bin/zsh"}"""))
        assertEquals("/bin/zsh", api().get("/api/terminal", TerminalStatus).shell)
    }

    @Test fun aWriteNamesTheSpacesOriginAndAReadDoesNot() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        api().send("PATCH", "/api/panel/tasks/t1/model", JSONObject().put("model", JSONObject.NULL))
        api().text("/api/tasks")
        val write = server.takeRequest(5, TimeUnit.SECONDS)!!
        assertEquals("PATCH", write.method)
        assertEquals(origin(), write.getHeader("Origin"))
        assertTrue(write.getHeader("Content-Type")!!.startsWith("application/json"))
        assertEquals("""{"model":null}""", write.body.readUtf8())
        val read = server.takeRequest(5, TimeUnit.SECONDS)!!
        assertNull(read.getHeader("Origin"))
        assertEquals("application/json", read.getHeader("Accept"))
    }

    @Test fun theProfilesCookiesGoWithEveryCall() = runBlocking {
        server.enqueue(MockResponse().setBody("{}"))
        server.enqueue(MockResponse().setBody("{}"))
        var asked: String? = null
        api(CookieSource { url -> asked = url; "CF_Authorization=abc" }).text("/api/apps")
        assertEquals("CF_Authorization=abc", server.takeRequest(5, TimeUnit.SECONDS)!!.getHeader("Cookie"))
        assertEquals(base.resolve("/api/apps").toString(), asked)

        val host = base.host
        val jar = CookieSource.fromCookies {
            listOf(StoredCookie("s", "1", host), StoredCookie("elsewhere", "2", "other.example.com"), StoredCookie("tls", "3", host, secure = true))
        }
        api(jar).text("/api/agents")
        // The server is plain HTTP: a secure cookie stays home.
        assertEquals("s=1", server.takeRequest(5, TimeUnit.SECONDS)!!.getHeader("Cookie"))
    }

    @Test fun theBareAnswerKeepsTheRoutesOwnStatus() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"ok":false,"error":"passphrase required"}"""))
        val answer = api().answer("POST", "/api/terminal/sessions", JSONObject().put("cols", 80), mapOf(TerminalRoute.passphraseHeader to "pw"))
        assertEquals(TerminalTicket.Passphrase("passphrase required"), TerminalTicket.read(answer.status, answer.body))
        val recorded = server.takeRequest(5, TimeUnit.SECONDS)!!
        assertEquals("pw", recorded.getHeader(TerminalRoute.passphraseHeader))
        assertEquals(origin(), recorded.getHeader("Origin"))
    }

    @Test fun anEventStreamCarriesItsRunAndMessages() = runBlocking {
        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "text/event-stream")
                .setHeader("x-run-id", "run-7")
                .setBody(": keepalive\n\nid: 1\ndata: {\"type\":\"system\"}\n\nid: 2\ndata: {\"type\":\"done\"}\n\n"),
        )
        val stream = api().events("POST", "/api/agents/space/assistant/chat", JSONObject().put("message", "hi"))
        assertEquals("run-7", stream.runId)
        assertEquals(
            listOf(SSEMessage(1, """{"type":"system"}"""), SSEMessage(2, """{"type":"done"}""")),
            stream.messages.toList(),
        )
        assertEquals("text/event-stream", server.takeRequest(5, TimeUnit.SECONDS)!!.getHeader("Accept"))
    }

    @Test fun anEventStreamThatDoesNotOpenThrows() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"ok":false,"error":"a run is active"}"""))
        assertEquals(SpaceApiError.Http(409, "a run is active"), failure { api().events("GET", "/api/agents/a/b/runs/x/events") })
    }

    @Test fun aSocketCarriesTheSessionAndTheSpacesOrigin() = runBlocking {
        val url = TerminalRoute.socket(TerminalMachine(name = "seoul"), "t", base)!!
        val request = api(CookieSource { "s=1" }).socketRequest(url)
        assertEquals(origin(), request.header("Origin"))
        assertEquals("s=1", request.header("Cookie"))
        assertTrue(url.toString().startsWith("ws://"))
    }

    @Test fun aNetworkFailureIsNotASignIn() {
        val dead = SpaceApi(URI("http://127.0.0.1:1/"), CookieSource.none)
        try {
            runBlocking { dead.text("/api/apps") }
            fail()
        } catch (e: java.io.IOException) {
            // expected: unreachable, not "sign in"
        }
    }
}
