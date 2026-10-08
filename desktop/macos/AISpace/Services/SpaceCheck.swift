import Foundation

/// Where a connection stands. A reachable port alone is not `ready`: the page must answer
/// a known Space API the way ai-space does.
enum SpaceState: Equatable {
    case connecting
    case ready
    case authenticationRequired
    case unreachable(String)
    case incompatible(String)

    var isFailure: Bool {
        switch self {
        case .unreachable, .incompatible: return true
        default: return false
        }
    }
}

/// Classifies the answer to `GET /api/panel/layout`, fetched from inside the loaded page so it
/// carries the page's own session (an access layer's cookie included).
enum SpaceCheck {
    static let path = "/api/panel/layout"

    /// Runs in an isolated content world of the page; page scripts cannot see or change it.
    static let script = """
    const r = await fetch(path, { credentials: "same-origin", headers: { Accept: "application/json" }, redirect: "manual" });
    return [r.status, r.headers.get("content-type") || "", r.type === "opaqueredirect" ? "" : await r.text()];
    """

    static func classify(status: Int, contentType: String, body: String) -> SpaceState {
        // A redirect away from the API, typically to an access layer's login page.
        if status == 0 || (300..<400).contains(status) || status == 401 || status == 403 {
            return .authenticationRequired
        }
        guard status == 200 else { return .incompatible("HTTP \(status)") }
        guard contentType.lowercased().contains("json"),
              let data = body.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["ok"] as? Bool == true,
              object["layout"] is [String: Any]
        else { return .incompatible("not an ai-space response") }
        return .ready
    }

    /// The result of the in-page script: `[status, contentType, body]`.
    static func classify(scriptResult: Any?) -> SpaceState {
        guard let parts = scriptResult as? [Any], parts.count == 3,
              let status = (parts[0] as? NSNumber)?.intValue,
              let type = parts[1] as? String, let body = parts[2] as? String
        else { return .incompatible("unexpected check result") }
        return classify(status: status, contentType: type, body: body)
    }

    /// A failed navigation, or nil when the failure is not the connection's fault
    /// (a cancelled load, or a response handed to a download).
    static func classify(error: Error) -> SpaceState? {
        let e = error as NSError
        if e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled { return nil }
        // WebKitErrorFrameLoadInterruptedByPolicyChange: the response became a download or left the app.
        if e.domain == "WebKitErrorDomain" && e.code == 102 { return nil }
        return .unreachable(e.localizedDescription)
    }
}
