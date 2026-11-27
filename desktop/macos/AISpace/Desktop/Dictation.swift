import AppKit
import ApplicationServices
import Carbon.HIToolbox
import Combine
import SwiftUI

/// Voice input in any app (docs/macos-desktop.md#voice-input): holding fn (FnKey) records, the
/// words show live in a large overlay above the bottom of the screen (LiveVoice, DictationHUD), and on release the text
/// goes once into whatever field has the keyboard, through the clipboard and a paste
/// (DictationRules). What the clipboard held comes back afterwards. Provisional text is never typed
/// into the field and corrected: that cannot be done reliably across apps.
/// Holding right ⌥ records the same way, but the text is sent to an app of the Space as a note
/// (`POST /api/capture/text`, the `.capture` destination) and never pasted. With it goes a
/// screenshot of the display under the pointer when the app takes pictures too (ScreenShot,
/// CaptureShotRules), as one `POST /api/capture/image`.
@MainActor
final class Dictation {
    private unowned let model: AppModel
    private let live = LiveVoice()
    private let hud = DictationHUD()
    /// The Space the recording goes to, while one is on.
    private var listener: URL?
    /// Which key's recording this is, from its press until the next press starts another.
    private var destination: DictationRules.Destination?
    /// A note on its way to the app: no new recording meanwhile.
    private var sending = false
    private var watchers: Set<AnyCancellable> = []
    /// Between fn and the recorder starting, while a Space is chosen.
    private var choosing = false
    /// fn came up while a Space was being chosen: nothing is recorded.
    private var released = false
    /// The screenshot of this right-⌥ press, taken when the hold is recognised; nil for fn, with
    /// the setting off or without Screen Recording.
    private var shot: NoteShot?
    private static let transient = NSPasteboard.PasteboardType("org.nspasteboard.TransientType")

    init(model: AppModel) {
        self.model = model
        live.$state.combineLatest(live.$text).sink { [weak self] state, text in self?.hud.follow(state, text: text) }.store(in: &watchers)
        live.$level.sink { [weak self] level in self?.hud.level(level) }.store(in: &watchers)
        live.$error.sink { [weak self] error in
            guard let self, let error else { return }
            // Asked again next time: the Space may have lost its voice since it said it had one.
            if let listener { VoiceInput.forget(listener) }
            hud.note(error)
        }.store(in: &watchers)
    }

    /// fn or right ⌥ held: a press of either key while a recording, its transcript or a note
    /// is still on its way does nothing.
    func begin(_ destination: DictationRules.Destination) {
        guard live.state == .idle, !choosing, !sending else { return }
        self.destination = destination
        choosing = true
        released = false
        // Before the overlay shows, which is also left out of the picture by its window.
        shot = takeShot(destination)
        hud.begin(destination, space: (model.selected ?? model.store.defaultConnection)?.name)
        Task {
            await start(destination)
            choosing = false
        }
    }

    /// The key let go: only the key that started the recording ends it.
    func end(_ destination: DictationRules.Destination) {
        guard DictationRules.ends(destination, recording: self.destination) else { return }
        if choosing { released = true; return }
        live.stop()
    }

    private func start(_ destination: DictationRules.Destination) async {
        // The Space chosen at the top left of the main window, and never another: the saved
        // Spaces may not all be the person's own, and speech goes nowhere unasked.
        guard let c = model.selected ?? model.store.defaultConnection else {
            hud.space = nil
            hud.note(String(localized: "Add a Space first to use voice input."))
            return
        }
        hud.space = c.name
        guard let space = model.lives[c.id], space.status == .ok || space.status == .unknown,
              let can = await VoiceInput.transcribes(space.api) else {
            hud.note(String(localized: "\(c.name) is not connected. Voice input needs the Space."))
            return
        }
        guard can else {
            hud.note(model.store.connections.count > 1
                ? String(localized: "\(c.name) cannot transcribe speech. Switch to a Space with voice input at the top left of the window.")
                : String(localized: "\(c.name) cannot transcribe speech."))
            return
        }
        // A note needs an app that takes one, on the Space that transcribes it.
        var target: ScreenshotRules.Target?
        if destination == .capture {
            guard let list = try? await space.api.get("/api/capture", as: DictationRules.TextTargets.self) else {
                hud.note(String(localized: "\(c.name) is not connected. Voice input needs the Space."))
                return
            }
            target = DictationRules.captureTarget(list.textTargets ?? [], chosen: Preferences.shared.voiceCaptureTargets[c.id.uuidString])
            guard let target else {
                hud.note(DictationRules.noTargetNote(space: c.name))
                return
            }
            hud.target = target.displayTitle()
            // A target that takes words only never gets the picture: it is dropped here.
            if !CaptureShotRules.takesImage(target) { shot = nil }
            if let shot = self.shot {
                Task { [weak self] in
                    guard let self, await shot.value() != nil, self.shot === shot, !self.sending else { return }
                    self.hud.attached = true
                }
            }
        }
        // Released before the Space answered: too short to have said anything.
        guard !released else { hud.follow(.idle, text: ""); return }
        listener = space.api.base
        let api = space.api
        let shot = self.shot
        live.start(api: api) { [weak self] text in
            if let target { self?.send(text, to: target, api: api, shot: shot) } else { self?.insert(text) }
        }
    }

    /// A note to the app: never into the field. Sent once with a fresh id, and again with the same
    /// id after a network error; when it does not arrive the text is left on the clipboard. With a
    /// screenshot it goes as one picture with the words, and as the words alone when the target
    /// refuses the picture (CaptureShotRules.next).
    private func send(_ text: String, to target: ScreenshotRules.Target, api: SpaceAPI, shot: NoteShot?) {
        let text = DictationRules.tidy(text)
        let title = target.displayTitle()
        let id = UUID()
        sending = true
        hud.sending(text)
        Task {
            defer { sending = false }
            // Taken long before the words are in; one still on its way is waited for briefly only.
            let picture = await shot?.value(within: CaptureShotRules.wait)
            var route = CaptureShotRules.route(target, shot: picture != nil)
            hud.attached = route == .image
            var retried = false
            var failure: String?
            var answer: DictationRules.CaptureAnswer?
            for _ in 0..<CaptureShotRules.maxTries {
                do {
                    let data: Data
                    if route == .image, let picture {
                        data = try await api.upload(CaptureShotRules.imagePath(to: target), field: "file",
                            filename: CaptureShotRules.filename, mimeType: CaptureShotRules.mimeType, data: picture,
                            fields: CaptureShotRules.fields(text: text, id: id), timeout: 60)
                    } else {
                        route = .text
                        data = try await api.send("POST", DictationRules.capturePath(to: target), json: DictationRules.captureBody(text: text, id: id))
                    }
                    answer = try? JSONDecoder().decode(DictationRules.CaptureAnswer.self, from: data)
                    failure = DictationRules.kept(answer) ? nil : String(localized: "the app did not keep it")
                    break
                } catch {
                    failure = HubStore.message(error)
                    guard let next = CaptureShotRules.next(after: error, route: route, retried: retried) else { break }
                    if next == route { retried = true }
                    if next != route { hud.attached = false }
                    route = next
                }
            }
            if let failure {
                // Not transient: this is the only copy of what was said (the words; never the picture).
                write(text, to: NSPasteboard.general, transient: false)
                hud.note(DictationRules.failedNote(title: title, reason: failure), clipboard: true)
            } else {
                hud.kept(label: answer?.label, text: text, shot: route == .image)
            }
        }
    }

    /// A screenshot for this press when CaptureShotRules says so; the first use without the grant
    /// shows the system's Screen Recording prompt once, and that note goes as words only.
    private func takeShot(_ destination: DictationRules.Destination) -> NoteShot? {
        let prefs = Preferences.shared
        let granted = ScreenShot.granted
        if CaptureShotRules.asks(destination, enabled: prefs.voiceCaptureScreenshot, granted: granted, askedBefore: prefs.screenshotAsked) {
            prefs.screenshotAsked = true
            ScreenShot.ask()
        }
        guard CaptureShotRules.takes(destination, enabled: prefs.voiceCaptureScreenshot, granted: granted) else { return nil }
        let shot = NoteShot()
        let excluded = [hud.windowNumber]
        Task { shot.finish(await ScreenShot.take(excluding: excluded)) }
        return shot
    }

    /// The transcript goes through the clipboard: written, pasted, and the earlier contents put
    /// back once the field has read it.
    private func insert(_ text: String) {
        let text = DictationRules.tidy(text)
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
                hud.note(String(localized: "The text is on the clipboard. Press ⌘V to paste it."), clipboard: true)
            }
        case .systemPaste:
            postCommandV()
        case .clipboardOnly:
            hud.note(String(localized: "The text is on the clipboard. Press ⌘V to paste it. To have it go in by itself, allow AI Space in System Settings → Privacy & Security → Accessibility."), clipboard: true)
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

/// A screenshot being taken: its bytes once done (nil when it failed).
@MainActor
final class NoteShot {
    private var data: Data?
    private var done = false
    private var waiting: [CheckedContinuation<Void, Never>] = []

    func finish(_ data: Data?) {
        self.data = data
        done = true
        waiting.forEach { $0.resume() }
        waiting = []
    }

    /// The bytes, waiting for the picture however long it takes.
    func value() async -> Data? {
        if !done { await withCheckedContinuation { waiting.append($0) } }
        return data
    }

    /// The bytes, or nil when the picture is not in within `seconds`: the words never wait longer.
    func value(within seconds: TimeInterval) async -> Data? {
        let deadline = Date().addingTimeInterval(seconds)
        while !done, Date() < deadline { try? await Task.sleep(for: .milliseconds(50)) }
        return done ? data : nil
    }
}
