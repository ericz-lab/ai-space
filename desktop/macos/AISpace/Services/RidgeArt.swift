import Foundation

/// The mountain range behind the first-launch window, drawn in binary digits: peaks whose slopes
/// meet, with a little noise along the line, as an image-to-ASCII tool would draw a picture with a
/// "01" character set and ordered (Bayer) dithering. The crest is drawn whole; below it the slopes
/// facing the light (from the left) keep more digits than those turned away. The picture is the
/// same every time and the same as the Windows and Linux clients' (RidgeArt.cs, ridge-art.ts).
enum RidgeArt {
    private static let seed = 11
    // Peaks stand about `spacing` picture-heights apart, `low` to `high` of it tall; a wider
    // picture shows more of them, not the same ones stretched.
    private static let spacing = 0.9, low = 0.50, high = 0.96, slope = 0.87, density = 0.14

    private static let bayer: [[Double]] = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]]

    /// `rows` lines of `cols` characters each, "0", "1" or a space. `cellAspect` is a character's
    /// width over the line height, so the slopes keep their angle whatever the font.
    static func lines(cols: Int, rows: Int, cellAspect: Double = 0.6) -> [String] {
        guard cols > 0, rows > 0 else { return [] }
        let aspect = Double(cols) * cellAspect / Double(rows)
        let heights = (0..<(cols + 2)).map { height((Double($0) - 0.5) / Double(cols), aspect) * Double(rows) }
        return (0..<rows).map { y in
            String((0..<cols).map { x -> Character in
                let h = heights[x + 1]
                let depth = Double(y) + 0.5 - (Double(rows) - h)
                guard depth >= 0 else { return " " }
                let left = heights[x], right = heights[x + 2]
                // A steep slope drops more than a row per column: the crest fills the gap.
                let crest = max(1, (h - min(left, right)) * 0.9)
                let d = density * (right < left ? 1.25 : 0.65)
                let show = depth < crest || d > (bayer[y % 4][x % 4] + 0.5) / 16
                return show ? (hash(x &* 131 &+ y &* 977) < 0.5 ? "0" : "1") : " "
            })
        }
    }

    /// The range's height at `u` (0 to 1 across), as a fraction of the picture's height.
    private static func height(_ u: Double, _ aspect: Double) -> Double {
        // v: across the picture in picture-heights, 0 in the middle, so it grows from the centre.
        let v = (u - 0.5) * aspect
        var h = 0.0
        let last = Int((aspect / 2 / spacing).rounded(.up)) + 1
        for i in -last...last {
            let px = (Double(i) - 0.5 + hash(seed * 100 + i) * 0.8) * spacing
            let ph = low + (high - low) * hash(seed * 100 + i + 50)
            let s = slope * (0.7 + 0.6 * hash(seed * 100 + i + 90))
            h = max(h, ph - abs(v - px) * s)
        }
        return h + 0.035 * (noise(v * 1.2, seed) - 0.5) + 0.015 * (noise(v * 4, seed + 3) - 0.5)
    }

    private static func noise(_ x: Double, _ seed: Int) -> Double {
        let i = Int(x.rounded(.down))
        let f = x - Double(i)
        let u = f * f * (3 - 2 * f)
        return hash(i &* 7919 &+ seed) * (1 - u) + hash((i &+ 1) &* 7919 &+ seed) * u
    }

    /// A number in [0, 1) from `n`, the same on every machine (32-bit, as the other clients).
    static func hash(_ n: Int) -> Double {
        var x = UInt32(truncatingIfNeeded: Int32(truncatingIfNeeded: n)) ^ 0x9e37_79b9
        x = x &* 0x85eb_ca6b
        x ^= x >> 13
        x = x &* 0xc2b2_ae35
        x ^= x >> 16
        return Double(x) / 4_294_967_296
    }
}
