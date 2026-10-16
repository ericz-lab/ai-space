package dev.aispace.android.web

import android.content.Context
import android.util.Log
import android.webkit.CookieManager
import android.webkit.WebStorage
import android.webkit.WebView
import androidx.annotation.MainThread
import androidx.webkit.Profile
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import dev.aispace.android.core.CookieSource
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.util.UUID
import kotlin.coroutines.resume

/**
 * One saved Space's own web profile: its cookies, storage and cache, apart from every other Space and
 * from the browser (the iOS client's `WKWebsiteDataStore(forIdentifier:)`). The panel, every app page
 * and the native calls of that Space use it: the native calls read this profile's cookies for each
 * request ([cookies]), so one sign-in in a web view serves all of them.
 *
 * The profile is an androidx.webkit [Profile] named `space-<uuid>` (WebView's MULTI_PROFILE, WebView
 * 123 and later). A WebView that has no such feature has one profile only: every Space then shares the
 * default profile, signing out of one Space clears the others' sessions too, and removing one leaves its
 * cookies in the shared jar. That fallback is the price of an outdated WebView, and is logged.
 *
 * The cold start (80ac12a on iOS: a cookie jar read before the persistent profile was initialized came
 * back empty, and everything looked signed out): Chromium's cookie store queues a read until it has
 * loaded its file, so `CookieManager.getCookie` answers from disk on a cold start without a page being
 * loaded first. What Android does need is the profile's CookieManager to be made on the main thread
 * (ProfileStore is a main-thread API, and the first CookieManager loads WebView itself) before it is read
 * elsewhere: [cookies] makes it there, then reads off the main thread, where the read may wait for the
 * store. And cookies reach the disk lazily (Chromium writes them about every 30 seconds): [flush] after
 * a page loads, so a sign-in survives the app being killed right after it.
 */
class SpaceProfile(context: Context, val id: UUID) {
    private val app: Context = context.applicationContext
    val name: String = profileName(id)

    @Volatile private var manager: CookieManager? = null

    /** This Space's profile, made when first asked for; null when WebView has a single profile. */
    @MainThread
    private fun profile(): Profile? =
        if (supported) ProfileStore.getInstance().getOrCreateProfile(name) else null

    /** The profile's cookie jar. Main thread on first use. */
    @MainThread
    fun cookieManager(): CookieManager =
        manager ?: (profile()?.cookieManager ?: CookieManager.getInstance()).also { manager = it }

    /** The `Cookie` header the profile would send to a URL: what native calls carry. */
    val cookies: CookieSource = CookieSource { url ->
        // Not before the launch's profile housekeeping, which also loads WebView ([warmUp]).
        ready.await()
        val jar = manager ?: withContext(Dispatchers.Main.immediate) { cookieManager() }
        withContext(Dispatchers.IO) { jar.getCookie(url) }?.takeIf { it.isNotEmpty() }
    }

    /** The same header, for a caller already off the main thread whose profile is in use (downloads). */
    fun cookieHeaderNow(url: String): String? = manager?.getCookie(url)?.takeIf { it.isNotEmpty() }

    /**
     * Puts [webView] in this profile. It must come before anything else is done with the view (its
     * settings, a script, a load): WebView refuses a profile once the view has been used.
     */
    @MainThread
    fun configure(webView: WebView) {
        warmUpNow()
        if (supported) WebViewCompat.setProfile(webView, name)
        cookieManager()
        // Third-party cookies stay off, as in a browser; an access layer's sign-in is first-party.
    }

    /** Writes the cookies to disk now, so a fresh sign-in survives the process ending. */
    fun flush() {
        manager?.flush()
    }

    /**
     * Ends the Space's session on this phone: its cookies, web storage (local storage, IndexedDB,
     * service worker caches) and HTTP cache.
     */
    @MainThread
    suspend fun clear() {
        val jar = cookieManager()
        suspendCancellableCoroutine { cont -> jar.removeAllCookies { cont.resume(Unit) } }
        jar.flush()
        (profile()?.webStorage ?: WebStorage.getInstance()).deleteAllData()
        // The HTTP cache has no profile API: a web view of the profile clears it.
        try {
            val view = WebView(app)
            configure(view)
            view.clearCache(true)
            view.destroy()
        } catch (e: RuntimeException) {
            Log.w(TAG, "could not clear the cache of $name", e)
        }
    }

    companion object {
        private const val TAG = "ai-space"
        private const val PREFIX = "space-"

        fun profileName(id: UUID): String = PREFIX + id.toString().lowercase()

        /** Open once [warmUp] has run: the profiles of removed Spaces are gone and WebView is loaded. */
        private val ready = kotlinx.coroutines.CompletableDeferred<Unit>()
        private var keep: (() -> Collection<UUID>)? = null
        private var appContext: Context? = null

        /**
         * Loading WebView takes seconds on a slow phone, and it happens on the main thread (ProfileStore
         * and the first CookieManager are main-thread APIs). Done at launch it held the first frame back;
         * [schedule] records what to keep, and [warmUp] does the work once the first frame is up.
         */
        fun schedule(context: Context, keep: () -> Collection<UUID>) {
            appContext = context.applicationContext
            this.keep = keep
        }

        /** After the first frame: prunes the profiles of removed Spaces, then lets cookie reads through. */
        @MainThread
        fun warmUp() = warmUpNow()

        @MainThread
        private fun warmUpNow() {
            if (ready.isCompleted) return
            val context = appContext
            val kept = keep
            if (context != null && kept != null) prune(context, kept())
            ready.complete(Unit)
        }

        /** Whether this phone's WebView keeps a profile per Space; see the class comment. */
        val supported: Boolean by lazy {
            val yes = WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)
            if (!yes) Log.w(TAG, "WebView has no MULTI_PROFILE: every Space shares the default web profile")
            yes
        }

        /**
         * Removes a Space's profile with its files. WebView keeps a profile it has loaded in this
         * process and refuses to delete it; then its session is cleared now and its files go at the
         * next launch ([prune]).
         */
        @MainThread
        fun delete(context: Context, id: UUID) {
            if (!supported) return
            val store = ProfileStore.getInstance()
            val name = profileName(id)
            try {
                store.deleteProfile(name)
            } catch (e: IllegalStateException) {
                store.getProfile(name)?.let { profile ->
                    profile.cookieManager.removeAllCookies(null)
                    profile.cookieManager.flush()
                    profile.webStorage.deleteAllData()
                }
            }
        }

        /** Deletes the profiles of Spaces that are no longer saved; at launch, before any is loaded. */
        @MainThread
        fun prune(context: Context, keep: Collection<UUID>) {
            if (!supported) return
            val kept = keep.map { profileName(it) }.toSet()
            try {
                val store = ProfileStore.getInstance()
                for (name in store.allProfileNames) {
                    if (name.startsWith(PREFIX) && name !in kept) {
                        try {
                            store.deleteProfile(name)
                        } catch (e: RuntimeException) {
                            Log.w(TAG, "could not delete profile $name", e)
                        }
                    }
                }
            } catch (e: RuntimeException) {
                Log.w(TAG, "could not list the web profiles", e)
            }
        }
    }
}
