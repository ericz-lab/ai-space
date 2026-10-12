// Draws the app icon and the in-app mark from the panel's own mark (src/web/public/favicon.svg).
// Run with `swift scripts/icons.swift` from mobile/ios after the mark changes; AppKit reads SVG.
import AppKit

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let mark = try String(contentsOf: root.appendingPathComponent("../../src/web/public/favicon.svg"), encoding: .utf8)

func png(_ svg: String, side: Int, opaque: Bool = false, to path: String) throws {
    guard let image = NSImage(data: Data(svg.utf8)) else { fatalError("cannot read the mark") }
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: side, pixelsHigh: side, bitsPerSample: 8, samplesPerPixel: opaque ? 3 : 4,
                               hasAlpha: !opaque, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    rep.size = NSSize(width: side, height: side)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    image.draw(in: NSRect(x: 0, y: 0, width: side, height: side))
    NSGraphicsContext.restoreGraphicsState()
    try rep.representation(using: .png, properties: [:])!.write(to: root.appendingPathComponent(path))
}

// In the app, the mark as it is, rounded corners included.
try png(mark, side: 256, to: "AISpace/Resources/Logo.png")
// iOS rounds the icon itself and refuses transparency: the same mark on a full square.
try png(mark.replacingOccurrences(of: "rx=\"14\" fill=\"url(#g)\"", with: "fill=\"url(#g)\""), side: 1024, opaque: true,
        to: "AISpace/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png")
