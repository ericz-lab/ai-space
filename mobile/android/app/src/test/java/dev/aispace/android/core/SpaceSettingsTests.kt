package dev.aispace.android.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class SpaceSettingsTests {
    private val services = """
    {"ok":true,"services":[
      {"app":"todo","title":"Todo","i18n":{"zh":{"title":"待办"}},"icon":"/api/apps/todo/icon","port":8801,"health":"ok","status":"active","hidden":false,"supervisor":"space"},
      {"app":"reader","title":"Reader","icon":"📰","port":8803,"health":"down","status":"active","hidden":false},
      {"app":"sleeper","title":"Sleeper","port":8804,"health":"down","status":"paused","hidden":false},
      {"app":"old","title":"Old","port":8805,"health":"ok","status":"archived","hidden":false},
      {"app":"voice","peer":"david","title":"Voice","port":8811,"hidden":false},
      {"title":"No app"}
    ],"peers":[]}
    """.trimIndent()

    private val backups = """
    {"ok":true,"target":"s3://bucket/backups/","maxAgeHours":48,"backups":[
      {"app":"todo","count":12,"lastAt":1791832080137,"lastStatus":"ok","lastOkAt":1791832080137,"lastOkBytes":11745,"stale":false,"retired":false},
      {"app":"reader","count":3,"lastStatus":"ok","lastOkAt":1791000000000,"stale":true,"retired":false},
      {"app":"notes","count":1,"lastStatus":"error","lastError":"disk full","lastOkAt":1791000000000,"stale":true,"retired":false},
      {"app":"gone","count":5,"lastStatus":"ok","lastOkAt":1791000000000,"stale":true,"retired":true},
      {"app":"fresh","count":0,"stale":false,"retired":false}
    ]}
    """.trimIndent()

    @Test fun readsServicesAndTheirStates() {
        val s = SpaceSettings.decode(services = services, backups = null)
        // An archived app's service is not shown; a row without an app is skipped.
        assertEquals(listOf("todo", "reader", "sleeper", "david/voice"), s.services.map { it.id })
        assertEquals(
            listOf(SpaceService.State.running, SpaceService.State.down, SpaceService.State.paused, SpaceService.State.unknown),
            s.services.map { it.state },
        )
        assertTrue(s.backups.isEmpty())
        assertEquals("待办", s.services[0].displayTitle(lang = "zh"))
    }

    @Test fun readsBackupsAndTheirStates() {
        val s = SpaceSettings.decode(services = null, backups = backups)
        assertEquals("s3://bucket/backups/", s.backupTarget)
        assertEquals(
            listOf(SpaceBackup.State.ok, SpaceBackup.State.stale, SpaceBackup.State.failed, SpaceBackup.State.retired, SpaceBackup.State.none),
            s.backups.map { it.state },
        )
        assertEquals(Instant.ofEpochMilli(1791832080137), s.backups[0].lastOk)
    }

    @Test fun readsTheDefaultModelAndItsOptions() {
        val body = """
        {"ok":true,"defaultModel":"codex/basic","appDefault":"codex/basic","baseDefault":"claude/junior","options":[
          {"value":"claude/junior","runtime":"claude","tier":"junior","model":"sonnet","capabilities":{"chat":true}},
          {"value":"codex/basic","runtime":"codex","tier":"basic","model":"gpt-6-luna"},
          {"runtime":"broken"}
        ]}
        """.trimIndent()
        val m = SpaceSettings.decode(services = null, backups = null, models = body).models
        assertEquals("codex/basic", m?.defaultModel)
        assertEquals(listOf("claude/junior", "codex/basic"), m?.options?.map { it.value })
        assertEquals("codex · Basic · gpt-6-luna", m?.label("codex/basic"))
        assertEquals("gone/model", m?.label("gone/model"))
        // The environment's defaults: no model is set.
        val unset = SpaceSettings.decode(services = null, backups = null, models = """{"ok":true,"defaultModel":null,"options":[]}""").models
        assertNotNull(unset)
        assertNull(unset?.defaultModel)
    }

    @Test fun anAnswerThatIsNotTheRouteIsEmpty() {
        val s = SpaceSettings.decode(services = "<html>Sign in</html>", backups = "{}")
        assertEquals(SpaceSettings(), s)
    }
}
