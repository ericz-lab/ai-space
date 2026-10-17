import Foundation

/// Reject directories and oversized files before allocating their contents.
enum PictureImport {
    static func read(_ url: URL) throws -> Data {
        var url = url
        url.removeAllCachedResourceValues()
        let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
        guard values.isRegularFile == true, let size = values.fileSize, size > 0,
              size <= 40 * 1024 * 1024 else { throw CocoaError(.fileReadTooLarge) }
        return try Data(contentsOf: url)
    }
}
