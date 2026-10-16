package dev.aispace.android.live

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.aispace.android.core.SpaceApi
import dev.aispace.android.core.TerminalMachine
import dev.aispace.android.core.TerminalRoute
import dev.aispace.android.core.TerminalStatus
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import java.net.URI
import java.util.UUID

/**
 * The Space's terminal on this phone: where a shell can open, the sessions open here with
 * their tabs, and the passphrases typed for them. Kept while the app runs (by the app model, in
 * its scope), so leaving the page keeps the sessions and their scrollback; nothing of it is
 * written down.
 */
class TerminalStore(api: SpaceApi, scope: CoroutineScope) : HubStore(api, scope) {
    /** A machine waiting for its passphrase, with what the Space said about the last one. */
    data class Ask(val machine: TerminalMachine, val message: String? = null) {
        val id: String get() = machine.id
    }

    var status by mutableStateOf<TerminalStatus?>(null)
        private set
    var tabs by mutableStateOf<List<TerminalTab>>(emptyList())
        private set
    var current by mutableStateOf<UUID?>(null)
    var asking by mutableStateOf<Ask?>(null)

    /** What is being typed for it; view state lives here, as on the other pages. */
    var passphraseDraft by mutableStateOf("")
    var showingRecent by mutableStateOf(false)
    var openLink: (URI) -> Unit = {}

    /** By machine, in memory only, as the panel's page keeps it for a page load. */
    private val passphrases = HashMap<String, String>()
    private val counters = HashMap<String, Int>()

    val machines: List<TerminalMachine> get() = status?.machines ?: emptyList()
    val currentTab: TerminalTab? get() = tabs.firstOrNull { it.id == current }

    override suspend fun load() {
        status = api.get(TerminalRoute.status, TerminalStatus)
    }

    /** A new shell on that machine, after its passphrase when the Space says it wants one. */
    fun open(machine: TerminalMachine) {
        if (machine.peer == null && status?.passphrase == true && passphrases[machine.id] == null) {
            asking = Ask(machine)
            return
        }
        val n = (counters[machine.id] ?: 0) + 1
        counters[machine.id] = n
        val session = TerminalSession(api, machine, scope)
        val tab = TerminalTab("${machine.name} #$n", session, passphrases[machine.id]) { url -> openLink(url) }
        session.onPassphrase = { message ->
            passphrases.remove(machine.id)
            // The tab never had a shell; the next try is a new one.
            remove(tab)
            asking = Ask(machine, message)
        }
        session.onClosed = { scope.launch { refresh() } }
        tabs = tabs + tab
        current = tab.id
    }

    fun submit(machine: TerminalMachine) {
        val passphrase = passphraseDraft
        passphraseDraft = ""
        asking = null
        if (passphrase.isEmpty()) return
        passphrases[machine.id] = passphrase
        open(machine)
    }

    /** Closes the tab; its shell is hung up by the Space. */
    fun close(tab: TerminalTab) {
        tab.session.close()
        remove(tab)
    }

    /** Every session of this Space ends: it was signed out of, or removed. */
    fun closeAll() {
        val all = tabs
        tabs = emptyList()
        current = null
        passphrases.clear()
        asking = null
        for (tab in all) tab.session.close()
    }

    private fun remove(tab: TerminalTab) {
        val list = tabs
        val i = list.indexOfFirst { it.id == tab.id }
        if (i < 0) return
        val next = list.toMutableList().also { it.removeAt(i) }
        tabs = next
        if (current == tab.id) current = if (i in next.indices) next[i].id else next.lastOrNull()?.id
    }
}
