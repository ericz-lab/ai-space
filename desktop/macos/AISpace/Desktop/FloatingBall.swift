import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// A small round window over every app, on every Space, that takes a dropped picture: the
/// picture opens in Share Picture to pick the app of the Space that keeps it. Drag the ball to
/// move it (its place is remembered on this Mac), click it for Pending Shares, right-click for
/// the picture actions and Hide. Space → Floating Ball and Settings › General show or hide it.
@MainActor
final class FloatingBall: NSObject, NSWindowDelegate {
    private unowned let model: AppModel
    private let state = FloatingBallState()
    private lazy var panel: NSPanel = makePanel()
    private var screenWatcher: NSObjectProtocol?

    init(model: AppModel) {
        self.model = model
        super.init()
    }

    func set(visible: Bool) {
        if visible { show() } else { panel.orderOut(nil) }
    }

    private func show() {
        place()
        // Not makeKeyAndOrderFront: the ball must never take the keyboard from the app in front.
        panel.orderFrontRegardless()
        if screenWatcher == nil {
            screenWatcher = NotificationCenter.default.addObserver(
                forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated { self?.place() }
            }
        }
    }

    /// Puts the ball where it was, on the screen that still has that place, else on the main one.
    private func place() {
        let saved = Preferences.shared.floatingBallOrigin
        let screen = saved.flatMap { p in NSScreen.screens.first { $0.visibleFrame.contains(p) } } ?? NSScreen.main ?? NSScreen.screens.first
        guard let visible = screen?.visibleFrame else { return }
        panel.setFrameOrigin(FloatingBallRules.origin(saved: saved, size: panel.frame.size, visible: visible))
    }

    /// After a drag of the ball: back inside the screen it was left on, and remembered.
    private func settle() {
        guard let visible = (panel.screen ?? NSScreen.main)?.visibleFrame else { return }
        panel.setFrameOrigin(FloatingBallRules.origin(saved: panel.frame.origin, size: panel.frame.size, visible: visible))
        Preferences.shared.floatingBallOrigin = panel.frame.origin
    }

    private func makePanel() -> NSPanel {
        let d = FloatingBallRules.diameter
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: d, height: d),
                            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.animationBehavior = .none
        panel.isExcludedFromWindowsMenu = true
        panel.delegate = self

        let content = NSView(frame: NSRect(x: 0, y: 0, width: d, height: d))
        let look = NSHostingView(rootView: FloatingBallLook(state: state))
        look.frame = content.bounds
        look.autoresizingMask = [.width, .height]
        content.addSubview(look)
        // Above the look, so it gets every mouse event and every drag; it draws nothing.
        let surface = FloatingBallSurface(frame: content.bounds)
        surface.autoresizingMask = [.width, .height]
        surface.state = state
        surface.take = { [weak self] data in self?.model.pictureSharing.take(data) }
        surface.refuse = { [weak self] message in self?.model.pictureSharing.refuse(message) }
        surface.open = { [weak self] in self?.model.pictureSharing.show() }
        surface.settle = { [weak self] in self?.settle() }
        surface.menu = contextMenu()
        content.addSubview(surface)
        panel.contentView = content
        return panel
    }

    private func contextMenu() -> NSMenu {
        let menu = NSMenu()
        func add(_ title: String, _ action: Selector) {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
            item.target = self
            menu.addItem(item)
        }
        add(String(localized: "Share Picture…"), #selector(sharePicture))
        add(String(localized: "Paste Picture"), #selector(pastePicture))
        add(String(localized: "Pending Shares"), #selector(pendingShares))
        menu.addItem(.separator())
        add(String(localized: "Hide Floating Ball"), #selector(hideBall))
        return menu
    }

    @objc private func sharePicture() { model.pictureSharing.choose() }
    @objc private func pastePicture() { model.pictureSharing.paste() }
    @objc private func pendingShares() { model.pictureSharing.show() }
    @objc private func hideBall() { Preferences.shared.floatingBall = false }
}

/// What the look shows: whether a drag the ball can take is over it, and whether a promised
/// file is still on its way.
@MainActor
final class FloatingBallState: ObservableObject {
    @Published var hover = false
    @Published var receiving = false
}

/// The ball itself: the mark on a round piece of glass, lit when a picture is held over it.
private struct FloatingBallLook: View {
    @ObservedObject var state: FloatingBallState

    var body: some View {
        ZStack {
            Circle().fill(.regularMaterial)
            Circle().strokeBorder(state.hover ? Theme.accent : Color.primary.opacity(0.14), lineWidth: state.hover ? 2 : 1)
            if state.receiving {
                ProgressView().controlSize(.small)
            } else {
                Logo(size: 30)
            }
        }
        .padding(3)
        .scaleEffect(state.hover ? 1.08 : 1)
        .animation(.easeOut(duration: 0.15), value: state.hover)
        .help("Drop a picture here to keep it in an app of the Space.")
        .accessibilityElement()
        .accessibilityLabel(Text("Floating Ball"))
    }
}

/// The ball's mouse and drag handling. A press and release is a click; a press that moves takes
/// the window along (a borderless panel is not moved by the system). A drag from another app is
/// taken when it holds one picture, as data, as one file or as a file promise.
private final class FloatingBallSurface: NSView {
    var state: FloatingBallState?
    var take: (Data) -> Void = { _ in }
    var refuse: (String) -> Void = { _ in }
    var open: () -> Void = {}
    var settle: () -> Void = {}

    private var pressed: NSPoint?
    private var startOrigin: NSPoint?
    private var moved = false
    private let promises = OperationQueue()

    override init(frame: NSRect) {
        super.init(frame: frame)
        var types: [NSPasteboard.PasteboardType] = [.png, .tiff, .fileURL]
        types += [UTType.jpeg, .heic, .gif, .webP, .image].map { NSPasteboard.PasteboardType($0.identifier) }
        types += NSFilePromiseReceiver.readableDraggedTypes.map { NSPasteboard.PasteboardType($0) }
        registerForDraggedTypes(types)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    // The panel never becomes key, so the first click must count.
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        pressed = NSEvent.mouseLocation
        startOrigin = window?.frame.origin
        moved = false
    }

    override func mouseDragged(with event: NSEvent) {
        guard let pressed, let startOrigin, let window else { return }
        let now = NSEvent.mouseLocation
        let dx = now.x - pressed.x, dy = now.y - pressed.y
        if abs(dx) + abs(dy) > 3 { moved = true }
        if moved { window.setFrameOrigin(NSPoint(x: startOrigin.x + dx, y: startOrigin.y + dy)) }
    }

    override func mouseUp(with event: NSEvent) {
        defer { pressed = nil; startOrigin = nil }
        if moved { settle() } else if event.clickCount == 1 { open() }
    }

    // MARK: Drop

    private func offer(_ info: NSDraggingInfo) -> FloatingBallRules.Offer {
        let board = info.draggingPasteboard
        let files = (board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? [])
            .map { (try? $0.resourceValues(forKeys: [.contentTypeKey]))?.contentType?.identifier ?? "" }
        let promised = board.canReadObject(forClasses: [NSFilePromiseReceiver.self], options: nil)
        return FloatingBallRules.offer(types: board.types?.map(\.rawValue) ?? [], files: files, promised: promised) {
            UTType($0)?.conforms(to: .image) == true
        }
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        let accepted = offer(sender) != .nothing
        state?.hover = accepted
        return accepted ? .copy : []
    }

    override func draggingExited(_ sender: NSDraggingInfo?) { state?.hover = false }
    override func draggingEnded(_ sender: NSDraggingInfo) { state?.hover = false }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        state?.hover = false
        let board = sender.draggingPasteboard
        switch offer(sender) {
        case .file:
            guard let url = (board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL])?.first else { return false }
            do { take(try PictureImport.read(url)) } catch { refuse(error.localizedDescription) }
            return true
        case .picture:
            guard let data = board.data(forType: .png) ?? board.data(forType: .tiff) ?? NSImage(pasteboard: board)?.tiffRepresentation else { return false }
            take(data)
            return true
        case .promise:
            guard let receiver = (board.readObjects(forClasses: [NSFilePromiseReceiver.self], options: nil) as? [NSFilePromiseReceiver])?.first else { return false }
            receive(receiver)
            return true
        case .nothing:
            return false
        }
    }

    /// A promised file lands in a folder of its own under the temporary directory, is read once
    /// and removed; the source writes it in the background, so the answer comes back to the
    /// main thread.
    private func receive(_ receiver: NSFilePromiseReceiver) {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("ai-space-drops", isDirectory: true).appendingPathComponent(UUID().uuidString, isDirectory: true)
        do { try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true) }
        catch { refuse(error.localizedDescription); return }
        state?.receiving = true
        let take = self.take, refuse = self.refuse
        let finish: @Sendable (Result<Data, Error>) -> Void = { [weak self] result in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    self?.state?.receiving = false
                    switch result {
                    case .success(let data): take(data)
                    case .failure(let error): refuse(error.localizedDescription)
                    }
                }
            }
        }
        receiver.receivePromisedFiles(atDestination: folder, options: [:], operationQueue: promises) { url, error in
            defer { try? FileManager.default.removeItem(at: folder) }
            if let error { finish(.failure(error)); return }
            finish(Result { try PictureImport.read(url) })
        }
    }
}
