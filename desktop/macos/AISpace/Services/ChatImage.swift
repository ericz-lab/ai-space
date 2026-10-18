import Foundation

struct ChatImage: Identifiable, Equatable {
    let id = UUID()
    let name: String
    let mediaType: String
    let bytes: Data

    var body: [String: String] {
        ["name": String(name.prefix(200)), "mediaType": mediaType, "data": bytes.base64EncodedString()]
    }

    static func validate(_ images: [ChatImage]) -> Bool {
        images.count <= 4 && images.allSatisfy { !$0.bytes.isEmpty && $0.bytes.count <= 5 * 1024 * 1024 } &&
            images.reduce(0) { $0 + $1.bytes.count } <= 10 * 1024 * 1024
    }
}
