// Draws the app icon and the in-app mark from the ai-space logo (docs/logo.svg), as the iPhone
// client does (mobile/ios/scripts/icons.swift). Run with `swift scripts/icons.swift` from
// desktop/macos after the mark changes; AppKit reads SVG, iconutil makes the .icns.
import AppKit

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let resources = root.appendingPathComponent("AISpace/Resources")
let mark = try String(contentsOf: root.appendingPathComponent("../../docs/logo.svg"), encoding: .utf8)

func png(_ svg: String, side: Int, to url: URL) throws {
    guard let image = NSImage(data: Data(svg.utf8)) else { fatalError("cannot read the mark") }
    let context = CGContext(data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
    image.draw(in: NSRect(x: 0, y: 0, width: side, height: side))
    NSGraphicsContext.restoreGraphicsState()
    try NSBitmapImageRep(cgImage: context.makeImage()!).representation(using: .png, properties: [:])!.write(to: url)
}

// In the app, the mark as it is, on a transparent ground.
try png(mark, side: 256, to: resources.appendingPathComponent("Logo.png"))

// A Mac icon draws its own shape: the mark on a white rounded square on Apple's 1024 grid
// (an 824 square, 100 in from each edge).
let body = mark.replacingOccurrences(of: #"<svg[^>]*>"#, with: "", options: .regularExpression)
    .replacingOccurrences(of: "</svg>", with: "")
    .replacingOccurrences(of: #"<title[^<]*</title>"#, with: "", options: .regularExpression)
let icon = """
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect x="100" y="100" width="824" height="824" rx="185" fill="#FFFFFF"/>
  <g transform="translate(232 232) scale(1.09375)">\(body)</g>
</svg>
"""
try icon.write(to: resources.appendingPathComponent("AppIcon.svg"), atomically: true, encoding: .utf8)

let set = FileManager.default.temporaryDirectory.appendingPathComponent("AppIcon.iconset")
try? FileManager.default.removeItem(at: set)
try FileManager.default.createDirectory(at: set, withIntermediateDirectories: true)
for side in [16, 32, 128, 256, 512] {
    try png(icon, side: side, to: set.appendingPathComponent("icon_\(side)x\(side).png"))
    try png(icon, side: side * 2, to: set.appendingPathComponent("icon_\(side)x\(side)@2x.png"))
}
let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["-c", "icns", set.path, "-o", resources.appendingPathComponent("AppIcon.icns").path]
try iconutil.run()
iconutil.waitUntilExit()
precondition(iconutil.terminationStatus == 0, "iconutil failed")
try? FileManager.default.removeItem(at: set)
