import AppKit
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

/// The screenshot that goes along with a spoken note (docs/macos-desktop.md#spoken-notes): the
/// whole display under the pointer, taken with ScreenCaptureKit when right ⌥ starts a recording,
/// as a JPEG within CaptureShotRules' budget. Any failure is nil and the note goes as words only.
enum ScreenShot {
    /// Screen Recording is granted (System Settings › Privacy & Security › Screen & System Audio
    /// Recording). Never prompts.
    static var granted: Bool { CGPreflightScreenCaptureAccess() }

    /// The system's own Screen Recording prompt; it does not block, and shows only while the
    /// answer is not yet known.
    static func ask() { _ = CGRequestScreenCaptureAccess() }

    /// The pane where the grant is given.
    static let settingsURL = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!

    /// The display under the pointer, without the windows numbered in `excluding` (the voice
    /// overlay), as JPEG bytes; nil without the grant or when anything fails.
    @MainActor
    static func take(excluding windowNumbers: [Int]) async -> Data? {
        guard granted else { return nil }
        let pointer = NSEvent.mouseLocation
        guard let screen = NSScreen.screens.first(where: { NSMouseInRect(pointer, $0.frame, false) }) ?? NSScreen.main,
              let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return nil }
        let displayID = CGDirectDisplayID(number.uint32Value)
        do {
            // Off-screen windows too, so the overlay is excluded even when it appears after this list.
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            guard let display = content.displays.first(where: { $0.displayID == displayID }) else { return nil }
            let excluded = content.windows.filter { windowNumbers.contains(Int($0.windowID)) }
            let filter = SCContentFilter(display: display, excludingWindows: excluded)
            let scale = Double(filter.pointPixelScale)
            let pixels = CaptureShotRules.size(width: Int((Double(filter.contentRect.width) * scale).rounded()),
                                               height: Int((Double(filter.contentRect.height) * scale).rounded()))
            let config = SCStreamConfiguration()
            config.width = pixels.width
            config.height = pixels.height
            // The pointer shows what "this" in the words points at.
            config.showsCursor = true
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            return await Task.detached(priority: .userInitiated) { encode(image) }.value
        } catch {
            NSLog("ai-space: screenshot for a spoken note failed: \(error.localizedDescription)")
            return nil
        }
    }

    /// The first of CaptureShotRules.steps that fits the budget.
    nonisolated static func encode(_ image: CGImage) -> Data? {
        var scaled: (side: Int, image: CGImage)?
        return CaptureShotRules.firstFitting { step in
            let source: CGImage
            if max(image.width, image.height) <= step.longSide {
                source = image
            } else if let done = scaled, done.side == step.longSide {
                source = done.image
            } else {
                guard let made = resize(image, longSide: step.longSide) else { return nil }
                scaled = (step.longSide, made)
                source = made
            }
            return jpeg(source, quality: step.quality)
        }?.data
    }

    private nonisolated static func resize(_ image: CGImage, longSide: Int) -> CGImage? {
        let size = CaptureShotRules.size(width: image.width, height: image.height, longSide: longSide)
        guard let context = CGContext(data: nil, width: size.width, height: size.height, bitsPerComponent: 8, bytesPerRow: 0,
                                      space: image.colorSpace.flatMap { $0.model == .rgb ? $0 : nil } ?? CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: size.width, height: size.height))
        return context.makeImage()
    }

    private nonisolated static func jpeg(_ image: CGImage, quality: Double) -> Data? {
        let out = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return out as Data
    }
}
