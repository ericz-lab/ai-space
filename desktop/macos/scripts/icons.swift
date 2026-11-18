// Draws the app icon and the in-app mark from the ai-space logo (docs/logo.svg), as the iPhone
// client does (mobile/ios/scripts/icons.swift). Run with `swift scripts/icons.swift` from
// desktop/macos after the mark changes; AppKit reads SVG, iconutil makes the .icns. The same run
// redraws the web panel's icons (src/web/public) and the Windows client's .ico, which have no
// drawing tools of their own.
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
// (an 824 square, 100 in from each edge), the mark filling about two thirds of it.
let body = mark.replacingOccurrences(of: #"<svg[^>]*>"#, with: "", options: .regularExpression)
    .replacingOccurrences(of: "</svg>", with: "")
    .replacingOccurrences(of: #"<title[^<]*</title>"#, with: "", options: .regularExpression)
let icon = """
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect x="100" y="100" width="824" height="824" rx="185" fill="#FFFFFF"/>
  <g transform="translate(144 144) scale(1.4375)">\(body)</g>
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

// The web panel: the mark itself as the favicon; where a platform wants an opaque square it masks
// itself (the home-screen icon, the installed web app), the mark on a full white square as on iOS.
let web = root.appendingPathComponent("../../src/web/public")
try mark.write(to: web.appendingPathComponent("favicon.svg"), atomically: true, encoding: .utf8)
let square = mark.replacingOccurrences(of: "</title>", with: "</title><rect width=\"512\" height=\"512\" fill=\"#FFFFFF\"/>")
try png(square, side: 512, to: web.appendingPathComponent("icon-512.png"))
try png(square, side: 180, to: web.appendingPathComponent("apple-touch-icon.png"))

// Windows draws an icon to its edges: the white rounded square without the Mac grid's margin and
// the mark larger in it, so it still reads at 16 pixels, as
// PNG images of every size the shell asks for in one .ico (a 256 entry is written as 0).
let tile = """
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" rx="230" fill="#FFFFFF"/>
  <g transform="translate(51 51) scale(1.8)">\(body)</g>
</svg>
"""
let sides = [16, 24, 32, 48, 64, 128, 256]
let scratch = FileManager.default.temporaryDirectory.appendingPathComponent("AISpace-ico-\(ProcessInfo.processInfo.processIdentifier).png")
var images: [Data] = []
for side in sides { try png(tile, side: side, to: scratch); images.append(try Data(contentsOf: scratch)) }
try? FileManager.default.removeItem(at: scratch)
func le<T: FixedWidthInteger>(_ value: T) -> Data { withUnsafeBytes(of: value.littleEndian) { Data($0) } }
var ico = le(UInt16(0)) + le(UInt16(1)) + le(UInt16(sides.count))
var offset = 6 + 16 * sides.count
for (side, image) in zip(sides, images) {
    ico += Data([UInt8(side % 256), UInt8(side % 256), 0, 0]) + le(UInt16(1)) + le(UInt16(32)) + le(UInt32(image.count)) + le(UInt32(offset))
    offset += image.count
}
for image in images { ico += image }
try ico.write(to: root.appendingPathComponent("../windows/AISpace/Assets/AISpace.ico"))
