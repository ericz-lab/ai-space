package dev.aispace.android.core

import java.text.Normalizer
import java.util.Locale

/**
 * The library's search rule (docs/panel.md#screens): every word of the query must appear in
 * the entry's title, description or id. All of an entry's languages are searched, so "todo"
 * and "待办" find the same app whichever language the phone shows.
 */
object CatalogueSearch {
    private val marks = Regex("\\p{Mn}+")

    /** Case, diacritics and width folded away: `Ｔｏｄｏ`, `TODO` and `tödo` all read `todo`. */
    fun fold(s: String): String {
        val narrow = StringBuilder(s.length)
        for (c in s) {
            narrow.append(
                when (c) {
                    in '！'..'～' -> (c.code - 0xFEE0).toChar()
                    '　' -> ' '
                    else -> c
                },
            )
        }
        val decomposed = Normalizer.normalize(narrow, Normalizer.Form.NFD)
        return marks.replace(decomposed, "").lowercase(Locale.ROOT)
    }

    fun haystack(e: CatalogueEntry): String {
        val parts = mutableListOf(e.title, e.ref, e.detail ?: "")
        for (text in (e.i18n ?: emptyMap()).values) {
            parts.add(text.title ?: "")
            parts.add(text.description ?: "")
        }
        return fold(parts.joinToString("\n"))
    }

    /** The query's words, folded. */
    fun words(query: String): List<String> {
        val out = ArrayList<String>()
        val current = StringBuilder()
        for (c in fold(query)) {
            if (Character.isWhitespace(c) || Character.isSpaceChar(c)) {
                if (current.isNotEmpty()) out.add(current.toString())
                current.setLength(0)
            } else current.append(c)
        }
        if (current.isNotEmpty()) out.add(current.toString())
        return out
    }

    fun matches(e: CatalogueEntry, query: String): Boolean {
        val words = words(query)
        if (words.isEmpty()) return true
        val text = haystack(e)
        return words.all { text.contains(it) }
    }

    fun filter(entries: List<CatalogueEntry>, query: String): List<CatalogueEntry> = entries.filter { matches(it, query) }
}
