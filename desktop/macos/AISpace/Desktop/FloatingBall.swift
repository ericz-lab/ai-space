import AppKit
import SwiftUI
import UniformTypeIdentifiers

private typealias DialSection = FloatingBallRules.Section

/// A small round window over every app, on every Space, that takes a dropped picture: the
/// picture opens in Share Picture to pick the app of the Space that keeps it. Under the pointer,
/// or while a picture is dragged over it, the ball opens into a glass dial of four sections (Keep,
/// Space Assistant, Todo, Design Studio): a click opens Quick Chat on that app's agent, to paste
/// text and pictures into and leave the rest to the agent; a picture dropped on a section opens it
/// with the picture attached. Drag the ball to move it (its place is remembered on this Mac),
/// right-click for the picture actions and Hide. Space →
/// Floating Ball and Settings show or hide it.
@MainActor
final class FloatingBall: NSObject, NSWindowDelegate {
    private unowned let model: AppModel
    private let state = FloatingBallState()
    private lazy var panel: NSPanel = makePanel()
    private var screenWatcher: NSObjectProtocol?
    /// Opens Quick Chat on an agent, with text to start the message, beside the ball's frame.
    private let chat: (_ agent: String, _ text: String?, _ near: NSRect?) -> Void
    /// The agent each section hands its work to, as an agent key (`<connection> <app>/<name>`).
    private var agents: [DialSection: String] = [:]
    /// Sections whose app has no agent of its own; Space Assistant takes their work.
    private var borrowed: Set<DialSection> = []
    /// Checks the pointer while the dial is open; it closes once the pointer has left it.
    private var pointerWatch: Timer?
    private var ticksOutside = 0

    init(model: AppModel, chat: @escaping (_ agent: String, _ text: String?, _ near: NSRect?) -> Void) {
        self.model = model
        self.chat = chat
        super.init()
    }

    func set(visible: Bool) {
        if visible { show() } else { collapse(); panel.orderOut(nil) }
    }

    private func show() {
        place()
        // Not makeKeyAndOrderFront: the ball must never take the keyboard from the app in front.
        panel.orderFrontRegardless()
        if screenWatcher == nil {
            screenWatcher = NotificationCenter.default.addObserver(
                forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated { self?.collapse(); self?.place() }
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
        panel.acceptsMouseMovedEvents = true
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
        surface.take = { [weak self] data, section in self?.drop(data, on: section) }
        surface.refuse = { [weak self] message in self?.collapse(); self?.model.pictureSharing.refuse(message) }
        surface.openSection = { [weak self] section in self?.open(section) }
        surface.settle = { [weak self] in self?.settle() }
        surface.expand = { [weak self] in self?.expand() }
        surface.collapse = { [weak self] center in self?.collapse(at: center) }
        surface.accepts = { [weak self] section in self?.state.droppable.contains(section) ?? false }
        surface.menu = contextMenu()
        content.addSubview(surface)
        panel.contentView = content
        return panel
    }

    // MARK: The dial

    /// Opens the dial around the ball, kept whole on its screen, with the Space's entries and
    /// what each section takes read afresh.
    private func expand() {
        guard !state.expanded, panel.isVisible else { return }
        let ball = panel.frame
        guard let visible = (panel.screen ?? NSScreen.main)?.visibleFrame else { return }
        let center = FloatingBallRules.dialCenter(ball: CGPoint(x: ball.midX, y: ball.midY), visible: visible)
        let d = FloatingBallRules.dialWindow
        resolveEntries()
        state.highlighted = nil
        state.shown = false
        state.expanded = true
        panel.setFrame(NSRect(x: center.x - d / 2, y: center.y - d / 2, width: d, height: d), display: true)
        panel.invalidateShadow()
        DispatchQueue.main.async { [state] in
            withAnimation(.spring(response: 0.26, dampingFraction: 0.8)) { state.shown = true }
        }
        ticksOutside = 0
        pointerWatch?.invalidate()
        pointerWatch = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.checkPointer() }
        }
    }

    /// Back to the ball: at its remembered place, or centred on `center` when the dial is being
    /// dragged away (the ball then follows the pointer).
    private func collapse(at center: CGPoint? = nil) {
        pointerWatch?.invalidate()
        pointerWatch = nil
        guard state.expanded else { return }
        state.shown = false
        state.expanded = false
        state.highlighted = nil
        state.dragging = false
        let d = FloatingBallRules.diameter
        if let center {
            panel.setFrame(NSRect(x: center.x - d / 2, y: center.y - d / 2, width: d, height: d), display: true)
        } else {
            panel.setContentSize(NSSize(width: d, height: d))
            place()
        }
        panel.invalidateShadow()
    }

    /// The dial closes a moment after the pointer leaves its disc; a drag in progress counts as the pointer.
    private func checkPointer() {
        guard state.expanded else { return }
        let f = panel.frame, p = NSEvent.mouseLocation
        let dx = p.x - f.midX, dy = p.y - f.midY
        let inside = (dx * dx + dy * dy).squareRoot() <= FloatingBallRules.dialDiameter / 2 + 6
        ticksOutside = inside ? 0 : ticksOutside + 1
        if ticksOutside >= 3 { collapse() }
    }

    /// Each section's entry (its icon and name) and its agent, in the selected Space: what Settings
    /// set for that Space (an app or an agent, or nothing), else the section's default app. An agent
    /// takes the work itself; an app hands it to its own agent, or to Space Assistant, told where it
    /// goes, when it has none. A catalogue older than a minute is read again in the background, so
    /// an agent the Space has just gained takes over its section.
    private func resolveEntries(refreshing: Bool = true) {
        guard let c = model.selected else {
            state.entries = [:]; state.icons = [:]; agents = [:]; borrowed = []; state.droppable = []
            return
        }
        let loader = model.loader(for: c)
        if refreshing, (loader.catalogue?.fetchedAt ?? .distantPast).timeIntervalSinceNow < -60 {
            Task { [weak self] in
                await loader.refresh()
                self?.resolveEntries(refreshing: false)
            }
        }
        let slots = Preferences.shared.floatingBallSlots[c.id.uuidString]
        var entries: [DialSection: CatalogueEntry] = [:]
        var agents: [DialSection: String] = [:]
        var borrowed: Set<DialSection> = []
        if let catalogue = loader.catalogue {
            let agentRefs = catalogue.agents.map(\.ref)
            for section in DialSection.allCases {
                let entry: CatalogueEntry?
                switch FloatingBallRules.slot(section, in: slots) {
                case FloatingBallRules.emptySlot?: entry = nil
                case let key?: entry = catalogue.entry(key)
                case nil:
                    let pool = section == .assistant ? catalogue.agents : catalogue.apps
                    entry = FloatingBallRules.ref(for: section, among: pool.map(\.ref)).flatMap { ref in pool.first { $0.ref == ref } }
                }
                guard let entry, entry.kind != .widget else { continue }
                let own = entry.kind == .agent ? entry.ref : FloatingBallRules.agent(forApp: entry.ref, among: agentRefs)
                guard let agent = own ?? FloatingBallRules.agent(for: .assistant, among: agentRefs) else { continue }
                entries[section] = entry
                agents[section] = AgentRef(connection: c.id, agent: agent).key
                if own == nil { borrowed.insert(section) }
            }
        }
        let icons = model.icons(for: c)
        state.hidden = Set(DialSection.allCases.filter { FloatingBallRules.slot($0, in: slots) == FloatingBallRules.emptySlot })
        state.entries = entries
        state.icons = Dictionary(uniqueKeysWithValues: entries.keys.map { ($0, icons) })
        self.agents = agents
        self.borrowed = borrowed
        state.droppable = Set(agents.keys)
    }

    /// Opens Quick Chat on the section's agent. When the app has no agent of its own, Space
    /// Assistant takes the work and the message starts by saying where it goes (once).
    private func handOver(_ section: DialSection) -> Bool {
        guard let agent = agents[section] else { return false }
        chat(agent, nil, panel.isVisible ? panel.frame : nil)
        if borrowed.contains(section), let chat = model.quickChatController {
            let name = state.entries[section]?.displayTitle() ?? section.fallbackTitle
            let lead = String(localized: "Save this to \(name):")
            if !chat.draft.hasPrefix(lead) { chat.draft = lead + "\n" + chat.draft }
        }
        return true
    }

    private func open(_ section: DialSection) {
        collapse()
        _ = handOver(section)
    }

    /// A picture dropped on the dial: on a section, Quick Chat opens on its agent with the picture
    /// added to the next message; on the hub, Share Picture opens on it as before.
    private func drop(_ data: Data, on section: DialSection?) {
        collapse()
        guard let section, handOver(section) else { return model.pictureSharing.take(data) }
        model.quickChatController?.attach(data, name: "Image")
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

/// What the look shows: whether a drag the ball can take is over it, whether a promised file is
/// still on its way, and the dial with its sections.
@MainActor
final class FloatingBallState: ObservableObject {
    @Published var hover = false
    @Published var receiving = false
    /// The dial is open around the ball.
    @Published var expanded = false
    /// The dial has grown to full size; set just after `expanded`, so only its scale and fade
    /// animate and never its place in the window as the window changes size.
    @Published var shown = false
    /// The section under the pointer, lit and named in the hub.
    @Published var highlighted: FloatingBallRules.Section?
    /// A picture is being dragged over the dial: sections that cannot take it are dimmed.
    @Published var dragging = false
    @Published var entries: [FloatingBallRules.Section: CatalogueEntry] = [:]
    @Published var droppable: Set<FloatingBallRules.Section> = []
    /// Sections Settings left empty for this Space: drawn blank, not greyed.
    @Published var hidden: Set<FloatingBallRules.Section> = []
    var icons: [FloatingBallRules.Section: IconStore] = [:]
}

/// The ball itself: the mark on a round piece of glass, lit when a picture is held over it; open,
/// the dial around it.
private struct FloatingBallLook: View {
    @ObservedObject var state: FloatingBallState

    var body: some View {
        ZStack {
            // Swapped without a transition: the window changes size at the same moment, and an
            // animated swap would slide the content from the old window's corner.
            if state.expanded {
                FloatingDial(state: state)
                    .scaleEffect(state.shown ? 1 : 0.35)
                    .opacity(state.shown ? 1 : 0)
            } else {
                ball
            }
        }
    }

    private var ball: some View {
        ZStack {
            Circle().fill(.regularMaterial)
            Circle().strokeBorder(state.hover ? Theme.accent : Color.primary.opacity(0.14), lineWidth: state.hover ? 2 : 1)
            if state.receiving {
                ProgressView().controlSize(.small)
            } else {
                Logo(size: 28)
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

/// The open dial, drawn to Design Studio's spec (design 11, "glass disc"): a 168 pt disc of frosted
/// glass with a hairline rim, four sections around a 60 pt hub, the section under the pointer
/// tinted blue and named in the hub. During a drag the sections that cannot take the picture are
/// faded and grey; a section Settings left empty is a dashed circle with a plus.
private struct FloatingDial: View {
    @ObservedObject var state: FloatingBallState
    @Environment(\.colorScheme) private var scheme

    private let outer = FloatingBallRules.dialDiameter / 2
    private let inner = FloatingBallRules.hubDiameter / 2
    private let iconSize: CGFloat = 28

    private var dark: Bool { scheme == .dark }
    private var line: Color { dark ? Color.white.opacity(0.12) : Color.black.opacity(0.08) }
    private var tint: Color { Color(nsColor: .systemBlue).opacity(dark ? 0.22 : 0.14) }

    var body: some View {
        GeometryReader { geo in
            let c = CGPoint(x: geo.size.width / 2, y: geo.size.height / 2)
            ZStack {
                Circle()
                    .fill(.ultraThinMaterial)
                    .overlay(Circle().fill(dark ? Color(red: 40 / 255, green: 40 / 255, blue: 44 / 255).opacity(0.62) : Color.white.opacity(0.62)))
                    .overlay(Circle().strokeBorder(line, lineWidth: 1))
                    .frame(width: outer * 2, height: outer * 2)
                    .shadow(color: .black.opacity(0.18), radius: 16, y: 12)
                    .position(c)
                ForEach(DialSection.allCases, id: \.self) { section in
                    DialWedge(center: c, angle: section.angle, inner: inner, outer: outer)
                        .fill(state.highlighted == section && (usable(section) || state.hidden.contains(section)) ? tint : .clear)
                }
                DialSeparators(center: c, inner: inner, outer: outer).stroke(line, lineWidth: 1)
                ForEach(DialSection.allCases, id: \.self) { section in
                    icon(section).position(point(section, center: c))
                }
                hub.frame(width: inner * 2, height: inner * 2).position(c)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Floating Ball"))
    }

    /// A section that can act now: its entry exists, and during a drag it takes pictures.
    private func usable(_ section: DialSection) -> Bool {
        state.entries[section] != nil && (!state.dragging || state.droppable.contains(section))
    }

    /// Icon centres 57 pt from the middle: halfway between the hub and the rim.
    private func point(_ section: DialSection, center c: CGPoint) -> CGPoint {
        let r = (inner + outer) / 2, a = section.angle * .pi / 180
        return CGPoint(x: c.x + cos(a) * r, y: c.y - sin(a) * r)
    }

    private func title(_ section: DialSection) -> String {
        state.entries[section]?.displayTitle() ?? section.fallbackTitle
    }

    @ViewBuilder private func icon(_ section: DialSection) -> some View {
        if state.hidden.contains(section) {
            ZStack {
                Circle().strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [3, 2.6]))
                Image(systemName: "plus").font(.system(size: 9, weight: .semibold))
            }
            .foregroundStyle(dark ? Color(red: 235 / 255, green: 235 / 255, blue: 245 / 255).opacity(0.3) : Color(red: 60 / 255, green: 60 / 255, blue: 67 / 255).opacity(0.3))
            .frame(width: iconSize, height: iconSize)
        } else {
            Group {
                if let entry = state.entries[section], let icons = state.icons[section] {
                    EntryIcon(icon: entry.icon, fallback: symbol(section), icons: icons, size: iconSize, isRound: entry.kind == .agent)
                } else {
                    Image(systemName: symbol(section)).font(.system(size: 15, weight: .medium)).foregroundStyle(.secondary)
                        .frame(width: iconSize, height: iconSize)
                }
            }
            .saturation(usable(section) ? 1 : 0)
            .opacity(usable(section) ? 1 : 0.3)
        }
    }

    private func symbol(_ section: DialSection) -> String {
        if let entry = state.entries[section] { return entry.kind == .agent ? "person.fill" : "app" }
        switch section {
        case .keep: return "bookmark"
        case .assistant: return "sparkles"
        case .todo: return "checklist"
        case .design: return "paintpalette"
        }
    }

    /// What the hub says: the section under the pointer ("Send to …" during a drag, "Add in
    /// Settings…" for an empty one); nothing otherwise.
    private var label: String? {
        guard let section = state.highlighted else { return nil }
        if state.hidden.contains(section) { return String(localized: "Add in Settings…") }
        if state.dragging, usable(section) { return String(localized: "Send to \(title(section))") }
        return title(section)
    }

    private var hub: some View {
        ZStack {
            Circle().fill(dark ? Color(red: 52 / 255, green: 52 / 255, blue: 57 / 255).opacity(0.78) : Color.white.opacity(0.78))
            Circle().strokeBorder(line, lineWidth: 1)
            if state.receiving {
                ProgressView().controlSize(.small)
            } else if let label {
                Text(verbatim: label)
                    .font(.system(size: 11, weight: .semibold))
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                    .minimumScaleFactor(0.85)
                    .foregroundStyle(Theme.text)
                    .padding(.horizontal, 5)
            }
        }
    }
}

/// One section of the dial: the ring between the hub and the rim, a quarter wide around `angle`
/// (degrees counterclockwise from the right; SwiftUI's y points down, so angles are negated).
private struct DialWedge: Shape {
    let center: CGPoint
    let angle: CGFloat
    let inner: CGFloat
    let outer: CGFloat

    func path(in rect: CGRect) -> Path {
        var p = Path()
        p.addArc(center: center, radius: outer, startAngle: .degrees(-(angle + 45)), endAngle: .degrees(-(angle - 45)), clockwise: false)
        p.addArc(center: center, radius: inner, startAngle: .degrees(-(angle - 45)), endAngle: .degrees(-(angle + 45)), clockwise: true)
        p.closeSubpath()
        return p
    }
}

/// The four hairlines between the sections, on the diagonals.
private struct DialSeparators: Shape {
    let center: CGPoint
    let inner: CGFloat
    let outer: CGFloat

    func path(in rect: CGRect) -> Path {
        var p = Path()
        for degrees in stride(from: 45.0, to: 360, by: 90) {
            let a = degrees * .pi / 180
            p.move(to: CGPoint(x: center.x + cos(a) * inner, y: center.y - sin(a) * inner))
            p.addLine(to: CGPoint(x: center.x + cos(a) * outer, y: center.y - sin(a) * outer))
        }
        return p
    }
}

/// The ball's mouse and drag handling. A press and release is a click; a press that moves takes
/// the window along (a borderless panel is not moved by the system). Resting on the ball opens
/// the dial; a click there opens the section under the pointer (the hub does nothing). A
/// drag from another app is taken when it holds one picture, as data, as one file or as a file
/// promise; it opens the dial too, so the picture can be dropped on a section.
private final class FloatingBallSurface: NSView {
    var state: FloatingBallState?
    var take: (Data, FloatingBallRules.Section?) -> Void = { _, _ in }
    var refuse: (String) -> Void = { _ in }
    var openSection: (FloatingBallRules.Section) -> Void = { _ in }
    var settle: () -> Void = {}
    var expand: () -> Void = {}
    var collapse: (CGPoint?) -> Void = { _ in }
    var accepts: (FloatingBallRules.Section) -> Bool = { _ in false }

    private var pressed: NSPoint?
    private var startOrigin: NSPoint?
    private var moved = false
    private var opening: DispatchWorkItem?
    private let promises = OperationQueue()

    override init(frame: NSRect) {
        super.init(frame: frame)
        var types: [NSPasteboard.PasteboardType] = [.png, .tiff, .fileURL]
        types += [UTType.jpeg, .heic, .gif, .webP, .image].map { NSPasteboard.PasteboardType($0.identifier) }
        types += NSFilePromiseReceiver.readableDraggedTypes.map { NSPasteboard.PasteboardType($0) }
        registerForDraggedTypes(types)
        // In the visible rect, so it follows the panel as the dial opens and closes.
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .mouseMoved, .activeAlways, .inVisibleRect],
                                       owner: self, userInfo: nil))
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    // The panel never becomes key, so the first click must count.
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    private var expanded: Bool { state?.expanded ?? false }

    /// The section under a point of this view; the dial is centred on the view while open.
    private func section(at point: NSPoint) -> FloatingBallRules.Section? {
        guard expanded else { return nil }
        return FloatingBallRules.section(at: point, center: CGPoint(x: bounds.midX, y: bounds.midY))
    }

    // MARK: Hover

    override func mouseEntered(with event: NSEvent) {
        guard pressed == nil, !expanded else { return }
        opening?.cancel()
        // A short rest, so a pointer passing over the ball does not open the dial.
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.pressed == nil, let window = self.window,
                  window.frame.contains(NSEvent.mouseLocation) else { return }
            self.expand()
        }
        opening = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12, execute: work)
    }

    override func mouseExited(with event: NSEvent) {
        if !expanded { opening?.cancel() }
    }

    override func mouseMoved(with event: NSEvent) {
        guard expanded, pressed == nil else { return }
        let s = section(at: convert(event.locationInWindow, from: nil))
        if state?.highlighted != s { state?.highlighted = s }
    }

    // MARK: Click and move

    override func mouseDown(with event: NSEvent) {
        opening?.cancel()
        pressed = NSEvent.mouseLocation
        startOrigin = window?.frame.origin
        moved = false
    }

    override func mouseDragged(with event: NSEvent) {
        guard let pressed, let window else { return }
        let now = NSEvent.mouseLocation
        let dx = now.x - pressed.x, dy = now.y - pressed.y
        if !moved, abs(dx) + abs(dy) > 3 {
            moved = true
            // Moving the open dial moves the ball: it closes around the hub and follows from there.
            if expanded {
                collapse(CGPoint(x: window.frame.midX, y: window.frame.midY))
            }
            startOrigin = window.frame.origin
        }
        if moved, let startOrigin { window.setFrameOrigin(NSPoint(x: startOrigin.x + dx, y: startOrigin.y + dy)) }
    }

    override func mouseUp(with event: NSEvent) {
        defer { pressed = nil; startOrigin = nil }
        if moved { return settle() }
        guard event.clickCount == 1 else { return }
        // The hub and the closed ball do nothing on a click; only a section opens something.
        if let s = section(at: convert(event.locationInWindow, from: nil)) { openSection(s) }
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
        guard accepted else { return [] }
        opening?.cancel()
        expand()
        state?.dragging = true
        return operation(sender)
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        guard state?.hover == true else { return [] }
        return operation(sender)
    }

    /// Lights the section under the drag; one that cannot take the picture refuses it, the hub takes it.
    private func operation(_ sender: NSDraggingInfo) -> NSDragOperation {
        let s = section(at: convert(sender.draggingLocation, from: nil))
        if state?.highlighted != s { state?.highlighted = s }
        if let s, !accepts(s) { return [] }
        return .copy
    }

    override func draggingExited(_ sender: NSDraggingInfo?) {
        state?.hover = false
        state?.highlighted = nil
    }

    override func draggingEnded(_ sender: NSDraggingInfo) {
        state?.hover = false
        state?.dragging = false
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        state?.hover = false
        let target = section(at: convert(sender.draggingLocation, from: nil))
        if let target, !accepts(target) { return false }
        let board = sender.draggingPasteboard
        switch offer(sender) {
        case .file:
            guard let url = (board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL])?.first else { return false }
            do { take(try PictureImport.read(url), target) } catch { refuse(error.localizedDescription) }
            return true
        case .picture:
            guard let data = board.data(forType: .png) ?? board.data(forType: .tiff) ?? NSImage(pasteboard: board)?.tiffRepresentation else { return false }
            take(data, target)
            return true
        case .promise:
            guard let receiver = (board.readObjects(forClasses: [NSFilePromiseReceiver.self], options: nil) as? [NSFilePromiseReceiver])?.first else { return false }
            receive(receiver, for: target)
            return true
        case .nothing:
            return false
        }
    }

    /// A promised file lands in a folder of its own under the temporary directory, is read once
    /// and removed; the source writes it in the background, so the answer comes back to the
    /// main thread.
    private func receive(_ receiver: NSFilePromiseReceiver, for section: FloatingBallRules.Section?) {
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
                    case .success(let data): take(data, section)
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
