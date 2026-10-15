package dev.aispace.android.core

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.net.URI
import java.nio.file.Files
import java.time.Instant

/** The tests of the Mac client's shared Foundation files (desktop/macos/AISpaceTests). */

class ChatStreamTests {
    @Test fun parsesTheRunStream() {
        val p = SSEParser()
        assertNull(p.feed(": keepalive"))
        assertNull(p.feed("id: 7"))
        assertEquals(SSEMessage(7, """{"type":"done"}"""), p.feed("""data: {"type":"done"}"""))
        assertEquals(SSEMessage(null, "no-space"), p.feed("data:no-space"))
        assertNull(p.feed("event: other"))
    }

    @Test fun buildsAReplyFromClaudeStyleEvents() {
        var r = ChatReply()
        r = r.applying("""{"type":"system","subtype":"init","session_id":"s1","model":"sol"}""")
        assertTrue(r.sessionID == "s1" && r.activity == ChatActivity.Thinking("sol"))
        r = r.applying("""{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}}""")
        r = r.applying("""{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}}""")
        assertTrue(r.text == "Hello" && r.activity == null)
        r = r.applying("""{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"},{"type":"tool_use","id":"t1","name":"Bash","input":{}}]}}""")
        r = r.applying("""{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{}}]}}""")
        assertTrue(r.text == "Hello" && r.tools == listOf("Bash") && r.activity == ChatActivity.Running("Bash"))
        r = r.applying("""{"type":"assistant","message":{"content":[{"type":"text","text":"Done."}]}}""")
        r = r.applying("""{"type":"result","session_id":"s2"}""")
        r = r.applying("""{"type":"done"}""")
        assertTrue(r.text == "Hello\n\nDone." && r.sessionID == "s2" && r.finished)
    }

    @Test fun errorsAndStops() {
        val r = ChatReply().applying("""{"type":"error","error":"timeout","status":"timeout"}""")
        assertEquals("⚠️ timeout", r.text)
        val s = ChatReply().applying("""{"type":"error","error":"stopped","status":"stopped"}""")
        assertTrue(s.stopped && s.text.isEmpty())
        val junk = ChatReply().applying("not json")
        assertEquals(ChatReply(), junk)
    }
}

class ConnectionRulesTests {
    @Test fun loopbackHosts() {
        for (host in listOf("127.0.0.1", "127.1.2.3", "localhost", "LOCALHOST", "::1", "[::1]")) {
            assertTrue(host, ConnectionRules.isLoopback(host))
        }
        for (host in listOf("127.example.com", "128.0.0.1", "10.0.0.1", "127.0.0", "127.0.0.256", "space.example.com", "")) {
            assertFalse(host, ConnectionRules.isLoopback(host))
        }
    }

    @Test fun defaultsTheSchemeByHost() {
        assertEquals("http://127.0.0.1:8700/", ConnectionRules.normalize("127.0.0.1:8700").toString())
        assertEquals("http://localhost:8700/", ConnectionRules.normalize("localhost:8700/").toString())
        assertEquals("https://space.example.com/", ConnectionRules.normalize(" space.example.com ").toString())
    }

    @Test fun dropsQueryAndFragmentAndLowercasesHost() {
        assertEquals("https://space.example.com/panel", ConnectionRules.normalize("HTTPS://Space.Example.com/panel?lang=zh#chat").toString())
    }

    private fun refused(input: String): ConnectionUrlError? = try {
        ConnectionRules.normalize(input)
        null
    } catch (e: ConnectionUrlException) {
        e.error
    }

    @Test fun refusesUnsafeAddresses() {
        assertEquals(ConnectionUrlError.empty, refused("  "))
        assertEquals(ConnectionUrlError.insecureRemote, refused("http://space.example.com"))
        assertEquals(ConnectionUrlError.insecureRemote, refused("http://192.168.1.5:8700"))
        assertEquals(ConnectionUrlError.credentials, refused("https://op:secret@space.example.com"))
        assertEquals(ConnectionUrlError.unsupportedScheme, refused("file:///Users/me"))
        assertEquals(ConnectionUrlError.unsupportedScheme, refused("ftp://space.example.com"))
    }

    @Test fun sameOriginUsesEffectivePorts() {
        assertTrue(ConnectionRules.sameOrigin(URI("https://a.example.com/x"), URI("https://A.example.com:443/")))
        assertTrue(ConnectionRules.sameOrigin(URI("http://127.0.0.1:8700/api"), URI("http://127.0.0.1:8700/")))
        assertFalse(ConnectionRules.sameOrigin(URI("http://127.0.0.1:8700/"), URI("http://127.0.0.1:8701/")))
        assertFalse(ConnectionRules.sameOrigin(URI("http://a.example.com/"), URI("https://a.example.com/")))
        assertFalse(ConnectionRules.sameOrigin(URI("https://a.example.com/"), URI("https://b.example.com/")))
    }

    @Test fun theOriginOfAnAddress() {
        assertEquals("https://space.example.com/", ConnectionRules.origin(URI("https://space.example.com/panel?x=1"))?.toString())
        assertEquals("http://127.0.0.1:8700", ConnectionRules.originHeader(URI("http://127.0.0.1:8700/api/apps")))
        assertEquals("http://[::1]:8700/", ConnectionRules.origin(URI("http://[::1]:8700/x"))?.toString())
    }
}

class ConnectionStoreTests {
    private val dir: File = Files.createTempDirectory("ai-space-tests").toFile()
    private val file = File(dir, "connections.json")

    @After fun cleanUp() {
        dir.deleteRecursively()
    }

    @Test fun firstConnectionBecomesDefaultAndPersists() {
        val store = ConnectionStore(file)
        val a = store.add("  ", URI("http://127.0.0.1:8700/"))
        val b = store.add("Seoul", URI("https://seoul.example.com/"))
        assertEquals("127.0.0.1", a.name)
        assertEquals(a.id, store.defaultConnection?.id)

        store.setDefault(b.id)
        val reread = ConnectionStore(file)
        assertEquals(listOf(a.id, b.id), reread.connections.value.map { it.id })
        assertEquals(listOf(b.id), reread.connections.value.filter { it.isDefault }.map { it.id })
    }

    @Test fun removingTheDefaultPromotesAnother() {
        val store = ConnectionStore(file)
        val a = store.add("Local", URI("http://127.0.0.1:8700/"))
        val b = store.add("Seoul", URI("https://seoul.example.com/"))
        store.remove(a.id)
        assertEquals(listOf(b.id), store.connections.value.map { it.id })
        assertTrue(store.defaultConnection?.id == b.id && store.connections.value[0].isDefault)
        store.remove(b.id)
        assertNull(store.defaultConnection)
    }

    @Test fun updateKeepsIdentity() {
        val store = ConnectionStore(file)
        val a = store.add("Local", URI("http://127.0.0.1:8700/"))
        store.update(a.id, "Mac", URI("http://127.0.0.1:8799/"))
        assertEquals("Mac", store.connection(a.id)?.name)
        assertEquals(8799, store.connection(a.id)?.url?.port)
    }

    @Test fun unreadableFileIsSetAsideNotOverwritten() {
        file.writeText("not json")
        val store = ConnectionStore(file)
        assertTrue(store.connections.value.isEmpty())
        val aside = store.loadError ?: return fail("the file was not set aside")
        assertEquals("not json", File(aside).readText())
    }
}

class DesktopRulesTests {
    private fun item(thread: String, lastAt: String, unread: Boolean = true, done: Boolean = false) =
        InboxItem(thread = thread, app = "todo", level = "info", title = null, text = "x", url = null, count = 1, lastAt = lastAt, unread = unread, done = done)

    @Test fun firstLookOnlyRecords() {
        val seen = InboxSeen()
        assertTrue(seen.fresh(listOf(item("a", "1"), item("b", "1"))).isEmpty())
        assertEquals(listOf("b", "c"), seen.fresh(listOf(item("a", "1"), item("b", "2"), item("c", "1"), item("d", "1", unread = false))).map { it.thread })
        assertTrue(seen.fresh(listOf(item("a", "1"), item("b", "2"))).isEmpty())
        assertEquals(seen, InboxSeen.from(seen.toJson()))
    }

    private val space = URI("https://space.example.com/")

    private fun app(name: String, url: String) = AppInfo(id = name, name = name, title = name, url = url)

    @Test fun linksFindTheirApp() {
        val apps = listOf(app("todo", "https://todo.example.com/?lang={lang}"), app("notes", "/apps/notes/"), app("none", ""))
        assertEquals("todo", AppRoutes.app(URI("https://todo.example.com/task/3"), apps, space)?.name)
        assertEquals("notes", AppRoutes.app(URI("https://space.example.com/apps/notes/x"), apps, space)?.name)
        assertNull(AppRoutes.app(URI("https://space.example.com/settings"), apps, space))
        assertNull(AppRoutes.app(URI("https://github.com/x"), apps, space))
        assertEquals("https://todo.example.com/?lang=zh", apps[0].pageURL(space, lang = "zh")?.toString())
    }

    @Test fun deepLinksNeverSend() {
        assertEquals(DeepLink.Chat("ai-todo/planner", "hi"), DeepLink.parse("aispace://chat?agent=ai-todo/planner&text=hi"))
        assertEquals(DeepLink.Chat(null, null), DeepLink.parse("aispace://chat"))
        assertEquals(DeepLink.Open("ai-todo"), DeepLink.parse("aispace://open?app=ai-todo"))
        assertNull(DeepLink.parse("aispace://open"))
        assertEquals(DeepLink.Inbox, DeepLink.parse("aispace://inbox"))
        assertNull(DeepLink.parse("aispace://run?cmd=rm"))
        assertNull(DeepLink.parse("https://chat"))
        assertEquals(DeepLink.Show, DeepLink.parse("aispace://show"))
        assertEquals(DeepLink.Show, DeepLink.parse("aispace://"))
        assertEquals(20_000, (DeepLink.parse("aispace://chat?text=" + "x".repeat(30_000)) as DeepLink.Chat).text?.length)
    }

    @Test fun cookiesFollowDomainPathAndSecurity() {
        fun cookie(name: String, domain: String, path: String = "/", secure: Boolean = false, expires: Instant? = null) =
            StoredCookie(name, "v", domain, path, secure, expires)
        val all = listOf(
            cookie("host", "space.example.com"),
            cookie("wide", ".example.com"),
            cookie("other", "todo.example.com"),
            cookie("api", "space.example.com", path = "/api"),
            cookie("old", "space.example.com", expires = Instant.now().minusSeconds(60)),
            cookie("tls", "space.example.com", secure = true),
        )
        fun names(url: String) = Cookies.matching(all, URI(url)).map { it.name }.toSet()
        assertEquals(setOf("host", "wide", "api", "tls"), names("https://space.example.com/api/apps"))
        assertEquals(setOf("host", "wide", "tls"), names("https://space.example.com/"))
        assertEquals(setOf("host", "wide"), names("http://space.example.com/apix"))
        assertEquals(setOf("wide"), names("https://example.com/"))
        assertEquals("host=v; wide=v; tls=v", Cookies.header(URI("https://space.example.com/"), all))
        assertNull(Cookies.header(URI("https://elsewhere.org/"), all))
    }

    private fun checked(status: Int, url: String = "https://space.example.com/api/apps", body: String = ""): SpaceApiError? = try {
        SpaceApi.check(status, URI(url), body, URI("https://space.example.com/"))
        null
    } catch (e: SpaceApiError) {
        e
    }

    @Test fun responsesMapToErrors() {
        assertNull(checked(200))
        assertEquals(SpaceApiError.AuthenticationRequired, checked(302))
        assertEquals(SpaceApiError.AuthenticationRequired, checked(403))
        assertEquals(SpaceApiError.AuthenticationRequired, checked(200, "https://team.cloudflareaccess.com/login"))
        assertEquals(SpaceApiError.Http(400, "bad agent"), checked(400, body = """{"ok":false,"error":"bad agent"}"""))
        assertEquals(SpaceApiError.Http(404, "not found"), checked(404, body = "Not Found"))
    }

    @Test fun manifestTextFollowsTheLanguage() {
        val i18n: I18n = mapOf("zh" to LocalizedText(title = "待办"), "ja-JP" to LocalizedText(title = "やること"))
        assertEquals("待办", Lang.pick("Todo", i18n, Lang.title, lang = "zh"))
        assertEquals("やること", Lang.pick("Todo", i18n, Lang.title, lang = "ja"))
        assertEquals("Todo", Lang.pick("Todo", i18n, Lang.title, lang = "en"))
        assertEquals("Todo", Lang.pick("Todo", null, Lang.title, lang = "zh"))
        assertEquals("zh", Lang.primary("zh-Hans-CN"))
        assertNotEquals("", Lang.current)
    }
}

class NavigationPolicyTests {
    private val panel = URI("https://space.example.com/")

    private fun decide(
        url: String,
        mainFrame: Boolean = true,
        link: Boolean = false,
        newWindow: Boolean = false,
        download: Boolean = false,
        fromPanel: Boolean = true,
    ) = NavigationPolicy.decide(NavigationRequest(URI(url), mainFrame, link, newWindow, download, fromPanel), panel)

    @Test fun panelPagesStayInTheWindow() {
        assertEquals(NavigationDecision.allow, decide("https://space.example.com/?lang=zh"))
        assertEquals(NavigationDecision.allow, decide("https://space.example.com/settings", link = true))
        assertEquals(NavigationDecision.allow, decide("about:blank"))
    }

    @Test fun linksAndNewWindowsGoToTheBrowser() {
        assertEquals(NavigationDecision.openExternally, decide("https://todo.space.example.com/", link = true))
        assertEquals(NavigationDecision.openExternally, decide("https://github.com/ericz-lab/ai-space", newWindow = true))
        assertEquals(NavigationDecision.openExternally, decide("https://space.example.com/apps/x", newWindow = true))
        assertEquals(NavigationDecision.openExternally, decide("mailto:op@example.com", link = true))
    }

    @Test fun signInRedirectsStayInTheWindow() {
        // The access layer redirects the main frame to its login origin, then back.
        assertEquals(NavigationDecision.allow, decide("https://team.cloudflareaccess.com/cdn-cgi/access/login"))
        // Taps on the login page (an identity provider button) belong to the sign-in flow.
        assertEquals(NavigationDecision.allow, decide("https://accounts.example.org/o/oauth2", link = true, fromPanel = false))
    }

    @Test fun framesLoadButNeverEscalate() {
        assertEquals(NavigationDecision.allow, decide("https://widget.example.net/card", mainFrame = false))
        assertEquals(NavigationDecision.cancel, decide("javascript:alert(1)", mainFrame = false))
        assertEquals(NavigationDecision.cancel, decide("x-other-app://open"))
    }

    @Test fun downloads() {
        assertEquals(NavigationDecision.download, decide("blob:https://space.example.com/1234", download = true))
        assertEquals(NavigationDecision.download, decide("https://space.example.com/api/backups/1", download = true))
        assertEquals(NavigationDecision.openExternally, decide("https://files.example.net/a.zip", download = true))
        assertEquals(NavigationDecision.cancel, decide("file:///etc/hosts", download = true))
    }
}

class SpaceCheckTests {
    @Test fun aSpaceAnswerIsReady() {
        val body = """{"ok":true,"layout":{"order":[],"hidden":[]}}"""
        assertEquals(SpaceState.Ready, SpaceCheck.classify(200, "application/json;charset=utf-8", body))
        assertEquals(SpaceState.Ready, SpaceCheck.classifyScriptResult(listOf(200, "application/json", body)))
        assertEquals(SpaceState.Ready, SpaceCheck.classifyScriptResult(org.json.JSONArray().put(200).put("application/json").put(body).toString()))
    }

    @Test fun aReachablePortAloneIsNotReady() {
        assertNotEquals(SpaceState.Ready, SpaceCheck.classify(200, "text/html", "<html>"))
        assertNotEquals(SpaceState.Ready, SpaceCheck.classify(200, "application/json", """{"ok":true}"""))
        assertEquals(SpaceState.Incompatible("HTTP 404"), SpaceCheck.classify(404, "text/plain", "Not Found"))
        assertNotEquals(SpaceState.Ready, SpaceCheck.classifyScriptResult("garbage"))
    }

    @Test fun accessLayerAnswersMeanSignIn() {
        for (status in listOf(0, 302, 401, 403)) {
            assertEquals(SpaceState.AuthenticationRequired, SpaceCheck.classify(status, "", ""))
        }
    }

    @Test fun networkErrors() {
        assertEquals(true, SpaceCheck.classifyError(-6, "net::ERR_CONNECTION_REFUSED")?.isFailure)
        assertNull(SpaceCheck.classifyError(-1, "net::ERR_ABORTED"))
    }
}
