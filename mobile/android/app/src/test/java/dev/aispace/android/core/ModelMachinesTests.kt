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

    @Test fun readsAPeersAppModelsOrWhyThereAreNone() {
        val ok = PeerAppModels.answer(
            "david",
            """{"ok":true,"apps":[{"app":"voice","rows":[{"tag":null,"model":"claude/basic","source":"default"}]}],
              "options":[{"value":"claude/basic","runtime":"claude","tier":"basic","model":"haiku"}]}""",
        )
        assertEquals(listOf("voice"), ok.apps?.map { it.app })
        assertEquals(listOf("claude/basic"), ok.options.map { it.value })
        assertEquals(false, ok.isLoading)
        // An older core answers with its page, or with a 404 that is not the hub's own.
        assertEquals(true, PeerAppModels.answer("david", "<!doctype html><html></html>").old)
        assertEquals(true, PeerAppModels.failure("david", 404, "not found").old)
        assertEquals("unknown peer: david", PeerAppModels.failure("david", 404, "unknown peer: david").error)
        assertEquals("fetch failed", PeerAppModels.failure("david", 502, "fetch failed").error)
        assertEquals("timeout", PeerAppModels.answer("david", """{"ok":false,"error":"timeout"}""").error)
        assertEquals(true, PeerAppModels("david").isLoading)
        val saved = ok.replacing(AppModelRows("voice", listOf(AppModelRows.Row(model = "codex/basic", override = "codex/basic"))))
        assertEquals("codex/basic", saved.apps?.single()?.rows?.single()?.override)
    }

    @Test fun aPeersAppIsSavedAndDrawnThroughTheHub() {
        assertEquals("/api/panel/apps/todo/model", PeerAppModels.savePath("todo", null))
        assertEquals("/api/peers/david/apps/voice/model", PeerAppModels.savePath("voice", "david"))
        assertEquals("/api/peers/david/model/apps", PeerAppModels.path("david"))
        assertEquals("/api/peers/david/apps/voice/icon", PeerAppModels.iconPath("david", "voice"))
    }

    private val inventory = """
    {"ok":true,"machines":[
      {"machine":"","via":"local","reachable":true,"clis":[
        {"cli":"claude","kind":"claude-code","installed":true,"signedIn":true,"version":"2.1.0","path":"/usr/bin/claude","checkedAt":"2026-10-27T01:00:00.000Z","configured":true,"runtimes":["claude"]},
        {"cli":"codex","kind":"codex","installed":true,"signedIn":false,"version":"0.9","checkedAt":"2026-10-27T02:00:00.000Z","configured":false,"runtimes":[]},
        {"cli":"dsh","kind":"deepseek-harness","installed":false,"configured":false,"runtimes":[]}
      ]},
      {"machine":"gpu","via":"ssh","reachable":false,"clis":[{"cli":"claude","kind":"claude-code","configured":true,"runtimes":["gpu-claude"]}]},
      {"machine":"david","via":"peer","stale":true,"clis":[{"cli":"codex","kind":"codex","installed":true,"configured":false,"runtimes":[]}]},
      {"machine":"old","via":"peer","old":true,"clis":[]},
      {"via":"peer"}
    ]}
    """.trimIndent()

    @Test fun readsTheAgentClisByMachine() {
        val rows = Inventory.decode(inventory)
        assertEquals(listOf("", "gpu", "david", "old"), rows.map { it.machine })
        assertEquals(listOf("claude", "codex", "dsh"), Inventory.cliNames(rows))
        val here = rows[0]
        assertEquals(
            listOf(CliInfo.State.SignedIn, CliInfo.State.SignedOut, CliInfo.State.Missing),
            here.clis.map { it.state },
        )
        assertEquals(CliInfo.State.Unknown, rows[1].cli("claude")?.state)
        assertEquals(CliInfo.State.Installed, rows[2].cli("codex")?.state)
        assertEquals(
            listOf(MachineInventory.Note.None, MachineInventory.Note.Unreachable, MachineInventory.Note.Offline, MachineInventory.Note.Old),
            rows.map { it.note },
        )
        assertEquals(listOf(false, true, true, false), rows.map { it.isOff })
        assertEquals("2026-10-27T02:00:00.000Z", Inventory.lastChecked(rows))
        assertEquals(listOf("claude"), here.usableClis)
        assertEquals(listOf("codex"), Inventory.machine(rows, "david")?.usableClis)
        assertEquals("", Inventory.machine(rows, null)?.machine)
    }

    @Test fun onlyAClisFoundHereAndUnusedCanBeAdded() {
        val rows = Inventory.decode(inventory)
        val here = rows[0]
        assertEquals(listOf(false, true, false), here.clis.map { here.canAdd(it) })
        // Added since the Space started: the button goes until a restart.
        assertEquals(false, here.canAdd(here.cli("codex")!!, setOf("codex")))
        // A peer's CLI is changed there.
        assertEquals(false, rows[2].canAdd(rows[2].cli("codex")!!))
        assertEquals("""{"kind":"codex"}""", Inventory.addBody("codex").toString())
        assertEquals("codex", Inventory.addedRuntime("""{"ok":true,"runtime":"codex"}"""))
        assertNull(Inventory.addedRuntime("<html>"))
    }
}
