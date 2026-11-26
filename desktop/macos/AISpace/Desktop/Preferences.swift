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
    /// Another app holds the Quick Chat shortcut, so it was not registered; not stored.
    @Published var quickChatTaken = false
    /// Voice input in any app while fn is held (Dictation.swift): it watches every key press and
    /// wants Accessibility, so it is off until the operator turns it on.
    @Published var voiceInput: Bool { didSet { defaults.set(voiceInput, forKey: "voiceInputFn") } }
    /// A spoken note sent to an app while right ⌥ is held (Dictation.swift, `.capture`): off until
    /// the operator turns it on, for the same reason as fn.
    @Published var voiceCapture: Bool { didSet { defaults.set(voiceCapture, forKey: "voiceCaptureRightOption") } }
    /// Where right ⌥ sends a note on each Space: connection id → capture target id (`GET /api/capture`).
    @Published var voiceCaptureTargets: [String: String] { didSet { defaults.set(voiceCaptureTargets, forKey: "voiceCaptureTargets") } }
    /// What voice input is transcribed in (VoiceLanguage): "" the app's language, "auto" detect, or a code.
    @Published var voiceLanguage: String { didSet { defaults.set(voiceLanguage, forKey: VoiceLanguage.defaultsKey) } }
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
    /// The ball's four sections for each Space (connection id → entry keys, top, right, bottom,
    /// left): "" keeps the section's default app, "-" leaves it empty (FloatingBallRules).
    @Published var floatingBallSlots: [String: [String]] { didSet { defaults.set(floatingBallSlots, forKey: "floatingBallSlots") } }
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

    /// The desk pet (docs/macos-desktop.md#desk-pet): Claude showing the Space's mood, in the main
    /// window by default; on the desktop it walks along the bottom of the screen over every app.
    @Published var pet: Bool { didSet { defaults.set(!pet, forKey: "hidesPet") } }
    @Published var petPlace: PetPlace { didSet { defaults.set(petPlace.rawValue, forKey: "petPlace") } }
    @Published var petSize: PetSize { didSet { defaults.set(petSize.rawValue, forKey: "petSize") } }
    /// Where the desktop pet was put down, as a fraction of the screen's width; nil until it was dragged.
    var deskPetSpot: Double? {
        get { defaults.object(forKey: "deskPetSpot") as? Double }
        set {
            if let v = newValue { defaults.set(v, forKey: "deskPetSpot") } else { defaults.removeObject(forKey: "deskPetSpot") }
        }
    }

    private init() {
        chatPermission = ChatPermission(rawValue: defaults.string(forKey: "chat-perm") ?? "") ?? .readOnly
        menuBar = defaults.object(forKey: "menuBar") as? Bool ?? true
        notifications = defaults.object(forKey: "notifications") as? Bool ?? true
        quickChat = Shortcut(rawValue: defaults.string(forKey: "quickChat") ?? "") ?? .optionSpace
        voiceInput = defaults.bool(forKey: "voiceInputFn")
        voiceCapture = defaults.bool(forKey: "voiceCaptureRightOption")
        voiceCaptureTargets = defaults.dictionary(forKey: "voiceCaptureTargets") as? [String: String] ?? [:]
        voiceLanguage = defaults.string(forKey: VoiceLanguage.defaultsKey) ?? VoiceLanguage.sameAsApp
        // Voice input once had a Space of its own here; it follows the selected Space now.
        defaults.removeObject(forKey: "voiceInputSpace")
        quickChatAgent = defaults.string(forKey: "quickChatAgent")
        appearance = Appearance(rawValue: defaults.string(forKey: "appearance") ?? "") ?? .system
        themeID = defaults.string(forKey: "theme") ?? ThemePreset.aurora.id
        showsWidgets = !defaults.bool(forKey: "hidesWidgets")
        floatingBall = defaults.bool(forKey: "floatingBall")
        floatingBallSlots = defaults.dictionary(forKey: "floatingBallSlots") as? [String: [String]] ?? [:]
        pet = !defaults.bool(forKey: "hidesPet")
        petPlace = PetPlace(rawValue: defaults.string(forKey: "petPlace") ?? "") ?? .window
        petSize = PetSize(rawValue: defaults.string(forKey: "petSize") ?? "") ?? .medium
        Theme.current = ThemePreset.named(themeID)
    }
}
