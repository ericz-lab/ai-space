package dev.aispace.android.core

import org.json.JSONObject
import java.text.DecimalFormat
import java.text.NumberFormat
import java.time.Duration
import java.time.Instant
import java.util.Currency
import java.util.Locale

/*
 * Widget blocks (docs/app-spec.md#blocks-a-state-card-instead-of-a-list, src/space/panel/blocks.ts):
 * the structured values an `items` widget may send next to its list. The Space has already
 * checked them; a block of a type this version does not know is dropped.
 */

/** A string, or the same text by language tag. */
sealed class BlockText {
    data class Plain(val value: String) : BlockText()
    data class ByLanguage(val texts: Map<String, String>) : BlockText()

    fun text(lang: String = Lang.current): String = when (this) {
        is Plain -> value
        is ByLanguage -> texts[lang]
            ?: texts.entries.firstOrNull { it.key.split('-').first() == lang }?.value
            ?: texts["en"]
            ?: texts.entries.sortedBy { it.key }.firstOrNull()?.value
            ?: ""
    }

    companion object {
        /** A JSON value as a text: a string, or an object whose every value is a string. */
        fun read(value: Any?): BlockText? {
            return when (value) {
                is String -> Plain(value)
                is JSONObject -> {
                    val m = LinkedHashMap<String, String>()
                    for (k in value.keyList()) m[k] = value.opt(k) as? String ?: return null
                    ByLanguage(m)
                }
                else -> null
            }
        }

        fun read(o: JSONObject, key: String): BlockText? = read(o.opt(key))
    }
}

enum class BlockTone {
    positive, negative, warning, neutral;

    companion object {
        fun of(raw: Any?): BlockTone? = entries.firstOrNull { it.name == raw }
    }
}

/** How a block's number is written. */
data class BlockNumber(
    val format: String? = null,
    val currency: String? = null,
    val decimals: Int? = null,
    val unit: BlockText? = null,
) {
    companion object : JsonReader<BlockNumber> {
        override fun from(o: JSONObject) = BlockNumber(o.str("format"), o.str("currency"), o.int("decimals"), BlockText.read(o, "unit"))
    }
}

data class WidgetBlock(
    val type: Kind,
    val label: BlockText,
    val caption: BlockText? = null,
    val url: String? = null,
    val tone: BlockTone? = null,
    val number: BlockNumber = BlockNumber(),
    /** The number of a metric, progress or gauge; null when the app could not obtain it. */
    val value: Double? = null,
    /** The text of a status. */
    val statusText: BlockText? = null,
    val display: BlockText? = null,
    val delta: Delta? = null,
    val style: String? = null,
    val signed: Boolean? = null,
    val points: List<Point>? = null,
    val min: Double? = null,
    val max: Double? = null,
    val zones: List<Zone>? = null,
    val time: String? = null,
    val tanks: List<Tank>? = null,
) {
    enum class Kind { metric, trend, progress, gauge, status, tanks }

    /** One upright tank of a `tanks` block: `value` of `max`, spilling over past it. */
    data class Tank(
        val label: BlockText,
        val value: Double?,
        val max: Double,
        val display: BlockText? = null,
        val tone: BlockTone? = null,
        val url: String? = null,
    ) {
        /** How full the tank is, 0 and up; above 1 it spills over. */
        val level: Double get() = if (value == null || max <= 0) 0.0 else Math.max(0.0, value / max)

        /** The app's own text, else the share of `max` in percent (WidgetBlocks.tsx `tankValue`). */
        fun shown(lang: String = Lang.current): String? =
            display?.text(lang) ?: value?.let { if (max > 0) BlockFormat.string(it / max * 100, BlockNumber(format = "percent", decimals = 0), lang) else null }

        companion object : JsonReader<Tank> {
            override fun from(o: JSONObject): Tank? {
                return Tank(BlockText.read(o, "label") ?: return null, o.dbl("value"), o.dbl("max") ?: 100.0, BlockText.read(o, "display"), BlockTone.of(o.opt("tone")), o.str("url"))
            }
        }
    }

    data class Delta(
        val value: Double,
        val format: String? = null,
        val currency: String? = null,
        val decimals: Int? = null,
        val unit: BlockText? = null,
        val label: BlockText? = null,
        val tone: BlockTone? = null,
    ) {
        val number: BlockNumber get() = BlockNumber(format, currency, decimals, unit)

        companion object : JsonReader<Delta> {
            override fun from(o: JSONObject): Delta? {
                return Delta(
                    value = o.dbl("value") ?: return null,
                    format = o.str("format"),
                    currency = o.str("currency"),
                    decimals = o.int("decimals"),
                    unit = BlockText.read(o, "unit"),
                    label = BlockText.read(o, "label"),
                    tone = BlockTone.of(o.opt("tone")),
                )
            }
        }
    }

    data class Point(val t: String, val v: Double?) {
        companion object : JsonReader<Point> {
            override fun from(o: JSONObject): Point? {
                return Point(o.str("t") ?: return null, o.dbl("v"))
            }
        }
    }

    data class Zone(val to: Double, val tone: BlockTone, val label: BlockText? = null) {
        companion object : JsonReader<Zone> {
            override fun from(o: JSONObject): Zone? {
                return Zone(o.dbl("to") ?: return null, BlockTone.of(o.opt("tone")) ?: return null, BlockText.read(o, "label"))
            }
        }
    }

    /** The value the block leads with, or null when the app could not obtain it (WidgetBlocks.tsx `shown`). */
    fun shown(lang: String = Lang.current): String? = when (type) {
        Kind.metric, Kind.progress -> display?.text(lang) ?: value?.let { BlockFormat.string(it, number, lang) }
        Kind.gauge -> display?.text(lang) ?: value?.let { BlockFormat.string(it, BlockNumber(), lang) }
        Kind.trend -> points?.lastOrNull { it.v != null }?.v?.let { BlockFormat.string(it, number, lang, signed = signed == true) }
        Kind.status -> statusText?.text(lang)
        Kind.tanks -> null
    }

    /** The tone the value is drawn in: the block's own, or for a gauge the zone its value is in. */
    val effectiveTone: BlockTone?
        get() {
            if (tone != null) return tone
            if (type != Kind.gauge || value == null) return null
            return zones?.firstOrNull { value <= it.to }?.tone
        }

    /** A progress as a share of its bar, 0…1. */
    val fraction: Double
        get() {
            val v = value ?: return 0.0
            val m = max ?: return 0.0
            if (m <= 0) return 0.0
            return (v / m).coerceIn(0.0, 1.0)
        }

    /** Where a value sits on a gauge's scale, 0…1. */
    fun position(v: Double): Double {
        val lo = min ?: 0.0
        val hi = max ?: 100.0
        if (hi <= lo) return 0.0
        return ((v - lo) / (hi - lo)).coerceIn(0.0, 1.0)
    }

    companion object : JsonReader<WidgetBlock> {
        override fun from(o: JSONObject): WidgetBlock? {
            val type = Kind.entries.firstOrNull { it.name == o.opt("type") } ?: return null
            val label = BlockText.read(o, "label") ?: return null
            val statusText = if (type == Kind.status) BlockText.read(o, "value") ?: return null else null
            return WidgetBlock(
                type = type,
                label = label,
                caption = BlockText.read(o, "caption"),
                url = o.str("url"),
                tone = BlockTone.of(o.opt("tone")),
                number = BlockNumber.from(o),
                value = if (type == Kind.status) null else o.dbl("value"),
                statusText = statusText,
                display = BlockText.read(o, "display"),
                delta = o.obj("delta")?.let { Delta.from(it) },
                style = o.str("style"),
                signed = o.bool("signed"),
                points = Json.all(o.arr("points"), Point),
                min = o.dbl("min"),
                max = o.dbl("max"),
                zones = Json.all(o.arr("zones"), Zone),
                time = o.str("time"),
                tanks = Json.all(o.arr("tanks"), Tank),
            )
        }
    }
}

/** Numbers in the reader's language, as the panel writes them (WidgetBlocks.tsx `fmt`). */
object BlockFormat {
    /** The locale numbers of a language are written in; `zh` is Simplified Chinese, `en` American English. */
    fun locale(lang: String): Locale = when (lang) {
        "zh" -> Locale.forLanguageTag("zh-Hans")
        "en" -> Locale.US
        else -> Locale.forLanguageTag(lang)
    }

    fun string(v: Double, n: BlockNumber, lang: String = Lang.current, signed: Boolean = false): String {
        val locale = locale(lang)
        var value = v
        var suffix = ""
        val d = n.decimals
        val f: NumberFormat
        when (n.format) {
            "percent" -> {
                f = NumberFormat.getPercentInstance(locale)
                value = v / 100
                f.minimumFractionDigits = d ?: 0
                f.maximumFractionDigits = d ?: 1
            }
            "currency" -> {
                f = NumberFormat.getCurrencyInstance(locale)
                // The currency first: setting it resets the fraction digits to the currency's own.
                val code = n.currency ?: "USD"
                try {
                    f.currency = Currency.getInstance(code)
                } catch (e: IllegalArgumentException) {
                    f.currency = Currency.getInstance("USD")
                }
                if (Math.abs(v) >= 100_000) {
                    val (cv, cs) = compact(v, lang)
                    value = cv
                    suffix = cs
                    f.minimumFractionDigits = 0
                    f.maximumFractionDigits = d ?: 2
                } else {
                    f.minimumFractionDigits = d ?: 2
                    f.maximumFractionDigits = d ?: 2
                }
            }
            "compact" -> {
                f = NumberFormat.getNumberInstance(locale)
                val (cv, cs) = compact(v, lang)
                value = cv
                suffix = cs
                f.minimumFractionDigits = 0
                f.maximumFractionDigits = d ?: 1
            }
            else -> {
                f = NumberFormat.getNumberInstance(locale)
                f.minimumFractionDigits = d ?: 0
                f.maximumFractionDigits = d ?: 2
            }
        }
        if (signed && v > 0 && f is DecimalFormat) f.positivePrefix = "+" + f.positivePrefix
        val s = f.format(value) + suffix
        val unit = n.unit?.text(lang) ?: ""
        return if (unit.isEmpty()) s else "$s $unit"
    }

    /** A large number in the units its language counts in: thousands, millions and billions, or 万 and 亿. */
    fun compact(v: Double, lang: String): Pair<Double, String> {
        val a = Math.abs(v)
        if (lang == "zh") {
            if (a >= 1e8) return v / 1e8 to "亿"
            if (a >= 1e4) return v / 1e4 to "万"
            return v to ""
        }
        if (a >= 1e12) return v / 1e12 to "T"
        if (a >= 1e9) return v / 1e9 to "B"
        if (a >= 1e6) return v / 1e6 to "M"
        if (a >= 1e3) return v / 1e3 to "K"
        return v to ""
    }
}

object WidgetLayout {
    /** Compact rows beside the hero, per card size (ROWS in WidgetBlocks.tsx). */
    fun rows(size: String?): Int = when (size) {
        "2x1" -> 4
        "1x2" -> 6
        "2x2" -> 10
        else -> 2
    }

    /** Whether the payload is older than the app said it stays true. */
    fun isOutdated(asOf: String?, staleAfterMs: Double?, now: Instant = Instant.now()): Boolean {
        if (asOf == null || staleAfterMs == null || staleAfterMs <= 0) return false
        val date = ISO8601.parse(asOf) ?: return false
        return Duration.between(date, now).toMillis().toDouble() > staleAfterMs
    }
}
