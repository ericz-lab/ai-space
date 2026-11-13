import AppKit
import Combine
import SwiftUI

/// The desk pet on the desktop (docs/macos-desktop.md#desk-pet): Claude walking along the bottom of
/// the main screen, above the Dock, over every app and on every Space, showing the selected Space's
/// mood. Built as the floating ball is: a borderless, non-activating panel at the floating level
/// that never takes the keyboard. The panel follows the pet and holds its bubble; it lets the
/// pointer through except over the pet itself, which a look at the pointer ten times a second
/// finds. A click opens what the mood points at (else the pet jumps); a drag puts the pet
/// elsewhere along the bottom; right-click to hide it or put it back in the window. It stops
/// while the screen cannot be seen, and is not shown with Reduce Motion on, as the panel's pet is not.
@MainActor
final class DeskPet: NSObject {
    private unowned let model: AppModel
    private let driver = PetDriver()
    private let frame = DeskPetFrame()
    private var panel: NSPanel?
    private var surface: DeskPetSurface?
    private var watchers: Set<AnyCancellable> = []
    private var observers: [(NotificationCenter, NSObjectProtocol)] = []
    private var pointerWatch: Timer?
    private var reduceMotionWatch: NSObjectProtocol?
    private var wanted = false

    init(model: AppModel) {
        self.model = model
        super.init()
        // Kept while the pet is hidden too, so turning Reduce Motion off brings it back.
        let workspace = NSWorkspace.shared.notificationCenter
        reduceMotionWatch = workspace.addObserver(forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.set(visible: self.wanted, size: self.frame.size)
            }
        }
    }

    func set(visible: Bool, size: PetSize) {
        wanted = visible
        frame.size = size
        if visible && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion { show() } else { hide() }
    }

    private func show() {
        let panel = self.panel ?? makePanel()
        self.panel = panel
        let returning = !panel.isVisible
        layout()
        if returning, let spot = Preferences.shared.deskPetSpot {
            driver.drop(at: DeskPetRules.x(fraction: spot, stage: Double(frame.visible.width), width: frame.size.width))
        }
        updateMood()
        // Not makeKeyAndOrderFront: the pet must never take the keyboard from the app in front.
        panel.orderFrontRegardless()
        driver.run(true)
        guard observers.isEmpty else { return }
        watch()
    }

    private func hide() {
        driver.run(false)
        pointerWatch?.invalidate()
        pointerWatch = nil
        panel?.orderOut(nil)
        watchers.removeAll()
        for (center, o) in observers { center.removeObserver(o) }
        observers.removeAll()
    }

    private func watch() {
        // The panel follows the pet.
        driver.$motion.sink { [weak self] m in
            guard let self, let m else { return }
            self.place(x: m.x)
        }.store(in: &watchers)
        model.livesRefreshed.sink { [weak self] in self?.updateMood() }.store(in: &watchers)
        let center = NotificationCenter.default
        observers.append((center, center.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.layout() }
        }))
        // Locked, asleep or covered: nothing to draw, so nothing runs.
        observers.append((center, center.addObserver(forName: NSWindow.didChangeOcclusionStateNotification, object: panel, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, let panel = self.panel else { return }
                self.driver.run(panel.isVisible && panel.occlusionState.contains(.visible))
            }
        }))
        pointerWatch = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.checkPointer() }
        }
    }

    /// The main screen's bottom, above the Dock, as the pet's stage.
    private func layout() {
        guard let screen = NSScreen.screens.first else { return }
        frame.visible = screen.visibleFrame
        driver.layout(stage: Double(screen.visibleFrame.width), width: frame.size.width)
        if let m = driver.motion { place(x: m.x) }
    }

    private var petSize: CGSize {
        CGSize(width: frame.size.width, height: frame.size.width * PetSheet.claude.aspect)
    }

    private func place(x: Double) {
        guard let panel else { return }
        let rect = DeskPetRules.window(x: x, pet: petSize, visible: frame.visible)
        if panel.frame != rect { panel.setFrame(rect, display: false) }
        surface?.sprite = DeskPetRules.sprite(x: x, pet: petSize, window: rect, visible: frame.visible)
    }

    /// The pointer over the pet makes the panel take it; anywhere else it passes through to what is under it.
    private func checkPointer() {
        guard let panel, panel.isVisible, let surface else { return }
        if surface.dragging { return }
        let sprite = surface.sprite.offsetBy(dx: panel.frame.minX, dy: panel.frame.minY)
        let over = sprite.contains(NSEvent.mouseLocation)
        if panel.ignoresMouseEvents == over { panel.ignoresMouseEvents = !over }
        if frame.hovering != over { frame.hovering = over }
    }

    private func updateMood() {
        driver.set(mood: PetMood.shown(model.selectedMood))
    }

    private func makePanel() -> NSPanel {
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 400, height: 160),
                            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.animationBehavior = .none
        panel.isExcludedFromWindowsMenu = true
        panel.ignoresMouseEvents = true

        let content = NSView(frame: NSRect(x: 0, y: 0, width: 400, height: 160))
        let look = NSHostingView(rootView: DeskPetLook(driver: driver, frame: frame))
        look.frame = content.bounds
        look.autoresizingMask = [.width, .height]
        content.addSubview(look)
        // Above the look, so it gets the pet's clicks and drags; it draws nothing.
        let surface = DeskPetSurface(frame: content.bounds)
        surface.autoresizingMask = [.width, .height]
        surface.click = { [weak self] in
            guard let self, let open = self.driver.click(), let c = self.model.selected else { return }
            self.model.openPet(open, connection: c.id)
        }
        surface.drag = { [weak self] dx in self?.drag(by: dx) }
        surface.dropped = { [weak self] in self?.dropped() }
        surface.menu = contextMenu()
        content.addSubview(surface)
        self.surface = surface
        panel.contentView = content
        return panel
    }

    private var dragStart: Double?

    private func drag(by dx: Double) {
        guard let m = driver.motion else { return }
        let start = dragStart ?? m.x
        dragStart = start
        driver.hold(at: start + dx)
    }

    private func dropped() {
        dragStart = nil
        guard let m = driver.motion else { return }
        Preferences.shared.deskPetSpot = DeskPetRules.fraction(x: m.x, stage: Double(frame.visible.width), width: frame.size.width)
        driver.drop(at: m.x)
    }

    private func contextMenu() -> NSMenu {
        let menu = NSMenu()
        func add(_ title: String, _ action: Selector) {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
            item.target = self
            menu.addItem(item)
        }
        add(String(localized: "Put the Pet in the Window"), #selector(toWindow))
        add(String(localized: "Hide the Desk Pet"), #selector(hidePet))
        return menu
    }

    @objc private func toWindow() { Preferences.shared.petPlace = .window }
    @objc private func hidePet() { Preferences.shared.pet = false }
}

/// What the desktop pet's look needs besides the pet: the screen's visible area and the pet's size,
/// and whether the pointer is on it (the bubble shows then).
@MainActor
final class DeskPetFrame: ObservableObject {
    @Published var visible: CGRect = .zero
    @Published var size: PetSize = .medium
    @Published var hovering = false
}

/// The pet and its bubble inside the panel, placed as DeskPetRules places the panel around it.
private struct DeskPetLook: View {
    @ObservedObject var driver: PetDriver
    @ObservedObject var frame: DeskPetFrame
    private let sheet = PetSheet.claude

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            Color.clear
            if let m = driver.motion {
                let pet = CGSize(width: frame.size.width, height: frame.size.width * sheet.aspect)
                let window = DeskPetRules.window(x: m.x, pet: pet, visible: frame.visible)
                let sprite = DeskPetRules.sprite(x: m.x, pet: pet, window: window, visible: frame.visible)
                PetBody(driver: driver, sheet: sheet, width: frame.size.width,
                        opensRight: m.x + frame.size.width / 2 < Double(frame.visible.width) / 2, hovering: frame.hovering)
                    .offset(x: sprite.minX)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Desk pet"))
    }
}

/// The pet's mouse handling. A press and release is a click; a press that moves drags the pet
/// along the bottom of the screen. Only the pet's own rectangle takes the mouse.
private final class DeskPetSurface: NSView {
    var click: () -> Void = {}
    var drag: (Double) -> Void = { _ in }
    var dropped: () -> Void = {}
    /// The pet's rectangle in this view (y up).
    var sprite: CGRect = .zero
    private(set) var dragging = false
    private var pressed: NSPoint?

    // The panel never becomes key, so the first click must count.
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func hitTest(_ point: NSPoint) -> NSView? {
        let local = convert(point, from: superview)
        return sprite.contains(local) ? self : nil
    }

    override func mouseDown(with event: NSEvent) {
        pressed = NSEvent.mouseLocation
        dragging = false
    }

    override func mouseDragged(with event: NSEvent) {
        guard let pressed else { return }
        let dx = NSEvent.mouseLocation.x - pressed.x
        if !dragging, abs(dx) > 3 { dragging = true }
        if dragging { drag(Double(dx)) }
    }

    override func mouseUp(with event: NSEvent) {
        defer { pressed = nil; dragging = false }
        if dragging { return dropped() }
        if event.clickCount == 1 { click() }
    }
}
