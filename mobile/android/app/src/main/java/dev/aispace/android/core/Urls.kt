package dev.aispace.android.core

import java.net.URI
import java.net.URISyntaxException
import java.nio.charset.StandardCharsets

/**
 * URL handling over `java.net.URI`, the type the core uses where the iOS client has `URL`.
 * `URI` is strict about characters a browser would encode; [parse] encodes them first, as
 * `URL(string:)` does on current iOS, so an address with a space or a brace still reads.
 */
object Urls {
    private const val HEX = "0123456789ABCDEF"

    /** Characters a URI may carry as they are (RFC 3986 reserved and unreserved, and `%`). */
    private fun isUriChar(c: Char): Boolean =
        c in 'a'..'z' || c in 'A'..'Z' || c in '0'..'9' || c in "-._~:/?#[]@!$&'()*+,;=%"

    /** The text as a URI, or null when it cannot be one even with stray characters encoded. */
    fun parse(text: String?): URI? {
        if (text == null) return null
        try {
            return URI(text)
        } catch (e: URISyntaxException) {
            // fall through to the encoded form
        }
        val sb = StringBuilder()
        for (ch in text) {
            if (isUriChar(ch)) sb.append(ch) else appendEncoded(sb, ch.toString())
        }
        // A `%` that does not start an escape is a literal percent sign.
        val fixed = Regex("%(?![0-9A-Fa-f]{2})").replace(sb.toString(), "%25")
        return try {
            URI(fixed)
        } catch (e: URISyntaxException) {
            null
        }
    }

    /**
     * [ref] resolved against [base] (`URL(string:relativeTo:)`), or null when [ref] is not an address.
     * A base with an authority and no path is taken as its root, which `URI.resolve` gets wrong.
     */
    fun resolve(base: URI, ref: String): URI? {
        val r = parse(ref) ?: return null
        val b = if (!base.isOpaque && base.rawAuthority != null && base.rawPath.isNullOrEmpty()) {
            parse(base.scheme + "://" + base.rawAuthority + "/" + (base.rawQuery?.let { "?$it" } ?: "")) ?: base
        } else base
        return try {
            b.resolve(r)
        } catch (e: IllegalArgumentException) {
            null
        }
    }

    /** The scheme, lowercased, or "" when there is none. */
    fun scheme(url: URI): String = url.scheme?.lowercase() ?: ""

    /**
     * The host, lowercased, without the brackets of an IPv6 literal (as `URL.host` reads), or
     * null. A host `URI` will not take as a server name (an underscore in it) is read from the authority.
     */
    fun host(url: URI): String? {
        val h = url.host ?: url.rawAuthority?.let { authorityHost(it) } ?: return null
        val bare = if (h.startsWith("[") && h.endsWith("]")) h.substring(1, h.length - 1) else h
        return bare.lowercase()
    }

    /** The host as it is written in an address: an IPv6 literal in brackets. */
    fun hostForAddress(host: String): String = if (host.contains(':') && !host.startsWith("[")) "[$host]" else host

    /** The explicit port, or null. */
    fun port(url: URI): Int? {
        if (url.port != -1) return url.port
        if (url.host != null) return null
        val hostPort = url.rawAuthority?.substringAfter("@") ?: return null
        val afterHost = if (hostPort.startsWith("[")) hostPort.substringAfter("]", "") else hostPort.substringAfter(":", "").let { if (it.isEmpty()) "" else ":$it" }
        return afterHost.removePrefix(":").toIntOrNull()
    }

    private fun authorityHost(authority: String): String? {
        val hostPort = authority.substringAfter("@")
        if (hostPort.startsWith("[")) return hostPort.substringBefore("]") + "]"
        return hostPort.substringBefore(":").ifEmpty { null }
    }

    /** Percent-encodes [s] as UTF-8, leaving the characters [isAllowed] accepts. */
    fun encode(s: String, isAllowed: (Char) -> Boolean): String {
        val sb = StringBuilder()
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (c.code < 128 && isAllowed(c)) {
                sb.append(c)
                i++
            } else {
                val end = if (Character.isHighSurrogate(c) && i + 1 < s.length) i + 2 else i + 1
                appendEncoded(sb, s.substring(i, end))
                i = end
            }
        }
        return sb.toString()
    }

    private fun appendEncoded(sb: StringBuilder, s: String) {
        for (b in s.toByteArray(StandardCharsets.UTF_8)) {
            val v = b.toInt() and 0xFF
            sb.append('%').append(HEX[v shr 4]).append(HEX[v and 0xF])
        }
    }

    /** Decodes `%XX` escapes as UTF-8; a `+` stays a plus (as `URLComponents` reads a query). */
    fun decode(s: String): String {
        if (!s.contains('%')) return s
        val out = java.io.ByteArrayOutputStream()
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (c == '%' && i + 2 < s.length && isHex(s[i + 1]) && isHex(s[i + 2])) {
                out.write(s.substring(i + 1, i + 3).toInt(16))
                i += 3
            } else {
                val end = if (Character.isHighSurrogate(c) && i + 1 < s.length) i + 2 else i + 1
                val bytes = s.substring(i, end).toByteArray(StandardCharsets.UTF_8)
                out.write(bytes, 0, bytes.size)
                i = end
            }
        }
        return String(out.toByteArray(), StandardCharsets.UTF_8)
    }

    private fun isHex(c: Char) = c in '0'..'9' || c in 'a'..'f' || c in 'A'..'F'

    private fun isUnreserved(c: Char) = c in 'a'..'z' || c in 'A'..'Z' || c in '0'..'9' || c in "-._~"

    /**
     * A query value as `URLComponents.queryItems` writes it: what a query may hold stays, and
     * `&`, `=`, `#` and `%` are escaped so the value reads back whole. A `+` stays a plus.
     */
    fun encodeQueryValue(s: String): String = encode(s) { isUnreserved(it) || it in "!$'()*+,;:@/?" }

    /** The name and value pairs of a raw query, decoded; a name without `=` has a null value. */
    fun queryItems(rawQuery: String?): List<Pair<String, String?>> {
        if (rawQuery.isNullOrEmpty()) return emptyList()
        return rawQuery.split('&').map { part ->
            val eq = part.indexOf('=')
            if (eq < 0) decode(part) to null else decode(part.substring(0, eq)) to decode(part.substring(eq + 1))
        }
    }

    /** As `encodeURIComponent` leaves a path segment. */
    fun encodeComponent(s: String): String = encode(s) { isUnreserved(it) || it in "!*'()" }
}

/** Path segments of the Space's routes. */
object SpacePath {
    /**
     * A name as one path segment: letters, digits and `-._~` stay, everything else is escaped.
     * The iOS client also leaves non-ASCII letters, which the URL then encodes on the wire to the
     * same bytes as here.
     */
    fun escape(s: String): String = Urls.encode(s) { c ->
        c in 'a'..'z' || c in 'A'..'Z' || c in '0'..'9' || c in "-._~"
    }
}
