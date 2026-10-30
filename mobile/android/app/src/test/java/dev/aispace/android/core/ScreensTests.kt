package dev.aispace.android.core

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.UUID

class ScreensTests {
    private val screens = listOf(
        PanelScreen(id = "home", items = listOf("app:todo", "builtin:inbox", "agent:space/assistant", "widget:todo/today", "app:docs")),
        PanelScreen(id = "s1", items = listOf("app:reader")),
    )

    @Test fun pinsOnceAndUnpinsFromOneScreenOnly() {
        var s = Screens.pin(screens, "s1", "app:todo")
        s = Screens.pin(s, "s1", "app:todo")
        assertEquals(listOf("app:reader", "app:todo"), s[1].items)
        assertTrue(Screens.isPinned(s, "s1", "app:todo"))
        s = Screens.unpin(s, "home", "app:todo")
        assertFalse(Screens.isPinned(s, "home", "app:todo"))
        assertTrue(Screens.isPinned(s, "s1", "app:todo"))
        assertEquals(screens, Screens.pin(screens, "nowhere", "app:todo"))
    }

    @Test fun reordersAGroupAndLeavesTheRestInPlace() {
        // The tiles move among themselves; the built-in tile and the widget between them stay put.
        val tiles = listOf("app:todo", "agent:space/assistant", "app:docs")
        val s = Screens.reorder(screens, "home", tiles, listOf("app:docs", "app:todo", "agent:space/assistant"))
        assertEquals(listOf("app:docs", "builtin:inbox", "app:todo", "widget:todo/today", "agent:space/assistant"), s[0].items)
        // An order that is not the same entries changes nothing.
        assertEquals(screens, Screens.reorder(screens, "home", tiles, listOf("app:docs", "app:todo")))
        assertEquals(screens, Screens.reorder(screens, "home", tiles, listOf("app:docs", "app:todo", "app:other")))
    }

    @Test fun addsAScreenWithAFreshIdUpToTheLimit() {
        val made = Screens.add(screens)!!
        assertEquals("s2", made.id)
        assertEquals(PanelScreen(id = "s2"), made.screens.last())
        // An id in use is passed over.
        val taken = Screens.add(screens + PanelScreen(id = "s3"))!!
        assertEquals("s4", taken.id)
        val full = (0 until Screens.limit).map { PanelScreen(id = if (it == 0) "home" else "s$it") }
        assertNull(Screens.add(full))
    }

    @Test fun homeCannotBeRemoved() {
        assertEquals(screens, Screens.remove(screens, "home"))
        assertEquals(listOf("home"), Screens.remove(screens, "s1").map { it.id })
    }

    @Test fun seedsTheHomeScreenAsThePanelDoes() {
        val apps = (1..10).map { "a$it" }
        val s = Screens.seed(apps, listOf("x/one"), listOf("x/w"))
        assertTrue(s.size == 1 && s[0].id == "home")
        assertEquals(
            (1..8).map { "app:a$it" } + listOf("builtin:inbox", "builtin:terminal", "builtin:settings", "agent:x/one", "widget:x/w"),
            s[0].items,
        )
    }

    @Test fun decodesAScreenWithoutANameOrItems() {
        assertEquals(PanelScreen(id = "s9"), Json.decode("""{"id":"s9"}""", PanelScreen))
    }

    @Test fun titlesFollowThePosition() {
        assertEquals("Main", Screens.title(0, "en"))
        assertEquals("Screen 3", Screens.title(2, "en"))
        assertEquals("主屏", Screens.title(0, "zh"))
        assertEquals("屏幕 2", Screens.title(1, "zh"))
    }
}

class ScreenStoreTests {
    private val dir: File = Files.createTempDirectory("aispace-screens").toFile()
    private val file = File(dir, "screens.json")
    private val a = UUID.randomUUID()
    private val b = UUID.randomUUID()
    private val panel = listOf(
        PanelScreen(id = "home", items = listOf("app:todo", "builtin:inbox", "agent:space/assistant", "app:todo", "widget:todo/today", "app:gone")),
        PanelScreen(id = "s2", items = listOf("app:docs", "builtin:terminal")),
    )

    @After fun cleanUp() {
        dir.deleteRecursively()
    }

    @Test fun copiesThePanelOnceAndKeepsItsOwnFromThenOn() {
        val store = ScreenStore(file)
        assertEquals(listOf(PanelScreen(id = "home")), store.screens(a))
        store.seed(a, panel)
        // Built-in tiles are the panel's own windows; a pin whose entry is gone is kept for when it returns.
        assertEquals(
            listOf(
                PanelScreen(id = "home", items = listOf("app:todo", "agent:space/assistant", "widget:todo/today", "app:gone")),
                PanelScreen(id = "s2", items = listOf("app:docs")),
            ),
            store.screens(a),
        )
        // The panel changes later; the phone does not follow.
        store.seed(a, listOf(PanelScreen(id = "home", items = listOf("app:reader"))))
        assertEquals("app:todo", store.screens(a).first().items.first())
        assertEquals(store.screens(a), ScreenStore(file).screens(a))
    }

    @Test fun aPanelWithNothingPinnedIsNotCopiedYet() {
        val store = ScreenStore(file)
        store.seed(a, listOf(PanelScreen(id = "home", items = listOf("builtin:inbox"))))
        store.seed(a, panel)
        assertEquals(2, store.screens(a).size)
    }

    @Test fun aLayoutMadeByHandIsNotOverwritten() {
        val store = ScreenStore(file)
        store.edit(a) { Screens.pin(it, Screens.home, "app:notes") }
        store.seed(a, panel)
        assertEquals(listOf(PanelScreen(id = "home", items = listOf("app:notes"))), store.screens(a))
        assertTrue(store.isPinned("app:notes", a))
        assertFalse(store.isPinned("app:notes", b))
    }

    @Test fun resetTakesThePanelAsItIsNow() {
        val store = ScreenStore(file)
        store.edit(a) { Screens.pin(it, Screens.home, "app:notes") }
        store.reset(a, panel)
        assertEquals(listOf("home", "s2"), store.screens(a).map { it.id })
        assertFalse(store.isPinned("app:notes", a))
    }

    @Test fun eachSpaceHasItsOwnScreensAndHomeAlwaysStays() {
        val store = ScreenStore(file)
        store.seed(a, panel)
        store.edit(b) { listOf(PanelScreen(id = "s1", items = listOf("app:reader")), PanelScreen(id = "s1")) }
        assertEquals(listOf(PanelScreen(id = "home"), PanelScreen(id = "s1", items = listOf("app:reader"))), store.screens(b))
        store.forget(a)
        assertEquals(listOf(PanelScreen(id = "home")), store.screens(a))
        assertEquals(2, ScreenStore(file).screens(b).size)
    }

    @Test fun changesArePublished() {
        val store = ScreenStore(file)
        store.seed(a, panel)
        assertEquals(store.screens(a), store.records.value[a.toString().uppercase()]?.screens)
    }

    // The Mac's ScreenLayoutTests: the panel is copied once, then edits stay on this device.

    @Test fun panelIsCopiedOnceThenEditsStayOnThisDevice() {
        val store = ScreenStore(file)
        store.seed(a, listOf(PanelScreen(Screens.home, "", listOf("app:notes", "builtin:inbox"))))
        assertEquals(listOf("app:notes"), store.screens(a).first().items)

        store.edit(a) { Screens.pin(it, Screens.home, "agent:space/assistant") }
        // A later catalogue does not overwrite what was changed here.
        store.seed(a, listOf(PanelScreen(Screens.home, "", listOf("app:todo"))))
        val reread = ScreenStore(file)
        assertEquals(listOf("app:notes", "agent:space/assistant"), reread.screens(a).first().items)
    }

    @Test fun emptyPanelDoesNotCountAsALayout() {
        val store = ScreenStore(file)
        store.seed(a, listOf(PanelScreen(Screens.home, "", emptyList())))
        store.seed(a, listOf(PanelScreen(Screens.home, "", listOf("app:notes"))))
        assertEquals(listOf("app:notes"), store.screens(a).first().items)
    }
}

class WidgetBlocksTests {
    private val widgets = """
    {"ok":true,"widgets":[{"id":"btc/ind","app":"btc","name":"ind","title":"Indicators","kind":"items","size":"2x1","ok":true,"items":[],
      "asOf":"2026-10-13T02:00:00.000Z","staleAfterMs":600000,"blocks":[
      {"type":"gauge","label":{"en":"Fear & Greed","zh":"恐贪指数"},"value":57,"min":0,"max":100,"display":"57 Greed","zones":[{"to":25,"tone":"negative"},{"to":45,"tone":"warning"},{"to":55,"tone":"neutral"},{"to":100,"tone":"positive"}]},
      {"type":"trend","label":"ETF flow","style":"bar","signed":true,"format":"currency","points":[{"t":"2026-10-10","v":120000000},{"t":"2026-10-11","v":null},{"t":"2026-10-12","v":-2500000}]},
      {"type":"metric","label":"Open interest","value":221886,"unit":"BTC","decimals":0,"delta":{"value":0.1,"format":"percent"}},
      {"type":"hologram","label":"From a newer server","value":1},
      {"type":"progress","label":"Reading","value":50,"max":100,"format":"percent"},
      {"type":"status","label":"Feed","value":{"en":"Live"},"tone":"positive","time":"2026-10-13T01:59:00Z"},
      {"type":"metric","label":"Missing","value":null}
    ]}]}
    """.trimIndent()

    private val blocks: List<WidgetBlock>
        get() = runCatching { Catalogue.decode(Fixture.payload(widgets = widgets)) }.getOrNull()?.widgets?.firstOrNull()?.blocks ?: emptyList()

    @Test fun decodesTheBlocksItKnowsAndSkipsTheRest() {
        assertEquals(
            listOf(WidgetBlock.Kind.gauge, WidgetBlock.Kind.trend, WidgetBlock.Kind.metric, WidgetBlock.Kind.progress, WidgetBlock.Kind.status, WidgetBlock.Kind.metric),
            blocks.map { it.type },
        )
        assertEquals("恐贪指数", blocks[0].label.text(lang = "zh"))
        assertEquals("Fear & Greed", blocks[0].label.text(lang = "fr"))
    }

    @Test fun decodesTanksWithTheirLevels() {
        val widgets = """
        {"ok":true,"widgets":[{"id":"r2/usage","app":"r2","name":"usage","title":"Usage","kind":"items","size":"2x1","ok":true,"items":[],"blocks":[
          {"type":"tanks","label":"Nearest 10 GB","tanks":[
            {"label":"a","value":7.5,"max":10,"display":"7.5 GB","tone":"warning"},
            {"label":"b","value":12,"max":10,"tone":"negative"},
            {"label":"c","value":null,"max":10}]}
        ]}]}
        """.trimIndent()
        val block = Catalogue.decode(Fixture.payload(widgets = widgets)).widgets.first().blocks!!.first()
        assertEquals(WidgetBlock.Kind.tanks, block.type)
        assertEquals(null, block.shown(lang = "en"))
        val tanks = block.tanks!!
        assertEquals(3, tanks.size)
        assertEquals("7.5 GB", tanks[0].shown(lang = "en"))
        assertEquals(BlockTone.warning, tanks[0].tone)
        assertEquals(1.2, tanks[1].level, 1e-9)
        assertEquals("120%", tanks[1].shown(lang = "en"))
        assertEquals(0.0, tanks[2].level, 1e-9)
        assertEquals(null, tanks[2].shown(lang = "en"))
    }

    @Test fun leadsWithTheValueAsThePanelWritesIt() {
        val blocks = blocks
        assertEquals("57 Greed", blocks[0].shown(lang = "en"))
        assertEquals(BlockTone.positive, blocks[0].effectiveTone)
        assertEquals(0.57, blocks[0].position(57.0), 0.0)
        // The last point that has a value, signed, large amounts abbreviated.
        assertEquals("-$2.5M", blocks[1].shown(lang = "en"))
        assertEquals("221,886 BTC", blocks[2].shown(lang = "en"))
        assertEquals("50%", blocks[3].shown(lang = "en"))
        assertEquals(0.5, blocks[3].fraction, 0.0)
        assertEquals("Live", blocks[4].shown(lang = "en"))
        assertNull(blocks[5].shown(lang = "en"))
    }

    @Test fun writesNumbersInTheReadersUnits() {
        assertEquals("1,234.5", BlockFormat.string(1234.5, BlockNumber(), lang = "en"))
        assertEquals("12.3%", BlockFormat.string(12.345, BlockNumber(format = "percent"), lang = "en"))
        assertEquals("1.5M", BlockFormat.string(1_500_000.0, BlockNumber(format = "compact"), lang = "en"))
        assertEquals("150万", BlockFormat.string(1_500_000.0, BlockNumber(format = "compact"), lang = "zh"))
        assertEquals("+3.2", BlockFormat.string(3.2, BlockNumber(), lang = "en", signed = true))
        assertEquals("$82,750", BlockFormat.string(82750.0, BlockNumber(format = "currency", decimals = 0), lang = "en"))
    }

    @Test fun sizesAndAge() {
        assertEquals(2, WidgetLayout.rows("1x1"))
        assertEquals(10, WidgetLayout.rows("2x2"))
        assertEquals(2, WidgetLayout.rows(null))
        val now = ISO8601.parse("2026-10-13T02:20:00Z")!!
        assertTrue(WidgetLayout.isOutdated("2026-10-13T02:00:00.000Z", 600_000.0, now))
        assertFalse(WidgetLayout.isOutdated("2026-10-13T02:15:00.000Z", 600_000.0, now))
        assertFalse(WidgetLayout.isOutdated(null, 600_000.0, now))
    }
}
