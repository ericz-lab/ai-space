package dev.aispace.android.core

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.LocalDate
import java.time.LocalTime
import java.util.Locale

class ChatCardsTests {
    private val receipt = """{"v":1,"kind":"receipt","title":"已添加 2 条待办","items":[
        {"id":"72","title":"开会","detail":"后天 周四 08:00 · 高","url":"https://todo.example.com/?todo=72","version":1},
        {"id":73,"title":"交报销","version":2}],
        "state":"card-state","actions":{"undo":"card-undo","edit":"card-edit"}}"""

    private fun card(json: String): Card? = Card.from(JSONObject(json))
    private fun item(fields: String, style: String = "rows", kind: String = "list"): Card? =
        card("""{"v":1,"kind":"$kind","style":"$style","items":[{"id":"1","title":"A"$fields}]}""")

    // Decoding: version 1

    @Test fun aV1ReceiptDecodes() {
        val c = card(receipt)!!
        assertEquals(CardKind.receipt, c.kind)
        assertEquals("已添加 2 条待办", c.title)
        assertEquals(listOf("72", "73"), c.items.map { it.id })
        assertEquals("后天 周四 08:00 · 高", c.items[0].detail)
        assertEquals("https://todo.example.com/?todo=72", c.items[0].url)
        assertEquals(2, c.items[1].version)
        assertEquals("card-state", c.state)
        // Only `undo` is known; `edit` is left out, not refused.
        assertEquals("card-undo", c.undo)
        assertEquals(CardStyle.rows, c.style)
        assertEquals(CardStyle.rows, c.drawnStyle)
        assertEquals(CardExtras(), c.items[0].extras)
    }

    @Test fun aValueCardNeedsItsText() {
        val c = card("""{"v":1,"kind":"value","title":"本周完成","text":"12 条"}""")!!
        assertEquals("12 条", c.text)
        assertTrue(c.items.isEmpty())
        assertNull(card("""{"v":1,"kind":"value","title":"x"}"""))
    }

    @Test fun aCardThatBreaksARuleIsDroppedWhole() {
        assertNull(card("""{"v":2,"kind":"receipt","items":[{"id":"1","title":"a"}]}"""))
        assertNull(card("""{"v":1,"kind":"draft","items":[{"id":"1","title":"a"}]}"""))
        assertNull(card("""{"v":1,"kind":"list","items":[]}"""))
        assertNull(card("""{"v":1,"kind":"list","items":[{"id":"1"}]}"""))
        assertNull(card("""{"v":1,"kind":"list","items":[{"id":"1","title":"a"},{"id":1,"title":"b"}]}"""))
        assertNull(card("""{"v":1,"kind":"list","items":[{"id":"1","title":"a","url":"javascript:x"}]}"""))
        assertNull(card("""{"v":1,"kind":"list","items":[{"id":"1","title":"a","version":-1}]}"""))
        assertNull(card("""{"v":1,"kind":"list","items":[{"id":"1","title":"a"}],"actions":{"undo":"card-undo"}}"""))
        assertNull(card("""{"v":1,"kind":"receipt","items":[{"id":"1","title":"a"}],"state":"bad name!"}"""))
        assertNull(card("""{"v":1,"kind":"list","title":"${"x".repeat(201)}","items":[{"id":"1","title":"a"}]}"""))
        val many = (1..21).joinToString(",") { """{"id":"$it","title":"t"}""" }
        assertNull(card("""{"v":1,"kind":"list","items":[$many]}"""))
    }

    @Test fun unknownFieldsAreIgnoredAndTheJsonKept() {
        val c = card("""{"v":1,"kind":"list","future":{"x":1},"items":[{"id":"1","title":"a","later":true}]}""")!!
        assertEquals("a", c.items.single().title)
        assertTrue(c.json.has("future"))
    }

    // Decoding: version 2

    @Test fun everyV2ItemFieldDecodes() {
        val c = item(""","when":"后天 周四 08:00","date":"2026-11-26T08:00","tags":[{"text":"高","tone":"warning"},{"text":"工作"}],
            "image":"https://todo.example.com/a.png","icon":"calendar","value":"¥3,200","progress":0.4""")!!
        val x = c.items.single().extras
        assertEquals("后天 周四 08:00", x.`when`)
        assertEquals(CardDate(LocalDate.of(2026, 11, 26), LocalTime.of(8, 0)), x.date)
        assertEquals(listOf(CardTag("高", CardTone.warning), CardTag("工作", CardTone.neutral)), x.tags)
        assertEquals("https://todo.example.com/a.png", x.image)
        assertEquals(CardIcon.calendar, x.icon)
        assertEquals("¥3,200", x.value)
        assertEquals(0.4, x.progress!!, 0.0)
        assertEquals(CardDate(LocalDate.of(2026, 11, 26)), item(""","date":"2026-11-26"""")!!.items.single().extras.date)
        assertEquals("/img/1.png", item(""","image":"/img/1.png"""")!!.items.single().extras.image)
    }

    @Test fun everyStyleNameDecodes() {
        for (s in CardStyle.entries) assertEquals(s, card("""{"v":1,"kind":"list","style":"${s.name}","items":[{"id":"1","title":"a"}]}""")!!.style)
    }

    @Test fun unknownNamesDegrade() {
        // A style this client does not know is rows; the card stays.
        assertEquals(CardStyle.rows, item("", style = "timeline")!!.style)
        assertEquals(CardTone.neutral, item(""","tags":[{"text":"x","tone":"glow"}]""")!!.items.single().extras.tags!!.single().tone)
        assertNull(item(""","icon":"rocket"""")!!.items.single().extras.icon)
    }

    @Test fun aV2FieldOfTheWrongShapeDropsTheCard() {
        assertNull(card("""{"v":1,"kind":"list","style":3,"items":[{"id":"1","title":"a"}]}"""))
        assertNull(item(""","when":5"""))
        assertNull(item(""","when":"${"x".repeat(41)}""""))
        assertNull(item(""","date":"2026/11/26""""))
        assertNull(item(""","date":"2026-02-30""""))
        assertNull(item(""","date":"2026-11-26T08:00:00""""))
        assertNull(item(""","tags":"高""""))
        assertNull(item(""","tags":[{"text":"a"},{"text":"b"},{"text":"c"},{"text":"d"},{"text":"e"}]"""))
        assertNull(item(""","tags":[{"tone":"accent"}]"""))
        assertNull(item(""","tags":[{"text":"${"x".repeat(25)}"}]"""))
        assertNull(item(""","tags":[{"text":"a","tone":1}]"""))
        assertNull(item(""","image":"ftp://x/a.png""""))
        assertNull(item(""","image":"//cdn/a.png""""))
        assertNull(item(""","icon":7"""))
        assertNull(item(""","value":12"""))
        assertNull(item(""","value":"${"9".repeat(25)}""""))
        assertNull(item(""","progress":1.2"""))
        assertNull(item(""","progress":-0.1"""))
        assertNull(item(""","progress":"50%""""))
    }

    @Test fun aStyleWhoseFieldIsMissingOnAnyItemDrawsAsRows() {
        fun drawn(style: String, kind: String, a: String, b: String) =
            card("""{"v":1,"kind":"$kind","style":"$style","items":[{"id":"1","title":"a"$a},{"id":"2","title":"b"$b}]}""")!!.drawnStyle
        assertEquals(CardStyle.gallery, drawn("gallery", "list", ""","image":"/a.png"""", ""","image":"/b.png""""))
        assertEquals(CardStyle.rows, drawn("gallery", "list", ""","image":"/a.png"""", ""))
        assertEquals(CardStyle.agenda, drawn("agenda", "receipt", ""","date":"2026-11-26"""", ""","date":"2026-11-27""""))
        assertEquals(CardStyle.rows, drawn("agenda", "receipt", ""","date":"2026-11-26"""", ""))
        assertEquals(CardStyle.stat, drawn("stat", "list", ""","value":"12"""", ""","value":"3""""))
        assertEquals(CardStyle.rows, drawn("stat", "list", ""","value":"12"""", ""))
        // stat is for list and value cards only.
        assertEquals(CardStyle.rows, drawn("stat", "receipt", ""","value":"12"""", ""","value":"3""""))
        assertEquals(CardStyle.compact, drawn("compact", "receipt", "", ""))
    }

    // The run's events and restored sessions

    @Test fun aLiveCardsEventAddsCardsWithTheirToken() {
        var reply = ChatReply()
        reply = reply.applying("""{"type":"cards","cards":[$receipt,{"v":9},${receipt.replace("receipt", "list").replace(",\"actions\":{\"undo\":\"card-undo\",\"edit\":\"card-edit\"}", "")}],"token":"tok-1"}""")
        assertEquals(2, reply.cards.size)
        assertEquals(listOf(0, 2), reply.cards.map { it.index })
        assertEquals(listOf("tok-1", "tok-1"), reply.cards.map { it.token })
        reply = reply.applying("""{"type":"cards","cards":[{"v":1,"kind":"value","text":"3"}]}""")
        assertEquals(3, reply.cards.size)
        assertNull(reply.cards.last().token)
        assertEquals(0, reply.cards.last().index)
        // The cards stay once the turn ends.
        assertEquals(3, reply.applying("""{"type":"done"}""").cards.size)
    }

    @Test fun aRestoredMessageCarriesCardsWithoutAToken() {
        val stored = Json.decode("""{"role":"ai","text":"好了","cards":[$receipt,{"v":1,"kind":"list"}]}""", ChatStored)
        assertEquals(1, stored.cards.size)
        assertNull(stored.cards.single().token)
        assertEquals("72", stored.cards.single().card.items.first().id)
        assertTrue(Json.decode("""{"role":"ai","text":"x"}""", ChatStored).cards.isEmpty())
    }

    // The rules

    @Test fun onlyTheLatestReplyIsActionable() {
        val isUser = listOf(true, false, true, false, false)
        assertFalse(CardRules.actionable(isUser, 1))
        assertTrue(CardRules.actionable(isUser, 3))
        assertTrue(CardRules.actionable(isUser, 4))
    }

    @Test fun undoNeedsActionableATokenAnUndoActionAndNotReadOnly() {
        val c = card(receipt)!!
        assertTrue(CardRules.canUndo(ShownCard(c, 0, "t"), actionable = true, readOnly = false))
        assertFalse(CardRules.canUndo(ShownCard(c, 0, "t"), actionable = false, readOnly = false))
        assertFalse(CardRules.canUndo(ShownCard(c, 0, "t"), actionable = true, readOnly = true))
        assertFalse(CardRules.canUndo(ShownCard(c, 0, null), actionable = true, readOnly = false))
        assertFalse(CardRules.canUndo(ShownCard(c.copy(undo = null), 0, "t"), actionable = true, readOnly = false))
    }

    @Test fun undoneAndChangedItemsCannotBeUndone() {
        val c = card(receipt)!!
        val states = mapOf(
            "72" to CardItemState("72", CardItemStatus.removed),
            "73" to CardItemState("73", CardItemStatus.active, changed = true),
        )
        assertTrue(CardRules.open(c, true, states).isEmpty())
        assertEquals(listOf("73"), CardRules.open(c, true, mapOf("72" to CardItemState("72", CardItemStatus.removed))))
        assertEquals(listOf("72", "73"), CardRules.open(c, true, mapOf("72" to CardItemState("72", CardItemStatus.done))))
        assertTrue(CardRules.open(c, false, emptyMap()).isEmpty())
    }

    @Test fun theHeaderLabel() {
        assertEquals(UndoLabel.One, CardRules.undoLabel(1, 1))
        assertEquals(UndoLabel.All, CardRules.undoLabel(3, 3))
        assertEquals(UndoLabel.Rest(2), CardRules.undoLabel(3, 2))
    }

    @Test fun rowUndoNeedsSeveralItemsAndARowStyle() {
        val c = card(receipt)!!
        assertTrue(CardRules.rowUndo(c, CardStyle.rows, true))
        assertTrue(CardRules.rowUndo(c, CardStyle.agenda, true))
        assertTrue(CardRules.rowUndo(c, CardStyle.gallery, true))
        assertFalse(CardRules.rowUndo(c, CardStyle.compact, true))
        assertFalse(CardRules.rowUndo(c, CardStyle.stat, true))
        assertFalse(CardRules.rowUndo(c, CardStyle.rows, false))
        assertFalse(CardRules.rowUndo(c.copy(items = c.items.take(1)), CardStyle.rows, true))
    }

    @Test fun theAnswerIsMergedOverThePrintedItem() {
        val c = card(receipt)!!
        val printed = c.items[0]
        val plain = CardRules.view(printed, null)
        assertEquals(CardItemStatus.active, plain.status)
        assertEquals(listOf("后天 周四 08:00", "高"), plain.segments)
        assertNull(plain.pill)

        val changed = CardRules.view(printed, CardItemState("72", CardItemStatus.active, title = "开会（改到会议室 B）", changed = true,
            extras = CardExtras(`when` = "明天 09:30", tags = listOf(CardTag("高")))))
        assertEquals("开会（改到会议室 B）", changed.title)
        assertEquals("后天 周四 08:00 · 高", changed.detail)
        assertEquals("明天 09:30", changed.extras.`when`)
        assertEquals(CardPill.Changed, changed.pill)

        val removed = CardRules.view(printed.copy(extras = CardExtras(`when` = "w", image = "/a.png", value = "3", progress = 0.5)),
            CardItemState("72", CardItemStatus.removed, title = "ignored", detail = "ignored"))
        assertEquals("开会", removed.title)
        assertNull(removed.detail)
        assertNull(removed.url)
        assertNull(removed.extras.`when`)
        assertNull(removed.extras.progress)
        assertEquals("/a.png", removed.extras.image)
        assertEquals("3", removed.extras.value)
        assertEquals(CardPill.Undone, removed.pill)

        assertEquals(CardPill.Done, CardRules.view(printed, CardItemState("72", CardItemStatus.done)).pill)
    }

    @Test fun mergeKeepsEarlierAnswersOfOtherItems() {
        val a = CardRules.merge(emptyMap(), listOf(CardItemState("1", CardItemStatus.done)))
        val b = CardRules.merge(a, listOf(CardItemState("2", CardItemStatus.removed)))
        assertEquals(setOf("1", "2"), b.keys)
        assertEquals(CardItemStatus.removed, CardRules.merge(b, listOf(CardItemState("1", CardItemStatus.removed)))["1"]!!.status)
    }

    // Requests and answers

    @Test fun theStateBodyIsTheAgentAndTheCardAsItCame() {
        val c = card(receipt)!!
        val body = CardRules.stateBody("todo/planner", c)
        assertEquals(setOf("agent", "card"), body.keyList().toSet())
        assertEquals("todo/planner", body.getString("agent"))
        assertEquals("card-undo", body.getJSONObject("card").getJSONObject("actions").getString("undo"))
        assertEquals(73, body.getJSONObject("card").getJSONArray("items").getJSONObject(1).getInt("id"))
    }

    @Test fun theUndoBodyIsOnlyTokenCardActionAndItems() {
        val body = CardRules.undoBody("tok", 2, listOf("72", "73"))
        assertEquals(setOf("token", "card", "action", "items"), body.keyList().toSet())
        assertEquals("tok", body.getString("token"))
        assertEquals(2, body.getInt("card"))
        assertEquals("undo", body.getString("action"))
        assertEquals(JSONArray(listOf("72", "73")).toString(), body.getJSONArray("items").toString())
    }

    @Test fun actionAnswers() {
        val ok = CardRules.outcome(200, """{"ok":true,"items":[{"id":"72","status":"removed"},{"id":"73","status":"active","changed":true,"title":"新","version":3},{"id":"x","status":"gone"}]}""")
        val items = (ok as CardRules.Outcome.Items).items
        assertEquals(listOf("72", "73"), items.map { it.id })
        assertTrue(items[1].changed)
        assertEquals(3, items[1].version)
        assertEquals(CardRules.Outcome.ReadOnly, CardRules.outcome(409, """{"ok":false,"readOnly":true}"""))
        assertEquals(CardRules.Outcome.Failed("no such card"), CardRules.outcome(400, """{"ok":false,"error":"no such card"}"""))
        assertEquals(CardRules.Outcome.Failed("HTTP 502"), CardRules.outcome(502, "<html>"))
    }

    @Test fun stateAnswersSkipItemsThatBreakARule() {
        val items = CardRules.stateItems("""{"ok":true,"items":[
            {"id":"1","status":"done","when":"今天","tags":[{"text":"高","tone":"negative"}],"value":"5","progress":1},
            {"id":"2","status":"active","progress":3},
            {"id":"3","status":"active","url":"mailto:x"},
            {"status":"active"}]}""")
        assertEquals(listOf("1", "3"), items.map { it.id })
        assertEquals("今天", items[0].extras.`when`)
        assertEquals(CardTone.negative, items[0].extras.tags!!.single().tone)
        assertEquals(1.0, items[0].extras.progress!!, 0.0)
        assertNull(items[1].url)
        assertTrue(CardRules.stateItems("""{"ok":false,"items":[{"id":"1","status":"done"}]}""").isEmpty())
        assertTrue(CardRules.stateItems("not json").isEmpty())
    }

    @Test fun routesOfTheSpaceAndOfAPeer() {
        val here = CardRoute.of(ChatRoute.base("todo/planner", null)!!)!!
        assertEquals("/api/agents/cards/state", here.state)
        assertEquals("/api/agents/cards/action", here.action)
        assertEquals("todo/planner", here.agent)
        val peer = CardRoute.of(ChatRoute.base("david/voice-studio/narrator", "david")!!)!!
        assertEquals("/api/peers/david/agents/cards/state", peer.state)
        assertEquals("/api/peers/david/agents/cards/action", peer.action)
        assertEquals("voice-studio/narrator", peer.agent)
        val escaped = CardRoute.of(ChatRoute.base("my app/a+b", "mac mini")!!)!!
        assertEquals("/api/peers/mac%20mini/agents/cards/state", escaped.state)
        assertEquals("my app/a+b", escaped.agent)
        assertNull(CardRoute.of("/api/inbox"))
    }

    // The header and the agenda

    @Test fun theAppHeadingTheCards() {
        val catalogue = Catalogue.decode(CataloguePayload(Fixture.apps, Fixture.agents, Fixture.widgets, fetchedAt = java.time.Instant.EPOCH))
        val planner = catalogue.agents.first { it.ref == "todo/planner" }
        val app = CardApp.of(planner, catalogue.apps)
        assertEquals("✅", app.icon)
        assertEquals("Todo", app.entry?.title)
        val voice = CatalogueEntry(EntryKind.agent, "david/voice-studio/narrator", "Narrator", peer = "david", reach = Reach.unknown)
        val peerApp = CardApp.of(voice, catalogue.apps)
        assertEquals("Voice Studio", peerApp.entry?.title)
        assertEquals("🎙️", peerApp.icon)
        val unknown = CardApp.of(CatalogueEntry(EntryKind.agent, "space/assistant", "A", reach = Reach.unknown, appIcon = "✨"), catalogue.apps)
        assertEquals(CardApp("✨", null), unknown)
    }

    @Test fun agendaBlocksOnlyOnTheFirstItemOfADay() {
        val d1 = CardDate(LocalDate.of(2026, 11, 26), LocalTime.of(8, 0))
        val d1b = CardDate(LocalDate.of(2026, 11, 26), LocalTime.of(14, 30))
        val d2 = CardDate(LocalDate.of(2026, 11, 27))
        assertEquals(listOf(d1, null, d2, d1), CardAgenda.blocks(listOf(d1, d1b, d2, d1)))
        assertEquals("08:00", CardAgenda.time(d1))
        assertEquals("14:30", CardAgenda.time(d1b))
        assertNull(CardAgenda.time(d2))
    }

    @Test fun agendaLabelsFollowTheLanguage() {
        val day = LocalDate.of(2026, 11, 26)
        assertEquals("周四", CardAgenda.weekday(day, Locale.SIMPLIFIED_CHINESE))
        assertEquals("Thu", CardAgenda.weekday(day, Locale.ENGLISH))
        assertEquals("11月", CardAgenda.month(day, Locale.SIMPLIFIED_CHINESE))
        assertEquals("Nov", CardAgenda.month(day, Locale.ENGLISH))
        assertFalse(CardAgenda.showsMonth(day, LocalDate.of(2026, 11, 24)))
        assertTrue(CardAgenda.showsMonth(LocalDate.of(2026, 12, 1), LocalDate.of(2026, 11, 24)))
        assertTrue(CardAgenda.showsMonth(LocalDate.of(2027, 11, 1), LocalDate.of(2026, 11, 24)))
    }
}
