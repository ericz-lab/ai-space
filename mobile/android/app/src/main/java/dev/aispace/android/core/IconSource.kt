package dev.aispace.android.core

import java.net.URI

/**
 * Where an icon's bytes come from. The catalogue gives an icon as a route of the Space or as an
 * http(s) URL a manifest names (src/space/panel/view.ts `iconUrl`), which may be on another site.
 * The Space's own are read through its API, with its session and its rule that an answer from
 * elsewhere means "sign in"; that rule must not be applied to a public image on another site,
 * which is fetched plainly, without the Space's cookies.
 */
sealed class IconSource {
    /** A route or URL of the Space itself, as the catalogue gave it. */
    data class Space(val path: String) : IconSource()

    /** An address on another site. */
    data class External(val url: URI) : IconSource()

    companion object {
        /** Where [icon] comes from, or null when it is not an http(s) address (an emoji, a `file:` URL). */
        fun of(icon: String, space: URI): IconSource? {
            val url = Urls.resolve(space, icon) ?: return null
            val scheme = Urls.scheme(url)
            if (scheme != "http" && scheme != "https") return null
            return if (ConnectionRules.sameOrigin(url, space)) Space(icon) else External(url)
        }
    }
}
