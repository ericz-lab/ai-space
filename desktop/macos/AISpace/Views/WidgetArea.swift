import AppKit
import SwiftUI

/// Which edge of a card a handle moves: its right edge, its row's bottom edge, or both.
enum WidgetEdge: Hashable {
    case x, y, xy
}

/// A handle that has the keyboard: the card's index and its edge.
struct WidgetHandleID: Hashable {
    var index: Int
    var edge: WidgetEdge
}

/// The snap lines shown while an edge is dragged, in the area's coordinates.
struct WidgetGuides: Equatable {
    var x: [Double] = []
    var y: [Double] = []
    var isEmpty: Bool { x.isEmpty && y.isEmpty }
}

/// The widget area's state (src/web/WidgetArea.tsx): its width, the frames shown while an edge is
/// dragged or moved with the keys, the snap guides, the last write (undone with Undo for eight
/// seconds), the Reset confirm and a failed save's message. Writes are drawn at once, sent with
/// `PUT /api/panel/layout`, and put back with a message when the Space does not take them.
@MainActor
final class WidgetAreaModel: ObservableObject {
    @Published var width: Double = 0
    @Published var live: [WidgetFrame]?
    @Published var active: WidgetHandleID?
    @Published var guides: WidgetGuides?
    @Published var undoable: (undo: LayoutWrite, redo: LayoutWrite)?
    @Published var confirmingReset = false
    @Published var error: String?
    /// The size class each card's inner layout follows, kept per card for the hysteresis.
    private var classes: [String: String] = [:]
    private var undoTask: Task<Void, Never>?
    private var errorTask: Task<Void, Never>?
    /// The frames when a drag or a run of key presses began, and a key run's frames so far.
    var dragBase: (frames: [WidgetFrame], placed: WidgetPlaced)?
    var keyRun: (base: [WidgetFrame], frames: [WidgetFrame])?
    var keyTask: Task<Void, Never>?

    /// Spaces this launch has told that they keep sizes only.
    private static var toldSizesOnly: Set<URL> = []

    func sizeClass(_ id: String, _ box: WidgetBox) -> String {
        let c = WidgetLayout.sizeClass(classes[id], box.width, box.height)
        classes[id] = c
        return c
    }

    func fail(_ text: String) {
        error = text
        errorTask?.cancel()
        errorTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(6))
            guard !Task.isCancelled else { return }
            self?.error = nil
        }
    }

    func setUndoable(_ value: (undo: LayoutWrite, redo: LayoutWrite)?) {
        undoable = value
        undoTask?.cancel()
        guard value != nil else { return }
        undoTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(8))
            guard !Task.isCancelled else { return }
            self?.undoable = nil
        }
    }

    /// Draws `write` at once and stores it; when the Space refuses it, `undo` is drawn again with a
    /// message. A Space that refuses frames but takes sizes (one older than the stepless layout) gets
    /// the nearest sizes, said once.
    func run(_ write: LayoutWrite, undo: LayoutWrite, animate: Bool, undoing: Bool = false, loader: CatalogueLoader, reduceMotion: Bool) {
        withAnimation(animate && !reduceMotion ? .smooth(duration: 0.24) : nil) { loader.apply(write) }
        error = nil
        setUndoable(undoing ? nil : (undo, write))
        Task {
            do {
                try await loader.api.send("PUT", "/api/panel/layout", json: write.json)
            } catch {
                if case SpaceAPIError.http(let code, _) = error, (400..<500).contains(code), write.frames != nil, let sizes = write.sizesOnly,
                   (try? await loader.api.send("PUT", "/api/panel/layout", json: sizes.json)) != nil {
                    // The sizes are stored, the frames are not (a size alone drops a frame): draw what the Space keeps.
                    loader.apply(sizes)
                    setUndoable(nil)
                    if Self.toldSizesOnly.insert(loader.api.base).inserted {
                        fail(String(localized: "This Space keeps widget sizes only, so the nearest size was saved"))
                    }
                    return
                }
                withAnimation(reduceMotion ? nil : .smooth(duration: 0.24)) { loader.apply(undo) }
                setUndoable(nil)
                fail(String(localized: "The layout could not be saved, so the change was undone"))
            }
        }
    }
}

/// A screen's widget cards in the stepless layout (docs/panel.md#widgets, src/web/WidgetArea.tsx):
/// placed by Core/WidgetLayout.swift, each card drawn in its box, the area as tall as its rows. While
/// the screen is arranged every card has three handles (its right edge, its row's bottom edge, the
/// corner) with the live size in its head, edges snap to the area's divisions and the other rows'
/// edges with a guide (Option stops the snapping, Shift changes only this card and lets the next ones
/// re-flow), and a toolbar aligns, centres, splits and resets with one Undo. Below the one-column width
/// the cards are one column sized by their content, as before; the frames are kept and not applied.
struct WidgetArea<Card: View>: View {
    @ObservedObject var loader: CatalogueLoader
    let widgets: [CatalogWidget]
    let align: WidgetAlign
    let editing: Bool
    /// A card in its box (nil: one column, sized by its content).
    @ViewBuilder let card: (CatalogWidget, WidgetCardBox?) -> Card
    @StateObject private var model = WidgetAreaModel()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var focused: WidgetHandleID?

    private var width: Double { model.width }
    /// The page around the area is 32 wider on each side; at the panel's one-column width the cards stack.
    private var free: Bool { width > 0 && width + 64 > WidgetLayout.oneColumnBelow }
    private var stored: [LayoutCard] { widgets.map { LayoutCard(id: $0.id, size: $0.size ?? "1x1", frame: $0.storedFrame) } }
    private var frames: [WidgetFrame] {
        if let live = model.live, live.count == widgets.count { return live }
        return WidgetLayout.resolveFrames(widgets.map { ($0.size, $0.storedFrame) }, width)
    }

    var body: some View {
        let frames = self.frames
        let placed = WidgetLayout.place(frames, max(width, 1), align)
        VStack(alignment: .leading, spacing: 16) {
            if editing && free && !widgets.isEmpty { toolbar(frames) }
            Group {
                if free {
                    ZStack(alignment: .topLeading) {
                        ForEach(Array(widgets.enumerated()), id: \.element.id) { i, w in
                            let b = placed.boxes[i]
                            card(w, WidgetCardBox(sizeClass: model.sizeClass(w.id, b),
                                                  readout: editing ? "\(Int(b.width.rounded())) × \(Int(b.height.rounded()))" : nil,
                                                  resizing: model.active?.index == i))
                                .frame(width: b.width, height: b.height)
                                .offset(x: b.x, y: b.y)
                        }
                        if editing {
                            ForEach(Array(widgets.indices), id: \.self) { i in handles(i, placed.boxes[i], frames: frames, placed: placed) }
                        }
                        if let g = model.guides { guides(g, height: placed.height) }
                    }
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                    .frame(height: placed.height, alignment: .topLeading)
                    .coordinateSpace(.named(Self.space))
                } else {
                    VStack(alignment: .leading, spacing: WidgetLayout.gap) {
                        ForEach(widgets) { w in card(w, nil) }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .onGeometryChange(for: Double.self) { Double($0.size.width) } action: { model.width = $0 }
        }
        .onChange(of: editing) { _, now in
            guard !now else { return }
            model.setUndoable(nil)
            model.confirmingReset = false
        }
        .onChange(of: focused) { old, _ in if old != nil { finishKeys() } }
    }

    private static var space: String { "widgetArea" }

    // MARK: Writes

    private func run(_ write: LayoutWrite, undo: LayoutWrite, animate: Bool, undoing: Bool = false) {
        model.run(write, undo: undo, animate: animate, undoing: undoing, loader: loader, reduceMotion: reduceMotion)
    }

    private func commit(_ before: [WidgetFrame], _ after: [WidgetFrame], animate: Bool = false) {
        guard let r = WidgetLayout.framesWrite(stored, before, after) else { return }
        run(r.write, undo: r.undo, animate: animate)
    }

    // MARK: Toolbar

    private func toolbar(_ frames: [WidgetFrame]) -> some View {
        HStack(spacing: 8) {
            Button("Align") { commit(frames, WidgetLayout.alignTwelfths(frames, width), animate: true) }
                .help(Text("Move every edge to the nearest twelfth of the width and even out row heights that are close"))
            Toggle(isOn: Binding(get: { align == .center }, set: { on in
                run(LayoutWrite(widgetAlign: on ? .center : .start), undo: LayoutWrite(widgetAlign: align), animate: true)
            })) { Text("Center") }
                .toggleStyle(.button)
                .help(Text("Center rows that do not fill the width"))
            Button("Split evenly") { commit(frames, WidgetLayout.splitEvenly(frames), animate: true) }
                .help(Text("Give the cards of every row equal widths and every row the same height"))
            if model.confirmingReset {
                Text("Return every card on this screen to its default size?").font(.callout).foregroundStyle(Theme.text)
                Button("Cancel") { model.confirmingReset = false }
                Button("Reset", role: .destructive) { reset() }.buttonStyle(.borderedProminent).tint(Theme.danger)
            } else {
                Button("Reset") { model.confirmingReset = true }
                    .disabled(!widgets.contains { $0.storedFrame != nil })
                    .help(Text("Return every card on this screen to its default size"))
            }
            if let error = model.error {
                Text(verbatim: error).font(.callout).foregroundStyle(Theme.danger).lineLimit(2)
            }
            Spacer(minLength: 0)
            if let u = model.undoable {
                Button { run(u.undo, undo: u.redo, animate: true, undoing: true) } label: { Label("Undo", systemImage: "arrow.uturn.backward") }
            }
        }
        .buttonStyle(.bordered)
        .controlSize(.regular)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("Widget layout"))
    }

    private func reset() {
        model.confirmingReset = false
        let framed = widgets.filter { $0.storedFrame != nil }
        guard !framed.isEmpty else { return }
        var write: [String: WidgetFrame?] = [:], frames: [String: WidgetFrame?] = [:], sizes: [String: String] = [:]
        for w in framed {
            write[w.id] = .some(nil)
            frames[w.id] = w.storedFrame
            sizes[w.id] = w.size ?? "1x1"
        }
        run(LayoutWrite(frames: write), undo: LayoutWrite(frames: frames, sizes: sizes), animate: true)
    }

    // MARK: Handles

    @ViewBuilder private func handles(_ i: Int, _ b: WidgetBox, frames: [WidgetFrame], placed: WidgetPlaced) -> some View {
        let size = "\(Int(b.width.rounded())) × \(Int(b.height.rounded()))"
        // The right edge: 14 wide over the card's border, between its head and its corner.
        handle(i, .x, label: "Width: drag, or Left and Right arrows (8 points, Shift for 1). Shift-drag re-flows the cards after it; hold Option to stop snapping", value: size) {
            EdgeMark(vertical: true, on: model.active?.index == i || focused == WidgetHandleID(index: i, edge: .x))
        }
        .frame(width: 14, height: max(b.height - 36, 8))
        .offset(x: b.x + b.width - 4, y: b.y + 14)
        handle(i, .y, label: "Row height: drag, or Up and Down arrows (8 points, Shift for 1); hold Option to stop snapping", value: size) {
            EdgeMark(vertical: false, on: model.active?.index == i || focused == WidgetHandleID(index: i, edge: .y))
        }
        .frame(width: max(b.width - 36, 8), height: 14)
        .offset(x: b.x + 14, y: b.y + b.height - 4)
        handle(i, .xy, label: "Width and height: drag, or the arrow keys (8 points, Shift for 1); hold Option to stop snapping", value: size) {
            CornerGrip(on: model.active?.index == i || focused == WidgetHandleID(index: i, edge: .xy))
        }
        .frame(width: 22, height: 22)
        .offset(x: b.x + b.width - 28, y: b.y + b.height - 28)
    }

    private func handle<Mark: View>(_ i: Int, _ edge: WidgetEdge, label: LocalizedStringKey, value: String, @ViewBuilder mark: () -> Mark) -> some View {
        mark()
            .contentShape(Rectangle())
            .onHover { inside in ResizeCursor.hover(edge, inside: inside, dragging: model.active != nil) }
            .gesture(drag(i, edge))
            .focusable()
            .focused($focused, equals: WidgetHandleID(index: i, edge: edge))
            .onKeyPress(keys: [.leftArrow, .rightArrow, .upArrow, .downArrow], phases: [.down, .repeat]) { press in
                key(i, edge, press) ? .handled : .ignored
            }
            .help(Text(label))
            .accessibilityElement()
            .accessibilityLabel(Text(label))
            .accessibilityValue(Text(verbatim: value))
            .accessibilityAdjustableAction { direction in
                let step: Double = direction == .increment ? 8 : -8
                let placed = WidgetLayout.place(frames, width, align)
                let b = placed.boxes[i]
                var f = frames
                if edge != .y { f = WidgetLayout.setWidth(f, width, i, b.width + step) }
                if edge != .x { f = WidgetLayout.setRowHeight(f, i, b.height + step) }
                commit(frames, f)
            }
    }

    /// Dragging an edge: the width through `setWidth` (the boundary with the next card, or the row's
    /// free space; Shift re-flows), the height sets the row's; both snap unless Option is held.
    private func drag(_ i: Int, _ edge: WidgetEdge) -> some Gesture {
        DragGesture(minimumDistance: 1, coordinateSpace: .named(Self.space))
            .onChanged { value in
                if model.dragBase == nil {
                    let base = frames
                    model.dragBase = (base, WidgetLayout.place(base, width, align))
                    model.active = WidgetHandleID(index: i, edge: edge)
                }
                let r = at(i, edge, value.translation)
                var t = Transaction()
                t.disablesAnimations = true
                withTransaction(t) {
                    model.live = r.frames
                    model.guides = r.guides.isEmpty ? nil : r.guides
                }
            }
            .onEnded { value in
                guard let base = model.dragBase else { return }
                let r = at(i, edge, value.translation)
                var t = Transaction()
                t.disablesAnimations = true
                withTransaction(t) {
                    model.live = nil
                    model.guides = nil
                    model.active = nil
                    model.dragBase = nil
                }
                commit(base.frames, r.frames)
                ResizeCursor.dragEnded()
            }
    }

    /// The frames and guides for a drag `d` from where it began (src/web/WidgetArea.tsx `at`).
    private func at(_ i: Int, _ edge: WidgetEdge, _ d: CGSize) -> (frames: [WidgetFrame], guides: WidgetGuides) {
        guard let start = model.dragBase else { return (frames, WidgetGuides()) }
        let base = start.frames, p0 = start.placed
        let flags = NSEvent.modifierFlags
        let reflow = flags.contains(.shift), noSnap = flags.contains(.option)
        let W = width
        let b0 = p0.boxes[i]
        let row = p0.rows[b0.row]
        let off0 = p0.boxes[row[0]].x
        let last = row.last == i
        var f = base
        var snappedX = false
        var snappedH: Double?
        if edge != .y {
            let dx = Double(d.width)
            var want: Double
            if (last || reflow) && align == .center {
                // A centred row whose width changes keeps its middle: its right end moves half as far as
                // the card grows, so the card grows twice the pointer's travel and snaps on the area's own lines.
                want = b0.width + 2 * dx
                if !noSnap {
                    let used0 = WidgetLayout.rowWidth(base, row, W)
                    let used = used0 + 2 * dx
                    let options = WidgetLayout.absoluteEdges(p0, i).map { 2 * $0 - W } + WidgetLayout.divisions.map { WidgetLayout.px($0, W) }
                    if let s = WidgetLayout.snap(used, options, within: 2 * WidgetLayout.snapDistance) {
                        want = b0.width + (s - used0)
                        snappedX = true
                    }
                }
            } else {
                want = b0.width + dx
                if !noSnap {
                    let left = b0.x - off0
                    if let s = WidgetLayout.snap(left + want, WidgetLayout.edgeCandidates(p0, W, i)) {
                        want = s - left
                        snappedX = true
                    }
                }
            }
            f = WidgetLayout.setWidth(f, W, i, want, reflow: reflow)
        }
        if edge != .x {
            var h = b0.height + Double(d.height)
            if !noSnap, let s = WidgetLayout.snap(h, WidgetLayout.heightCandidates(p0, i)) {
                h = s
                snappedH = s
            }
            f = WidgetLayout.setRowHeight(f, i, h)
        }
        let p = WidgetLayout.place(f, W, align)
        let b = p.boxes[i]
        var g = WidgetGuides()
        if snappedX { g.x.append(b.x + b.width) }
        if let snappedH {
            g.y.append(b.y + b.height)
            for r in p.rows {
                let rb = p.boxes[r[0]]
                if rb.row != b.row && rb.height == snappedH { g.y.append(rb.y + rb.height) }
            }
        }
        return (f, g)
    }

    /// The handles from the keyboard: 8 points a press, 1 with Shift; saved once the keys rest or the focus leaves.
    private func key(_ i: Int, _ edge: WidgetEdge, _ press: KeyPress) -> Bool {
        let step: Double = press.modifiers.contains(.shift) ? 1 : 8
        var dx = 0.0, dy = 0.0
        switch press.key {
        case .rightArrow where edge != .y: dx = step
        case .leftArrow where edge != .y: dx = -step
        case .downArrow where edge != .x: dy = step
        case .upArrow where edge != .x: dy = -step
        default: return false
        }
        let run = model.keyRun ?? (frames, frames)
        let b = WidgetLayout.place(run.frames, width, align).boxes[i]
        var f = run.frames
        if dx != 0 { f = WidgetLayout.setWidth(f, width, i, b.width + dx) }
        if dy != 0 { f = WidgetLayout.setRowHeight(f, i, b.height + dy) }
        model.keyRun = (run.base, f)
        model.live = f
        model.active = WidgetHandleID(index: i, edge: edge)
        model.keyTask?.cancel()
        model.keyTask = Task {
            try? await Task.sleep(for: .milliseconds(700))
            guard !Task.isCancelled else { return }
            finishKeys()
        }
        return true
    }

    private func finishKeys() {
        guard let run = model.keyRun else { return }
        model.keyTask?.cancel()
        model.keyRun = nil
        model.live = nil
        model.active = nil
        commit(run.base, run.frames)
    }

    // MARK: Guides

    private func guides(_ g: WidgetGuides, height: Double) -> some View {
        ZStack(alignment: .topLeading) {
            ForEach(Array(g.x.enumerated()), id: \.offset) { _, x in
                Rectangle().fill(Theme.accent).frame(width: 1, height: height + 24)
                    .shadow(color: Theme.accent, radius: 3)
                    .offset(x: x - 0.5, y: -12)
            }
            ForEach(Array(g.y.enumerated()), id: \.offset) { _, y in
                Rectangle().fill(Theme.accent).frame(width: max(width + 24, 0), height: 1)
                    .shadow(color: Theme.accent, radius: 3)
                    .offset(x: -12, y: y - 0.5)
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// The short bar in the middle of an edge handle: faint, full while dragged or focused or under the pointer.
private struct EdgeMark: View {
    let vertical: Bool
    let on: Bool
    @State private var hovering = false

    var body: some View {
        ZStack {
            Capsule().fill(Theme.accent)
                .frame(width: vertical ? 4 : 40, height: vertical ? 40 : 4)
                .opacity(on || hovering ? 1 : 0.45)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onHover { hovering = $0 }
    }
}

/// The corner grip: two short diagonal strokes in the accent.
private struct CornerGrip: View {
    let on: Bool

    var body: some View {
        Canvas { ctx, size in
            for k in [0.55, 0.75] {
                var p = Path()
                p.move(to: CGPoint(x: size.width * k, y: size.height - 3))
                p.addLine(to: CGPoint(x: size.width - 3, y: size.height * k))
                ctx.stroke(p, with: .color(Theme.accent), style: StrokeStyle(lineWidth: 2, lineCap: .round))
            }
        }
        .opacity(on ? 1 : 0.8)
    }
}

/// The resize cursors over the handles, kept while a drag goes on outside the handle.
@MainActor
enum ResizeCursor {
    private static var pushed = false
    private static var outsideWhileDragging = false

    static func cursor(_ edge: WidgetEdge) -> NSCursor {
        switch edge {
        case .x: return .resizeLeftRight
        case .y: return .resizeUpDown
        case .xy:
            if #available(macOS 15.0, *) { return .frameResize(position: .bottomRight, directions: .all) }
            return .crosshair
        }
    }

    static func hover(_ edge: WidgetEdge, inside: Bool, dragging: Bool) {
        if inside {
            outsideWhileDragging = false
            if !pushed { cursor(edge).push(); pushed = true }
        } else if dragging {
            outsideWhileDragging = true
        } else if pushed {
            NSCursor.pop()
            pushed = false
        }
    }

    static func dragEnded() {
        guard outsideWhileDragging, pushed else { return }
        NSCursor.pop()
        pushed = false
        outsideWhileDragging = false
    }
}
