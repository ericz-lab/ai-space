package dev.aispace.android.core

import java.net.URI

enum class NavigationDecision { allow, openExternally, download, cancel }

/** One navigation as the policy sees it, free of WebView types so it can be tested. */
data class NavigationRequest(
    val url: URI,
    val isMainFrame: Boolean,
    /** The user tapped a link (a navigation with a user gesture). */
    val isLinkActivation: Boolean,
    /** target=_blank or window.open: the page asks for a new window. */
    val opensNewWindow: Boolean,
    /** The link carries a `download` attribute. */
    val shouldDownload: Boolean,
    /** The main frame currently shows the connection's own origin. */
    val fromConnectionPage: Boolean,
)

/**
 * The panel stays in the window; everything else goes to the default browser.
 * A redirect or script navigation away from the panel's origin stays in the window so an access
 * layer's sign-in can complete, but a link the user taps on the panel leaves for the browser.
 */
object NavigationPolicy {
    fun decide(r: NavigationRequest, connection: URI): NavigationDecision {
        val scheme = Urls.scheme(r.url)
        val web = scheme == "http" || scheme == "https"
        val sameOrigin = web && ConnectionRules.sameOrigin(r.url, connection)

        if (r.shouldDownload) {
            if (sameOrigin || scheme == "blob" || scheme == "data") return NavigationDecision.download
            return if (web) NavigationDecision.openExternally else NavigationDecision.cancel
        }
        if (r.opensNewWindow) {
            return if (web) NavigationDecision.openExternally else NavigationDecision.cancel
        }
        when (scheme) {
            "about", "blob", "data" -> return NavigationDecision.allow
            "http", "https" -> {}
            // mailto:, tel:, other apps' schemes: only on a tap, and never inside the panel.
            else -> return if (r.isLinkActivation) NavigationDecision.openExternally else NavigationDecision.cancel
        }
        if (!r.isMainFrame || sameOrigin) return NavigationDecision.allow
        if (r.isLinkActivation && r.fromConnectionPage) return NavigationDecision.openExternally
        return NavigationDecision.allow
    }
}
