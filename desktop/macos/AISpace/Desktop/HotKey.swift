import Carbon.HIToolbox
import Foundation

/// One system-wide shortcut through Carbon's RegisterEventHotKey, which needs no Accessibility
/// permission. Registering again replaces the previous shortcut.
@MainActor
final class HotKey {
    private var ref: EventHotKeyRef?
    private var handler: EventHandlerRef?
    private let action: () -> Void

    init(action: @escaping () -> Void) {
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
            InstallEventHandler(GetApplicationEventTarget(), { _, _, userData in
                guard let userData else { return noErr }
                let hotKey = Unmanaged<HotKey>.fromOpaque(userData).takeUnretainedValue()
                DispatchQueue.main.async { MainActor.assumeIsolated { hotKey.action() } }
                return noErr
            }, 1, &spec, me, &handler)
        }
        let id = EventHotKeyID(signature: OSType(0x4149_5350), id: 1) // "AISP"
        return RegisterEventHotKey(key, modifiers, id, GetApplicationEventTarget(), 0, &ref) == noErr
    }

    func unregister() {
        if let ref { UnregisterEventHotKey(ref) }
        ref = nil
    }
}
