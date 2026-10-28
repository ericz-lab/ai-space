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
}
