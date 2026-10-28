import AppKit
import Carbon.HIToolbox

/// Desktop settings, in the app's own user defaults.
@MainActor
final class Preferences: ObservableObject {
    static let shared = Preferences()

    enum Shortcut: String, CaseIterable, Identifiable {
        case off
        case optionSpace
        case controlOptionSpace
        case commandShiftSpace

        var id: String { rawValue }

        var label: String {
            switch self {
            case .off: return String(localized: "Off")
            case .optionSpace: return "⌥ Space"
            case .controlOptionSpace: return "⌃⌥ Space"
            case .commandShiftSpace: return "⇧⌘ Space"
            }
        }

        /// Carbon key code and modifiers for RegisterEventHotKey.
        var carbon: (key: UInt32, modifiers: UInt32)? {
            switch self {
            case .off: return nil
            case .optionSpace: return (UInt32(kVK_Space), UInt32(optionKey))
            case .controlOptionSpace: return (UInt32(kVK_Space), UInt32(controlKey | optionKey))
            case .commandShiftSpace: return (UInt32(kVK_Space), UInt32(cmdKey | shiftKey))
            }
        }
    }

    private let defaults = UserDefaults.standard

    @Published var chatPermission: ChatPermission { didSet { defaults.set(chatPermission.rawValue, forKey: "chat-perm") } }

    @Published var menuBar: Bool { didSet { defaults.set(menuBar, forKey: "menuBar") } }
    @Published var notifications: Bool { didSet { defaults.set(notifications, forKey: "notifications") } }
    @Published var quickChat: Shortcut { didSet { defaults.set(quickChat.rawValue, forKey: "quickChat") } }
    /// The agent Quick Chat last talked to, as `<connection id> <agent id>`.
    @Published var quickChatAgent: String? { didSet { defaults.set(quickChatAgent, forKey: "quickChatAgent") } }
    /// How this Mac draws the app and which of the panel's themes, whatever a browser is set to.
    @Published var appearance: Appearance {
        didSet {
            defaults.set(appearance.rawValue, forKey: "appearance")
            NSApp.appearance = appearance.nsAppearance
        }
    }
    @Published var themeID: String {
        didSet {
            defaults.set(themeID, forKey: "theme")
            Theme.current = ThemePreset.named(themeID)
        }
    }
    /// Widget cards on the screens; they stay pinned and stay in the library when off.
    @Published var showsWidgets: Bool { didSet { defaults.set(!showsWidgets, forKey: "hidesWidgets") } }
    /// The floating ball over every app that takes a dropped picture (FloatingBall.swift); off
    /// until the operator turns it on.
    @Published var floatingBall: Bool { didSet { defaults.set(floatingBall, forKey: "floatingBall") } }
    /// Where the ball last stood, in screen points; nil until it was moved.
    var floatingBallOrigin: CGPoint? {
        get {
            guard let xy = defaults.array(forKey: "floatingBallOrigin") as? [Double], xy.count == 2 else { return nil }
            return CGPoint(x: xy[0], y: xy[1])
        }
        set {
            if let p = newValue { defaults.set([Double(p.x), Double(p.y)], forKey: "floatingBallOrigin") }
            else { defaults.removeObject(forKey: "floatingBallOrigin") }
        }
    }

    private init() {
        chatPermission = ChatPermission(rawValue: defaults.string(forKey: "chat-perm") ?? "") ?? .readOnly
        menuBar = defaults.object(forKey: "menuBar") as? Bool ?? true
        notifications = defaults.object(forKey: "notifications") as? Bool ?? true
        quickChat = Shortcut(rawValue: defaults.string(forKey: "quickChat") ?? "") ?? .optionSpace
        quickChatAgent = defaults.string(forKey: "quickChatAgent")
        appearance = Appearance(rawValue: defaults.string(forKey: "appearance") ?? "") ?? .system
        themeID = defaults.string(forKey: "theme") ?? ThemePreset.aurora.id
        showsWidgets = !defaults.bool(forKey: "hidesWidgets")
        floatingBall = defaults.bool(forKey: "floatingBall")
        Theme.current = ThemePreset.named(themeID)
    }
}
