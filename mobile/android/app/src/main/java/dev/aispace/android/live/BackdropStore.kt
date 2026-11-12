package dev.aispace.android.live

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.util.LruCache
import android.view.View
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import dev.aispace.android.core.ConnectionRules
import dev.aispace.android.core.SpacePath
import dev.aispace.android.core.Urls
import dev.aispace.android.web.SpaceProfile
import dev.aispace.android.web.WebHost
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.net.URI

/**
 * The drawn artwork some of the panel's themes have behind the page (`/backdrops/<name>.html`,
 * src/web/theme.ts), fetched from the Space with its session and drawn once to a bitmap by an offscreen
 * web view: the artwork is static, and a picture scrolls better under the pages than a live document.
 * Kept on disk per name, light or dark, and size: a launch shows the bitmap of the one before as soon
 * as it is read (a2e99bb, read off the main thread), and draws the artwork again behind it in case it
 * changed. In memory only the few most recently used, bounded by bytes: each is a screen of pixels.
 *
 * Main thread only.
 */
class BackdropStore(
    private val context: Context,
    private val space: URI,
    private val profile: SpaceProfile,
    private val directory: File,
    private val scope: CoroutineScope,
) {
    private class Job(val key: String, val name: String, val dark: Boolean, val width: Int, val height: Int)

    private val images = object : LruCache<String, Bitmap>(MEMORY_BYTES) {
        override fun sizeOf(key: String, value: Bitmap): Int = value.allocationByteCount
    }
    private val failed = HashSet<String>()
    private val diskChecked = HashSet<String>()

    /** Read from disk and not drawn again in this launch yet. */
    private val stale = HashSet<String>()
    private var waiting: Job? = null
    private var current: Job? = null
    private var webView: WebView? = null
    private val main = Handler(Looper.getMainLooper())

    private val versionState = MutableStateFlow(0)

    /** Bumps whenever an image becomes available (or a failed one may be tried again). */
    val version: StateFlow<Int> = versionState.asStateFlow()

    /** The names are the presets' own (`ThemePreset.backdrop`), so the key is a safe file name. */
    private fun file(key: String): File = File(directory, key.replace("|", "-") + ".png")

    /**
     * The artwork at this size in pixels, or while it is being drawn the same artwork at another size;
     * null until there is any. Starts drawing it when it is missing or was read from disk.
     */
    fun image(name: String, dark: Boolean, width: Int, height: Int): Bitmap? {
        if (width <= 50 || height <= 50) return null
        val prefix = "$name|$dark|"
        val key = prefix + "${width}x$height"
        // Room for this size and one other (shown while this one is drawn) whatever the budget, or a
        // large screen's bitmap would be evicted as it is put and drawn again and again.
        val needed = (width.toLong() * height * 4 * 2).coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
        if (needed > images.maxSize()) images.resize(needed)
        if (images[key] == null && diskChecked.add(key)) readFromDisk(key, width, height)
        val hit = images[key]
        if ((hit == null || key in stale) && current?.key != key && waiting?.key != key && key !in failed) {
            // Only the latest size asked for matters; not started from inside a composition.
            waiting = Job(key, name, dark, width, height)
            main.post { next() }
        }
        return hit ?: images.snapshot().entries.firstOrNull { it.key.startsWith(prefix) }?.value
    }

    /**
     * The bitmap an earlier launch saved, decoded on the IO dispatcher, no larger than the size asked
     * for. A drawing that finished first is newer and is kept.
     */
    private fun readFromDisk(key: String, width: Int, height: Int) {
        val path = file(key).path
        scope.launch {
            val decoded = withContext(Dispatchers.IO) {
                try {
                    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    BitmapFactory.decodeFile(path, bounds)
                    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return@withContext null
                    var sample = 1
                    while (bounds.outWidth / (sample * 2) >= width && bounds.outHeight / (sample * 2) >= height) sample *= 2
                    BitmapFactory.decodeFile(path, BitmapFactory.Options().apply { inSampleSize = sample })
                } catch (e: OutOfMemoryError) {
                    null
                }
            } ?: return@launch
            if (images[key] != null) return@launch
            images.put(key, decoded)
            stale.add(key)
            versionState.value += 1
        }
    }

    /** A failed drawing is tried again after a sign-in (the session may have been the reason). */
    fun retryFailed() {
        if (failed.isEmpty()) return
        failed.clear()
        versionState.value += 1
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun next() {
        val job = waiting ?: return
        if (current != null) return
        val activity = WebHost.activity
        if (activity == null) {
            WebHost.whenAttached { next() }
            return
        }
        val url = Urls.resolve(space, "/backdrops/${SpacePath.escape(job.name)}.html?v=2") ?: return
        waiting = null
        current = job
        val view = WebView(activity)
        // The Space's own profile, for its session: the artwork is served behind the access layer too.
        profile.configure(view)
        view.settings.javaScriptEnabled = true
        view.settings.domStorageEnabled = true
        view.setBackgroundColor(Color.TRANSPARENT)
        view.isVerticalScrollBarEnabled = false
        view.isHorizontalScrollBarEnabled = false
        view.isFocusable = false
        view.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        view.webViewClient = Client()
        webView = view
        if (!WebHost.attachOffscreen(view, job.width, job.height)) {
            finish(null)
            return
        }
        view.loadUrl(url.toString())
    }

    private fun finish(image: Bitmap?) {
        val job = current
        if (job != null) {
            if (image != null) {
                images.put(job.key, image)
                stale.remove(job.key)
                save(image, file(job.key))
            } else {
                failed.add(job.key)
            }
        }
        webView?.let {
            it.stopLoading()
            WebHost.detachOffscreen(it)
            it.destroy()
        }
        webView = null
        current = null
        versionState.value += 1
        next()
    }

    /** Encoding a screen of pixels takes long enough to drop frames: it happens off the main thread. */
    private fun save(image: Bitmap, target: File) {
        scope.launch(Dispatchers.IO) {
            try {
                target.parentFile?.mkdirs()
                val tmp = File(target.path + ".tmp")
                FileOutputStream(tmp).use { image.compress(Bitmap.CompressFormat.PNG, 100, it) }
                if (!tmp.renameTo(target)) tmp.delete()
            } catch (e: Exception) {
                // The memory cache still works when the disk cache is unavailable.
            }
        }
    }

    private fun snapshot(view: WebView) {
        val job = current ?: return
        if (view !== webView) return
        // The artwork picks its version from `data-theme`; the app's choice wins over the system's.
        view.evaluateJavascript("document.documentElement.dataset.theme='${if (job.dark) "dark" else "light"}'", null)
        // The artwork's filters and gradients need a moment after the load to be painted.
        main.postDelayed({
            if (view !== webView || current !== job) return@postDelayed
            val bitmap = try {
                Bitmap.createBitmap(job.width, job.height, Bitmap.Config.ARGB_8888).also { view.draw(Canvas(it)) }
            } catch (e: RuntimeException) {
                null
            } catch (e: OutOfMemoryError) {
                null
            }
            finish(bitmap)
        }, 600)
    }

    private companion object {
        /** About three phone screens of ARGB pixels, and never more than an eighth of the heap. */
        val MEMORY_BYTES: Int = minOf(32L * 1024 * 1024, Runtime.getRuntime().maxMemory() / 8).toInt()
    }

    private inner class Client : WebViewClient() {
        override fun onPageCommitVisible(view: WebView, url: String?) {
            val job = current ?: return
            view.evaluateJavascript("document.documentElement.dataset.theme='${if (job.dark) "dark" else "light"}'", null)
        }

        override fun onPageFinished(view: WebView, url: String?) {
            snapshot(view)
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame && view === webView) finish(null)
        }

        /** A main page that is not 200 (a sign-in, a missing artwork) is not the artwork. */
        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
            if (request.isForMainFrame && errorResponse.statusCode != 200 && view === webView) finish(null)
        }

        /** Only the artwork itself loads: a redirect to a sign-in page, or anything off the Space, is not it. */
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val scheme = request.url.scheme?.lowercase() ?: return true
            if (scheme == "about" || scheme == "data" || scheme == "blob") return false
            val url = Urls.parse(request.url.toString()) ?: return true
            val allowed = ConnectionRules.sameOrigin(url, space) && (url.rawPath ?: "").startsWith("/backdrops/")
            if (!allowed && request.isForMainFrame && view === webView) main.post { if (view === webView) finish(null) }
            return !allowed
        }
    }
}
