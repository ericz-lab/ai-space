import SwiftUI
import UIKit

/// The panel's default ("Aurora") tokens from src/web/styles.css and theme.ts, so the phone
/// reads as the same product: the ground, the three aurora glows, the accent and the radii.
enum Theme {
    static let accent = Color(hex: 0x8B5CF6)
    static let link = Color(hex: 0x6366F1)
    static let success = Color(hex: 0x34C759)
    static let warning = Color(hex: 0xFF9500)
    static let danger = Color(hex: 0xEF4444)
    static let ground = Color(light: 0xF6F7FB, dark: 0x1C2030)
    static let text = Color(light: 0x0E1116, dark: 0xF1F4F8)
    static let solid = Color(light: 0xFFFFFF, dark: 0x2C3145)
    static let glowA = Color(light: 0xC7D2FE, dark: 0x2A2872)
    static let glowB = Color(light: 0xFBCFE8, dark: 0x5F1642)
    static let glowC = Color(light: 0xA5F3FC, dark: 0x134354)
    static let hairline = Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(white: 1, alpha: 0.12) : UIColor(red: 14 / 255, green: 17 / 255, blue: 22 / 255, alpha: 0.08) })
    /// `--radius` and the two radii derived from it.
    static let radius: CGFloat = 18
    static let radiusMedium: CGFloat = 16
    static let radiusSmall: CGFloat = 14
}

extension Color {
    init(hex: UInt32) {
        self.init(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255, opacity: 1)
    }

    init(light: UInt32, dark: UInt32) {
        self.init(UIColor { UIColor(Color(hex: $0.userInterfaceStyle == .dark ? dark : light)) })
    }
}

/// The panel's aurora: three soft glows over the ground colour.
struct Backdrop: View {
    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width, h = geo.size.height
            ZStack {
                Theme.ground
                Circle().fill(Theme.glowA).frame(width: w * 0.9).position(x: w * 0.12, y: h * 0.08)
                Circle().fill(Theme.glowB).frame(width: w * 0.8).position(x: w * 0.95, y: h * 0.32)
                Circle().fill(Theme.glowC).frame(width: w * 0.85).position(x: w * 0.3, y: h * 0.92)
            }
            .blur(radius: 70)
            .opacity(0.9)
            .background(Theme.ground)
        }
        .ignoresSafeArea()
    }
}

/// A glass surface as the panel draws its cards: translucent, hairline border, soft shadow.
struct Glass: ViewModifier {
    var radius: CGFloat = Theme.radius

    func body(content: Content) -> some View {
        content
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(Theme.hairline))
            .shadow(color: Color(hex: 0x1F2687).opacity(0.08), radius: 16, y: 6)
    }
}

extension View {
    func glass(radius: CGFloat = Theme.radius) -> some View { modifier(Glass(radius: radius)) }
}

/// The ai-space mark (src/web/public/favicon.svg), shipped as a bitmap.
struct Logo: View {
    var size: CGFloat = 72
    /// A plain file in the bundle, so it needs no asset catalog to be found.
    private static let image = Bundle.main.url(forResource: "Logo", withExtension: "png").flatMap { UIImage(contentsOfFile: $0.path) } ?? UIImage()

    var body: some View {
        Image(uiImage: Self.image).resizable().interpolation(.high).frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}
