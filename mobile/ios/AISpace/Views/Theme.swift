import SwiftUI
import UIKit

/// One of the panel's themes (PRESETS in src/web/theme.ts) as the phone draws it: the ground,
/// the text, the accent, the three glows and the radius, for light and for dark. The presets
/// that have drawn artwork behind the panel (Orbit, Northern Lights, Paper Cut, Prism) name it;
/// the Space serves it and BackdropStore draws it, over the theme's ground until it has.
struct ThemePreset: Identifiable, Equatable {
    struct Palette: Equatable {
        var ground: UInt32
        var text: UInt32
        var solid: UInt32
        var accent: UInt32
        var glowA: UInt32 = 0, glowB: UInt32 = 0, glowC: UInt32 = 0
    }

    var id: String
    var name: String
    var light: Palette
    var dark: Palette
    /// The soft glows over the ground; Simple is flat.
    var glow = true
    var radius: CGFloat = 18
    /// Drawn artwork behind the pages, by the name the Space serves it under (`/backdrops/<name>.html`).
    var backdrop: String?

    private static let lightGlow: (UInt32, UInt32, UInt32) = (0xC7D2FE, 0xFBCFE8, 0xA5F3FC)
    private static let darkGlow: (UInt32, UInt32, UInt32) = (0x2A2872, 0x5F1642, 0x134354)

    private static func light(_ ground: UInt32, accent: UInt32, text: UInt32 = 0x0E1116, solid: UInt32 = 0xFFFFFF, glow: (UInt32, UInt32, UInt32) = lightGlow) -> Palette {
        Palette(ground: ground, text: text, solid: solid, accent: accent, glowA: glow.0, glowB: glow.1, glowC: glow.2)
    }

    private static func dark(_ ground: UInt32, accent: UInt32, text: UInt32 = 0xF1F4F8, solid: UInt32 = 0x2C3145, glow: (UInt32, UInt32, UInt32) = darkGlow) -> Palette {
        Palette(ground: ground, text: text, solid: solid, accent: accent, glowA: glow.0, glowB: glow.1, glowC: glow.2)
    }

    static let aurora = ThemePreset(id: "aurora", name: "Aurora", light: light(0xF6F7FB, accent: 0x8B5CF6), dark: dark(0x1C2030, accent: 0x8B5CF6))
    static let all: [ThemePreset] = [
        aurora,
        ThemePreset(id: "simple", name: "Simple", light: light(0xF4F5F7, accent: 0x2563EB),
                    dark: dark(0x16181D, accent: 0x3B82F6, text: 0xECEEF2, solid: 0x2A2D35), glow: false, radius: 10),
        ThemePreset(id: "warm", name: "Warm",
                    light: light(0xFAF6F0, accent: 0xC2410C, text: 0x2B2118, solid: 0xFFFAF3, glow: (0xFDE3C4, 0xFBD0C0, 0xFEF3C7)),
                    dark: dark(0x211A15, accent: 0xF0A46B, text: 0xF6EDE4, solid: 0x3A2F27, glow: (0x5A3418, 0x5C1F2A, 0x4A3C12)), radius: 20),
        ThemePreset(id: "orbit", name: "Orbit", light: light(0xD3D2F6, accent: 0x5550B8), dark: dark(0x04050E, accent: 0x93A4FF, solid: 0x1C2140), backdrop: "orbit"),
        ThemePreset(id: "northern", name: "Northern Lights", light: light(0xF3F1FA, accent: 0x0B7FC9), dark: dark(0x040816, accent: 0x4BE3A8, solid: 0x182540), backdrop: "northern"),
        ThemePreset(id: "papercut", name: "Paper Cut", light: light(0xF8F5EF, accent: 0x4D79DE), dark: dark(0x1A2337, accent: 0x7CC4EA, solid: 0x26324C), backdrop: "papercut"),
        ThemePreset(id: "prism", name: "Prism", light: light(0xE6E8ED, accent: 0x7257FF), dark: dark(0x12141C, accent: 0xA394FF, solid: 0x242838), backdrop: "prism"),
    ]

    static func named(_ id: String) -> ThemePreset { all.first { $0.id == id } ?? aurora }
}

/// The tokens of the theme on show, by the panel's names (src/web/styles.css), so the phone
/// reads as the same product. `current` is this phone's choice (AppModel keeps it); the views
/// are rebuilt when it changes.
enum Theme {
    static var current = ThemePreset.aurora

    static var accent: Color { Color(light: current.light.accent, dark: current.dark.accent) }
    static let link = Color(hex: 0x6366F1)
    static let success = Color(hex: 0x34C759)
    static let warning = Color(hex: 0xFF9500)
    static let danger = Color(hex: 0xEF4444)
    static var ground: Color { Color(light: current.light.ground, dark: current.dark.ground) }
    static var text: Color { Color(light: current.light.text, dark: current.dark.text) }
    static var solid: Color { Color(light: current.light.solid, dark: current.dark.solid) }
    static var glowA: Color { Color(light: current.light.glowA, dark: current.dark.glowA) }
    static var glowB: Color { Color(light: current.light.glowB, dark: current.dark.glowB) }
    static var glowC: Color { Color(light: current.light.glowC, dark: current.dark.glowC) }
    static let hairline = Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(white: 1, alpha: 0.12) : UIColor(red: 14 / 255, green: 17 / 255, blue: 22 / 255, alpha: 0.08) })
    /// `--radius` and the two radii derived from it.
    static var radius: CGFloat { current.radius }
    static var radiusMedium: CGFloat { max(current.radius - 2, 6) }
    static var radiusSmall: CGFloat { max(current.radius - 4, 6) }
}

extension Theme {
    /// `color-mix(in srgb, a share, b)`, resolved for the light or dark appearance on show.
    static func mix(_ a: Color, _ b: Color, _ share: CGFloat) -> Color {
        Color(UIColor { traits in
            var (r1, g1, b1, a1): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
            var (r2, g2, b2, a2): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
            UIColor(a).resolvedColor(with: traits).getRed(&r1, green: &g1, blue: &b1, alpha: &a1)
            UIColor(b).resolvedColor(with: traits).getRed(&r2, green: &g2, blue: &b2, alpha: &a2)
            let t = 1 - share
            return UIColor(red: r1 * share + r2 * t, green: g1 * share + g2 * t, blue: b1 * share + b2 * t, alpha: a1 * share + a2 * t)
        })
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255, opacity: 1)
    }

    init(light: UInt32, dark: UInt32) {
        self.init(UIColor { UIColor(Color(hex: $0.userInterfaceStyle == .dark ? dark : light)) })
    }
}

/// The panel's aurora: three soft glows over the ground colour, or the ground alone in a flat theme.
struct Backdrop: View {
    var body: some View {
        if Theme.current.glow { glows } else { Theme.ground.ignoresSafeArea() }
    }

    private var glows: some View {
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
            // One picture, drawn when the size or the scheme changes. A live blur this wide is
            // drawn again by the render server on every frame anything over it moves.
            .drawingGroup()
        }
        .ignoresSafeArea()
    }
}

/// What is behind the pages of a Space: the theme's glows, or its artwork once the Space has sent it.
struct SpaceBackdrop: View {
    @ObservedObject var store: BackdropStore
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        if let name = Theme.current.backdrop {
            GeometryReader { geo in
                ZStack {
                    Theme.ground
                    if let image = store.image(name, dark: scheme == .dark, size: geo.size) {
                        Image(uiImage: image).resizable().scaledToFill()
                            .frame(width: geo.size.width, height: geo.size.height).clipped()
                            .transition(.opacity)
                    }
                }
            }
            .ignoresSafeArea()
            .accessibilityHidden(true)
        } else {
            Backdrop()
        }
    }
}

/// A glass surface as the panel draws its cards: translucent, hairline border, soft shadow.
/// The shadow is a picture of its own behind the surface. Cast by the card with `.shadow`, it
/// made the render server draw everything in the card again off screen on every frame of a
/// scroll; cast by the material fill alone, the material stops blurring what is behind it.
/// A widget card has no border at all, as on the panel: its edge is the glass and the shadow.
struct Glass: ViewModifier {
    var radius: CGFloat?
    var bordered = true

    func body(content: Content) -> some View {
        let radius = radius ?? Theme.radius
        content
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(bordered ? Theme.hairline : .clear))
            .background { GlassShadow(radius: radius) }
    }
}

/// The shadow of a rounded surface, drawn once for its size and then only moved.
private struct GlassShadow: View {
    let radius: CGFloat
    private static let color = Color(hex: 0x1F2687).opacity(0.08)
    private static let blur: CGFloat = 16
    private static let drop: CGFloat = 6
    /// How far past the surface the picture reaches, so the blur is not cut off.
    private static let reach = blur * 2 + drop

    var body: some View {
        Canvas { context, size in
            let surface = CGRect(origin: .zero, size: size).insetBy(dx: Self.reach, dy: Self.reach)
            context.addFilter(.shadow(color: Self.color, radius: Self.blur, x: 0, y: Self.drop, options: .shadowOnly))
            context.fill(Path(roundedRect: surface, cornerRadius: radius, style: .continuous), with: .color(.black))
        }
        .padding(-Self.reach)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

extension View {
    func glass(radius: CGFloat? = nil, bordered: Bool = true) -> some View { modifier(Glass(radius: radius, bordered: bordered)) }
}

/// The ai-space mark (docs/logo.svg), shipped as a bitmap.
struct Logo: View {
    var size: CGFloat = 72
    /// A plain file in the bundle, so it needs no asset catalog to be found.
    private static let image = Bundle.main.url(forResource: "Logo", withExtension: "png").flatMap { UIImage(contentsOfFile: $0.path) } ?? UIImage()

    var body: some View {
        Image(uiImage: Self.image).resizable().interpolation(.high).frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// The mark while the Space is being reached: its three circles and then its leaf dip in turn,
/// a signal going round. Drawn as shapes from the logo's own geometry (docs/logo.svg, a 512
/// square) so each part moves alone; still under Reduce Motion.
struct ConnectingMark: View {
    var size: CGFloat = 64
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let circles: [CGPoint] = [CGPoint(x: 159, y: 159), CGPoint(x: 159, y: 353), CGPoint(x: 353, y: 353)]
    private static let leaf = CGRect(x: 269, y: 71, width: 174, height: 175)
    private static let blue = Color(hex: 0x3F63CF)
    private static let cyan = Color(hex: 0x2CC8DC)
    /// One round, the time a part takes to dip and return, and the gap between two parts.
    private static let period = 1.8, dip = 0.7, step = 0.2

    var body: some View {
        TimelineView(.animation(paused: reduceMotion)) { timeline in
            let time = reduceMotion ? nil : timeline.date.timeIntervalSinceReferenceDate
            let unit = size / 512
            ZStack(alignment: .topLeading) {
                ForEach(0..<3, id: \.self) { index in
                    part(Circle().fill(Self.blue), in: CGRect(x: Self.circles[index].x - 97, y: Self.circles[index].y - 97, width: 194, height: 194),
                         unit: unit, depth: Self.depth(index, at: time))
                }
                part(UnevenRoundedRectangle(topLeadingRadius: 71 * unit, bottomTrailingRadius: 71 * unit).fill(Self.cyan),
                     in: Self.leaf, unit: unit, depth: Self.depth(3, at: time))
            }
            .frame(width: size, height: size, alignment: .topLeading)
        }
        .accessibilityHidden(true)
    }

    private func part(_ shape: some View, in rect: CGRect, unit: CGFloat, depth: Double) -> some View {
        shape
            .frame(width: rect.width * unit, height: rect.height * unit)
            .scaleEffect(1 - 0.2 * depth)
            .opacity(1 - 0.45 * depth)
            .offset(x: rect.minX * unit, y: rect.minY * unit)
    }

    /// How far into its dip a part is, 0 at rest and 1 at the bottom.
    static func depth(_ index: Int, at time: TimeInterval?) -> Double {
        guard let time else { return 0 }
        let local = (time - Double(index) * step).truncatingRemainder(dividingBy: period)
        guard local >= 0, local < dip else { return 0 }
        return sin(.pi * local / dip)
    }
}

/// Fade the untinted blur into the page instead of ending at a visible status-bar seam.
/// Attach once outside the pager, confined to the status safe area. Keeping it separate from
/// the search capsule avoids overlapping refractive surfaces as pages move.
struct LauncherHeaderBlur: ViewModifier {
    func body(content: Content) -> some View {
        content.overlay {
            GeometryReader { viewport in
                glass
                    .frame(height: viewport.safeAreaInsets.top)
                    .mask(LinearGradient(stops: [
                        .init(color: .black, location: 0),
                        .init(color: .black, location: 0.5),
                        .init(color: .clear, location: 1),
                    ], startPoint: .top, endPoint: .bottom))
                    .offset(y: -viewport.safeAreaInsets.top)
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
    }

    @ViewBuilder private var glass: some View {
        if #available(iOS 26.0, *) {
            GeometryReader { bounds in
                Color.clear
                    .frame(width: bounds.size.width + 128, height: bounds.size.height + 128)
                    .glassEffect(.clear.tint(nil), in: Rectangle())
                    .offset(x: -64, y: -64)
            }
            .clipped()
        } else {
            Rectangle().fill(.ultraThinMaterial)
        }
    }
}

/// Frost the search backdrop enough to keep moving labels from refracting into its text.
/// No custom tint or solid fill is added.
struct LauncherCapsuleGlass: ViewModifier {
    @ViewBuilder func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.glassEffect(.regular.tint(nil), in: Capsule())
        } else {
            // No outer border, as the panel's command box has none.
            content.background(.ultraThinMaterial, in: Capsule())
        }
    }
}
