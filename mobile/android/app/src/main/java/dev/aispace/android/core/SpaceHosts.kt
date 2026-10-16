package dev.aispace.android.core

import java.net.URI

/**
 * The hostnames that belong to one Space: the panel's origin, the page origin of every app
 * that runs a service there or on a peer, and, when the Space routes app hostnames itself,
 * every HTTPS host under its domain (docs/router.md). Pages on these stay in the app and share
 * the Space's web session. Anything else is another site, a link app's page included (a tile
 * that points at documentation or a repository elsewhere): it opens in the browser, where the
 * operator's own logins for that site are.
 */
class SpaceHosts private constructor(val origins: Set<String>, val domain: String?) {

    fun contains(url: URI): Boolean {
        val origin = origin(url) ?: return false
        if (origin in origins) return true
        val domain = domain ?: return false
        if (Urls.scheme(url) != "https") return false
        val host = Urls.host(url) ?: return false
        val port = Urls.port(url)
        if (port != null && port != 443) return false
        return host == domain || host.endsWith(".$domain")
    }

    override fun equals(other: Any?) = other is SpaceHosts && other.origins == origins && other.domain == domain
    override fun hashCode() = origins.hashCode() * 31 + (domain?.hashCode() ?: 0)
    override fun toString() = "SpaceHosts(origins=$origins, domain=$domain)"

    companion object {
        operator fun invoke(space: URI, pages: List<URI> = emptyList(), domain: String? = null): SpaceHosts {
            val origins = (listOf(space) + pages).mapNotNull { origin(it) }.toSet()
            // The domain only widens the list for a Space that is itself served under it.
            val d = domain?.lowercase()?.trim('.')
            val host = Urls.host(space)
            val kept = if (!d.isNullOrEmpty() && Urls.scheme(space) == "https" && host != null &&
                (host == d || host.endsWith(".$d"))
            ) d else null
            return SpaceHosts(origins, kept)
        }

        /** The panel and the pages of the apps that run a service (not link apps), and the catalogue's domain. */
        fun of(space: URI, catalogue: Catalogue?): SpaceHosts {
            val pages = (catalogue?.apps ?: emptyList()).filter { it.reach != Reach.link }.mapNotNull { it.pageURL(space) }
            return invoke(space, pages, catalogue?.domain)
        }

        /** `scheme://host:port` with the default port written out; null for anything but http(s). */
        fun origin(url: URI): String? {
            val scheme = Urls.scheme(url)
            if (scheme != "http" && scheme != "https") return null
            val host = Urls.host(url)
            if (host.isNullOrEmpty()) return null
            return "$scheme://$host:${Urls.port(url) ?: if (scheme == "https") 443 else 80}"
        }
    }
}

/**
 * Where a navigation of a Space page goes on the phone. It is the desktop client's policy
 * ([NavigationPolicy]) with the Space's host list in place of one origin: Space pages stay, a
 * link tapped on a Space page to another site leaves for the browser, and a redirect off the list
 * stays in the view so the access layer's sign-in can finish there, in the Space's session.
 */
object MobileNavigation {
    fun decide(r: NavigationRequest, hosts: SpaceHosts, space: URI): NavigationDecision =
        NavigationPolicy.decide(r, if (hosts.contains(r.url)) r.url else space)

    /** What to do with a link the policy sent out of the view (a new window, or a tapped link). */
    fun external(url: URI, hosts: SpaceHosts): ExternalRoute =
        if (hosts.contains(url)) ExternalRoute.sameView else ExternalRoute.browser

    enum class ExternalRoute {
        /** A Space page asked for a new window: the phone has one view, so it loads there. */
        sameView,
        browser,
    }
}
