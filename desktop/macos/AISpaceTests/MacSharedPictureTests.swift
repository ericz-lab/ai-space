#if canImport(AISpace)
import AppKit
import Testing
@testable import AISpace

@MainActor struct MacSharedPictureTests {
    @Test func acceptsSecureAppKitImageArchiveAndBoundsItsPixels() throws {
        let bitmap = try #require(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 32, pixelsHigh: 16,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
        let image = NSImage(size: NSSize(width: 6400, height: 3200))
        image.addRepresentation(bitmap)
        let archived = try NSKeyedArchiver.archivedData(withRootObject: image, requiringSecureCoding: true)
        let data = try #require(MacSharedPicture.data(archived))
        #expect(ScreenshotRules.sendable(data) != nil)
        let decoded = try #require(NSBitmapImageRep(data: data))
        #expect(decoded.pixelsWide <= 2048)
        #expect(decoded.pixelsHigh <= 2048)
        #expect(MacSharedPicture.data(Data("invalid picture".utf8)) == nil)
        let png = try #require(bitmap.representation(using: .png, properties: [:]))
        #expect(MacSharedPicture.data(png) == png)
    }
}
#endif
