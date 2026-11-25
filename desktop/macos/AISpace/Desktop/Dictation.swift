import AppKit
import ApplicationServices
import Carbon.HIToolbox
import Combine
import SwiftUI

/// Voice input in any app (docs/macos-desktop.md#voice-input): the voice input shortcut starts a
/// clip, pressing it again ends it, the selected Space transcribes it as a field's microphone
/// does (VoiceInput), and the text goes into whatever field has the keyboard, through the
/// clipboard and a paste (DictationRules). What the clipboard held comes back afterwards.
@MainActor
final class Dictation {
    private unowned let model: AppModel
    private let voice = VoiceInput()
    private let hud = DictationHUD()
    private var watchers: Set<AnyCancellable> = []
    /// Between the press and the recorder starting: a second press then does nothing.
    private var starting = false
    private var askedForAccessibility = false
    private static let transient = NSPasteboard.PasteboardType("org.nspasteboard.TransientType")

    init(model: AppModel) {
        self.model = model
        voice.$state.sink { [weak self] state in self?.hud.follow(state) }.store(in: &watchers)
        voice.$error.sink { [weak self] error in if let error { self?.hud.note(error) } }.store(in: &watchers)
    }

    /// What the shortcut does.
    func toggle() {
        switch voice.state {
        case .recording: voice.toggle { [weak self] text in self?.insert(text) }
        case .transcribing: break
        case .idle, .unavailable:
            guard !starting else { return }
            starting = true
            Task {
                await start()
                starting = false
            }
        }
    }

    private func start() async {
        // The selected Space first, then the others: this Mac's own Space often has no
        // transcriber while a Space it is also connected to does.
        let first = model.selected ?? model.store.defaultConnection
        let order = ([first].compactMap { $0 } + model.store.connections.filter { $0.id != first?.id })
        guard let first else {
            hud.note(String(localized: "Add a Space first to use voice input."))
            return
        }
        var reachable = false
        for c in order {
            guard let live = model.lives[c.id] else { continue }
            switch live.status {
            case .signInNeeded, .offline: continue
            case .ok, .unknown: break
            }
            reachable = true
            await voice.check(live.api)
            if voice.state != .unavailable { break }
        }
        guard voice.state == .idle else {
            if !reachable {
                hud.note(String(localized: "\(first.name) is not connected. Voice input needs the Space."))
            } else if voice.state == .unavailable {
                hud.note(String(localized: "None of your Spaces can transcribe speech."))
            }
            return
        }
        let ownKeyWindow = NSApp.keyWindow != nil
        if DictationRules.asksForAccessibility(ownKeyWindow: ownKeyWindow, trusted: AXIsProcessTrusted(), askedBefore: askedForAccessibility) {
            askedForAccessibility = true
            // The system's own prompt, which opens Privacy & Security → Accessibility.
            AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
        }
        voice.toggle { [weak self] text in self?.insert(text) }
    }

    /// The transcript goes through the clipboard: written, pasted, and the earlier contents put
    /// back once the field has read it.
    private func insert(_ text: String) {
        let board = NSPasteboard.general
        var delivery = DictationRules.delivery(ownKeyWindow: NSApp.keyWindow != nil, active: NSApp.isActive, trusted: AXIsProcessTrusted())
        let saved = delivery == .clipboardOnly ? [] : snapshot(board)
        // Marked transient while it is only passing through, so clipboard managers skip it.
        write(text, to: board, transient: delivery != .clipboardOnly)
        switch delivery {
        case .ownPaste:
            if !NSApp.sendAction(#selector(NSText.paste(_:)), to: nil, from: nil) {
                delivery = .clipboardOnly
                write(text, to: board, transient: false)
                hud.note(String(localized: "The text is on the clipboard. Press ⌘V to paste it."))
            }
        case .systemPaste:
            postCommandV()
        case .clipboardOnly:
            hud.note(String(localized: "The text is on the clipboard. Press ⌘V to paste it. To have it go in by itself, allow AI Space in System Settings → Privacy & Security → Accessibility."))
        }
        let written = board.changeCount
        DispatchQueue.main.asyncAfter(deadline: .now() + DictationRules.restoreDelay) {
            guard DictationRules.restores(delivery, changeCount: board.changeCount, written: written) else { return }
            board.clearContents()
            if !saved.isEmpty { board.writeObjects(saved) }
        }
    }

    private func write(_ text: String, to board: NSPasteboard, transient: Bool) {
        board.clearContents()
        let item = NSPasteboardItem()
        item.setString(text, forType: .string)
        if transient { item.setData(Data(), forType: Self.transient) }
        board.writeObjects([item])
    }

    /// Every item of the clipboard with every type's data, read now: the items themselves belong
    /// to the pasteboard and are gone once it is cleared.
    private func snapshot(_ board: NSPasteboard) -> [NSPasteboardItem] {
        (board.pasteboardItems ?? []).compactMap { item in
            let copy = NSPasteboardItem()
            for type in item.types {
                if let data = item.data(forType: type) { copy.setData(data, forType: type) }
            }
            return copy.types.isEmpty ? nil : copy
        }
    }

    /// ⌘V to the app in front, by the physical V key.
    private func postCommandV() {
        let source = CGEventSource(stateID: .combinedSessionState)
        for down in [true, false] {
            let event = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_ANSI_V), keyDown: down)
            event?.flags = .maskCommand
            event?.post(tap: .cghidEventTap)
        }
    }
}

/// The capsule at the bottom of the screen that says what voice input is doing. It never takes
/// the keyboard or the pointer, so the field being dictated into keeps both.
@MainActor
final class DictationHUD {
    enum Look: Equatable {
        case listening(String)
        case transcribing
        case note(String)
    }

    private var look: Look?
    private lazy var panel: NSPanel = makePanel()
    private var host: NSHostingView<DictationHUDView>?
    /// Counts what was shown, so a note's timer hides only that note.
    private var shown = 0

    func follow(_ state: VoiceInput.State) {
        switch state {
        case .recording:
            let shortcut = Preferences.shared.voiceInput.label
            show(.listening(String(localized: "Listening… \(shortcut) to stop")))
        case .transcribing: show(.transcribing)
        case .idle, .unavailable:
            // A note just shown (a failed transcription) outlives the end of the clip.
            if case .note = look { return }
            hide()
        }
    }

    func note(_ text: String) {
        show(.note(text))
        let mine = shown
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
            guard let self, self.shown == mine else { return }
            self.hide()
        }
    }

    private func show(_ look: Look) {
        shown += 1
        self.look = look
        let panel = self.panel
        guard let host else { return }
        // Set, not observed: the size below must be the new look's, measured now.
        host.rootView = DictationHUDView(look: look)
        host.layoutSubtreeIfNeeded()
        let size = host.fittingSize
        let pointer = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { NSMouseInRect(pointer, $0.frame, false) } ?? NSScreen.main
        guard let visible = screen?.visibleFrame else { return }
        panel.setFrame(NSRect(x: visible.midX - size.width / 2, y: visible.minY + 72, width: size.width, height: size.height), display: true)
        panel.orderFrontRegardless()
    }

    private func hide() {
        shown += 1
        look = nil
        panel.orderOut(nil)
    }

    private func makePanel() -> NSPanel {
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 240, height: 40),
                            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle, .stationary]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.animationBehavior = .none
        panel.isExcludedFromWindowsMenu = true
        panel.ignoresMouseEvents = true
        let host = NSHostingView(rootView: DictationHUDView(look: nil))
        panel.contentView = host
        self.host = host
        return panel
    }
}

struct DictationHUDView: View {
    let look: DictationHUD.Look?

    var body: some View {
        HStack(spacing: 8) {
            switch look {
            case .listening(let text):
                Image(systemName: "mic.fill").foregroundStyle(Theme.danger).symbolEffect(.pulse, isActive: true)
                Text(verbatim: text)
            case .transcribing:
                ProgressView().controlSize(.small)
                Text("Transcribing…")
            case .note(let text):
                Image(systemName: "mic.slash").foregroundStyle(.secondary)
                Text(verbatim: text).fixedSize(horizontal: false, vertical: true)
            case nil:
                EmptyView()
            }
        }
        .font(.callout)
        .foregroundStyle(Theme.text)
        .frame(maxWidth: 420)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(Color.primary.opacity(0.14), lineWidth: 1))
        .padding(4)
        .accessibilityElement(children: .combine)
    }
}
