import Carbon.HIToolbox
import Foundation

/// One system-wide shortcut through Carbon's RegisterEventHotKey, which needs no Accessibility
/// permission. Registering again replaces the previous shortcut. Each instance has its own `id`
/// and passes on the presses of the others, so several can be registered at once.
@MainActor
final class HotKey {
    private static let signature = OSType(0x4149_5350) // "AISP"
    private var ref: EventHotKeyRef?
    private var handler: EventHandlerRef?
    private let id: UInt32
    private let action: () -> Void

    init(id: UInt32 = 1, action: @escaping () -> Void) {
        self.id = id
        self.action = action
    }

    /// False when another app already holds the combination.
    @discardableResult
    func register(_ shortcut: Preferences.Shortcut) -> Bool {
        unregister()
        guard let (key, modifiers) = shortcut.carbon else { return true }
        if handler == nil {
            var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
            let me = Unmanaged.passUnretained(self).toOpaque()
            InstallEventHandler(GetApplicationEventTarget(), { _, event, userData in
                guard let event, let userData else { return OSStatus(eventNotHandledErr) }
                var pressed = EventHotKeyID()
                let read = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                                             nil, MemoryLayout<EventHotKeyID>.size, nil, &pressed)
                let hotKey = Unmanaged<HotKey>.fromOpaque(userData).takeUnretainedValue()
                // Another instance's key: the next handler on the target gets it.
                guard read == noErr, pressed.signature == HotKey.signature, pressed.id == hotKey.id else {
                    return OSStatus(eventNotHandledErr)
                }
                DispatchQueue.main.async { MainActor.assumeIsolated { hotKey.action() } }
                return noErr
            }, 1, &spec, me, &handler)
        }
        let hotKeyID = EventHotKeyID(signature: Self.signature, id: id)
        return RegisterEventHotKey(key, modifiers, hotKeyID, GetApplicationEventTarget(), 0, &ref) == noErr
    }

    func unregister() {
        if let ref { UnregisterEventHotKey(ref) }
        ref = nil
    }
}
