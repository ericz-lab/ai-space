package dev.aispace.android.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HubModelsTests {
    private val tasks = """
    {"ok":true,"tasks":[
      {"id":"t1","app":"todo","name":"backup","source":"manifest","orphaned":false,"enabled":true,
       "schedule":{"kind":"cron","expr":"8 3 * * *"},"target":{"kind":"command","command":"x","env":{"A":"b"}},
       "modelSelectable":false,"timeoutMs":1800000,"triggers":[],"overrides":{},
       "state":{"lastRunAt":"2026-10-13T03:08:00.000Z","lastStatus":"ok","lastDurationMs":812,"consecutiveErrors":0}},
      {"id":"t2","app":"reader","name":"digest","source":"api","orphaned":false,"enabled":true,
       "schedule":{"kind":"every","everyMs":900000},"target":{"kind":"agent"},"modelSelectable":true,
       "triggers":[{"event":"reader/article.saved","debounceMs":5000}],"overrides":{"model":"codex/basic"},"model":"codex/basic","base":{"model":"claude/junior"},
       "state":{"lastStatus":"error","lastError":"boom","consecutiveErrors":3,"pending":{"events":2}}},
      {"id":"t3","app":"reader","name":"paused","enabled":false,"schedule":{"kind":"manual"},"state":{"lastStatus":"error","consecutiveErrors":1}},
      {"id":"t4","app":"gone","name":"old","orphaned":true,"enabled":true,"schedule":{"kind":"manual"}},
      {"id":"t5","app":"todo","name":"live","enabled":true,"schedule":{"kind":"manual"},"state":{"runningAt":"2026-10-13T03:08:00.000Z","lastStatus":"ok"}},
      {"id":"t6","app":"todo","name":"new","schedule":{"kind":"at","at":"2026-11-01T00:00:00.000Z"}},
      {"name":"no id"}
    ]}
    """.trimIndent()

    @Test fun readsTasksAndTheirStates() {
        val tasks = Hub.rows("tasks", tasks, SpaceTask)
        // A row without an id is skipped, the rest are kept.
        assertEquals(listOf("t1", "t2", "t3", "t4", "t5", "t6"), tasks.map { it.id })
        assertEquals(
            listOf(
                SpaceTask.Status.Ok, SpaceTask.Status.Error(3), SpaceTask.Status.Off,
                SpaceTask.Status.Orphaned, SpaceTask.Status.Running, SpaceTask.Status.NeverRan,
            ),
            tasks.map { it.status },
        )
        assertEquals(4, tasks.count { it.isActive })
        assertEquals(listOf("t2"), tasks.filter { it.isFailing }.map { it.id })
        assertEquals(listOf("reader/article.saved"), tasks[1].triggers?.map { it.event })
        assertEquals(false, tasks[1].overrides?.isEmpty)
        assertEquals(true, tasks[0].overrides?.isEmpty)
        assertEquals(2, tasks[1].state?.pending?.events)
    }

    @Test fun offersATaskOnlyTheModelsItsKindCanRun() {
        val options = Hub.rows(
            "models",
            """
            {"ok":true,"models":[
              {"value":"claude/basic","runtime":"claude","tier":"basic","model":"haiku","capabilities":{"complete":true,"agent":true}},
              {"value":"slim/basic","runtime":"slim","tier":"basic","model":"luna","capabilities":{"complete":true,"agent":false}}
            ]}
            """.trimIndent(),
            ModelChoice,
        )
        val tasks = Hub.rows("tasks", tasks, SpaceTask)
        assertEquals(listOf("claude/basic"), tasks[1].eligible(options).map { it.value })
        assertEquals(listOf("claude/basic", "slim/basic"), tasks[0].eligible(options).map { it.value })
        assertEquals("claude · Basic · haiku", options[0].label)
    }

    @Test fun aMissingKeyIsAnEmptyList() {
        assertTrue(Hub.rows("runs", """{"ok":true}""", TaskRun).isEmpty())
        val runs = Hub.rows(
            "runs",
            """{"runs":[{"id":7,"taskId":"t1","startedAt":1000,"endedAt":3500,"status":"ok","trigger":"event","eventIds":[1,2]}]}""",
            TaskRun,
        )
        assertEquals(2500.0, runs.first().durationMs!!, 0.0)
        assertEquals(listOf(1, 2), runs.first().eventIds)
    }

    @Test fun anAnswerThatIsNotJsonThrows() {
        try {
            Hub.rows("tasks", "<html>Sign in</html>", SpaceTask)
            throw AssertionError("expected a DecodingException")
        } catch (e: DecodingException) {
            // expected
        }
    }

    @Test fun readsModelUsageWithItsRowsAndWeeks() {
        val usage = Hub.decode(
            """
            {"ok":true,"window":"24h","backend":"local","totals":{"calls":10,"errors":1,"tokens":1500,"costUsd":0.5,"durationMs":2000},
             "byTag":[{"calls":7,"tokens":1000,"app":"todo","tag":"plan","model":"haiku"},{"calls":3,"tokens":500,"app":"reader","tag":"digest","model":"sonnet"}],
             "byModel":[{"calls":7,"tokens":1000,"model":"haiku"}],
             "history":{"firstAt":"2026-10-01T00:00:00.000Z","totals":{"calls":40,"tokens":9000},
               "days":[{"day":"2026-10-05","tokens":100},{"day":"2026-10-11","tokens":200},{"day":"2026-10-12","tokens":300},{"day":"bad","tokens":9}]}}
            """.trimIndent(),
            ModelUsage,
        )
        assertEquals(10.0, usage.totals.calls!!, 0.0)
        assertEquals(listOf("todo", "reader"), usage.byTag?.map { it.app })
        assertEquals(1000.0, usage.byTag?.first()?.totals?.tokens!!, 0.0)
        // 2026-10-05 is a Monday: the 5th and the 11th share a week, the 12th starts the next.
        assertEquals(listOf(300.0, 300.0), usage.weekly({ it.tokens }).map { it.value })
        assertEquals("2026-10-05", usage.weekly({ it.tokens }).first().week.toString())
        assertEquals(13, usage.daysRecorded(now = ISO8601.parse("2026-10-13T12:00:00.000Z")!!))
    }

    @Test fun drawsAppUsageByTimeWhenMeasuredAndByOpensOtherwise() {
        val rows = Hub.rows(
            "usage",
            """
            {"ok":true,"usage":[
              {"kind":"app","key":"todo","opens":4,"activeMs":120000,"sessions":4,"lastAt":"2026-10-13T02:00:00.000Z","daily":[{"day":"2026-10-12","opens":1,"activeMs":60000},{"day":"2026-10-13","opens":3,"activeMs":60000}]},
              {"kind":"agent","key":"space/assistant","opens":2,"activeMs":null,"sessions":0,"lastAt":null,"daily":[{"day":"2026-10-13","opens":2,"activeMs":0}]}
            ]}
            """.trimIndent(),
            AppUsageRow,
        )
        val now = ISO8601.parse("2026-10-13T12:00:00.000Z")!!
        assertEquals(listOf(0.0, 60000.0, 60000.0), rows[0].spark(days = 3, now = now))
        assertEquals(listOf(0.0, 0.0, 2.0), rows[1].spark(days = 3, now = now))
        assertEquals(30000.0, rows[0].averageMs!!, 0.0)
        assertNull(rows[1].averageMs)
        assertEquals("agent:space/assistant", rows[1].id)
    }

    @Test fun readsAppModelsEventsAndPackages() {
        val models = Hub.rows(
            "apps",
            """{"apps":[{"app":"notes","rows":[{"tag":null,"model":"codex/basic","source":"default"},{"tag":"image","manifest":"codex/intermediate","override":"claude/basic","model":"claude/basic","source":"override-tag"}]}]}""",
            AppModelRows,
        )
        assertEquals(listOf("", "image"), models[0].rows.map { it.id })
        assertEquals("claude/basic", models[0].rows[1].override)

        val events = Hub.rows(
            "events",
            """{"events":[{"id":5,"name":"a/b.changed","app":"a","at":"2026-10-13T03:42:58.228Z","data":{"to":23769,"from":1.5,"counts":{"binding":1},"assets":[],"who":"me","on":true}}]}""",
            SpaceEvent,
        )
        assertEquals("""assets: [] · counts: {"binding":1} · from: 1.5 · on: true""", events[0].preview)

        val catalogue = Hub.decode(
            """{"spaceId":"c551","apps":[],"remotes":[{"connectionId":"3b06","spaceId":"0d8c","available":true,"apps":[{"app":"voice","title":"Voice","version":"0.1.0","page":true,"url":"/_space/x"}]}]}""",
            PackageCatalogue,
        )
        assertEquals("Voice", catalogue.remotes?.first()?.apps?.first()?.title)
        val links = Hub.rows(
            "connections",
            """{"connections":[{"id":"3b06","remoteSpaceId":"0d8c","direction":"outgoing","apps":[],"enabled":true,"connected":true}]}""",
            SpaceLink,
        )
        assertEquals(true, links.first().connected)
    }

    @Test fun readsTheInboxAndItsFilters() {
        val items = Hub.rows(
            "items",
            """{"items":[{"thread":"n1","app":"trade","level":"alert","text":"first line\nsecond","count":3,"firstAt":"2026-10-13T03:33:34.175Z","lastAt":"2026-10-13T03:40:00.000Z","action":true,"unread":true,"done":false},{"thread":"n2","app":"trade","title":"Titled","text":"body"}]}""",
            InboxThread,
        )
        assertEquals(listOf("first line", "Titled"), items.map { it.heading })
        assertEquals(listOf("filter=all", "filter=unread", "filter=open&action=1", "filter=done"), InboxFilter.entries.map { it.query })
        assertEquals(140, InboxThread.firstLine("x".repeat(200)).length)
    }

    @Test fun findsAnAgentsChatRoute() {
        assertEquals("/api/agents/space/assistant", ChatRoute.base("space/assistant", null))
        assertEquals("/api/peers/david/agents/ai-draw/illustrator", ChatRoute.base("david/ai-draw/illustrator", "david"))
        assertNull(ChatRoute.base("broken", null))
    }

    @Test fun writesFiguresAsThePanelDoes() {
        assertEquals("–", HubFormat.tokens(null))
        assertEquals("999", HubFormat.tokens(999.0))
        assertEquals("1.2K", HubFormat.tokens(1234.0))
        assertEquals("12K", HubFormat.tokens(12345.0))
        assertEquals("1.23M", HubFormat.tokens(1_234_567.0))
        assertEquals("12.3M", HubFormat.tokens(12_345_678.0))
        assertEquals("2.69B", HubFormat.tokens(2_689_400_000.0))
        assertEquals("–", HubFormat.cost(null))
        assertEquals("$0.002", HubFormat.cost(0.0021))
        assertEquals("$5.75", HubFormat.cost(5.749))
        assertEquals("$123", HubFormat.cost(123.4))
        assertEquals("812 ms", HubFormat.duration(812.0))
        assertEquals("–", HubFormat.duration(null))
        assertEquals("1h 5m", HubFormat.duration(3_900_000.0, lang = "en"))
        assertEquals("1小时5分钟", HubFormat.duration(3_900_000.0, lang = "zh"))
        assertEquals("12,345", HubFormat.count(12345.9, lang = "en"))
    }

    @Test fun relativeTimesReadInTheLanguage() {
        val now = ISO8601.parse("2026-10-13T12:00:00Z")!!
        assertEquals("2h ago", Times.relative(now.minusSeconds(7200), now, "en"))
        assertEquals("in 5m", Times.relative(now.plusSeconds(300), now, "en"))
        assertEquals("2小时前", Times.relative(now.minusSeconds(7200), now, "zh"))
        assertEquals("now", Times.ago(now.minusSeconds(30), now, "en"))
        assertEquals("刚刚", Times.ago(now.plusSeconds(300), now, "zh"))
        assertEquals("3d ago", Times.ago(now.minusSeconds(3 * 86400 + 5), now, "en"))
    }

    @Test fun anyJsonValueReadsOnOneLine() {
        assertEquals("null", JSONValue.Null.compact)
        assertEquals("[1,\"a\",true]", JSONValue.of(org.json.JSONArray("[1,\"a\",true]"))!!.compact)
        assertEquals("1.25", JSONValue.Number(1.25).compact)
    }
}
