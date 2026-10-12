import Foundation

/// Where an icon's bytes come from. The catalogue gives an icon as a route of the Space or as an
/// http(s) URL a manifest names (src/space/panel/view.ts `iconUrl`), which may be on another site.
/// The Space's own are read through its API, with its session and its rule that an answer from
/// elsewhere means "sign in"; that rule must not be applied to a public image on another site.
enum IconSource: Equatable {
    /// A route or URL of the Space itself.
    case space(String)
    /// An address on another site.
    case external(URL)

    init?(_ icon: String, space: URL) {
        guard let url = URL(string: icon, relativeTo: space)?.absoluteURL,
              let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https"
        else { return nil }
        self = ConnectionRules.sameOrigin(url, space) ? .space(icon) : .external(url)
    }
}
