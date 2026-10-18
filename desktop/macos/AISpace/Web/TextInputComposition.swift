import AppKit

/// Return belongs to the input method while marked text is being composed.
/// SwiftUI key handlers must leave that event to AppKit instead of submitting a prompt.
@MainActor
enum TextInputComposition {
    static var isActive: Bool {
        isActive(in: NSTextInputContext.current?.client) ||
        isActive(in: NSApp.keyWindow?.firstResponder as? NSTextInputClient)
    }

    static func isActive(in client: NSTextInputClient?) -> Bool {
        client?.hasMarkedText() == true
    }
}
