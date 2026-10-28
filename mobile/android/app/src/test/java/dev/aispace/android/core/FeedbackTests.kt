package dev.aispace.android.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FeedbackTests {
    private val settings = """
    {"ok":true,
     "settings":{"enabled":true,"appsDefault":false,"apps":{"todo":"on","reader":"maybe"},"mode":"later","machine":"","model":"claude/advanced","effort":"max","errors":false},
     "apps":[{"app":"todo","title":"Todo","zh":"待办","status":"active","enabled":true},{"app":"reader","title":"Reader","enabled":false},{"title":"no app"}],
     "peers":[
       {"name":"david","ok":true,"synced":false,"error":"timeout","apps":[{"app":"voice","title":"Voice","enabled":false}],"counts":{"later":2}},
       {"name":"lab","ok":false,"error":"fetch failed","synced":false,"apps":[]}
     ],
     "machines":[{"value":"","label":"hub"},{"value":"david","label":"david"}],
     "models":[{"value":"claude/advanced","runtime":"claude","tier":"advanced","model":"fable"},{"value":"codex/basic","runtime":"codex","tier":"basic","model":"luna","unavailable":"signed-out"}],
     "counts":{"later":3,"queued":0,"fixing":1},
     "shortcut":"Alt+Shift+F"}
    """.trimIndent()

    @Test fun readsTheSettingsTheAppsAndThePeers() {
        val v = Hub.decode(settings, FeedbackView)
        val s = v.settings
        assertTrue(s.enabled)
        assertFalse(s.appsDefault)
        // A value the button does not know is dropped: the app follows the default.
        assertEquals(mapOf("todo" to "on"), s.apps)
        assertEquals("later", s.mode)
        assertEquals("max", s.effort)
        assertFalse(s.errors)
        assertEquals(listOf("todo", "reader"), v.apps.map { it.app })
        assertEquals("待办", v.appTitle("todo", lang = "zh"))
        assertEquals("Voice", v.appTitle("voice", peer = "david"))
        assertEquals("gone", v.appTitle("gone"))
        assertEquals(listOf("david", "lab"), v.peers.map { it.name })
        assertEquals(2, v.peers[0].later)
        assertFalse(v.peers[1].ok)
        assertEquals(3, v.later)
        assertEquals("signed-out", v.models[1].unavailable)
        assertEquals(listOf("", "david"), v.machines.map { it.value })
    }

    @Test fun anOlderSpaceWithoutPeersOrNewFieldsStillReads() {
        val v = Hub.decode("""{"settings":{"effort":"ultra"},"apps":[]}""", FeedbackView)
        assertFalse(v.settings.enabled)
        assertTrue(v.settings.appsDefault)
        assertEquals("auto", v.settings.mode)
        assertEquals("xhigh", v.settings.effort)
        assertTrue(v.peers.isEmpty())
        assertEquals(0, v.later)
    }

    @Test fun aPatchShowsAtOnceTheWayTheSpaceAppliesIt() {
        val v = Hub.decode(settings, FeedbackView)
        // The default turned on: reader, without its own choice, now shows the button; so do the peer's apps that answer.
        val on = v.withPatch(FeedbackPatch(appsDefault = true))
        assertEquals(listOf(true, true), on.apps.map { it.enabled })
        assertEquals(listOf(true), on.peers[0].apps.map { it.enabled })
        // "default" drops todo's own choice: with the default off it hides.
        val dropped = v.withPatch(FeedbackPatch(apps = mapOf("todo" to "default")))
        assertNull(dropped.settings.apps["todo"])
        assertEquals(listOf(false, false), dropped.apps.map { it.enabled })
        // The main switch off hides everything.
        assertEquals(listOf(false, false), v.withPatch(FeedbackPatch(enabled = false)).apps.map { it.enabled })
        assertEquals("""{"apps":{"todo":"default"}}""", FeedbackPatch(apps = mapOf("todo" to "default")).toJson().toString())
        assertEquals("""{"model":""}""", FeedbackPatch(model = "").toJson().toString())
    }

    @Test fun readsRecentFeedbackAndWhatCanBeFixed() {
        val rows = Hub.rows(
            "items",
            """{"ok":true,"items":[
              {"id":4,"peer":"","app":"todo","text":"Button overlaps","status":"later","todoId":12,"todoPeer":"","todoUrl":"https://todo.example.com/t/12","runId":null,"runMachine":"","note":null,"createdAt":1761500000000},
              {"id":3,"peer":"david","app":"voice","text":"Crash","status":"failed","todoId":7,"note":"tests failed\nmore","runMachine":"david","createdAt":1761400000000},
              {"id":2,"app":"todo","text":"Nice","status":"accepted","todoId":5},
              {"id":1,"app":"todo","text":"Odd","status":"brand-new","todoId":null},
              {"app":"no id","status":"later"}
            ]}""",
            FeedbackItem,
        )
        assertEquals(listOf("-4", "david-3", "-2", "-1"), rows.map { it.key })
        assertNull(rows[0].peer)
        assertNull(rows[0].runMachine)
        assertEquals(listOf(true, true, false, false), rows.map { it.canFix })
        assertEquals("tests failed", rows[1].reason)
        assertNull(rows[0].reason)
        // A status this client does not know is kept as it came.
        assertEquals("brand-new", rows[3].status)
        assertFalse(rows.any { it.isMoving })
        assertEquals("""{"peer":"david","ids":[3]}""", Feedback.fixBody("david", listOf(3)).toString())
        assertEquals("{}", Feedback.fixBody().toString())
    }
}
