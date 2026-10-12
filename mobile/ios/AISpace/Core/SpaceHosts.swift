import Foundation

/// The hostnames that belong to one Space: the panel's origin, the page origin of every app
/// that runs a service there or on a peer, and, when the Space routes app hostnames itself,
/// every HTTPS host under its domain (docs/router.md). Pages on these stay in the app and share
/// the Space's web session. Anything else is another site, a link app's page included (a tile
/// that points at documentation or a repository elsewhere): it opens in Safari, where the
/// operator's own logins for that site are.
struct SpaceHosts: Equatable {
    private(set) var origins: Set<String>
    private(set) var domain: String?

    init(space: URL, pages: [URL] = [], domain: String? = nil) {
        origins = Set(([space] + pages).compactMap(Self.origin))
        // The domain only widens the list for a Space that is itself served under it.
        if let domain = domain?.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: ".")), !domain.isEmpty,
           space.scheme?.lowercased() == "https", let host = space.host?.lowercased(),
           host == domain || host.hasSuffix("." + domain) {
            self.domain = domain
        }
    }

    init(space: URL, catalogue: Catalogue?) {
        let pages = (catalogue?.apps ?? []).filter { $0.reach != .link }.compactMap { $0.pageURL(space: space) }
        self.init(space: space, pages: pages, domain: catalogue?.domain)
    }

    func contains(_ url: URL) -> Bool {
        guard let origin = Self.origin(url) else { return false }
        if origins.contains(origin) { return true }
        guard let domain, url.scheme?.lowercased() == "https", let host = url.host?.lowercased(),
              url.port == nil || url.port == 443
        else { return false }
        return host == domain || host.hasSuffix("." + domain)
    }

    /// `scheme://host:port` with the default port written out; nil for anything but http(s).
    static func origin(_ url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = url.host?.lowercased(), !host.isEmpty
        else { return nil }
        return "\(scheme)://\(host):\(url.port ?? (scheme == "https" ? 443 : 80))"
    }
}

/// Where a navigation of a Space page goes on the phone. It is the desktop client's policy
/// (NavigationPolicy) with the Space's host list in place of one origin: Space pages stay, a
/// link tapped on a Space page to another site leaves for Safari, and a redirect off the list
/// stays in the view so the access layer's sign-in can finish there, in the Space's session.
enum MobileNavigation {
    static func decide(_ r: NavigationRequest, hosts: SpaceHosts, space: URL) -> NavigationDecision {
        NavigationPolicy.decide(r, connection: hosts.contains(r.url) ? r.url : space)
    }

    /// What to do with a link the policy sent out of the view (a new window, or a tapped link).
    static func external(_ url: URL, hosts: SpaceHosts) -> ExternalRoute {
        hosts.contains(url) ? .sameView : .browser
    }

    enum ExternalRoute: Equatable {
        /// A Space page asked for a new window: the phone has one view, so it loads there.
        case sameView
        case browser
    }
}
