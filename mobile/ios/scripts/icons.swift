// Draws the app icon and the in-app mark from the ai-space logo (docs/logo.svg).
// Run with `swift scripts/icons.swift` from mobile/ios after the mark changes; AppKit reads SVG.
import AppKit

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let mark = try String(contentsOf: root.appendingPathComponent("../../docs/logo.svg"), encoding: .utf8)

func png(_ svg: String, side: Int, opaque: Bool = false, to path: String) throws {
    guard let image = NSImage(data: Data(svg.utf8)) else { fatalError("cannot read the mark") }
    // A bitmap context has no 24-bit layout: an opaque image skips the alpha byte instead.
    let alpha: CGImageAlphaInfo = opaque ? .noneSkipLast : .premultipliedLast
    let context = CGContext(data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: alpha.rawValue)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
    image.draw(in: NSRect(x: 0, y: 0, width: side, height: side))
    NSGraphicsContext.restoreGraphicsState()
    try NSBitmapImageRep(cgImage: context.makeImage()!).representation(using: .png, properties: [:])!.write(to: root.appendingPathComponent(path))
}

// In the app, the mark as it is, on a transparent ground.
try png(mark, side: 256, to: "AISpace/Resources/Logo.png")
// iOS rounds the icon itself and refuses transparency: the same mark on a full white square.
try png(mark.replacingOccurrences(of: "</title>", with: "</title><rect width=\"512\" height=\"512\" fill=\"#FFFFFF\"/>"), side: 1024, opaque: true,
        to: "AISpace/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png")
// The launch screen (Info.plist, UILaunchScreen) shows the mark at 96 points on the Aurora ground
// (LaunchGround.colorset), where the first screen then draws it.
for (scale, suffix) in [(1, ""), (2, "@2x"), (3, "@3x")] {
    try png(mark, side: 96 * scale, to: "AISpace/Resources/Assets.xcassets/LaunchLogo.imageset/LaunchLogo\(suffix).png")
}
