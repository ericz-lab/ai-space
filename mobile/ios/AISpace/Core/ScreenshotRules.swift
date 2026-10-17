import Foundation

/// The rules of keeping a screenshot in Spark, apart from Photos and UIKit so they can be tested
/// on the Mac. The Space forwards `POST /api/capture/image` to the image capturer
/// (`ai-spark/capture-image`) as one bus call, whose body is capped at 4 MiB.
enum ScreenshotRules {
    /// The largest picture sent: the bus cap less the room the app keeps for the multipart envelope
    /// (ai-spark `MAX_IMAGE_BYTES`), less a margin for the text fields.
    static let maxBytes = 4 * 1024 * 1024 - 64 * 1024 - 16 * 1024
    /// A screenshot in Photos taken this long before the notice still counts as the one just taken.
    static let lookback: TimeInterval = 15
    /// How long the offer stays on screen when it is not touched.
    static let offerSeconds: TimeInterval = 8

    enum Kind: Equatable {
        case png, jpeg

        var mimeType: String { self == .png ? "image/png" : "image/jpeg" }
        var fileExtension: String { self == .png ? "png" : "jpg" }
    }

    /// PNG or JPEG from the first bytes; anything else (HEIC among them) has to be re-encoded.
    static func kind(of data: Data) -> Kind? {
        let b = [UInt8](data.prefix(4))
        if b.count == 4, b == [0x89, 0x50, 0x4E, 0x47] { return .png }
        if b.count >= 3, b[0] == 0xFF, b[1] == 0xD8, b[2] == 0xFF { return .jpeg }
        return nil
    }

    /// Bytes that can be sent as they are: PNG or JPEG within the limit.
    static func sendable(_ data: Data) -> Kind? {
        guard data.count <= maxBytes else { return nil }
        return kind(of: data)
    }

    /// Whether a screenshot asset created at `created` is the one the notice at `noticed` was about.
    static func isFresh(created: Date?, noticed: Date) -> Bool {
        guard let created else { return false }
        return created >= noticed.addingTimeInterval(-lookback)
    }

    /// The form fields sent before the file. `id` is kept across retries of the same picture,
    /// so a retry after a lost answer finds the first idea instead of making a second one.
    static func fields(id: UUID, text: String, via: String) -> [(String, String)] {
        var out = [("id", id.uuidString.lowercased()), ("via", via)]
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !words.isEmpty { out.append(("text", words)) }
        return out
    }

    /// What the capturer answered: the idea it made and the address of its page, when the Space knows one.
    struct Answer: Decodable, Equatable {
        struct Idea: Decodable, Equatable { let id: Int }
        let idea: Idea
        let url: String?
    }

    /// Whether the Space has an image capturer (`GET /api/capture`).
    struct Availability: Decodable, Equatable {
        let image: Bool
        let app: String?
    }
}
