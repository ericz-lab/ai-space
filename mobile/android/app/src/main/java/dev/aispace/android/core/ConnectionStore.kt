package dev.aispace.android.core

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.URI
import java.util.UUID

/**
 * The saved connections, kept as one JSON file in the app's own files, separate from any Space
 * workspace. Exactly one connection is the default while any exist.
 *
 * Safe to call from any thread; changes are published on [connections].
 */
class ConnectionStore(private val file: File) {
    private val state = MutableStateFlow<List<Connection>>(emptyList())
    val connections: StateFlow<List<Connection>> = state.asStateFlow()

    /** The path of an unreadable file that was set aside at load, for the operator. */
    @Volatile var loadError: String? = null
        private set

    private val lock = Any()

    init {
        load()
    }

    val defaultConnection: Connection? get() = state.value.let { list -> list.firstOrNull { it.isDefault } ?: list.firstOrNull() }

    fun connection(id: UUID): Connection? = state.value.firstOrNull { it.id == id }

    fun add(name: String, url: URI, makeDefault: Boolean = false): Connection = synchronized(lock) {
        val list = state.value
        val c = Connection(name = displayName(name, url), url = url, isDefault = makeDefault || list.isEmpty())
        val base = if (c.isDefault) list.map { it.copy(isDefault = false) } else list
        commit(base + c)
        c
    }

    fun update(id: UUID, name: String, url: URI) {
        synchronized(lock) {
            val list = state.value
            if (list.none { it.id == id }) return
            commit(list.map { if (it.id == id) it.copy(name = displayName(name, url), url = url) else it })
        }
    }

    fun setDefault(id: UUID) {
        synchronized(lock) {
            val list = state.value
            if (list.none { it.id == id }) return
            commit(list.map { it.copy(isDefault = it.id == id) })
        }
    }

    fun remove(id: UUID) {
        synchronized(lock) {
            var list = state.value.filter { it.id != id }
            if (list.isNotEmpty() && list.none { it.isDefault }) list = listOf(list[0].copy(isDefault = true)) + list.drop(1)
            commit(list)
        }
    }

    private fun commit(list: List<Connection>) {
        state.value = list
        save(list)
    }

    private fun load() {
        val text = TextFiles.read(file) ?: return
        val decoded = decode(text)
        if (decoded != null) {
            state.value = decoded
        } else {
            // Keep the unreadable file for the operator instead of overwriting it on the next save.
            val aside = File(file.parentFile, file.nameWithoutExtension + ".unreadable.json")
            aside.delete()
            if (file.renameTo(aside)) loadError = aside.path
        }
    }

    private fun save(list: List<Connection>) {
        val array = JSONArray()
        for (c in list) {
            array.put(
                JSONObject()
                    .put("id", c.id.toString().uppercase())
                    .put("name", c.name)
                    .put("url", c.url.toString())
                    .put("isDefault", c.isDefault),
            )
        }
        try {
            TextFiles.writeAtomically(file, array.toString(2))
        } catch (e: IOException) {
            System.err.println("ai-space: could not save connections: ${e.message}")
        }
    }

    companion object {
        private fun displayName(name: String, url: URI): String {
            val trimmed = name.trim()
            return trimmed.ifEmpty { Urls.host(url) ?: url.toString() }
        }

        /** The file's connections, or null when it is not a list of them (any bad row fails it, as on iOS). */
        internal fun decode(text: String): List<Connection>? {
            val array = try {
                JSONArray(text)
            } catch (e: JSONException) {
                return null
            }
            val out = ArrayList<Connection>()
            for (i in 0 until array.length()) {
                val o = array.opt(i) as? JSONObject ?: return null
                val id = o.str("id")?.let { runCatching { UUID.fromString(it) }.getOrNull() } ?: return null
                val name = o.str("name") ?: return null
                val url = Urls.parse(o.str("url")) ?: return null
                val isDefault = o.bool("isDefault") ?: return null
                out.add(Connection(id, name, url, isDefault))
            }
            return out
        }
    }
}
