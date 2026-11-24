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

/// Whether a picture's bytes end the way their format ends. An image decoder takes the top of a
/// PNG or JPEG whose download was cut short and leaves the rest blank, so an icon store would keep
/// half an icon; a picture that fails this is not cached and is fetched again. Formats it does not
/// know (SVG, ICO) pass.
enum PictureBytes {
    static func isComplete(_ data: Data) -> Bool {
        let b = [UInt8](data)
        if b.starts(with: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) {
            // The IEND chunk: length 0, "IEND", CRC.
            return b.count >= 20 && Array(b[(b.count - 12)..<(b.count - 4)]) == [0, 0, 0, 0, 0x49, 0x45, 0x4E, 0x44]
        }
        if b.starts(with: [0xFF, 0xD8, 0xFF]) {
            // The end-of-image marker, allowing for padding after it.
            let tail = b.suffix(32)
            return zip(tail, tail.dropFirst()).contains { $0 == 0xFF && $1 == 0xD9 }
        }
        if b.starts(with: Array("GIF8".utf8)) { return b.last == 0x3B }
        if b.count >= 12, b.starts(with: Array("RIFF".utf8)), Array(b[8..<12]) == Array("WEBP".utf8) {
            let size = Int(b[4]) | Int(b[5]) << 8 | Int(b[6]) << 16 | Int(b[7]) << 24
            return b.count >= size + 8
        }
        return true
    }
}
