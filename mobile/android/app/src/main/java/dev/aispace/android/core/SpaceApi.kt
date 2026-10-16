package dev.aispace.android.core

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.CookieJar
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.io.IOException
import java.net.URI
import java.nio.charset.StandardCharsets
import java.time.Instant
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

sealed class SpaceApiError(message: String) : Exception(message) {
    /** The access layer wants a sign-in, or the panel session has expired. */
    data object AuthenticationRequired : SpaceApiError("sign-in needed")

    /** Any other answer that is not a success, with the server's `error` text. */
    data class Http(val code: Int, val msg: String) : SpaceApiError(msg)

    /** An answer that is not the shape the route sends. */
    data object InvalidResponse : SpaceApiError("invalid response")
}

/**
 * A cookie of the Space's web profile, for matching by [Cookies] when the cookie store hands out
 * cookies rather than a ready header.
 */
data class StoredCookie(
    val name: String,
    val value: String,
    /** With a leading dot when the cookie was set with a Domain attribute (it then fits subdomains too). */
    val domain: String,
    val path: String = "/",
    val secure: Boolean = false,
    val expiresAt: Instant? = null,
)

/** Which stored cookies a request to a URL carries, by the usual domain, path, secure and expiry rules. */
object Cookies {
    fun matching(cookies: List<StoredCookie>, url: URI, now: Instant = Instant.now()): List<StoredCookie> {
        val host = Urls.host(url) ?: return emptyList()
        val path = url.path?.ifEmpty { null } ?: "/"
        val secure = Urls.scheme(url) == "https"
        return cookies.filter { c ->
            val domain = c.domain.lowercase()
            val bare = domain.removePrefix(".")
            // A cookie set without a Domain attribute is stored without the leading dot and fits its host only.
            val domainOK = host == bare || (domain.startsWith(".") && host.endsWith(".$bare"))
            val cookiePath = c.path.ifEmpty { "/" }
            val pathOK = path == cookiePath || path.startsWith(if (cookiePath.endsWith("/")) cookiePath else "$cookiePath/")
            val fresh = c.expiresAt?.isAfter(now) ?: true
            domainOK && pathOK && fresh && (!c.secure || secure)
        }
    }

    /** The `Cookie` header for a request to [url], or null when no cookie fits. */
    fun header(url: URI, cookies: List<StoredCookie>, now: Instant = Instant.now()): String? {
        val matched = matching(cookies, url, now)
        if (matched.isEmpty()) return null
        return matched.joinToString("; ") { "${it.name}=${it.value}" }
    }
}

/**
 * Where a request's cookies come from: the Space's own web profile. Android's
 * `CookieManager.getCookie(url)` already answers with the header of the cookies that fit a URL,
 * so the web layer can hand that over as it is; [fromCookies] matches a list of cookies instead.
 * Read the profile only once it is initialized, or the jar reads empty (80ac12a).
 */
fun interface CookieSource {
    /** The `Cookie` header for a request to the http(s) [url], or null for none. */
    suspend fun header(url: String): String?

    companion object {
        val none: CookieSource = CookieSource { null }

        fun fromCookies(cookies: suspend () -> List<StoredCookie>): CookieSource =
            CookieSource { url -> Urls.parse(url)?.let { Cookies.header(it, cookies()) } }
    }
}

/** A server-sent event stream: the run id the answer named, and its messages. */
class EventStream(
    /** The `x-run-id` header, when the answer carries one. */
    val runId: String?,
    /**
     * Each `data:` line with the `id:` before it. Collect it once: collecting reads the open
     * answer, and ending the collection closes it.
     */
    val messages: Flow<SSEMessage>,
)

/**
 * Native calls to one Space's panel routes. They carry the cookies of the connection's own web
 * profile, so an access layer that the operator signed in to on the panel page lets them
 * through; nothing is copied out of the browser and no operator token is used. A redirect is
 * never followed: it means a sign-in is needed. OkHttp keeps no cookies of its own here.
 *
 * Network failures surface as [IOException]; answers that are not a success as [SpaceApiError].
 */
class SpaceApi(
    base: URI,
    private val cookies: CookieSource,
    client: OkHttpClient = sharedClient,
    /** Sent as `User-Agent` when set. */
    private val userAgent: String? = null,
) {
    /** The Space's origin, `scheme://host[:port]/`. */
    val base: URI = ConnectionRules.origin(base) ?: base

    private val client: OkHttpClient = client.newBuilder()
        .followRedirects(false)
        .followSslRedirects(false)
        .cookieJar(CookieJar.NO_COOKIES)
        .cache(null)
        .connectTimeout(30, TimeUnit.SECONDS)
        // The request timeout counts silence, as iOS's does.
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    /** For event streams: a run may think for minutes between events. */
    private val streamClient: OkHttpClient = this.client.newBuilder().readTimeout(300, TimeUnit.SECONDS).build()

    /** For sockets: a shell at its prompt is silent, so silence must never end it. */
    private val socketClient: OkHttpClient = this.client.newBuilder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .writeTimeout(0, TimeUnit.MILLISECONDS)
        .callTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(0, TimeUnit.MILLISECONDS)
        .build()

    /** A path (or address) resolved against the Space. */
    fun url(path: String): URI = Urls.resolve(base, path) ?: base

    /** The request a call sends: Accept, the profile's cookies, and for a write its JSON and the Space's origin. */
    suspend fun request(method: String, path: String, json: JSONObject? = null, accept: String = "application/json"): Request {
        val target = url(path)
        val b = Request.Builder().url(target.toString()).header("Accept", accept)
        cookies.header(target.toString())?.takeIf { it.isNotEmpty() }?.let { b.header("Cookie", it) }
        userAgent?.let { b.header("User-Agent", it) }
        if (json != null) {
            // A write names the origin it comes from, as the panel's page does: the routes that
            // change the Space (src/space/auth.ts `sameOrigin`) take a write from the Space's own origin only.
            ConnectionRules.originHeader(target)?.let { b.header("Origin", it) }
            b.method(method, json.toString().toByteArray(StandardCharsets.UTF_8).toRequestBody(jsonType))
        } else {
            b.method(method, if (method.uppercase() in bodyMethods) ByteArray(0).toRequestBody(null) else null)
        }
        return b.build()
    }

    /** Reads a route's answer as one [T]; [SpaceApiError.InvalidResponse] when it is not one. */
    suspend fun <T> get(path: String, reader: JsonReader<T>): T {
        val r = fetch(client, request("GET", path))
        check(r.status, r.finalUrl, r.body, base)
        return try {
            Json.decode(String(r.body, StandardCharsets.UTF_8), reader)
        } catch (e: DecodingException) {
            throw SpaceApiError.InvalidResponse
        }
    }

    /** A write; the answer's text. */
    suspend fun send(method: String, path: String, json: JSONObject): String {
        val r = fetch(client, request(method, path, json))
        check(r.status, r.finalUrl, r.body, base)
        return String(r.body, StandardCharsets.UTF_8)
    }

    data class Answer(val status: Int, val body: String)

    /**
     * A write's bare answer, for a route whose 401 is its own and not the access layer's (the
     * terminal's passphrase). A redirect is returned as its 3xx status; one that ended off the
     * Space is still a sign-in.
     */
    suspend fun answer(method: String, path: String, json: JSONObject, headers: Map<String, String> = emptyMap()): Answer {
        val built = request(method, path, json).newBuilder()
        for ((name, value) in headers) built.header(name, value)
        val r = fetch(client, built.build())
        if (r.finalUrl != null && !ConnectionRules.sameOrigin(r.finalUrl, base)) throw SpaceApiError.AuthenticationRequired
        return Answer(r.status, String(r.body, StandardCharsets.UTF_8))
    }

    /** Bytes of an icon or avatar, or any route's answer. */
    suspend fun data(path: String): ByteArray {
        val r = fetch(client, request("GET", path, accept = "*/*"))
        check(r.status, r.finalUrl, r.body, base)
        return r.body
    }

    /** A JSON route's answer as text, for [Hub.rows] and the other readers. */
    suspend fun text(path: String): String {
        val r = fetch(client, request("GET", path))
        check(r.status, r.finalUrl, r.body, base)
        return String(r.body, StandardCharsets.UTF_8)
    }

    /**
     * A server-sent event stream: each `data:` line with the `id:` before it, and the run id
     * from the `x-run-id` header when the response carries one. Throws as [get] does when the
     * stream does not open.
     */
    suspend fun events(method: String, path: String, json: JSONObject? = null): EventStream {
        val call = streamClient.newCall(request(method, path, json, accept = "text/event-stream"))
        val response = open(call) { response ->
            if (response.code !in 200..299) {
                val body = response.peekBody(4096).bytes()
                check(response.code, response.request.url.toUri(), body, base)
            }
            check(response.code, response.request.url.toUri(), ByteArray(0), base)
        }
        val runId = response.header("x-run-id")
        val messages = callbackFlow {
            val reader = launch(Dispatchers.IO) {
                try {
                    response.use { r ->
                        val source = r.body?.source() ?: return@use
                        val parser = SSEParser()
                        while (true) {
                            val line = source.readUtf8Line() ?: break
                            // Blank lines are dropped, as iOS's `lines` drops them; the server
                            // sends one data line per event, so each is complete.
                            if (line.isEmpty()) continue
                            parser.feed(line)?.let { send(it) }
                        }
                    }
                    close()
                } catch (e: IOException) {
                    close(e)
                }
            }
            awaitClose {
                call.cancel()
                reader.cancel()
            }
        }
        return EventStream(runId, messages)
    }

    /**
     * The request of a socket to the Space ([TerminalRoute.socket]), with the session's cookies
     * and the Space's origin as the panel's page would send them.
     */
    suspend fun socketRequest(url: URI): Request {
        val b = Request.Builder().url(url.toString())
        cookies.header(this.url(url.rawPath ?: "/").toString())?.takeIf { it.isNotEmpty() }?.let { b.header("Cookie", it) }
        userAgent?.let { b.header("User-Agent", it) }
        b.header("Origin", base.toString().removeSuffix("/"))
        return b.build()
    }

    /**
     * Opens a socket to the Space. No read timeout and no ping deadline: a shell at its prompt
     * is silent, and silence must not close it. The socket starts connecting at once.
     */
    suspend fun socket(url: URI, listener: WebSocketListener): WebSocket =
        socketClient.newWebSocket(socketRequest(url), listener)

    private class Fetched(val status: Int, val finalUrl: URI?, val body: ByteArray)

    private suspend fun fetch(client: OkHttpClient, request: Request): Fetched = suspendCancellableCoroutine { cont ->
        val call = client.newCall(request)
        cont.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (cont.isActive) cont.resumeWithException(e)
            }

            override fun onResponse(call: Call, response: Response) {
                // Consume and close on OkHttp's worker, including slow bodies. Cancellation stays
                // attached to the call until the complete answer has been read.
                try {
                    val fetched = response.use {
                        Fetched(it.code, it.request.url.toUri(), it.body?.bytes() ?: ByteArray(0))
                    }
                    if (cont.isActive) cont.resume(fetched)
                } catch (e: Exception) {
                    if (cont.isActive) cont.resumeWithException(e)
                }
            }
        })
    }

    /** Runs a call; cancelling the coroutine cancels the call. The caller closes the response. */
    private suspend fun open(call: Call, validate: (Response) -> Unit): Response = suspendCancellableCoroutine { cont ->
        cont.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (cont.isActive) cont.resumeWithException(e)
            }

            override fun onResponse(call: Call, response: Response) {
                try {
                    // Error bodies can be slow too; validate on the worker before handing off.
                    validate(response)
                    cont.resume(response) { _, value, _ -> value.close() }
                } catch (e: Exception) {
                    response.close()
                    if (cont.isActive) cont.resumeWithException(e)
                }
            }
        })
    }

    companion object {
        private val jsonType = "application/json".toMediaType()
        private val bodyMethods = setOf("POST", "PUT", "PATCH")

        /** One client for every Space, so they share a connection pool and threads. */
        val sharedClient: OkHttpClient by lazy { OkHttpClient() }

        /**
         * Maps an answer to an error: a redirect, 401 or 403 means sign in, and so does an answer
         * that ended on another origin; any other non-2xx carries the server's `error` text.
         */
        fun check(status: Int, finalUrl: URI?, body: ByteArray, expected: URI) {
            if (finalUrl != null && !ConnectionRules.sameOrigin(finalUrl, expected)) throw SpaceApiError.AuthenticationRequired
            when {
                status in 200..299 -> return
                status in 300..399 || status == 401 || status == 403 -> throw SpaceApiError.AuthenticationRequired
                else -> {
                    val message = Json.obj(String(body, StandardCharsets.UTF_8))?.str("error")
                    throw SpaceApiError.Http(status, message ?: reason(status))
                }
            }
        }

        fun check(status: Int, finalUrl: URI?, body: String, expected: URI) =
            check(status, finalUrl, body.toByteArray(StandardCharsets.UTF_8), expected)

        /** A status as words, as `HTTPURLResponse.localizedString(forStatusCode:)` gives them. */
        fun reason(status: Int): String = when (status) {
            400 -> "bad request"
            402 -> "payment required"
            404 -> "not found"
            405 -> "method not allowed"
            406 -> "unacceptable"
            408 -> "request timed out"
            409 -> "conflict"
            410 -> "no longer exists"
            411 -> "length required"
            412 -> "precondition failed"
            413 -> "request too large"
            414 -> "requested URL too long"
            415 -> "unsupported media type"
            422 -> "unprocessable entity"
            429 -> "too many requests"
            500 -> "internal server error"
            501 -> "unimplemented"
            502 -> "bad gateway"
            503 -> "service unavailable"
            504 -> "gateway timed out"
            505 -> "unsupported version"
            in 400..499 -> "client error"
            in 500..599 -> "server error"
            else -> "HTTP $status"
        }
    }
}
