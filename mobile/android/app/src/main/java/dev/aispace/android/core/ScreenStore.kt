package dev.aispace.android.core

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.UUID

/**
 * The screens of each saved Space as this phone lays them out, kept in one JSON file here. A
 * phone, a browser and a Mac are different places to work from, so each has its own layout: the
 * first catalogue of a Space copies the panel's screens once, and from then on what is pinned,
 * moved or added here stays here and nothing is written to the Space.
 *
 * Safe to call from any thread; every change is published on [records] (keyed by the
 * connection's id, uppercase as iOS writes it) and written to the file at once.
 */
class ScreenStore(private val file: File) {
    data class Record(val screens: List<PanelScreen> = listOf(PanelScreen(id = Screens.home)), val seeded: Boolean = false) {
        fun toJson(): JSONObject =
            JSONObject().put("screens", JSONArray().also { a -> screens.forEach { a.put(it.toJson()) } }).put("seeded", seeded)

        companion object : JsonReader<Record> {
            override fun from(o: JSONObject): Record? {
                val screens = Json.all(o.arr("screens") ?: return null, PanelScreen) ?: return null
                return Record(screens, o.bool("seeded") ?: return null)
            }
        }
    }

    private val state = MutableStateFlow<Map<String, Record>>(emptyMap())
    val records: StateFlow<Map<String, Record>> = state.asStateFlow()
    private val lock = Any()

    init {
        TextFiles.read(file)?.let { decode(it) }?.let { state.value = it }
    }

    /** Home first; a Space that has not been copied yet has an empty home screen. */
    fun screens(connection: UUID): List<PanelScreen> = state.value[key(connection)]?.screens ?: Record().screens

    fun isPinned(key: String, connection: UUID, screen: String = Screens.home): Boolean =
        Screens.isPinned(screens(connection), screen, key)

    /** Takes the panel's screens as the phone's first layout, once per Space. */
    fun seed(connection: UUID, panel: List<PanelScreen>) {
        synchronized(lock) {
            if (state.value[key(connection)]?.seeded == true) return
            val copy = copy(panel)
            // A panel with nothing pinned is not a layout yet: wait for a catalogue that has one.
            if (copy.none { it.items.isNotEmpty() }) return
            write(connection, Record(copy, seeded = true))
        }
    }

    /** Replaces the phone's layout with the panel's as it is now, when the operator asks for it. */
    fun reset(connection: UUID, panel: List<PanelScreen>) {
        synchronized(lock) { write(connection, Record(copy(panel), seeded = true)) }
    }

    fun edit(connection: UUID, change: (List<PanelScreen>) -> List<PanelScreen>) {
        synchronized(lock) {
            // A layout made by hand is never overwritten by a later copy.
            write(connection, Record(normalized(change(screens(connection))), seeded = true))
        }
    }

    fun forget(connection: UUID) {
        synchronized(lock) {
            val k = key(connection)
            if (k !in state.value) return
            state.value = state.value - k
            save()
        }
    }

    private fun write(connection: UUID, record: Record) {
        val k = key(connection)
        if (state.value[k] == record) return
        state.value = state.value + (k to record)
        save()
    }

    private fun save() {
        val o = JSONObject()
        for ((k, r) in state.value) o.put(k, r.toJson())
        try {
            TextFiles.writeAtomically(file, o.toString(2))
        } catch (e: IOException) {
            System.err.println("ai-space: could not save the screens: ${e.message}")
        }
    }

    companion object {
        private fun key(connection: UUID) = connection.toString().uppercase()

        private fun decode(text: String): Map<String, Record>? {
            val o = Json.obj(text) ?: return null
            val out = LinkedHashMap<String, Record>()
            for (k in o.keyList()) {
                val r = (o.opt(k) as? JSONObject)?.let { Record.from(it) } ?: return null
                out[k.uppercase()] = r
            }
            return out
        }

        /**
         * The panel's screens as the phone keeps them: only entries of a kind the phone shows
         * (`builtin:` tiles are the panel's own windows), each once per screen. A key whose entry
         * is gone is kept, so it comes back with the entry.
         */
        fun copy(panel: List<PanelScreen>): List<PanelScreen> {
            val kinds = EntryKind.entries.map { it.name + ":" }
            return normalized(
                panel.map { s ->
                    val seen = HashSet<String>()
                    PanelScreen(s.id, s.name, s.items.filter { key -> kinds.any { key.startsWith(it) } && seen.add(key) })
                },
            )
        }

        /** Home exists and comes first, ids are unique, and there are no more screens than the limit. */
        private fun normalized(screens: List<PanelScreen>): List<PanelScreen> {
            val seen = HashSet<String>()
            val out = screens.filter { seen.add(it.id) }.toMutableList()
            val i = out.indexOfFirst { it.id == Screens.home }
            if (i >= 0) out.add(0, out.removeAt(i)) else out.add(0, PanelScreen(id = Screens.home))
            return out.take(Screens.limit)
        }
    }
}
