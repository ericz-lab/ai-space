package dev.aispace.android.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AgentGroupsTests {
    private fun agent(app: String, name: String, peer: String? = null, offline: Boolean = false) = CatalogueEntry(
        kind = EntryKind.agent,
        ref = listOfNotNull(peer, app, name).joinToString("/"),
        title = name,
        peer = peer,
        reach = if (offline) Reach.peerOffline else Reach.unknown,
    )

    @Test fun groupsTheSameAgentAcrossMachinesLocalFirst() {
        val agents = listOf(
            agent("ops", "engineer", peer = "david"),
            agent("todo", "planner"),
            agent("ops", "engineer"),
            agent("ops", "engineer", peer = "lab"),
        )
        val groups = AgentGroups.group(agents)
        assertEquals(listOf("ops/engineer", "todo/planner"), groups.map { it.key })
        val ops = groups[0]
        assertEquals("agent:ops/engineer", ops.primary.key)
        assertEquals(listOf(null, "david", "lab"), ops.machines.map { it.peer })
        assertEquals("agent:david/ops/engineer", ops.machine("david")?.key)
    }

    @Test fun anOfflinePeerDoesNotStandForTheGroupWhileAnotherAnswers() {
        val groups = AgentGroups.group(listOf(agent("ops", "engineer", "david", offline = true), agent("ops", "engineer", "lab")))
        assertEquals("lab", groups.single().primary.peer)
        assertEquals(listOf("david", "lab"), groups.single().machines.map { it.peer })
        // Every machine offline: the first listed stands for it.
        val all = AgentGroups.group(listOf(agent("ops", "engineer", "david", offline = true), agent("ops", "engineer", "lab", offline = true)))
        assertEquals("david", all.single().primary.peer)
    }

    @Test fun opensTheRememberedMachineWhileItAnswers() {
        val g = AgentGroups.group(
            listOf(agent("ops", "engineer"), agent("ops", "engineer", "david"), agent("ops", "engineer", "lab", offline = true)),
        ).single()
        assertNull(AgentGroups.preferred(g, null).peer)
        assertEquals("david", AgentGroups.preferred(g, "david").peer)
        assertNull(AgentGroups.preferred(g, "").peer)
        // Offline or gone: the primary, and the choice is kept for later.
        assertNull(AgentGroups.preferred(g, "lab").peer)
        assertNull(AgentGroups.preferred(g, "nowhere").peer)
    }

    @Test fun pointsPinnedVariantsAtTheGroup() {
        val groups = AgentGroups.group(listOf(agent("ops", "engineer"), agent("ops", "engineer", "david")))
        val items = listOf("app:todo", "agent:david/ops/engineer", "agent:ops/engineer", "agent:gone/x", "widget:todo/today")
        assertEquals(listOf("app:todo", "agent:ops/engineer", "agent:gone/x", "widget:todo/today"), AgentGroups.canonicalItems(items, groups))
        assertEquals("david", AgentGroups.byKey(groups, "agent:david/ops/engineer")?.machines?.get(1)?.peer)
    }

    @Test fun theCatalogueShowsEachAgentOnceAndMarksAStaleOne() {
        val agents = """
        {"ok":true,"agents":[
          {"id":"space/assistant","app":"space","name":"assistant","title":"Space Assistant"},
          {"id":"david/space/assistant","peer":"david","app":"space","name":"assistant","title":"Space Assistant","stale":true},
          {"id":"lab/space/assistant","peer":"lab","app":"space","name":"assistant","title":"Space Assistant"}
        ]}
        """.trimIndent()
        val c = Catalogue.decode(Fixture.payload(agents = agents, peers = null))
        assertEquals(3, c.agents.size)
        assertEquals(listOf("agent:space/assistant"), c.shownAgents.map { it.key })
        assertEquals(1, c.searchEntries.count { it.kind == EntryKind.agent })
        assertEquals(Reach.peerOffline, c.entry("agent:david/space/assistant")?.reach)
        assertEquals(Reach.unknown, c.entry("agent:lab/space/assistant")?.reach)
        assertEquals("space/assistant", c.agentGroup("agent:lab/space/assistant")?.key)
    }
}
