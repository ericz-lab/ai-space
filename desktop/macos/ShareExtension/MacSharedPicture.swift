import AppKit

/// AppKit can send public.image as a secure NSImage archive rather than a PNG/TIFF file.
/// Decode only NSImage, then rasterize into a bounded bitmap before using the common encoder.
enum MacSharedPicture {
    static func data(_ data: Data) -> Data? {
        guard data.count <= 40 * 1024 * 1024 else { return nil }
        if let picture = CapturePicture.prepare(data) { return picture.data }
        guard data.starts(with: Data("bplist".utf8)),
              let image = try? NSKeyedUnarchiver.unarchivedObject(ofClass: NSImage.self, from: data) else { return nil }
        let size = image.size
        guard size.width.isFinite, size.height.isFinite, size.width > 0, size.height > 0 else { return nil }
        let scale = min(1, 2048 / max(size.width, size.height))
        let width = max(1, Int((size.width * scale).rounded()))
        let height = max(1, Int((size.height * scale).rounded()))
        guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
              let context = NSGraphicsContext(bitmapImageRep: bitmap) else { return nil }
        NSGraphicsContext.saveGraphicsState()
        defer { NSGraphicsContext.restoreGraphicsState() }
        NSGraphicsContext.current = context
        image.draw(in: NSRect(x: 0, y: 0, width: width, height: height), from: .zero, operation: .copy, fraction: 1)
        guard let png = bitmap.representation(using: .png, properties: [:]) else { return nil }
        return CapturePicture.prepare(png)?.data
    }
}
