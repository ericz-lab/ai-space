package dev.aispace.android.core

import org.json.JSONArray
import org.json.JSONException

/**
 * Where a connection stands. A reachable port alone is not [Ready]: the page must answer
 * a known Space API the way ai-space does.
 */
sealed class SpaceState {
    data object Connecting : SpaceState()
    data object Ready : SpaceState()
    data object AuthenticationRequired : SpaceState()
    data class Unreachable(val message: String) : SpaceState()
    data class Incompatible(val message: String) : SpaceState()

    val isFailure: Boolean get() = this is Unreachable || this is Incompatible
}

/**
 * Classifies the answer to `GET /api/panel/layout`, fetched with the page's own session (an
 * access layer's cookie included): from inside the loaded page, or natively with the profile's cookies.
 */
object SpaceCheck {
    const val path = "/api/panel/layout"

    /**
     * The check as page script (the body of an async function; iOS runs it in an isolated content
     * world). It resolves to `[status, contentType, body]`. Android's `evaluateJavascript` does not
     * wait for a promise, so a caller there has to deliver the result some other way, or make the
     * request natively and use [classify].
     */
    const val script = """
    const r = await fetch(path, { credentials: "same-origin", headers: { Accept: "application/json" }, redirect: "manual" });
    return [r.status, r.headers.get("content-type") || "", r.type === "opaqueredirect" ? "" : await r.text()];
    """

    fun classify(status: Int, contentType: String, body: String): SpaceState {
        // A redirect away from the API, typically to an access layer's login page.
        if (status == 0 || status in 300..399 || status == 401 || status == 403) return SpaceState.AuthenticationRequired
        if (status != 200) return SpaceState.Incompatible("HTTP $status")
        if (!contentType.lowercase().contains("json")) return SpaceState.Incompatible("not an ai-space response")
        val o = Json.obj(body) ?: return SpaceState.Incompatible("not an ai-space response")
        if (o.bool("ok") != true || o.obj("layout") == null) return SpaceState.Incompatible("not an ai-space response")
        return SpaceState.Ready
    }

    /**
     * The result of the in-page script: `[status, contentType, body]`, as a list, a JSONArray or
     * the JSON text of one.
     */
    fun classifyScriptResult(result: Any?): SpaceState {
        val parts: List<Any?> = when (result) {
            is List<*> -> result
            is JSONArray -> (0 until result.length()).map { result.opt(it) }
            is String -> try {
                val a = JSONArray(result)
                (0 until a.length()).map { a.opt(it) }
            } catch (e: JSONException) {
                return SpaceState.Incompatible("unexpected check result")
            }
            else -> return SpaceState.Incompatible("unexpected check result")
        }
        if (parts.size != 3) return SpaceState.Incompatible("unexpected check result")
        val status = (parts[0] as? Number)?.toInt()
        val type = parts[1] as? String
        val body = parts[2] as? String
        if (status == null || type == null || body == null) return SpaceState.Incompatible("unexpected check result")
        return classify(status, type, body)
    }

    /**
     * A failed main-frame load (WebView `onReceivedError`: its error code and description), or null
     * when the failure is not the connection's fault: a cancelled load, or a response handed to a
     * download (Chromium reports both as `net::ERR_ABORTED`).
     */
    fun classifyError(code: Int, description: String): SpaceState? {
        if (description.contains("ERR_ABORTED")) return null
        return SpaceState.Unreachable(description.ifEmpty { "error $code" })
    }
}
