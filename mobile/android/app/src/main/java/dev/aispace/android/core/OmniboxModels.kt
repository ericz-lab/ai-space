package dev.aispace.android.core

import org.json.JSONObject

/**
 * The shared command contract of universal search (docs/shortcuts.md), as the iPhone client reads
 * it (OmniboxModels.swift). Calendar inputs stay strings, never instants: the Space reads them in
 * the zone the request names.
 */
data class ShortcutAction(
    val id: String,
    val peer: String? = null,
    val title: String,
    val effect: String,
    val available: Boolean,
    val reason: String? = null,
    val idempotent: Boolean? = null,
    val inputs: List<Input> = emptyList(),
    val i18n: Map<String, Translation>? = null,
) {
    data class Input(
        val name: String,
        val type: String,
        val label: String,
        val required: Boolean? = null,
        val default: JSONValue? = null,
        val options: List<Option>? = null,
        val min: Double? = null,
        val max: Double? = null,
    ) {
        companion object : JsonReader<Input> {
            override fun from(o: JSONObject): Input? {
                return Input(
                    name = o.str("name") ?: return null,
                    type = o.str("type") ?: return null,
                    label = o.str("label") ?: return null,
                    required = o.bool("required"),
                    default = if (o.has("default")) JSONValue.of(o.opt("default")) else null,
                    options = o.arr("options")?.let { Json.lossy(it, Option) },
                    min = o.dbl("min"),
                    max = o.dbl("max"),
                )
            }
        }
    }

    data class Option(val value: String, val label: String) {
        companion object : JsonReader<Option> {
            override fun from(o: JSONObject): Option? {
                return Option(o.str("value") ?: return null, o.str("label") ?: return null)
            }
        }
    }

    data class Translation(val title: String? = null, val inputs: Map<String, String>? = null, val options: Map<String, String>? = null) {
        companion object : JsonReader<Translation> {
            private fun strings(o: JSONObject?): Map<String, String>? =
                o?.keyList()?.mapNotNull { k -> o.str(k)?.let { k to it } }?.toMap()

            override fun from(o: JSONObject): Translation {
                return Translation(o.str("title"), strings(o.obj("inputs")), strings(o.obj("options")))
            }
        }
    }

    fun translation(lang: String = Lang.current): Translation? {
        val i18n = i18n ?: return null
        return i18n[lang] ?: i18n.entries.firstOrNull { it.key.split("-").first() == lang }?.value
    }

    fun displayTitle(lang: String = Lang.current): String = translation(lang)?.title ?: title

    fun label(input: Input, lang: String = Lang.current): String = translation(lang)?.inputs?.get(input.name) ?: input.label

    fun optionLabel(option: Option, lang: String = Lang.current): String = translation(lang)?.options?.get(option.value) ?: option.label

    /** The form's first values: what the resolver read from the text, else each input's default. */
    fun initial(args: Map<String, JSONValue>): Map<String, String> =
        inputs.associate { it.name to ((args[it.name] ?: it.default)?.compact ?: "") }

    fun valid(values: Map<String, String>): Boolean = inputs.all { input ->
        val value = (values[input.name] ?: "").trim()
        when {
            value.isEmpty() -> input.required != true
            input.type == "number" -> {
                val n = value.toDoubleOrNull()
                n != null && n.isFinite() && n >= (input.min ?: -Double.MAX_VALUE) && n <= (input.max ?: Double.MAX_VALUE)
            }
            input.type == "choice" || input.type == "task" -> input.options?.any { it.value == value } == true
            // The Space checks calendar dates, times and periods in the supplied zone.
            else -> true
        }
    }

    fun payload(values: Map<String, String>): JSONObject {
        val out = JSONObject()
        for (input in inputs) {
            val value = values[input.name] ?: continue
            if (value.isBlank()) continue
            if (input.type == "number") value.toDoubleOrNull()?.let { out.put(input.name, it) } else out.put(input.name, value)
        }
        return out
    }

    companion object : JsonReader<ShortcutAction> {
        override fun from(o: JSONObject): ShortcutAction? {
            return ShortcutAction(
                id = o.str("id") ?: return null,
                peer = o.str("peer"),
                title = o.str("title") ?: return null,
                effect = o.str("effect") ?: return null,
                available = o.bool("available") ?: return null,
                reason = o.str("reason"),
                idempotent = o.bool("idempotent"),
                inputs = Json.lossy(o.arr("inputs"), Input),
                i18n = o.obj("i18n")?.let { m -> m.keyList().mapNotNull { k -> m.obj(k)?.let { k to Translation.from(it) } }.toMap() },
            )
        }
    }
}

data class ShortcutIntent(
    val kind: String,
    val key: String,
    val expression: String? = null,
    val action: ShortcutAction? = null,
    val args: Map<String, JSONValue>? = null,
    val strong: Boolean? = null,
    val ambiguous: Boolean? = null,
) {
    val id: String get() = key

    companion object : JsonReader<ShortcutIntent> {
        override fun from(o: JSONObject): ShortcutIntent? {
            return ShortcutIntent(
                kind = o.str("kind") ?: return null,
                key = o.str("key") ?: return null,
                expression = o.str("expression"),
                action = o.obj("action")?.let { ShortcutAction.from(it) },
                args = o.obj("args")?.let { JSONValue.fieldsOf(it) },
                strong = o.bool("strong"),
                ambiguous = o.bool("ambiguous"),
            )
        }
    }
}

data class ShortcutAgentIntent(
    val id: String,
    val title: String,
    val agent: String,
    val available: Boolean,
    val reason: String? = null,
) {
    companion object : JsonReader<ShortcutAgentIntent> {
        override fun from(o: JSONObject): ShortcutAgentIntent? {
            return ShortcutAgentIntent(
                id = o.str("id") ?: return null,
                title = o.str("title") ?: return null,
                agent = o.str("agent") ?: return null,
                available = o.bool("available") ?: return null,
                reason = o.str("reason"),
            )
        }
    }
}

/**
 * The resolver's answer. Precedence is the server's (28e789e): a matching agent leaves `intents`
 * empty, and `ambiguous` says when the person has to choose.
 */
data class ShortcutResolution(
    val intents: List<ShortcutIntent>,
    val agentIntents: List<ShortcutAgentIntent>,
    val ambiguous: Boolean,
) {
    companion object : JsonReader<ShortcutResolution> {
        override fun from(o: JSONObject): ShortcutResolution {
            return ShortcutResolution(
                Json.lossy(o.arr("intents"), ShortcutIntent),
                Json.lossy(o.arr("agentIntents"), ShortcutAgentIntent),
                o.bool("ambiguous") == true,
            )
        }
    }
}

data class ShortcutResult(
    val kind: String,
    val text: String? = null,
    val value: JSONValue? = null,
    val unit: String? = null,
    val detail: String? = null,
    val source: String? = null,
    val asOf: String? = null,
    val stale: Boolean? = null,
    val items: List<Item>? = null,
    val task: String? = null,
    val status: String? = null,
    val output: String? = null,
    val error: String? = null,
) {
    data class Item(
        val title: String,
        val url: String? = null,
        val detail: String? = null,
        val source: String? = null,
        val date: String? = null,
        val time: String? = null,
        val timezone: String? = null,
        val at: String? = null,
    ) {
        companion object : JsonReader<Item> {
            override fun from(o: JSONObject): Item? {
                return Item(
                    o.str("title") ?: return null, o.str("url"), o.str("detail"), o.str("source"),
                    o.str("date"), o.str("time"), o.str("timezone"), o.str("at"),
                )
            }
        }
    }

    companion object : JsonReader<ShortcutResult> {
        override fun from(o: JSONObject): ShortcutResult? {
            return ShortcutResult(
                kind = o.str("kind") ?: return null,
                text = o.str("text"),
                value = if (o.has("value")) JSONValue.of(o.opt("value")) else null,
                unit = o.str("unit"),
                detail = o.str("detail"),
                source = o.str("source"),
                asOf = o.str("asOf"),
                stale = o.bool("stale"),
                items = o.arr("items")?.let { Json.lossy(it, Item) },
                task = o.str("task"),
                status = o.str("status"),
                output = o.str("output"),
                error = o.str("error"),
            )
        }
    }
}

data class ShortcutRun(
    val id: Long,
    val title: String,
    val status: String,
    val effect: String,
    val result: ShortcutResult? = null,
    val error: String? = null,
    val createdAt: String,
) {
    companion object : JsonReader<ShortcutRun> {
        override fun from(o: JSONObject): ShortcutRun? {
            return ShortcutRun(
                id = o.long("id") ?: return null,
                title = o.str("title") ?: return null,
                status = o.str("status") ?: return null,
                effect = o.str("effect") ?: return null,
                result = o.obj("result")?.let { ShortcutResult.from(it) },
                error = o.str("error"),
                createdAt = o.str("createdAt") ?: return null,
            )
        }
    }
}

/**
 * The Home command box's rules (docs/panel.md#omnibox), as the web panel's `src/web/omnibox.ts`
 * and the Mac's OmniboxRules.swift: how well an entry's name fits the query, and whether Search
 * opens the best match or asks Space Assistant. Keep them in step.
 */
object OmniboxRules {
    /** A name that equals the query, starts with it, has a word starting with it, or holds it; else a match elsewhere. */
    object Score {
        const val EXACT = 100
        const val PREFIX = 80
        const val WORD = 60
        const val INSIDE = 50
        const val TEXT = 10
    }

    /** At or above this, the best match is a name the person typed: Search opens it. */
    const val OPEN_SCORE = Score.INSIDE

    private val separators = Regex("[ \\-_/·.\\s]+")

    /** The entry's titles in every language and its layout id. */
    fun names(e: CatalogueEntry): List<String> = listOf(e.title) + (e.i18n ?: emptyMap()).values.mapNotNull { it.title } + e.ref

    /** 0 when the library search would not show the entry; more the better a name fits. */
    fun score(query: String, e: CatalogueEntry): Int {
        val q = CatalogueSearch.fold(query.trim())
        if (q.isEmpty() || !CatalogueSearch.matches(e, q)) return 0
        var best = Score.TEXT
        for (raw in names(e)) {
            val name = CatalogueSearch.fold(raw)
            if (name == q) return Score.EXACT
            best = when {
                name.startsWith(q) -> maxOf(best, Score.PREFIX)
                name.split(separators).any { it.startsWith(q) } -> maxOf(best, Score.WORD)
                name.contains(q) -> maxOf(best, Score.INSIDE)
                else -> best
            }
        }
        return best
    }

    /** The matching entries, best first; equal scores keep the given order. */
    fun rank(query: String, entries: List<CatalogueEntry>): List<CatalogueEntry> =
        entries.mapIndexed { i, e -> Triple(i, score(query, e), e) }
            .filter { it.second > 0 }
            .sortedWith(compareByDescending<Triple<Int, Int, CatalogueEntry>> { it.second }.thenBy { it.first })
            .map { it.third }

    /** Search opens the best match when its name holds the whole query; anything else is a question. */
    fun opensByDefault(query: String, first: CatalogueEntry?): Boolean = first != null && score(query, first) >= OPEN_SCORE
}

/** Provisional text replaces its segment; a final event commits even an empty correction. */
class VoiceTranscript(private val prefix: String) {
    private val segments = java.util.TreeMap<Int, Pair<String, Boolean>>()

    fun update(id: Int, text: String, final: Boolean): String {
        if (segments[id]?.second != true) segments[id] = text to final
        return (listOf(prefix) + segments.values.map { it.first }).map { it.trim() }.filter { it.isNotEmpty() }.joinToString(" ")
    }
}

/** The realtime transcriber accepts at most 100 ms (3,200 bytes) of 16 kHz PCM16 per message. */
class VoicePCMFrames {
    private var pending = ByteArray(0)

    fun append(data: ByteArray): List<ByteArray> {
        pending += data
        val frames = ArrayList<ByteArray>()
        var at = 0
        while (pending.size - at >= FRAME) {
            frames.add(pending.copyOfRange(at, at + FRAME))
            at += FRAME
        }
        pending = pending.copyOfRange(at, pending.size)
        return frames
    }

    fun finish(): ByteArray? {
        if (pending.isEmpty()) return null
        val tail = pending
        pending = ByteArray(0)
        return tail
    }

    companion object {
        const val FRAME = 3200
    }
}
