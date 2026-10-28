package dev.aispace.android.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.net.URI
import java.nio.file.Files
import java.util.UUID

class CatalogueTests {
    private val space = URI("https://space.example.com/")

    @Test fun listsTheAppsAPersonCanOpen() {
        val c = Catalogue.decode(Fixture.payload())
        // Hidden, archived, page-less and malformed rows are left out; the rest keep the server's order.
        assertEquals(listOf("docs", "todo", "reader", "sleeper", "david/voice-studio"), c.apps.map { it.ref })
        assertEquals("app:docs", c.apps.map { it.key }.first())
        assertEquals(listOf("agent:space/assistant", "agent:todo/planner"), c.agents.map { it.key })
        assertEquals(listOf("todo/today", "reader/unread"), c.widgets.map { it.id })
        assertEquals(Fixture.fetchedAt, c.fetchedAt)
    }

    @Test fun saysHowReachableEachAppIs() {
        val c = Fixture.catalogue
        val reach = c.apps.associate { it.ref to it.reach }
        assertEquals(Reach.link, reach["docs"])
        assertEquals(Reach.up, reach["todo"])
        assertEquals(Reach.down, reach["reader"])
        assertEquals(Reach.paused, reach["sleeper"])
        // A stale snapshot wins over the health it recorded while the peer still answered.
        assertEquals(Reach.peerOffline, reach["david/voice-studio"])
        assertEquals(true, c.peers.firstOrNull()?.isOffline)
        assertEquals("2026-10-12T03:34:17.782Z", c.peer("david")?.asOf)
    }

    @Test fun aDownPeerMarksItsEntriesEvenWithoutTheStaleFlag() {
        val apps = Fixture.apps.replace("\"stale\":true,", "")
        val c = Catalogue.decode(Fixture.payload(apps = apps))
        assertEquals(Reach.peerOffline, c.app("voice-studio")?.reach)
    }

    @Test fun picksTheTitleOfTheLanguage() {
        val todo = Fixture.catalogue.app("todo")!!
        assertEquals("Todo", todo.displayTitle(lang = "en"))
        assertEquals("待办", todo.displayTitle(lang = "zh"))
        assertEquals("Todo", todo.displayTitle(lang = "fr"))
        assertEquals("任务与提醒。", todo.displayDetail(lang = "zh"))
        assertNull(Fixture.catalogue.app("docs")?.displayDetail(lang = "zh"))
    }

    @Test fun resolvesPagesAgainstTheSpace() {
        val c = Fixture.catalogue
        assertEquals("https://todo.example.com/?lang=zh", c.app("todo")?.pageURL(space, lang = "zh")?.toString())
        val path = CatalogueEntry(kind = EntryKind.app, ref = "wiki", title = "Wiki", link = "/wiki/", reach = Reach.link)
        assertEquals("https://space.example.com/wiki/", path.pageURL(space)?.toString())
        val script = CatalogueEntry(kind = EntryKind.app, ref = "x", title = "X", link = "javascript:alert(1)", reach = Reach.link)
        assertNull(script.pageURL(space))
        assertNull(c.agents[0].pageURL(space))
    }

    @Test fun readsTheHomeScreenAndTheDomain() {
        val c = Fixture.catalogue
        // As the panel shows them: a repeated key once (agent-groups.ts `canonicalItems`), a gone one kept.
        assertEquals(listOf("app:todo", "builtin:inbox", "agent:space/assistant", "widget:todo/today", "app:gone"), c.homePins)
        assertEquals(listOf("home", "s2"), c.screens?.map { it.id })
        assertEquals(listOf("app:docs"), c.screens?.last()?.items)
        assertEquals("example.com", c.domain)
        val bare = Catalogue.decode(
            Fixture.payload(peers = null, layout = "{\"ok\":true,\"layout\":{\"screens\":null}}", router = "{\"ok\":true,\"domain\":\"\"}"),
        )
        // A Space that has stored no screens yet shows the home screen its panel would seed.
        assertNull(bare.screens)
        assertEquals("app:docs", bare.homePins.first())
        assertTrue(bare.homePins.contains("builtin:inbox"))
        assertTrue(bare.homePins.contains("widget:todo/today"))
        assertNull(bare.domain)
        assertTrue(bare.peers.isEmpty())
    }

    @Test fun refusesAnAnswerThatIsNotASpace() {
        try {
            Catalogue.decode(Fixture.payload(apps = "<html>Sign in</html>"))
            fail()
        } catch (e: CatalogueError) {
            assertEquals(CatalogueError.NotASpace("/api/apps"), e)
        }
        try {
            Catalogue.decode(Fixture.payload(agents = "{\"ok\":false,\"error\":\"nope\"}"))
            fail()
        } catch (e: CatalogueError) {
            assertEquals(CatalogueError.NotASpace("/api/agents"), e)
        }
    }

    @Test fun findsAnAppByIdThenByName() {
        val c = Fixture.catalogue
        assertEquals("david/voice-studio", c.app("david/voice-studio")?.ref)
        assertEquals("david/voice-studio", c.app("voice-studio")?.ref)
        assertNull(c.app("nope"))
        assertEquals(EntryKind.widget, c.entry("widget:todo/today")?.kind)
    }

    @Test fun thePayloadSurvivesTheCache() {
        val dir = Files.createTempDirectory("aispace-cache").toFile()
        try {
            val cache = CatalogueCache(dir)
            val id = UUID.randomUUID()
            assertNull(cache.load(id))
            cache.save(Fixture.payload(), id)
            assertEquals(Fixture.payload(), cache.load(id))
            assertEquals(Fixture.catalogue, Catalogue.decode(cache.load(id)!!))
            cache.remove(id)
            assertNull(cache.load(id))
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test fun aWriteQueuedBeforeARemovalCannotBringTheCacheBack() {
        val dir = Files.createTempDirectory("aispace-cache").toFile()
        try {
            val cache = CatalogueCache(dir)
            val id = UUID.randomUUID()
            cache.saveInBackground(Fixture.payload(), id)
            cache.remove(id)
            assertNull(cache.load(id))
            cache.saveInBackground(Fixture.payload(), id)
            assertNotNull(cache.load(id))
        } finally {
            dir.deleteRecursively()
        }
    }
}

class CatalogueSearchTests {
    private val entries = Fixture.catalogue.entries

    private fun find(q: String) = CatalogueSearch.filter(entries, q).map { it.key }

    @Test fun matchesEnglishChineseAndId() {
        assertTrue(find("todo").contains("app:todo"))
        assertEquals(listOf("app:todo", "widget:todo/today"), find("待办"))
        assertEquals(listOf("app:david/voice-studio"), find("voice-studio"))
        assertEquals(listOf("app:david/voice-studio"), find("语音"))
        assertEquals(listOf("agent:space/assistant"), find("空间助手"))
    }

    @Test fun everyWordMustMatchAndCaseDoesNot() {
        assertEquals(listOf("widget:todo/today"), find("TODO today"))
        assertTrue(find("todo nothing").isEmpty())
        assertEquals(entries.size, find("  ").size)
        assertEquals(listOf("app:todo"), find("reminders"))
        // Full-width letters, as a Chinese keyboard may type them.
        assertTrue(find("ｔｏｄｏ").contains("app:todo"))
    }

    @Test fun diacriticsDoNotMatter() {
        assertEquals("todo", CatalogueSearch.fold("Tödo"))
        assertTrue(find("rèader").contains("app:reader"))
    }
}

class QuickActionTests {
    @Test fun theFirstAppsOfHomeBecomeActions() {
        val c = Fixture.catalogue
        val items = QuickAction.items(
            listOf("agent:space/assistant", "app:todo", "app:gone", "app:david/voice-studio", "app:docs", "app:reader", "app:sleeper"),
            c,
            lang = "zh",
        )
        assertEquals(listOf("待办", "语音工作室", "Bun 文档", "Reader"), items.map { it.title })
        assertEquals("david", items[1].subtitle)
        assertEquals("aispace://open?app=david/voice-studio", items[1].url.toString())
        // The link is what the deep-link handler reads back.
        assertEquals(DeepLink.Open("david/voice-studio"), DeepLink.parse(items[1].url))
        assertEquals(DeepLink.Open("a b&c"), DeepLink.parse(QuickAction.link("a b&c")!!))
    }

    @Test fun anActionNamesTheSpaceItWasMadeFor() {
        val space = UUID.randomUUID()
        val action = QuickAction.items(listOf("app:todo"), Fixture.catalogue).first()
        // Two Spaces may each have a "todo"; the shortcut item says which one it opens.
        val info = action.userInfo(space)
        assertEquals(QuickAction.Target(action.url, space), QuickAction.target(info))
        // An item published before the Space was carried still opens, in the Space on show.
        assertEquals(QuickAction.Target(action.url, null), QuickAction.target(mapOf("url" to "aispace://open?app=todo")))
        assertNull(QuickAction.target(mapOf("url" to "aispace://open?app=todo", "space" to "not a uuid"))?.space)
        assertNull(QuickAction.target(mapOf("space" to space.toString())))
        assertNull(QuickAction.target(null))
    }
}

class IconSourceTests {
    private val space = URI("https://space.example.com/")

    @Test fun theSpacesOwnIconsGoThroughItsSession() {
        assertEquals(IconSource.Space("/api/apps/todo/icon"), IconSource.of("/api/apps/todo/icon", space))
        assertEquals(IconSource.Space("https://space.example.com/assistant.svg"), IconSource.of("https://space.example.com/assistant.svg", space))
        assertEquals(IconSource.Space("HTTPS://SPACE.example.com:443/a.png"), IconSource.of("HTTPS://SPACE.example.com:443/a.png", space))
    }

    @Test fun anIconOnAnotherSiteIsNotTheSpaces() {
        val cdn = "https://cdn.example.net/todo.png"
        assertEquals(IconSource.External(URI(cdn)), IconSource.of(cdn, space))
        // Another app's hostname, another port and a scheme-relative address are other origins too.
        assertEquals(IconSource.External(URI("https://todo.example.com/icon.png")), IconSource.of("https://todo.example.com/icon.png", space))
        assertEquals(IconSource.External(URI("https://space.example.com:8443/a.png")), IconSource.of("https://space.example.com:8443/a.png", space))
        assertEquals(IconSource.External(URI(cdn)), IconSource.of("//cdn.example.net/todo.png", space))
        assertNull(IconSource.of("file:///etc/hosts", space))
    }

    /** Why the split exists: the Space's API reads a 200 from any other origin as "sign in". */
    @Test fun theSpaceAPIRefusesAnAnswerFromAnotherOrigin() {
        try {
            SpaceApi.check(200, URI("https://cdn.example.net/todo.png"), ByteArray(0), space)
            fail()
        } catch (e: SpaceApiError) {
            assertEquals(SpaceApiError.AuthenticationRequired, e)
        }
    }
}
