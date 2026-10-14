import AppKit
import Combine
import CryptoKit

/// Icons and avatars of one Space, as the iPhone client keeps them (mobile/ios/AISpace/Live/IconStore.swift):
/// fetched through the Space's API with its session, an icon on another site fetched plainly without it,
/// and cached in memory and as PNGs under the app's caches, one folder per saved Space. A cached icon
/// shows at once after a relaunch; one older than a day is fetched again behind it. AppKit draws SVG
/// itself, so an SVG icon is drawn once to a bitmap here.
@MainActor
final class IconStore {
    /// The icon that has just loaded; nil when every icon is gone (sign-out).
    let updates = PassthroughSubject<String?, Never>()
    private let api: SpaceAPI
    private let directory: URL
    private var images: [String: NSImage] = [:]
    private var diskChecked: Set<String> = []
    private var fetchedAt: [String: Date] = [:]
    private var pending: Set<String> = []
    private var failed: Set<String> = []
    private var generation = 0
    private static let maxAge: TimeInterval = 24 * 60 * 60
    private static let side: CGFloat = 128

    /// For icons on other sites: no cookie goes out and none is kept.
    private static let external: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.httpCookieAcceptPolicy = .never
        config.timeoutIntervalForRequest = 30
        return URLSession(configuration: config)
    }()
    /// Twice what the Space accepts for an icon of its own; a larger answer is not an icon.
    private static let externalLimit = 1 << 20

    init(api: SpaceAPI, directory: URL) {
        self.api = api
        self.directory = directory
    }

    private func file(_ icon: String) -> URL {
        let digest = SHA256.hash(data: Data((api.base.absoluteString + "\n" + icon).utf8))
        return directory.appendingPathComponent(digest.map { String(format: "%02x", $0) }.joined() + ".png")
    }

    func image(_ icon: String?) -> NSImage? {
        guard let icon, Icon.isPath(icon) else { return nil }
        if images[icon] == nil, diskChecked.insert(icon).inserted {
            let url = file(icon)
            if let image = NSImage(contentsOf: url) {
                images[icon] = image
                fetchedAt[icon] = (try? FileManager.default.attributesOfItem(atPath: url.path)[.modificationDate]) as? Date
            }
        }
        let cached = images[icon]
        if cached != nil, let at = fetchedAt[icon], Date().timeIntervalSince(at) < Self.maxAge { return cached }
        guard !pending.contains(icon), !failed.contains(icon) else { return cached }
        pending.insert(icon)
        let generation = self.generation
        Task {
            let image = await load(icon)
            // A request begun before sign-out must not fill the cache again afterwards.
            guard generation == self.generation else { return }
            pending.remove(icon)
            guard let image else {
                failed.insert(icon)
                return
            }
            images[icon] = image
            fetchedAt[icon] = Date()
            if let png = Self.png(image) {
                try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                try? png.write(to: file(icon), options: .atomic)
            }
            updates.send(icon)
        }
        return cached
    }

    func clear() {
        generation += 1
        images.removeAll()
        diskChecked.removeAll()
        fetchedAt.removeAll()
        pending.removeAll()
        failed.removeAll()
        try? FileManager.default.removeItem(at: directory)
        updates.send(nil)
    }

    /// A failed icon is tried again after a refresh (the session may have been the reason).
    func retryFailed() {
        let retry = failed
        failed.removeAll()
        for icon in retry { updates.send(icon) }
    }

    private func load(_ icon: String) async -> NSImage? {
        let bytes: Data?
        switch IconSource(icon, space: api.base) {
        case .space(let path):
            bytes = try? await api.data(path)
        case .external(let url):
            if let (data, response) = try? await Self.external.data(from: url),
               let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode), data.count <= Self.externalLimit {
                bytes = data
            } else {
                bytes = nil
            }
        case nil:
            bytes = nil
        }
        guard let bytes, !bytes.isEmpty, let image = NSImage(data: bytes) else { return nil }
        // An SVG stays a drawing until it is drawn; a bitmap of it is what the cache keeps.
        return Icon.isSVG(bytes) ? Self.raster(image) : image
    }

    private static func raster(_ image: NSImage) -> NSImage? {
        let px = Int(side * 2)
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
                                         hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
        else { return nil }
        rep.size = NSSize(width: side, height: side)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        let size = image.size.width > 0 && image.size.height > 0 ? image.size : NSSize(width: side, height: side)
        let scale = min(side / size.width, side / size.height)
        let drawn = NSSize(width: size.width * scale, height: size.height * scale)
        image.draw(in: NSRect(x: (side - drawn.width) / 2, y: (side - drawn.height) / 2, width: drawn.width, height: drawn.height))
        NSGraphicsContext.restoreGraphicsState()
        let out = NSImage(size: rep.size)
        out.addRepresentation(rep)
        return out
    }

    private static func png(_ image: NSImage) -> Data? {
        guard let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) else { return nil }
        return rep.representation(using: .png, properties: [:])
    }
}

enum Icon {
    /// A path on the Space or an http(s) URL; anything else is an emoji to draw as text.
    static func isPath(_ s: String) -> Bool {
        s.hasPrefix("/") || s.lowercased().hasPrefix("http://") || s.lowercased().hasPrefix("https://")
    }

    static func emoji(_ s: String?) -> String? {
        guard let s, !s.isEmpty, !isPath(s), s.count <= 4 else { return nil }
        return s
    }

    static func isSVG(_ data: Data) -> Bool {
        guard let head = String(data: data.prefix(512), encoding: .utf8)?.lowercased() else { return false }
        return head.contains("<svg") || head.contains("<?xml")
    }
}
