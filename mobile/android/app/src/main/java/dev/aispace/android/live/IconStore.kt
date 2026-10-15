package dev.aispace.android.live

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import dev.aispace.android.core.IconSource
import dev.aispace.android.core.SpaceApi
import dev.aispace.android.web.WebHost
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.CookieJar
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume

/**
 * Icons and avatars of one Space, fetched through its API with its session and cached in memory and on
 * disk; an icon a manifest places on another site is fetched plainly, without the session (b357ab9).
 * An emoji needs no loading (see [Icon.emoji]); SVG files, which BitmapFactory cannot decode, are drawn
 * once by an offscreen web view with scripts off ([SVGRasterizer]).
 *
 * Main thread only. Cached images appear at once after a relaunch; after a day a requested icon is
 * fetched again in the background while its previous image stays on show. A failed fetch keeps that
 * image and is tried again after the catalogue is refreshed ([retryFailed]).
 */
class IconStore(
    private val api: SpaceApi,
    private val directory: File,
    private val scope: CoroutineScope,
    private val now: () -> Long = System::currentTimeMillis,
    /** Loads one icon's image; the network and the decoders unless a test supplies the images. */
    private val loadImage: (suspend (String) -> Bitmap?)? = null,
) : IconImages {
    private val updateFlow = MutableSharedFlow<String?>(extraBufferCapacity = 256)

    /** Only the views showing the completed icon draw again (015df11); null clears them all on sign-out. */
    override val updates: SharedFlow<String?> = updateFlow.asSharedFlow()

    private val images = HashMap<String, ImageBitmap>()
    private val diskChecked = HashSet<String>()
    private val fetchedAt = HashMap<String, Long>()
    private var generation = 0
    private val pending = HashSet<String>()
    private val failed = HashSet<String>()

    private fun file(icon: String): File {
        // The origin is part of the key, so a saved Space whose address changes does not show another
        // Space's icons. Neither URLs with credentials nor arbitrary path components become file names.
        val digest = MessageDigest.getInstance("SHA-256").digest((api.base.toString() + "\n" + icon).toByteArray(Charsets.UTF_8))
        return File(directory, digest.joinToString("") { "%02x".format(it) } + ".png")
    }

    override fun image(icon: String?): ImageBitmap? {
        if (icon == null || !Icon.isPath(icon)) return null
        if (images[icon] == null && diskChecked.add(icon)) {
            val f = file(icon)
            BitmapFactory.decodeFile(f.path)?.let { saved ->
                images[icon] = saved.asImageBitmap()
                fetchedAt[icon] = f.lastModified()
            }
        }
        val cached = images[icon]
        val at = fetchedAt[icon]
        if (cached != null && at != null && now() - at < MAX_AGE_MS) return cached
        if (icon in pending || icon in failed) return cached
        pending.add(icon)
        val generation = this.generation
        scope.launch {
            val bitmap = try {
                val supplied = loadImage
                if (supplied != null) supplied(icon) else load(icon)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                null
            }
            // A request begun before sign-out must not fill the cache again afterwards.
            if (generation != this@IconStore.generation) return@launch
            pending.remove(icon)
            if (bitmap != null) {
                images[icon] = bitmap.asImageBitmap()
                val at = now()
                fetchedAt[icon] = at
                val target = file(icon)
                // Encoded and written off the main thread; the memory cache works without the disk.
                withContext(Dispatchers.IO) {
                    try {
                        directory.mkdirs()
                        val tmp = File(directory, target.name + ".tmp")
                        FileOutputStream(tmp).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
                        if (tmp.renameTo(target)) target.setLastModified(at) else tmp.delete()
                    } catch (e: Exception) {
                        // The memory cache still works when the disk cache is unavailable.
                    }
                }
                if (generation == this@IconStore.generation) updateFlow.tryEmit(icon)
            } else {
                failed.add(icon)
            }
        }
        return cached
    }

    fun clear() {
        generation += 1
        images.clear()
        diskChecked.clear()
        fetchedAt.clear()
        pending.clear()
        failed.clear()
        directory.deleteRecursively()
        updateFlow.tryEmit(null)
    }

    /** A failed icon is tried again after a refresh (the session may have been the reason). */
    fun retryFailed() {
        val retry = failed.toList()
        failed.clear()
        // A view already showing the fallback no longer redraws with the catalogue: wake it.
        for (icon in retry) updateFlow.tryEmit(icon)
    }

    private suspend fun load(icon: String): Bitmap? {
        val data = data(icon) ?: return null
        if (data.isEmpty()) return null
        if (Icon.isSVG(data)) return SVGRasterizer.image(data)
        return withContext(Dispatchers.Default) { BitmapFactory.decodeByteArray(data, 0, data.size) }
    }

    private suspend fun data(icon: String): ByteArray? = when (val source = IconSource.of(icon, api.base)) {
        is IconSource.Space -> try {
            api.data(source.path)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        }
        is IconSource.External -> external(source.url.toString())
        null -> null
    }

    /** An icon on another site: no cookie goes out and none is kept, and a large answer is not an icon. */
    private suspend fun external(url: String): ByteArray? = withContext(Dispatchers.IO) {
        try {
            externalClient.newCall(Request.Builder().url(url).build()).execute().use { response ->
                if (response.code !in 200..299) return@use null
                val body = response.body ?: return@use null
                if (body.contentLength() > EXTERNAL_LIMIT) return@use null
                val source = body.source()
                // Reads one byte past the limit to tell a large answer from one exactly at it.
                source.request(EXTERNAL_LIMIT + 1)
                if (source.buffer.size > EXTERNAL_LIMIT) return@use null
                source.buffer.readByteArray()
            }
        } catch (e: Exception) {
            null
        }
    }

    private companion object {
        const val MAX_AGE_MS = 24L * 60 * 60 * 1000

        /** Twice what the Space accepts for an icon of its own (MAX_ICON_BYTES). */
        const val EXTERNAL_LIMIT = 1L shl 20

        val externalClient: OkHttpClient by lazy {
            SpaceApi.sharedClient.newBuilder()
                .cookieJar(CookieJar.NO_COOKIES)
                .cache(null)
                .callTimeout(30, TimeUnit.SECONDS)
                .readTimeout(30, TimeUnit.SECONDS)
                .build()
        }
    }
}

/**
 * Draws an SVG to a bitmap with a web view that runs no script and loads nothing but the image itself,
 * one at a time. The view sits in the activity's window behind the app's content, at full opacity: a web
 * view outside a window may never paint, and a faded one gives a faded bitmap (the iOS "SVG rendering
 * regression").
 */
object SVGRasterizer {
    /** The side of the drawn image, in dp: the largest an icon is shown at, sharp at the screen's density. */
    private const val SIDE_DP = 96

    private class Job(val svg: ByteArray, val done: (Bitmap?) -> Unit)

    private val queue = ArrayDeque<Job>()
    private var current: Job? = null
    private var view: WebView? = null
    private val main = Handler(Looper.getMainLooper())

    suspend fun image(svg: ByteArray): Bitmap? = withContext(Dispatchers.Main) {
        suspendCancellableCoroutine { cont ->
            queue.addLast(Job(svg) { bitmap -> if (cont.isActive) cont.resume(bitmap) })
            next()
        }
    }

    private fun next() {
        if (current != null || queue.isEmpty()) return
        val activity = WebHost.activity
        if (activity == null) {
            WebHost.whenAttached { next() }
            return
        }
        val job = queue.removeFirst()
        current = job
        val side = (SIDE_DP * activity.resources.displayMetrics.density).toInt()
        val web = view ?: makeView(activity, side).also { view = it }
        if (web.parent == null && !WebHost.attachOffscreen(web, side, side)) return finish(null)
        val base64 = Base64.encodeToString(job.svg, Base64.NO_WRAP)
        val html = """
            <!doctype html><meta name="viewport" content="width=$SIDE_DP,initial-scale=1">
            <style>html,body{margin:0;background:transparent;overflow:hidden}img{display:block;width:${SIDE_DP}px;height:${SIDE_DP}px;object-fit:contain}</style>
            <img src="data:image/svg+xml;base64,$base64">
        """.trimIndent()
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
    }

    private fun makeView(activity: android.app.Activity, side: Int): WebView {
        val web = WebView(activity)
        web.settings.javaScriptEnabled = false
        web.settings.blockNetworkLoads = true
        web.settings.allowFileAccess = false
        web.settings.allowContentAccess = false
        web.setBackgroundColor(Color.TRANSPARENT)
        web.isVerticalScrollBarEnabled = false
        web.isHorizontalScrollBarEnabled = false
        web.isFocusable = false
        web.importantForAccessibility = android.view.View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        web.webViewClient = object : WebViewClient() {
            /** The page is the image and nothing else: no link, redirect or subresource leaves it. */
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val scheme = request.url.scheme?.lowercase() ?: ""
                return !(scheme == "about" || scheme == "data")
            }

            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val scheme = request.url.scheme?.lowercase() ?: ""
                return if (scheme == "data" || scheme == "about") null else WebResourceResponse("text/plain", "utf-8", null)
            }

            override fun onPageFinished(view: WebView, url: String?) {
                if (current == null) return
                // Waits for the image to be decoded and drawn before the snapshot.
                if (WebViewFeature.isFeatureSupported(WebViewFeature.VISUAL_STATE_CALLBACK)) {
                    WebViewCompat.postVisualStateCallback(view, 0) { main.postDelayed({ snapshot(view, side) }, 50) }
                } else {
                    main.postDelayed({ snapshot(view, side) }, 150)
                }
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: android.webkit.WebResourceError) {
                if (request.isForMainFrame) finish(null)
            }
        }
        return web
    }

    private fun snapshot(web: WebView, side: Int) {
        if (current == null) return
        val bitmap = try {
            Bitmap.createBitmap(side, side, Bitmap.Config.ARGB_8888).also { web.draw(Canvas(it)) }
        } catch (e: RuntimeException) {
            null
        }
        finish(bitmap?.takeUnless { isBlank(it) })
    }

    /** A bitmap with nothing drawn on it is a failed drawing, not an icon. */
    private fun isBlank(bitmap: Bitmap): Boolean {
        val pixels = IntArray(bitmap.width * bitmap.height)
        bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        return pixels.all { Color.alpha(it) == 0 }
    }

    private fun finish(bitmap: Bitmap?) {
        val job = current ?: return
        current = null
        job.done(bitmap)
        if (queue.isEmpty()) {
            // Nothing else to draw: the view leaves the window, and is made again for the next icon
            // (it holds the activity it was made in, which a rotation replaces).
            view?.let {
                WebHost.detachOffscreen(it)
                it.destroy()
            }
            view = null
        }
        next()
    }
}
