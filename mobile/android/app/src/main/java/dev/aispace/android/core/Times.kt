package dev.aispace.android.core

import java.time.Duration
import java.time.Instant
import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException

/** The API's instants: ISO 8601 in UTC, with or without fractional seconds (docs/time.md). */
object ISO8601 {
    fun parse(text: String): Instant? = try {
        OffsetDateTime.parse(text, DateTimeFormatter.ISO_OFFSET_DATE_TIME).toInstant()
    } catch (e: DateTimeParseException) {
        null
    }

    /** `2026-10-13T03:08:00.000Z`, as the Space writes instants. */
    fun format(instant: Instant): String = DateTimeFormatter.ISO_INSTANT.format(instant)
}

/**
 * How the API's instants read on the phone (docs/time.md). The words are English or Chinese by
 * [Lang]; a view that wants other wording formats from the instant itself.
 */
object Times {
    /** The Swift `Date.distantPast`: what a catalogue that was never fetched carries. */
    val distantPast: Instant = Instant.parse("0001-01-01T00:00:00Z")

    fun parse(text: String): Instant? = ISO8601.parse(text)

    /** Milliseconds since 1970 as an instant (task runs, backups, terminal rows). */
    fun fromMillis(ms: Double): Instant {
        val whole = Math.floor(ms)
        return Instant.ofEpochMilli(whole.toLong()).plusNanos(((ms - whole) * 1_000_000).toLong())
    }

    /** "2h ago"; an instant within the last minute, or one a skewed clock puts ahead, is "now". */
    fun ago(date: Instant, now: Instant = Instant.now(), lang: String = Lang.current): String {
        if (date.isAfter(now.minusSeconds(60))) return if (lang == "zh") "刚刚" else "now"
        return relative(date, now, lang)
    }

    /** "in 5m" or "2h ago" (`.relative(presentation: .numeric, unitsStyle: .narrow)`). */
    fun relative(date: Instant, now: Instant = Instant.now(), lang: String = Lang.current): String {
        val seconds = Duration.between(now, date).seconds
        val future = seconds > 0
        val a = Math.abs(seconds)
        val (n, unit) = when {
            a < 60 -> a to 0
            a < 3600 -> a / 60 to 1
            a < 86400 -> a / 3600 to 2
            a < 7 * 86400 -> a / 86400 to 3
            a < 30 * 86400 -> a / (7 * 86400) to 4
            a < 365 * 86400 -> a / (30 * 86400) to 5
            else -> a / (365 * 86400) to 6
        }
        return if (lang == "zh") {
            val names = arrayOf("秒", "分钟", "小时", "天", "周", "个月", "年")
            "$n${names[unit]}" + if (future) "后" else "前"
        } else {
            val names = arrayOf("s", "m", "h", "d", "w", "mo", "y")
            if (future) "in $n${names[unit]}" else "$n${names[unit]} ago"
        }
    }
}

/** Rounding as Swift's `rounded()`: to nearest, halves away from zero. */
internal fun roundHalfAway(x: Double): Double = if (x < 0) -Math.floor(-x + 0.5) else Math.floor(x + 0.5)
