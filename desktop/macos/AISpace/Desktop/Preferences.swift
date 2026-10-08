import Carbon.HIToolbox
import Foundation

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

    @Published var menuBar: Bool { didSet { defaults.set(menuBar, forKey: "menuBar") } }
    @Published var notifications: Bool { didSet { defaults.set(notifications, forKey: "notifications") } }
    @Published var quickChat: Shortcut { didSet { defaults.set(quickChat.rawValue, forKey: "quickChat") } }
    /// The agent Quick Chat last talked to, as `<connection id> <agent id>`.
    @Published var quickChatAgent: String? { didSet { defaults.set(quickChatAgent, forKey: "quickChatAgent") } }

    private init() {
        menuBar = defaults.object(forKey: "menuBar") as? Bool ?? true
        notifications = defaults.object(forKey: "notifications") as? Bool ?? true
        quickChat = Shortcut(rawValue: defaults.string(forKey: "quickChat") ?? "") ?? .optionSpace
        quickChatAgent = defaults.string(forKey: "quickChatAgent")
    }
}
