package dev.aispace.android.core

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * Tolerant JSON reading over org.json, the counterpart of the iOS client's optional and `Lossy`
 * decoding: a missing or mistyped optional field reads as null, an unknown field is ignored, and a
 * row of a list that cannot be read is dropped instead of failing the whole answer.
 *
 * Values are taken as they are and never coerced: a number is not a string, `1` is not `true`.
 */

/** Reads one value of type [T] from a JSON object, or null when the object is not one. */
fun interface JsonReader<T> {
    fun from(o: JSONObject): T?
}

/** An answer that is not the JSON a route sends. */
class DecodingException(message: String, cause: Throwable? = null) : Exception(message, cause)

object Json {
    /** The text as a JSON object, or null when it is not one. */
    fun obj(text: String?): JSONObject? {
        if (text == null) return null
        return try {
            JSONObject(text)
        } catch (e: JSONException) {
            null
        }
    }

    /** The text as a JSON object; throws [DecodingException] when it is not one. */
    fun requireObj(text: String?): JSONObject =
        obj(text) ?: throw DecodingException("not a JSON object")

    /** Reads one [T] from the text; throws [DecodingException] when the text or the value is not one. */
    fun <T> decode(text: String?, reader: JsonReader<T>): T =
        reader.from(requireObj(text)) ?: throw DecodingException("unexpected shape")

    /** The objects of an array that [reader] can read; the others are skipped (Swift `Lossy`). */
    fun <T> lossy(array: JSONArray?, reader: JsonReader<T>): List<T> {
        if (array == null) return emptyList()
        val out = ArrayList<T>(array.length())
        for (i in 0 until array.length()) {
            val o = array.opt(i) as? JSONObject ?: continue
            val value = try {
                reader.from(o)
            } catch (e: JSONException) {
                null
            }
            if (value != null) out.add(value)
        }
        return out
    }

    /**
     * Every element of an array read by [reader], or null when any one of them cannot be read
     * (a Swift `[T]` decoded with `try?`: all or nothing).
     */
    fun <T> all(array: JSONArray?, reader: JsonReader<T>): List<T>? {
        if (array == null) return null
        val out = ArrayList<T>(array.length())
        for (i in 0 until array.length()) {
            val o = array.opt(i) as? JSONObject ?: return null
            out.add(reader.from(o) ?: return null)
        }
        return out
    }

    /** A Double as a number of whole units, when it is one. */
    internal fun exactInt(n: Number?): Long? {
        if (n == null) return null
        return when (n) {
            is Int, is Long, is Short, is Byte -> n.toLong()
            else -> {
                val d = n.toDouble()
                if (d.isFinite() && d == Math.floor(d) && Math.abs(d) < 9.0E18) d.toLong() else null
            }
        }
    }
}

/** A string field, or null when absent, null or not a string. */
fun JSONObject.str(key: String): String? = opt(key) as? String

/** A boolean field, or null when absent, null or not a boolean. */
fun JSONObject.bool(key: String): Boolean? = opt(key) as? Boolean

/** A number field as a Double, or null when absent, null or not a number. */
fun JSONObject.dbl(key: String): Double? = (opt(key) as? Number)?.toDouble()

/** A whole-number field, or null when absent, null, not a number or not whole. */
fun JSONObject.int(key: String): Int? = Json.exactInt(opt(key) as? Number)?.let {
    if (it in Int.MIN_VALUE..Int.MAX_VALUE) it.toInt() else null
}

/** A whole-number field as a Long. */
fun JSONObject.long(key: String): Long? = Json.exactInt(opt(key) as? Number)

/** An object field, or null. */
fun JSONObject.obj(key: String): JSONObject? = opt(key) as? JSONObject

/** An array field, or null. */
fun JSONObject.arr(key: String): JSONArray? = opt(key) as? JSONArray

/** Whether the field is absent or JSON null. */
fun JSONObject.isNullOrAbsent(key: String): Boolean {
    val v = opt(key)
    return v == null || v == JSONObject.NULL
}

/** An array of strings, or null when absent or when any element is not a string (all or nothing). */
fun JSONObject.strings(key: String): List<String>? {
    val a = arr(key) ?: return null
    val out = ArrayList<String>(a.length())
    for (i in 0 until a.length()) out.add(a.opt(i) as? String ?: return null)
    return out
}

/** An array of whole numbers, or null when absent or when any element is not one (all or nothing). */
fun JSONObject.ints(key: String): List<Int>? {
    val a = arr(key) ?: return null
    val out = ArrayList<Int>(a.length())
    for (i in 0 until a.length()) {
        val n = Json.exactInt(a.opt(i) as? Number) ?: return null
        if (n !in Int.MIN_VALUE..Int.MAX_VALUE) return null
        out.add(n.toInt())
    }
    return out
}

/** The keys of an object, in the order org.json gives them. */
fun JSONObject.keyList(): List<String> {
    val out = ArrayList<String>()
    val it = keys()
    while (it.hasNext()) out.add(it.next())
    return out
}
