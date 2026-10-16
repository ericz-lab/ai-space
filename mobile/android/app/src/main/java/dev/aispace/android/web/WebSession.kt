package dev.aispace.android.web

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.content.MutableContextWrapper
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Message
import android.util.Log
import android.view.MotionEvent
import android.view.ViewGroup
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import dev.aispace.android.BuildConfig
import dev.aispace.android.R
import dev.aispace.android.core.ConnectionRules
import dev.aispace.android.core.MobileNavigation
import dev.aispace.android.core.NavigationDecision
import dev.aispace.android.core.NavigationRequest
import dev.aispace.android.core.SpaceCheck
import dev.aispace.android.core.SpaceHosts
import dev.aispace.android.core.SpaceState
import dev.aispace.android.core.Urls
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import java.io.File
import java.io.IOException
import java.net.URI
import java.util.concurrent.TimeUnit

/**
 * One web view and its state: a Space's panel, or one app's page. Its cookies live in the Space's own
 * web profile ([SpaceProfile]), apart from the browser and from every other saved Space, and the
 * native catalogue calls read the same profile, so one sign-in serves both. Nothing here is exposed to
 * page scripts: there is no JavaScript interface and no message listener.
 *
 * The session owns its web view, not the views showing it: a tab kept while another is on show keeps
 * its page, its scroll position and its form (cd6128a). [WebContainer][dev.aispace.android.ui.shell.WebContainer]
 * moves the same view into whichever place shows it. Main thread only.
 */
class WebSession(
    context: Context,
    /** The Space this page belongs to. */
    val space: URI,
    home: URI?,
    private val profile: SpaceProfile,
    /** The Space's hostnames as of now; read on every navigation, so a refreshed catalogue applies at once. */
    val hosts: () -> SpaceHosts,
) {
    private val app: Context = context.applicationContext

    /** The page this session opens. */
    val home: URI = home ?: space

    /** The panel's session confirms the page is ai-space; an app's page is whatever the app serves. */
    val verifiesSpace: Boolean = home == null

    /** Where a link leaving the view goes; the app hands it to the browser. */
    var openExternally: (URI) -> Unit = {}
    var onStateChange: ((SpaceState) -> Unit)? = null

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val density = app.resources.displayMetrics.density

    private val stateFlow = MutableStateFlow<SpaceState>(SpaceState.Connecting)
    val state: StateFlow<SpaceState> = stateFlow.asStateFlow()

    private val loadingState = MutableStateFlow(false)
    val isLoading: StateFlow<Boolean> = loadingState.asStateFlow()

    /**
     * Whether a page has been drawn since the session's own page was asked for: a Space page once it
     * starts to arrive, any other (an access layer's sign-in) once it is whole (6ee42f8). Until then the
     * view is blank, through every redirect of a sign-in that needs no one, and the mark stands in.
     */
    private val contentState = MutableStateFlow(false)
    val hasContent: StateFlow<Boolean> = contentState.asStateFlow()

    private val backState = MutableStateFlow(false)
    val canGoBack: StateFlow<Boolean> = backState.asStateFlow()
    private val forwardState = MutableStateFlow(false)
    val canGoForward: StateFlow<Boolean> = forwardState.asStateFlow()
    private val hiddenState = MutableStateFlow(false)

    /** The floating button leaves while the finger reads down the page, and comes back going up. */
    val controlsHidden: StateFlow<Boolean> = hiddenState.asStateFlow()
    private val progressState = MutableStateFlow(0f)
    val progress: StateFlow<Float> = progressState.asStateFlow()
    private val urlState = MutableStateFlow<URI?>(null)
    val currentUrl: StateFlow<URI?> = urlState.asStateFlow()
    private val titleState = MutableStateFlow("")
    val pageTitle: StateFlow<String> = titleState.asStateFlow()

    /**
     * The page's own background (ARGB), for the system bars' areas around it (0bbbb62). Android has no
     * `underPageBackgroundColor`: the computed background of the page's root (or its body, as CSS
     * propagates it to the canvas) is read after a load and every few seconds while the page is on
     * show. It is only read: the website stays in charge of its colours.
     */
    private val backgroundState = MutableStateFlow(defaultBackground())
    val pageBackground: StateFlow<Int> = backgroundState.asStateFlow()

    /** A finished download, waiting for the share sheet. */
    val downloaded = MutableStateFlow<File?>(null)

    /** Why a download did not finish, waiting to be said. */
    val downloadFailure = MutableStateFlow<String?>(null)

    private val gesture = BrowserControlGesture(24f * density)
    private var started = false
    private var destroyed = false

    /** The main frame's last load failed; its onPageFinished is not a page. */
    private var loadFailed = false

    /** Counts the Space checks, so one that answers after the next navigation is dropped. */
    private var checkToken = 0
    private var userAgent: String = ""

    private val viewState = MutableStateFlow(makeView())

    /** The web view on show; a new one replaces it when the page's renderer died. */
    val views: StateFlow<WebView> = viewState.asStateFlow()
    val webView: WebView get() = viewState.value

    private fun defaultBackground(): Int {
        val night = app.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
        return if (night) Color.BLACK else Color.WHITE
    }

    @SuppressLint("SetJavaScriptEnabled", "ClickableViewAccessibility")
    private fun makeView(): WebView {
        // A context the view can be moved between activities with (WebContainer sets the activity on
        // show): pop-ups such as a <select> list need an activity.
        val view = WebView(MutableContextWrapper(app))
        // The profile first: WebView refuses one once the view has been used.
        profile.configure(view)
        with(view.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            setSupportMultipleWindows(true)
            javaScriptCanOpenWindowsAutomatically = true
            allowFileAccess = false
            builtInZoomControls = true
            displayZoomControls = false
            // The panel leaves its dock, edges, swipe and hint out for this user agent.
            userAgentString = "$userAgentString AISpaceMobile/${BuildConfig.VERSION_NAME}"
            this@WebSession.userAgent = userAgentString
        }
        if (verifiesSpace) {
            // The panel lies over the app's own ground; an app page keeps WebView's opaque white.
            view.setBackgroundColor(Color.TRANSPARENT)
        }
        view.webViewClient = Client()
        view.webChromeClient = Chrome()
        view.setDownloadListener { url, _, disposition, mimeType, _ -> download(url, disposition, mimeType) }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            // A page usually revokes a blob right after its download link is clicked, before the
            // download reaches here; the revocation waits a minute so the blob can still be read.
            WebViewCompat.addDocumentStartJavaScript(view, KEEP_BLOBS, setOf("*"))
        }
        // Vertical drags in the page, nested scrolling regions included, hide and show the floating
        // button; the touches go on to the page untouched.
        var startX = 0f
        var startY = 0f
        var tracking = false
        view.setOnTouchListener { _, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    startX = e.x
                    startY = e.y
                    tracking = true
                    gesture.reset()
                }
                MotionEvent.ACTION_POINTER_DOWN -> tracking = false
                MotionEvent.ACTION_MOVE -> if (tracking) {
                    gesture.update(e.x - startX, e.y - startY)?.let { hiddenState.value = it }
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> tracking = false
            }
            false
        }
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
        return view
    }

    /** Loads the page the first time it is shown. */
    fun start() {
        if (started || destroyed) return
        started = true
        load()
        scope.launch {
            // A light poll of the page's background: CSS can change it at any time (a theme switch).
            while (isActive) {
                delay(2500)
                if (!destroyed && webView.isAttachedToWindow && !loadingState.value) sampleBackground()
            }
        }
    }

    fun load() {
        if (destroyed) return
        started = true
        setState(SpaceState.Connecting)
        contentState.value = false
        loadFailed = false
        webView.loadUrl(home.toString())
    }

    /** Reloads the current page; after a failure, starts again from the session's own page. */
    fun reload() {
        if (destroyed) return
        if (webView.url == null || stateFlow.value.isFailure) load() else webView.reload()
    }

    /** Stops the page loading; the page stays. */
    fun stopLoading() {
        if (destroyed) return
        webView.stopLoading()
        loadingState.value = false
    }

    /** Ends the session: the tab was closed, or the Space signed out. The web view is destroyed. */
    fun stop() {
        if (destroyed) return
        destroyed = true
        onStateChange = null
        scope.cancel()
        val view = webView
        view.stopLoading()
        (view.parent as? ViewGroup)?.removeView(view)
        view.destroy()
        loadingState.value = false
    }

    fun recoverIfFailed() {
        if (started && stateFlow.value.isFailure) load()
    }

    fun showControls() {
        hiddenState.value = false
        gesture.reset()
    }

    fun goBack() {
        if (!destroyed && webView.canGoBack()) webView.goBack()
    }

    fun goForward() {
        if (!destroyed && webView.canGoForward()) webView.goForward()
    }

    private fun current(): URI? = if (destroyed) urlState.value else webView.url?.let { Urls.parse(it) }

    /**
     * The address to hand to the browser or the share sheet: the page on show while it is a Space page,
     * else the session's own page (never a half-finished sign-in URL).
     */
    val shareUrl: URI get() = current()?.takeIf { hosts().contains(it) } ?: home

    /** True while the view shows a page of the Space; false on an access layer's sign-in pages. */
    val showsSpacePage: Boolean get() = current()?.let { hosts().contains(it) } ?: false

    private fun setState(value: SpaceState) {
        if (stateFlow.value == value) return
        stateFlow.value = value
        if (BuildConfig.DEBUG) Log.d(TAG, "$home $value at ${current() ?: "-"}")
        onStateChange?.invoke(value)
    }

    private fun updateNavigation(view: WebView) {
        if (destroyed || view !== webView) return
        backState.value = view.canGoBack()
        forwardState.value = view.canGoForward()
        urlState.value = view.url?.let { Urls.parse(it) }
        view.title?.let { titleState.value = it }
    }

    /**
     * Whether the page is ai-space. The iOS client runs [SpaceCheck.script] in the page; Android's
     * evaluateJavascript cannot wait for a promise, so the check is the same request made natively with
     * the profile's cookies, which is what the page's own fetch would carry.
     */
    private fun check() {
        if (!showsSpacePage) return setState(SpaceState.AuthenticationRequired)
        val url = current()
        if (!verifiesSpace || url == null || !ConnectionRules.sameOrigin(url, space)) return setState(SpaceState.Ready)
        val token = ++checkToken
        scope.launch {
            val result = verify(url)
            if (token == checkToken && !destroyed) setState(result)
        }
    }

    private suspend fun verify(page: URI): SpaceState = withContext(Dispatchers.IO) {
        val target = Urls.resolve(page, SpaceCheck.path) ?: return@withContext SpaceState.Incompatible("invalid address")
        val b = Request.Builder().url(target.toString()).header("Accept", "application/json").header("User-Agent", userAgent)
        profile.cookieHeaderNow(target.toString())?.let { b.header("Cookie", it) }
        try {
            checkClient.newCall(b.build()).execute().use { r ->
                SpaceCheck.classify(r.code, r.header("Content-Type") ?: "", r.body?.string() ?: "")
            }
        } catch (e: IOException) {
            SpaceState.Incompatible(e.localizedMessage ?: e.toString())
        }
    }

    private fun fail(code: Int, description: String) {
        loadingState.value = false
        contentState.value = true
        SpaceCheck.classifyError(code, description)?.let {
            loadFailed = true
            setState(it)
        }
    }

    private fun sampleBackground() {
        if (destroyed) return
        webView.evaluateJavascript(BACKGROUND) { raw ->
            parseBackground(raw)?.let { if (!destroyed) backgroundState.value = it }
        }
    }

    private fun hidePanelChrome(view: WebView) {
        // The panel page has its own ways between its screens (src/web/ScreenNav.tsx). The app has its
        // own screens, so they are left out. A newer Space leaves them out itself, by the user agent;
        // this covers one that does not yet.
        if (verifiesSpace) view.evaluateJavascript(PANEL_STYLE, null)
    }

    private fun route(url: URI, list: SpaceHosts) {
        when (MobileNavigation.external(url, list)) {
            MobileNavigation.ExternalRoute.sameView -> if (!destroyed) webView.loadUrl(url.toString())
            MobileNavigation.ExternalRoute.browser -> openExternally(url)
        }
    }

    private fun download(url: String, disposition: String?, mimeType: String?) {
        if (destroyed) return
        val scheme = url.substringBefore(':').lowercase()
        if (scheme == "http" || scheme == "https") {
            val parsed = Urls.parse(url) ?: return
            val request = NavigationRequest(
                url = parsed, isMainFrame = true, isLinkActivation = false, opensNewWindow = false,
                shouldDownload = true, fromConnectionPage = showsSpacePage,
            )
            when (MobileNavigation.decide(request, hosts(), space)) {
                NavigationDecision.download -> {}
                NavigationDecision.openExternally -> return openExternally(parsed)
                else -> return
            }
        } else if (scheme != "blob" && scheme != "data") {
            return
        }
        loadingState.value = false
        contentState.value = true
        scope.launch {
            try {
                downloaded.value = when (scheme) {
                    "data" -> WebDownloads.saveData(url, disposition, mimeType)
                    "blob" -> WebDownloads.saveBlob(webView, url, disposition, mimeType)
                    else -> WebDownloads.saveHttp(url, disposition, mimeType, userAgent, profile)
                }
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "download failed: ${e.message}")
                downloadFailure.value = e.localizedMessage ?: e.toString()
            }
        }
    }

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = Urls.parse(request.url.toString()) ?: return true
            val list = hosts()
            val navigation = NavigationRequest(
                url = url,
                isMainFrame = request.isForMainFrame,
                // A tap is a navigation with a user gesture; a redirect after it is not one.
                isLinkActivation = request.hasGesture() && !request.isRedirect,
                opensNewWindow = false,
                shouldDownload = false,
                fromConnectionPage = showsSpacePage,
            )
            return when (MobileNavigation.decide(navigation, list, space)) {
                NavigationDecision.allow -> false
                NavigationDecision.download, NavigationDecision.cancel -> true
                NavigationDecision.openExternally -> {
                    route(url, list)
                    true
                }
            }
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            if (view !== webView) return
            checkToken++
            loadFailed = false
            loadingState.value = true
            showControls()
            updateNavigation(view)
        }

        override fun onPageCommitVisible(view: WebView, url: String?) {
            if (view !== webView) return
            updateNavigation(view)
            if (showsSpacePage) contentState.value = true
            hidePanelChrome(view)
            sampleBackground()
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
            updateNavigation(view)
        }

        override fun onPageFinished(view: WebView, url: String?) {
            if (view !== webView || destroyed) return
            loadingState.value = false
            updateNavigation(view)
            if (loadFailed) return
            contentState.value = true
            hidePanelChrome(view)
            check()
            sampleBackground()
            profile.flush()
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (view !== webView || !request.isForMainFrame) return
            fail(error.errorCode, error.description?.toString() ?: "")
        }

        /** Android ends a page's renderer under memory pressure; the page is made again from the server. */
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            if (view !== webView || destroyed) {
                (view.parent as? ViewGroup)?.removeView(view)
                view.destroy()
                return true
            }
            (view.parent as? ViewGroup)?.removeView(view)
            view.destroy()
            viewState.value = makeView()
            if (started) load()
            return true
        }
    }

    private inner class Chrome : WebChromeClient() {
        override fun onProgressChanged(view: WebView, newProgress: Int) {
            if (view !== webView) return
            progressState.value = newProgress / 100f
            updateNavigation(view)
        }

        override fun onReceivedTitle(view: WebView, title: String?) {
            if (view === webView) titleState.value = title ?: ""
        }

        /**
         * target=_blank and window.open never get a second web view: a Space page loads in this one,
         * another site goes to the browser. A throwaway view takes the new window only to learn its
         * address.
         */
        override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
            val transport = resultMsg.obj as? WebView.WebViewTransport ?: return false
            val popup = WebView(view.context)
            profile.configure(popup)
            var taken = false
            fun take(address: String?) {
                if (taken || address == null) return
                taken = true
                val url = Urls.parse(address)
                val scheme = url?.let { Urls.scheme(it) }
                if (url != null && (scheme == "http" || scheme == "https") && !destroyed) route(url, hosts())
                popup.post {
                    popup.stopLoading()
                    popup.destroy()
                }
            }
            popup.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
                    take(request.url.toString())
                    return true
                }

                override fun onPageStarted(v: WebView, url: String?, favicon: Bitmap?) {
                    if (url != null && url != "about:blank") take(url)
                }
            }
            // A window that never names an address (written by script) goes away after a while.
            popup.postDelayed({ if (!taken) { taken = true; popup.destroy() } }, 10_000)
            transport.webView = popup
            resultMsg.sendToTarget()
            return true
        }

        /** Camera and microphone for the Space's own pages only; Android still asks the operator. */
        override fun onPermissionRequest(request: PermissionRequest) {
            val origin = Urls.parse(request.origin.toString())
            val onList = origin != null && hosts().contains(origin)
            val wanted = request.resources.filter {
                it == PermissionRequest.RESOURCE_VIDEO_CAPTURE || it == PermissionRequest.RESOURCE_AUDIO_CAPTURE
            }
            val host = WebHost.current
            if (!onList || wanted.isEmpty() || host == null || destroyed) {
                request.deny()
                return
            }
            fun permission(resource: String) =
                if (resource == PermissionRequest.RESOURCE_VIDEO_CAPTURE) Manifest.permission.CAMERA else Manifest.permission.RECORD_AUDIO
            host.requestPermissions(wanted.map { permission(it) }.distinct().toTypedArray()) { answers ->
                val granted = wanted.filter { answers[permission(it)] == true }
                if (granted.isEmpty()) request.deny() else request.grant(granted.toTypedArray())
            }
        }

        override fun onShowFileChooser(
            webView: WebView?,
            filePathCallback: ValueCallback<Array<Uri>>?,
            fileChooserParams: FileChooserParams?,
        ): Boolean {
            val callback = filePathCallback ?: return false
            val host = WebHost.current
            val intent: Intent? = try {
                fileChooserParams?.createIntent()
            } catch (e: RuntimeException) {
                null
            }
            if (host == null || intent == null) {
                callback.onReceiveValue(null)
                return true
            }
            if (fileChooserParams?.mode == FileChooserParams.MODE_OPEN_MULTIPLE) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            host.chooseFiles(intent) { uris -> callback.onReceiveValue(uris) }
            return true
        }

        override fun onJsAlert(view: WebView, url: String?, message: String?, result: JsResult): Boolean {
            val activity = WebHost.activity ?: run { result.cancel(); return true }
            AlertDialog.Builder(activity)
                .setTitle(origin(url))
                .setMessage(message)
                .setPositiveButton(R.string.shell_ok) { _, _ -> result.confirm() }
                .setOnCancelListener { result.cancel() }
                .show()
            return true
        }

        override fun onJsConfirm(view: WebView, url: String?, message: String?, result: JsResult): Boolean {
            val activity = WebHost.activity ?: run { result.cancel(); return true }
            AlertDialog.Builder(activity)
                .setTitle(origin(url))
                .setMessage(message)
                .setNegativeButton(R.string.shell_cancel) { _, _ -> result.cancel() }
                .setPositiveButton(R.string.shell_ok) { _, _ -> result.confirm() }
                .setOnCancelListener { result.cancel() }
                .show()
            return true
        }

        override fun onJsPrompt(view: WebView, url: String?, message: String?, defaultValue: String?, result: JsPromptResult): Boolean {
            val activity = WebHost.activity ?: run { result.cancel(); return true }
            val field = EditText(activity).apply { setText(defaultValue ?: "") }
            val box = FrameLayout(activity).apply {
                val pad = (20 * density).toInt()
                setPadding(pad, 0, pad, 0)
                addView(field)
            }
            AlertDialog.Builder(activity)
                .setTitle(origin(url))
                .setMessage(message)
                .setView(box)
                .setNegativeButton(R.string.shell_cancel) { _, _ -> result.cancel() }
                .setPositiveButton(R.string.shell_ok) { _, _ -> result.confirm(field.text.toString()) }
                .setOnCancelListener { result.cancel() }
                .show()
            return true
        }

        /** Titled with the page's origin, so a dialog from a page is not mistaken for the app's. */
        private fun origin(url: String?): String? = url?.let { Urls.parse(it) }?.let { ConnectionRules.originHeader(it) }
    }

    companion object {
        private const val TAG = "ai-space"

        private val checkClient: OkHttpClient by lazy {
            dev.aispace.android.core.SpaceApi.sharedClient.newBuilder()
                .followRedirects(false)
                .followSslRedirects(false)
                .cookieJar(okhttp3.CookieJar.NO_COOKIES)
                .cache(null)
                .callTimeout(30, TimeUnit.SECONDS)
                .build()
        }

        private const val PANEL_STYLE =
            "(function(){if(document.getElementById('aispace-mobile'))return;var s=document.createElement('style');" +
                "s.id='aispace-mobile';s.textContent='.dock,.edge,.screens-hint{display:none!important}';" +
                "(document.head||document.documentElement).appendChild(s);})()"

        private const val KEEP_BLOBS =
            "(function(){var r=URL.revokeObjectURL;if(!r||r.__aispace)return;" +
                "var d=function(u){setTimeout(function(){r.call(URL,u)},60000)};d.__aispace=true;URL.revokeObjectURL=d;})();"

        /**
         * The colour the page's canvas has: the root's background, else the body's (CSS propagates it),
         * else the default canvas, dark for a page that asks for a dark scheme.
         */
        private const val BACKGROUND =
            "(function(){function c(e){if(!e)return null;var v=getComputedStyle(e).backgroundColor;" +
                "return v&&v!=='transparent'&&!/^rgba\\(.*,\\s*0\\)$/.test(v)?v:null}" +
                "var v=c(document.documentElement)||c(document.body);if(v)return v;" +
                "var s=getComputedStyle(document.documentElement).colorScheme||'';" +
                "return s.indexOf('dark')>=0&&(s.indexOf('light')<0||matchMedia('(prefers-color-scheme: dark)').matches)?'dark':'light'})()"

        /** The script's answer (a JSON string) as an opaque colour; null when it cannot be read. */
        internal fun parseBackground(raw: String?): Int? {
            if (raw == null || raw == "null") return null
            val text = try {
                JSONArray("[$raw]").optString(0)
            } catch (e: Exception) {
                return null
            }
            when (text) {
                "light" -> return Color.WHITE
                "dark" -> return Color.rgb(18, 18, 18)
            }
            val match = Regex("""rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)""").find(text) ?: return null
            val r = match.groupValues[1]
            val g = match.groupValues[2]
            val b = match.groupValues[3]
            val alphaText = match.groupValues[4]
            val alpha = when {
                alphaText.isEmpty() -> 1f
                alphaText.endsWith("%") -> (alphaText.dropLast(1).toFloatOrNull() ?: 100f) / 100f
                else -> alphaText.toFloatOrNull() ?: 1f
            }.coerceIn(0f, 1f)
            fun channel(v: String): Float = (v.toFloatOrNull() ?: 255f).coerceIn(0f, 255f)
            // A translucent background lies over the white canvas.
            fun over(v: String): Int = (channel(v) * alpha + 255f * (1 - alpha)).toInt()
            return Color.rgb(over(r), over(g), over(b))
        }
    }
}
