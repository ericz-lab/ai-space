import Foundation

struct ChatImage: Identifiable, Equatable {
    let id = UUID()
    let name: String
    let mediaType: String
    let bytes: Data

    var body: [String: String] {
        ["name": String(name.prefix(200)), "mediaType": mediaType, "data": bytes.base64EncodedString()]
    }

    /// The most pictures one message carries.
    static let limit = 4

    /// Whether `adding` more pictures fit beside the ones attached and the ones still being read.
    static func fits(adding: Int, attached: Int, pending: Int) -> Bool {
        adding + attached + pending <= limit
    }

    static func validate(_ images: [ChatImage]) -> Bool {
        images.count <= limit && images.allSatisfy { !$0.bytes.isEmpty && $0.bytes.count <= 5 * 1024 * 1024 } &&
            images.reduce(0) { $0 + $1.bytes.count } <= 10 * 1024 * 1024
    }
}
