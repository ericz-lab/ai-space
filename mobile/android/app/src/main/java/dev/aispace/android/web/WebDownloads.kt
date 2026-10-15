package dev.aispace.android.web

import android.net.Uri
import android.util.Base64
import android.webkit.URLUtil
import android.webkit.WebView
import dev.aispace.android.core.SpaceApi
import dev.aispace.android.live.AppPaths
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume

/**
 * A page's downloads, saved under [AppPaths.downloads] on their way to the share sheet (b357ab9: they
 * are not kept; the directory is emptied at launch). A page of the Space is fetched with the Space's
 * cookies, as the web view would; a `data:` address is decoded; a `blob:` one exists only inside the
 * page, so the page reads it and the result is collected with plain script calls (there is no bridge
 * from the page to the app, and the page cannot call into it).
 */
internal object WebDownloads {
    /** Larger than any export a page makes; a blob is read through a string, which must fit in memory. */
    private const val BLOB_LIMIT = 25L * 1024 * 1024

    private val client: OkHttpClient by lazy {
        SpaceApi.sharedClient.newBuilder()
            .cookieJar(okhttp3.CookieJar.NO_COOKIES)
            .cache(null)
            .readTimeout(60, TimeUnit.SECONDS)
            .build()
    }

    /** A fresh directory per download keeps the server's file name without replacing anything. */
    private fun target(name: String): File {
        val dir = File(AppPaths.downloads, UUID.randomUUID().toString())
        dir.mkdirs()
        val clean = File(name).name.ifEmpty { "download" }
        return File(dir, clean)
    }

    suspend fun saveHttp(url: String, disposition: String?, mimeType: String?, userAgent: String, profile: SpaceProfile): File =
        withContext(Dispatchers.IO) {
            // Each hop of a redirect carries the cookies the profile has for it, as the web view's own would.
            val withCookies = client.newBuilder().addNetworkInterceptor { chain ->
                val request = chain.request()
                val cookie = profile.cookieHeaderNow(request.url.toString())
                chain.proceed(
                    if (cookie != null) request.newBuilder().header("Cookie", cookie).build() else request,
                )
            }.build()
            val request = Request.Builder().url(url).header("User-Agent", userAgent).build()
            withCookies.newCall(request).execute().use { response ->
                if (!response.isSuccessful) throw IOException("HTTP ${response.code} ${SpaceApi.reason(response.code)}")
                val body = response.body ?: throw IOException("empty answer")
                val name = URLUtil.guessFileName(
                    response.request.url.toString(),
                    disposition?.takeIf { it.isNotEmpty() } ?: response.header("Content-Disposition"),
                    mimeType?.takeIf { it.isNotEmpty() } ?: body.contentType()?.toString(),
                )
                val file = target(name)
                file.outputStream().use { out -> body.byteStream().use { it.copyTo(out) } }
                file
            }
        }

    suspend fun saveData(url: String, disposition: String?, mimeType: String?): File = withContext(Dispatchers.IO) {
        val (type, bytes) = decodeDataUrl(url) ?: throw IOException("unreadable data address")
        val file = target(URLUtil.guessFileName("data:", disposition, mimeType ?: type))
        file.writeBytes(bytes)
        file
    }

    /** `data:[type][;base64],payload`: the type and the bytes. */
    private fun decodeDataUrl(url: String): Pair<String?, ByteArray>? {
        if (!url.startsWith("data:", ignoreCase = true)) return null
        val comma = url.indexOf(',')
        if (comma < 0) return null
        val header = url.substring(5, comma)
        val payload = url.substring(comma + 1)
        val base64 = header.endsWith(";base64", ignoreCase = true)
        val type = header.substringBefore(';').takeIf { it.isNotEmpty() }
        val bytes = try {
            if (base64) Base64.decode(payload, Base64.DEFAULT) else Uri.decode(payload).toByteArray(Charsets.UTF_8)
        } catch (e: IllegalArgumentException) {
            return null
        }
        return type to bytes
    }

    suspend fun saveBlob(view: WebView, url: String, disposition: String?, mimeType: String?): File {
        val id = UUID.randomUUID().toString().replace("-", "")
        val quoted = JSONObject.quote(url)
        val start = "(function(){var k='__aispaceBlob';window[k]=window[k]||{};var put=function(v){window[k]['$id']=v};" +
            "fetch($quoted).then(function(r){return r.blob()}).then(function(b){" +
            "if(b.size>$BLOB_LIMIT){put({error:'too large'});return}" +
            "var f=new FileReader();f.onload=function(){put({type:b.type,data:f.result})};" +
            "f.onerror=function(){put({error:String(f.error)})};f.readAsDataURL(b)})" +
            ".catch(function(e){put({error:String(e)})})})()"
        val take = "(function(){var k=window.__aispaceBlob;var v=k&&k['$id'];if(!v)return null;delete k['$id'];return JSON.stringify(v)})()"
        evaluate(view, start)
        // The page reads the blob asynchronously; its answer is picked up when it is there.
        repeat(300) {
            delay(100)
            val raw = evaluate(view, take)
            if (raw != null && raw != "null") {
                val text = JSONArray("[$raw]").optString(0)
                val o = JSONObject(text)
                if (o.has("error")) throw IOException(o.optString("error"))
                val data = o.optString("data")
                val type = o.optString("type").takeIf { it.isNotEmpty() }
                return saveData(data, disposition, mimeType?.takeIf { it.isNotEmpty() } ?: type)
            }
        }
        throw IOException("the page did not hand over the file")
    }

    private suspend fun evaluate(view: WebView, script: String): String? = withContext(Dispatchers.Main) {
        suspendCancellableCoroutine<String?> { cont ->
            try {
                view.evaluateJavascript(script) { if (cont.isActive) cont.resume(it) }
            } catch (e: RuntimeException) {
                // A destroyed view.
                if (cont.isActive) cont.resume(null)
            }
        }
    }
}
