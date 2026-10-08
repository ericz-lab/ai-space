import Foundation

enum SpaceAPIError: Error, Equatable {
    /// The access layer wants a sign-in, or the panel session has expired.
    case authenticationRequired
    case http(Int, String)
    case invalidResponse
}

/// Native calls to one Space's panel routes. They carry the cookies of the connection's own
/// WebKit store, so an access layer that the operator signed in to on the panel page lets them
/// through; nothing is copied out of Safari and no operator token is used. A redirect is never
/// followed: it means a sign-in is needed.
@MainActor
final class SpaceAPI {
    let base: URL
    private let cookies: @MainActor () async -> [HTTPCookie]
    private let session: URLSession

    init(base: URL, cookies: @escaping @MainActor () async -> [HTTPCookie]) {
        self.base = ConnectionRules.origin(of: base) ?? base
        self.cookies = cookies
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.httpCookieAcceptPolicy = .never
        config.timeoutIntervalForRequest = 30
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: config, delegate: NoRedirects(), delegateQueue: nil)
    }

    func url(_ path: String) -> URL {
        URL(string: path, relativeTo: base)?.absoluteURL ?? base
    }

    func request(_ method: String, _ path: String, json: [String: Any]? = nil, accept: String = "application/json") async -> URLRequest {
        let target = url(path)
        var r = URLRequest(url: target)
        r.httpMethod = method
        r.setValue(accept, forHTTPHeaderField: "Accept")
        r.httpShouldHandleCookies = false
        if let header = Cookies.header(for: target, from: await cookies()) { r.setValue(header, forHTTPHeaderField: "Cookie") }
        if let json {
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = try? JSONSerialization.data(withJSONObject: json)
        }
        return r
    }

    func get<T: Decodable>(_ path: String, as type: T.Type) async throws -> T {
        let (data, response) = try await session.data(for: await request("GET", path))
        try Self.check(response, data: data, expected: base)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw SpaceAPIError.invalidResponse
        }
    }

    @discardableResult
    func send(_ method: String, _ path: String, json: [String: Any]) async throws -> Data {
        let (data, response) = try await session.data(for: await request(method, path, json: json))
        try Self.check(response, data: data, expected: base)
        return data
    }

    /// Bytes of an icon or avatar.
    func data(_ path: String) async throws -> Data {
        let (data, response) = try await session.data(for: await request("GET", path, accept: "*/*"))
        try Self.check(response, data: data, expected: base)
        return data
    }

    /// A server-sent event stream: each `data:` line with the `id:` before it, and the run id
    /// from the `x-run-id` header when the response carries one.
    func events(_ method: String, _ path: String, json: [String: Any]? = nil) async throws -> (runID: String?, stream: AsyncThrowingStream<SSEMessage, Error>) {
        var r = await request(method, path, json: json, accept: "text/event-stream")
        r.timeoutInterval = 300
        let (bytes, response) = try await session.bytes(for: r)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            var body = Data()
            for try await b in bytes.prefix(4096) { body.append(b) }
            try Self.check(response, data: body, expected: base)
        }
        try Self.check(response, data: Data(), expected: base)
        let runID = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "x-run-id")
        let stream = AsyncThrowingStream<SSEMessage, Error> { continuation in
            let task = Task {
                var parser = SSEParser()
                do {
                    // `lines` drops blank lines; the server sends one data line per event, so each is complete.
                    for try await line in bytes.lines {
                        if let message = parser.feed(line) { continuation.yield(message) }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
        return (runID, stream)
    }

    /// Maps a response to an error: a redirect, 401 or 403 means sign in; any other non-2xx
    /// carries the server's `error` text.
    nonisolated static func check(_ response: URLResponse, data: Data, expected: URL) throws {
        guard let http = response as? HTTPURLResponse else { throw SpaceAPIError.invalidResponse }
        if let final = http.url, !ConnectionRules.sameOrigin(final, expected) { throw SpaceAPIError.authenticationRequired }
        switch http.statusCode {
        case 200..<300: return
        case 300..<400, 401, 403: throw SpaceAPIError.authenticationRequired
        default:
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw SpaceAPIError.http(http.statusCode, message ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode))
        }
    }
}

/// Refuses every redirect so the caller sees the 3xx itself.
private final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// Which stored cookies a request to a URL carries, by the usual domain, path, secure and expiry rules.
enum Cookies {
    static func matching(_ cookies: [HTTPCookie], for url: URL, now: Date = Date()) -> [HTTPCookie] {
        guard let host = url.host?.lowercased() else { return [] }
        let path = url.path.isEmpty ? "/" : url.path
        let secure = url.scheme?.lowercased() == "https"
        return cookies.filter { c in
            let domain = c.domain.lowercased()
            let bare = domain.hasPrefix(".") ? String(domain.dropFirst()) : domain
            // A cookie set without a Domain attribute is stored without the leading dot and fits its host only.
            let domainOK = host == bare || (domain.hasPrefix(".") && host.hasSuffix("." + bare))
            let cookiePath = c.path.isEmpty ? "/" : c.path
            let pathOK = path == cookiePath || path.hasPrefix(cookiePath.hasSuffix("/") ? cookiePath : cookiePath + "/")
            let fresh = c.expiresDate.map { $0 > now } ?? true
            return domainOK && pathOK && fresh && (!c.isSecure || secure)
        }
    }

    static func header(for url: URL, from cookies: [HTTPCookie]) -> String? {
        let matched = matching(cookies, for: url)
        guard !matched.isEmpty else { return nil }
        return HTTPCookie.requestHeaderFields(with: matched)["Cookie"]
    }
}
