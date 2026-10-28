package dev.aispace.android.core

/**
 * One agent, whatever the number of machines it runs on (src/web/agent-groups.ts,
 * docs/peers.md#agents-on-several-machines). An app deployed on the Space's machine and on peers
 * declares the same agent under the same `app/name` on each; the catalogue lists one entry per
 * machine. The phone shows it once: the local variant (else the first peer that answers, else the
 * first listed) stands for the group in the library, search and on the screens, and the chat picks
 * the machine. Chat routes, sessions and runs stay per machine, so every variant keeps its own key.
 */
data class AgentGroup(
    /** `<app>/<name>`, the same on every machine. */
    val key: String,
    /** The variant that stands for the group. */
    val primary: CatalogueEntry,
    /** Every machine's variant: the local one first, then the peers in the catalogue's order. */
    val machines: List<CatalogueEntry>,
) {
    /** The variant on a machine: a peer's name, or null for the Space's own machine. */
    fun machine(peer: String?): CatalogueEntry? = machines.firstOrNull { it.peer == peer }
}

object AgentGroups {
    /** `<app>/<name>` of an agent entry: its ref without the `<peer>/` in front. */
    fun keyOf(entry: CatalogueEntry): String {
        val peer = entry.peer
        return if (peer != null && entry.ref.startsWith("$peer/")) entry.ref.removePrefix("$peer/") else entry.ref
    }

    /** A variant whose machine does not answer: shown offline, not sent to. */
    fun isOffline(entry: CatalogueEntry): Boolean = entry.reach == Reach.peerOffline

    /** Groups in the order their first variant has in the catalogue; within a group the local variant comes first. */
    fun group(agents: List<CatalogueEntry>): List<AgentGroup> {
        val order = ArrayList<String>()
        val primary = HashMap<String, CatalogueEntry>()
        val machines = HashMap<String, MutableList<CatalogueEntry>>()
        for (a in agents) {
            val key = keyOf(a)
            val list = machines[key]
            val p = primary[key]
            if (list == null || p == null) {
                order += key
                primary[key] = a
                machines[key] = mutableListOf(a)
            } else if (a.peer == null && p.peer != null) {
                primary[key] = a
                list.add(0, a)
            } else {
                list += a
                // An offline peer does not stand for the group while another peer answers.
                if (p.peer != null && isOffline(p) && !isOffline(a)) primary[key] = a
            }
        }
        return order.map { AgentGroup(it, primary.getValue(it), machines.getValue(it)) }
    }

    /** The group whose variants include this entry key (`agent:<ref>`). */
    fun byKey(groups: List<AgentGroup>, key: String): AgentGroup? =
        groups.firstOrNull { g -> g.machines.any { it.key == key } }

    /**
     * The variant a tile opens: the machine chosen last time ([remembered]: a peer's name, "" for
     * the Space's own machine, null when never chosen) while it is listed and answering, else the
     * primary. The choice is kept, so it comes back once that machine answers again.
     */
    fun preferred(group: AgentGroup, remembered: String?): CatalogueEntry {
        if (remembered == null) return group.primary
        val m = group.machine(remembered.ifEmpty { null })
        return if (m != null && !isOffline(m)) m else group.primary
    }

    /**
     * Screen items with every agent key pointed at its group's primary and repeats dropped, so a
     * layout pinned with one key per machine shows one tile; keys of agents the catalogue does not
     * list are kept as they are.
     */
    fun canonicalItems(items: List<String>, groups: List<AgentGroup>): List<String> {
        val out = ArrayList<String>()
        for (key in items) {
            val next = if (key.startsWith("agent:")) byKey(groups, key)?.primary?.key ?: key else key
            if (next !in out) out += next
        }
        return out
    }

    /** Every screen's items through [canonicalItems]. */
    fun canonicalScreens(screens: List<PanelScreen>, groups: List<AgentGroup>): List<PanelScreen> =
        screens.map { it.copy(items = canonicalItems(it.items, groups)) }
}
