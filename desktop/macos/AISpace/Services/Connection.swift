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
