#if os(macOS)
import AppKit
import UniformTypeIdentifiers
typealias CaptureImage = NSImage
#else
import UIKit
typealias CaptureImage = UIImage
#endif
import ImageIO

/// Bounded image decoding shared by the screenshot flow and the Share Extension.
enum CapturePicture {
    struct Picture {
        let data: Data
        let kind: ScreenshotRules.Kind
        let preview: CaptureImage
    }

    static func preview(_ data: Data, maxPixelSize: Int = 1024) -> CaptureImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: maxPixelSize
              ] as CFDictionary) else { return nil }
        #if os(macOS)
        return NSImage(cgImage: thumbnail, size: NSSize(width: thumbnail.width, height: thumbnail.height))
        #else
        return UIImage(cgImage: thumbnail)
        #endif
    }

    static func prepare(_ data: Data) -> Picture? {
        guard data.count <= 40 * 1024 * 1024, let image = preview(data, maxPixelSize: 2048) else { return nil }
        if let kind = ScreenshotRules.sendable(data) { return Picture(data: data, kind: kind, preview: image) }
        #if os(macOS)
        for pixels in [2048, 1600, 1280, 1024, 800, 640, 400, 256] {
            guard let reduced = preview(data, maxPixelSize: pixels),
                  let cg = reduced.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
            let output = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
            CGImageDestinationAddImage(destination, cg, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
            if CGImageDestinationFinalize(destination), output.length <= ScreenshotRules.maxBytes {
                return Picture(data: output as Data, kind: .jpeg, preview: image)
            }
        }
        #else
        var scale: CGFloat = 1
        for _ in 0..<8 {
            let size = CGSize(width: max(1, (image.size.width * scale).rounded()), height: max(1, (image.size.height * scale).rounded()))
            let format = UIGraphicsImageRendererFormat.default()
            format.scale = 1
            let drawn = scale == 1 ? image : UIGraphicsImageRenderer(size: size, format: format).image { _ in
                image.draw(in: CGRect(origin: .zero, size: size))
            }
            if let jpeg = drawn.jpegData(compressionQuality: 0.85), jpeg.count <= ScreenshotRules.maxBytes {
                return Picture(data: jpeg, kind: .jpeg, preview: image)
            }
            scale *= 0.8
        }
        #endif
        return nil
    }
}
