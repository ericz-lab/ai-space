import Foundation

/// A saved Space the desktop app can open: a local Space or a remote Hub's panel.
/// Only this Mac knows about it; removing it never changes the server.
struct Connection: Codable, Identifiable, Hashable {
    var id: UUID
    var name: String
    var url: URL
    var isDefault: Bool

    init(id: UUID = UUID(), name: String, url: URL, isDefault: Bool = false) {
        self.id = id
        self.name = name
        self.url = url
        self.isDefault = isDefault
    }

    // Only these keys are read and written: a file saved by the retired Local edition also has
    // `managed` (true on the Space it installed), which is ignored here and gone on the next save.
    private enum CodingKeys: String, CodingKey { case id, name, url, isDefault }

    var isLocal: Bool { ConnectionRules.isLoopback(url.host ?? "") }
}

enum ConnectionURLError: Error, Equatable {
    case empty
    case invalid
    case unsupportedScheme
    case credentials
    case insecureRemote
}

/// What a connection URL may be: HTTPS anywhere, plain HTTP only to this Mac's loopback.
enum ConnectionRules {
    /// The default `SPACE_PORT` in src/space/config.ts.
    static let localDefault = "http://127.0.0.1:8700"

    static func isLoopback(_ host: String) -> Bool {
        var h = host.lowercased()
        if h.hasPrefix("[") && h.hasSuffix("]") { h = String(h.dropFirst().dropLast()) }
        if h == "localhost" || h == "::1" { return true }
        let parts = h.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4, parts.allSatisfy({ !$0.isEmpty && $0.count <= 3 && $0.allSatisfy(\.isASCII) && UInt8($0) != nil }) else {
            return false
        }
        return parts[0] == "127"
    }

    /// Turns what the operator typed into a panel URL, or says why it cannot be one.
    /// A missing scheme means HTTP for loopback and HTTPS otherwise; query and fragment are dropped.
    static func normalize(_ input: String) throws -> URL {
        var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { throw ConnectionURLError.empty }
        if !text.contains("://") {
            let host = text.split(separator: "/", maxSplits: 1).first.map(String.init) ?? text
            let bare = host.split(separator: ":").first.map(String.init) ?? host
            text = (isLoopback(bare) || host.hasPrefix("[::1]") ? "http://" : "https://") + text
        }
        guard var parts = URLComponents(string: text) else { throw ConnectionURLError.invalid }
        guard let scheme = parts.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            throw ConnectionURLError.unsupportedScheme
        }
        guard let host = parts.host, !host.isEmpty else { throw ConnectionURLError.invalid }
        if parts.user != nil || parts.password != nil { throw ConnectionURLError.credentials }
        if scheme == "http" && !isLoopback(host) { throw ConnectionURLError.insecureRemote }
        parts.scheme = scheme
        parts.host = host.lowercased()
        parts.query = nil
        parts.fragment = nil
        if parts.path.isEmpty { parts.path = "/" }
        guard let url = parts.url else { throw ConnectionURLError.invalid }
        return url
    }

    /// The address to hand the default browser for an app page shown at `current`, opened from `home`.
    /// A package app's page is `/_space/apps/<app>` (or `/_space/connections/<id>/apps/<app>`) on the
    /// Space, which redirects through a one-time ticket to the app's own origin; that origin only
    /// admits the web view that redeemed the ticket (src/space/packages/gateway.ts). So the browser
    /// gets the entry again, with the page it was on in `path`, and redeems a ticket of its own.
    static func browserURL(current: URL?, home: URL) -> URL {
        guard let current else { return home }
        guard !sameOrigin(current, home), isPackageEntry(home.path),
              var entry = URLComponents(url: home, resolvingAgainstBaseURL: true),
              let page = URLComponents(url: current, resolvingAgainstBaseURL: true)
        else { return current }
        // Kept percent-encoded, without the fragment: the Space takes `path` as a request target and refuses `#` or spaces.
        var path = page.percentEncodedPath.isEmpty ? "/" : page.percentEncodedPath
        if let query = page.percentEncodedQuery { path += "?" + query }
        entry.queryItems = (entry.queryItems ?? []).filter { $0.name != "path" } + (path == "/" ? [] : [URLQueryItem(name: "path", value: path)])
        if entry.queryItems?.isEmpty == true { entry.queryItems = nil }
        return entry.url ?? home
    }

    /// Whether a Space path is a package app's entry (src/space/packages/panel.ts).
    static func isPackageEntry(_ path: String) -> Bool {
        let parts = path.split(separator: "/", omittingEmptySubsequences: true)
        guard parts.first == "_space" else { return false }
        return (parts.count == 3 && parts[1] == "apps") || (parts.count == 5 && parts[1] == "connections" && parts[3] == "apps")
    }

    /// Whether two URLs share scheme, host and effective port.
    static func sameOrigin(_ a: URL, _ b: URL) -> Bool {
        guard let sa = a.scheme?.lowercased(), let sb = b.scheme?.lowercased(), sa == sb,
              let ha = a.host?.lowercased(), let hb = b.host?.lowercased(), ha == hb
        else { return false }
        return effectivePort(a) == effectivePort(b)
    }

    static func origin(of url: URL) -> URL? {
        var parts = URLComponents()
        parts.scheme = url.scheme
        parts.host = url.host
        parts.port = url.port
        parts.path = "/"
        return parts.url
    }

    private static func effectivePort(_ url: URL) -> Int? {
        if let port = url.port { return port }
        switch url.scheme?.lowercased() {
        case "http": return 80
        case "https": return 443
        default: return nil
        }
    }
}
