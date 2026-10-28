package dev.aispace.android.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Models across machines: greyed choices, usage with peers' calls, peer apps, the CLIs by machine. */
class ModelMachinesTests {
    @Test fun aChoiceSaysWhyItCannotBePicked() {
        val rows = Hub.rows(
            "models",
            """{"models":[
              {"value":"claude/basic","runtime":"claude","tier":"basic","model":"haiku","capabilities":{"agent":true,"complete":true}},
              {"value":"codex/basic","runtime":"codex","tier":"basic","model":"luna","unavailable":"signed-out"},
              {"value":"david:claude/basic","runtime":"david:claude","tier":"basic","model":"haiku","unavailable":"offline"}
            ]}""",
            ModelChoice,
        )
        assertEquals(listOf(null, "signed-out", "offline"), rows.map { it.unavailable })
        assertEquals(listOf(null, ModelChoices.Reason.SignedOut, ModelChoices.Reason.Offline), rows.map { ModelChoices.reason(it.unavailable) })
        // A reason this client does not know still greys the choice.
        assertEquals(ModelChoices.Reason.SignedOut, ModelChoices.reason("limited"))
    }

    @Test fun theDefaultModelsOptionsCarryTheReasonToo() {
        val p = Json.decode("""{"defaultModel":"gone/x","options":[{"value":"codex/basic","runtime":"codex","tier":"basic","model":"luna","unavailable":"signed-out"}]}""", ModelPreferences)
        assertEquals("signed-out", p.options.single().unavailable)
        assertEquals("gone/x", ModelChoices.savedMissing(p.defaultModel, p.options.map { it.value }))
    }

    @Test fun aSavedValueNoLongerOfferedStaysShown() {
        assertEquals("old/x", ModelChoices.savedMissing("old/x", listOf("claude/basic")))
        assertNull(ModelChoices.savedMissing("claude/basic", listOf("claude/basic")))
        assertNull(ModelChoices.savedMissing(null, listOf("claude/basic")))
        assertNull(ModelChoices.savedMissing("", listOf("claude/basic")))
    }

    @Test fun usageNamesTheSpaceTheMachinesAndThePeers() {
        val u = Hub.decode(
            """{"ok":true,"window":"24h","space":"hub","backend":"local","totals":{"calls":5},
              "byApp":[{"app":"david/voice","calls":2}],
              "byTag":[{"app":"david/voice","tag":"asr","model":"gpt-6-luna","machine":"david","calls":2},{"app":"todo","tag":"plan","model":"haiku","calls":3}],
              "byModel":[{"model":"gpt-6-luna","machine":"david","calls":2},{"model":"haiku","machine":"","calls":3}],
              "byBackend":[{"backend":"local","origin":"peer","calls":1}],
              "history":{"totals":{"calls":5},"days":[]},
              "peers":[{"name":"david","ok":true},{"name":"lab","ok":false,"asOf":"2026-10-27T01:00:00.000Z","error":"timeout"},{"name":"old","ok":false,"error":"404"}]}""",
            ModelUsage,
        )
        assertEquals("hub", u.space)
        assertEquals(listOf("david:gpt-6-luna", "haiku"), u.byTag?.map { it.modelOn })
        assertEquals(listOf("david:gpt-6-luna", "haiku"), u.byModel?.map { it.modelOn })
        assertEquals("peer", u.byBackend?.single()?.origin)
        assertEquals(listOf("lab", "old"), u.absentPeers.map { it.name })
        assertEquals("2026-10-27T01:00:00.000Z", u.absentPeers[0].asOf)
        assertNull(u.absentPeers[1].asOf)
        // An older Space: no name, no peers.
        val old = Hub.decode("""{"totals":{"calls":0}}""", ModelUsage)
        assertNull(old.space)
        assertEquals(emptyList<ModelUsage.Peer>(), old.absentPeers)
    }

    @Test fun aPeersCallCarriesItsPeerAndMachine() {
        val calls = Hub.rows(
            "calls",
            """{"calls":[
              {"id":-41,"app":"david/voice","tag":"asr","model":"gpt-6-luna","machine":"david","peer":"david","origin":"run","status":"ok"},
              {"id":12,"app":"todo","model":"haiku","machine":"","status":"error","error":"limit"}
            ]}""",
            ModelCall,
        )
        assertEquals(listOf(-41, 12), calls.map { it.id })
        assertEquals("david:gpt-6-luna", calls[0].modelOn)
        assertEquals("david", calls[0].peer)
        assertEquals("haiku", calls[1].modelOn)
        assertNull(calls[1].peer)
    }

    @Test fun appTitlesAreKeyedByIdAndByTheBareName() {
        val labels = AppLabel.index(
            Hub.rows(
                "apps",
                """{"apps":[{"id":"david/voice","name":"voice","title":"Voice (david)"},{"id":"todo","name":"todo","title":"Todo"},{"id":"david/todo","name":"todo","title":"Todo (david)"}]}""",
                AppLabel,
            ),
        )
        assertEquals("Voice (david)", labels["david/voice"]?.title)
        assertEquals("Todo (david)", labels["david/todo"]?.title)
        // The bare name is the local app when there is one.
        assertEquals("Todo", labels["todo"]?.title)
        assertEquals("Voice (david)", labels["voice"]?.title)
    }
}
