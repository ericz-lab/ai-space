package dev.aispace.android.core

import java.net.URI
import java.net.URISyntaxException
import java.util.UUID

/**
 * A saved Space the app can open: a local Space or a remote Hub's panel.
 * Only this phone knows about it; removing it never changes the server.
 */
data class Connection(
    val id: UUID = UUID.randomUUID(),
    val name: String,
    val url: URI,
    val isDefault: Boolean = false,
) {
    val isLocal: Boolean get() = ConnectionRules.isLoopback(Urls.host(url) ?: "")
}

/** Why an address cannot be a connection. */
enum class ConnectionUrlError { empty, invalid, unsupportedScheme, credentials, insecureRemote }

class ConnectionUrlException(val error: ConnectionUrlError) : Exception(error.name)

/** What a connection URL may be: HTTPS anywhere, plain HTTP only to the device's loopback. */
object ConnectionRules {
    /** The default `SPACE_PORT` in src/space/config.ts. */
    const val localDefault = "http://127.0.0.1:8700"

    fun isLoopback(host: String): Boolean {
        var h = host.lowercase()
        if (h.startsWith("[") && h.endsWith("]") && h.length >= 2) h = h.substring(1, h.length - 1)
        if (h == "localhost" || h == "::1") return true
        val parts = h.split(".")
        if (parts.size != 4) return false
        val numeric = parts.all { p -> p.isNotEmpty() && p.length <= 3 && p.all { it in '0'..'9' } && p.toInt() <= 255 }
        return numeric && parts[0] == "127"
    }

    /**
     * Turns what the operator typed into a panel URL, or says why it cannot be one (throws
     * [ConnectionUrlException]). A missing scheme means HTTP for loopback and HTTPS otherwise;
     * query and fragment are dropped.
     */
    fun normalize(input: String): URI {
        var text = input.trim()
        if (text.isEmpty()) throw ConnectionUrlException(ConnectionUrlError.empty)
        if (!text.contains("://")) {
            val host = text.split("/", limit = 2).first()
            val bare = host.split(":").first()
            text = (if (isLoopback(bare) || host.startsWith("[::1]")) "http://" else "https://") + text
        }
        val parts = try {
            URI(text)
        } catch (e: URISyntaxException) {
            throw ConnectionUrlException(ConnectionUrlError.invalid)
        }
        val scheme = parts.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") throw ConnectionUrlException(ConnectionUrlError.unsupportedScheme)
        val host = Urls.host(parts)
        if (host.isNullOrEmpty()) throw ConnectionUrlException(ConnectionUrlError.invalid)
        if (parts.rawUserInfo != null) throw ConnectionUrlException(ConnectionUrlError.credentials)
        if (scheme == "http" && !isLoopback(host)) throw ConnectionUrlException(ConnectionUrlError.insecureRemote)
        val port = Urls.port(parts)?.let { ":$it" } ?: ""
        val path = parts.rawPath.takeUnless { it.isNullOrEmpty() } ?: "/"
        return try {
            URI("$scheme://${Urls.hostForAddress(host)}$port$path")
        } catch (e: URISyntaxException) {
            throw ConnectionUrlException(ConnectionUrlError.invalid)
        }
    }

    /** Whether two URLs share scheme, host and effective port. */
    fun sameOrigin(a: URI, b: URI): Boolean {
        val sa = a.scheme?.lowercase() ?: return false
        val sb = b.scheme?.lowercase() ?: return false
        if (sa != sb) return false
        val ha = Urls.host(a) ?: return false
        val hb = Urls.host(b) ?: return false
        if (ha != hb) return false
        return effectivePort(a) == effectivePort(b)
    }

    /** `scheme://host[:port]/`, or null for an address without a scheme or host. */
    fun origin(url: URI): URI? {
        val scheme = url.scheme ?: return null
        val host = Urls.host(url) ?: return null
        val port = Urls.port(url)?.let { ":$it" } ?: ""
        return Urls.parse("$scheme://${Urls.hostForAddress(host)}$port/")
    }

    /** [origin] as the `Origin` header writes it: without the trailing slash. */
    fun originHeader(url: URI): String? = origin(url)?.toString()?.removeSuffix("/")

    private fun effectivePort(url: URI): Int? {
        Urls.port(url)?.let { return it }
        return when (url.scheme?.lowercase()) {
            "http" -> 80
            "https" -> 443
            else -> null
        }
    }
}
