package dev.aispace.android.core

import org.junit.Assert.*
import org.junit.Test

/** Universal search's contract and rules, as the iPhone's OmniboxTests check them. */
class OmniboxTests {
    companion object {
        const val ACTION = """{"id":"todo/create","peer":"seoul","title":"Create todo","effect":"write","available":true,"inputs":[
            {"name":"title","type":"text","label":"Title","required":true},
            {"name":"date","type":"date","label":"Date","default":"tomorrow"},
            {"name":"time","type":"time","label":"Time"},
            {"name":"count","type":"number","label":"Count","min":1,"max":10},
            {"name":"kind","type":"choice","label":"Kind","options":[{"value":"work","label":"Work"}]}],
            "i18n":{"zh":{"title":"新建待办","inputs":{"title":"标题"}}}}"""
    }

    @Test fun parsesAResolutionWithoutLosingThePeerOrTheAmbiguity() {
        val result = Hub.decode(
            """{"ok":true,"ambiguous":true,"intents":[{"kind":"action","key":"seoul:todo/create","strong":true,"action":$ACTION,"args":{"title":"Report","time":"15:00"}}],"agentIntents":[{"id":"news","title":"News","agent":"news/curator","available":false,"reason":"Missing skill"}]}""",
            ShortcutResolution,
        )
        assertTrue(result.ambiguous)
        assertEquals("seoul", result.intents.first().action?.peer)
        assertEquals(JSONValue.Str("15:00"), result.intents.first().args?.get("time"))
        assertFalse(result.agentIntents.first().available)
        assertEquals("新建待办", result.intents.first().action?.displayTitle("zh"))
        assertEquals("Create todo", result.intents.first().action?.displayTitle("en"))
    }

    @Test fun formsKeepCalendarValuesAndCheckNumbersAndOptions() {
        val action = Hub.decode(ACTION, ShortcutAction)
        var values = action.initial(mapOf("title" to JSONValue.Str("Report"), "time" to JSONValue.Str("15:00")))
        assertEquals("tomorrow", values["date"])
        assertTrue(action.valid(values))
        assertEquals("tomorrow", action.payload(values).getString("date"))
        assertEquals("15:00", action.payload(values).getString("time"))
        values = values + ("count" to "nan")
        assertFalse(action.valid(values))
        values = values + ("count" to "11")
        assertFalse(action.valid(values))
        values = values + ("count" to "2.5")
        assertTrue(action.valid(values))
        assertEquals(2.5, action.payload(values).getDouble("count"), 0.0)
        values = values + ("kind" to "missing")
        assertFalse(action.valid(values))
        values = values + ("kind" to "work") + ("title" to " ")
        assertFalse(action.valid(values))
    }

    @Test fun readsEveryResultKindAndUnknownOutcomes() {
        for (result in listOf(
            """{"kind":"value","value":12.5,"text":"12.5 USD","stale":true}""",
            """{"kind":"list","items":[{"title":"News","url":"https://example.com"}]}""",
            """{"kind":"receipt","items":[{"id":"1","title":"Created"}]}""",
            """{"kind":"task","taskId":"daily","task":"Daily","status":"running"}""",
        )) {
            val run = Hub.decode(
                """{"id":1,"title":"Action","status":"unknown","effect":"write","createdAt":"2026-10-17T00:00:00.000Z","result":$result}""",
                ShortcutRun,
            )
            assertEquals("unknown", run.status)
            assertNotNull(run.result)
        }
    }

    @Test fun localNamesRankAheadOfDescriptions() {
        val notes = CatalogueEntry(EntryKind.app, "notes", "Notes", reach = Reach.up)
        val todo = CatalogueEntry(EntryKind.app, "todo", "Todo", detail = "notes on tasks", reach = Reach.up)
        assertEquals("notes", OmniboxRules.rank("notes", listOf(todo, notes)).first().ref)
        assertTrue(OmniboxRules.opensByDefault("notes", notes))
        assertFalse(OmniboxRules.opensByDefault("tasks", todo))
        val reader = CatalogueEntry(EntryKind.app, "feeds", "Feed Reader", reach = Reach.up)
        assertEquals(OmniboxRules.Score.WORD, OmniboxRules.score("read", reader))
        assertEquals(0, OmniboxRules.score("", reader))
    }

    @Test fun aVoiceTranscriptReplacesPartialsAndCommitsFinalCorrections() {
        val transcript = VoiceTranscript("Existing text ")
        assertEquals("Existing text hel", transcript.update(0, "hel", false))
        assertEquals("Existing text hello", transcript.update(0, "hello", false))
        assertEquals("Existing text Hello.", transcript.update(0, "Hello.", true))
        assertEquals("Existing text Hello.", transcript.update(0, "stale", false))
        assertEquals("Existing text Hello. noise", transcript.update(1, "noise", false))
        assertEquals("Existing text Hello.", transcript.update(1, "", true))
        assertEquals("Existing text Hello. Last", transcript.update(3, "Last", true))
        assertEquals("Existing text Hello. Next Last", transcript.update(2, "Next", true))
    }

    @Test fun voiceFramesKeepTheirOrderAndFlushTheTail() {
        val frames = VoicePCMFrames()
        val first = ByteArray(2800) { 1 }
        val second = ByteArray(4000) { 2 }
        assertTrue(frames.append(first).isEmpty())
        val emitted = frames.append(second)
        assertEquals(listOf(3200, 3200), emitted.map { it.size })
        val tail = frames.finish()!!
        assertEquals(400, tail.size)
        assertArrayEquals(first + second, emitted.reduce { a, b -> a + b } + tail)
        assertNull(frames.finish())
    }
}
