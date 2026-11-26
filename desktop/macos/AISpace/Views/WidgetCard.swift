import Combine
import SwiftUI

/// The box a card is drawn in by the widget area (Views/WidgetArea.swift): its inner layout follows
/// the size class of that box, not the stored size, and its rows are paged to the room it has.
struct WidgetCardBox: Equatable {
    var sizeClass: String
    /// The card's size while the screen is arranged ("540 × 300").
    var readout: String?
    /// The card's edge is being dragged.
    var resizing = false
}

/// A message under a card's controls: what the app said after an action, or why it failed.
struct WidgetCardMessage: Equatable {
    var isError: Bool
    var text: String
}

/// A card's interactive state (src/web/Tiles.tsx `Widget`): the chosen view, one action at a time
/// with a check ticked while it is on the way, the in-card confirm, the field's text, a refresh, and
/// the values that changed since the last payload. View state lives in an object here, as elsewhere
/// in the Mac client.
@MainActor
final class WidgetCardModel: ObservableObject {
    struct Asking: Equatable {
        var action: WidgetAction
        var value: String?
    }

    @Published var viewID: String?
    @Published var busy: String?
    @Published var ticked: Set<String> = []
    @Published var message: WidgetCardMessage?
    @Published var asking: Asking?
    @Published var refreshing = false
    @Published var draft = ""
    @Published private(set) var flash: (key: String, value: BlockFlash)?
    private var previous: (key: String, blocks: [WidgetBlock])?
    private var messageTask: Task<Void, Never>?
    private var flashTask: Task<Void, Never>?

    /// A payload on show: when it is the same view's next one, the values that moved flash once.
    func observe(key: String, blocks: [WidgetBlock]?) {
        defer { previous = blocks.map { (key, $0) } }
        guard let blocks, let previous, previous.key == key, previous.blocks != blocks else { return }
        let marks = WidgetInteract.blockChanges(previous.blocks, blocks)
        guard marks.contains(where: { $0 != nil }) else { return }
        flash = (key, BlockFlash(n: (flash?.value.n ?? 0) + 1, marks: marks))
        flashTask?.cancel()
        // Cleared once played, so a later page of rows does not play it again.
        flashTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(1300))
            guard !Task.isCancelled else { return }
            self?.flash = nil
        }
    }

    func say(_ text: String, error: Bool) {
        message = WidgetCardMessage(isError: error, text: text)
        messageTask?.cancel()
        messageTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(error ? 6 : 4))
            guard !Task.isCancelled else { return }
            self?.message = nil
        }
    }

    /// Sends an action the payload declared, after the in-card confirm when it asks for one.
    func request(_ action: WidgetAction, value: String? = nil, widget: CatalogWidget, api: SpaceAPI, replace: @escaping (CatalogWidget) -> Void) {
        guard busy == nil, widget.declaredActions.contains(action.id) else { return }
        message = nil
        if action.confirm != nil {
            asking = Asking(action: action, value: value)
            return
        }
        send(action, value: value, widget: widget, api: api, replace: replace)
    }

    func answer(_ yes: Bool, widget: CatalogWidget, api: SpaceAPI, replace: @escaping (CatalogWidget) -> Void) {
        guard let a = asking else { return }
        asking = nil
        if yes { send(a.action, value: a.value, widget: widget, api: api, replace: replace) }
    }

    private func send(_ action: WidgetAction, value: String?, widget: CatalogWidget, api: SpaceAPI, replace: @escaping (CatalogWidget) -> Void) {
        if action.kind == .check { ticked.insert(action.id) }
        busy = action.id
        var body: [String: Any] = ["action": action.id]
        if let value { body["value"] = value }
        Task {
            let answer = await Self.post(api, widget, "action", body)
            busy = nil
            if action.kind == .check { ticked.remove(action.id) }
            switch answer {
            case .ok(let fresh, let said):
                replace(fresh)
                if action.kind == .input { draft = "" }
                if let text = said?.text(), !text.isEmpty { say(String(text.prefix(200)), error: false) }
            case .failed(let error):
                say(String(localized: "Failed: \(error)"), error: true)
            }
        }
    }

    func refresh(widget: CatalogWidget, api: SpaceAPI, replace: @escaping (CatalogWidget) -> Void) {
        guard !refreshing else { return }
        refreshing = true
        Task {
            let answer = await Self.post(api, widget, "refresh", [:])
            refreshing = false
            switch answer {
            case .ok(let fresh, _): replace(fresh)
            case .failed(let error): say(String(localized: "Failed: \(error)"), error: true)
            }
        }
    }

    /// `POST /api/widgets/:app/:name/action` or `/refresh`; a network or HTTP failure is a `.failed`.
    static func post(_ api: SpaceAPI, _ widget: CatalogWidget, _ what: String, _ body: [String: Any]) async -> WidgetAnswer {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        let app = widget.app.addingPercentEncoding(withAllowedCharacters: allowed) ?? widget.app
        let name = widget.name.addingPercentEncoding(withAllowedCharacters: allowed) ?? widget.name
        do {
            let r = try await api.answer("POST", "/api/widgets/\(app)/\(name)/\(what)", json: body)
            return WidgetAnswer.decode(status: r.status, data: r.data)
        } catch SpaceAPIError.authenticationRequired {
            return .failed(String(localized: "sign-in needed"))
        } catch {
            return .failed(error.localizedDescription)
        }
    }
}

/// A widget of the Space as a card: its state card when the app sends blocks, its latest rows
/// otherwise, as the Space last read them from the app. Against a Space with the widget
/// interactions (`stepless`) it also has the payload's views, copy and write-back controls, the
/// as-of time as a refresh control and paged rows; the controls respond only while `live` (not while
/// the screen is arranged, not in the library), and a peer's card has no write-back controls.
struct WidgetCard: View {
    let widget: CatalogWidget
    let icons: IconStore
    /// The Space's API, for the card's actions and refresh; nil draws none.
    let api: SpaceAPI?
    /// Puts the card the Space answered in place of this one.
    let replace: (CatalogWidget) -> Void
    let stepless: Bool
    let live: Bool
    /// The box the widget area draws the card in; nil for a card sized by its content.
    let box: WidgetCardBox?
    /// Opens a row's link, or the widget's own page for nil.
    let open: (String?) -> Void
    @StateObject private var model: WidgetCardModel

    /// `model` starts the card in a given state (a check on its way, a confirm, a message), for
    /// pictures of the card; the app passes none.
    @MainActor init(widget: CatalogWidget, icons: IconStore, api: SpaceAPI? = nil, replace: @escaping (CatalogWidget) -> Void = { _ in },
         stepless: Bool = false, live: Bool = true, box: WidgetCardBox? = nil,
         model: WidgetCardModel? = nil, open: @escaping (String?) -> Void) {
        self.widget = widget
        self.icons = icons
        self.api = api
        self.replace = replace
        self.stepless = stepless
        self.live = live
        self.box = box
        self.open = open
        _model = StateObject(wrappedValue: model ?? WidgetCardModel())
    }

    private var views: [WidgetViewDef]? { stepless ? widget.cardViews : nil }
    private var view: WidgetViewDef? {
        guard let views else { return nil }
        let id = model.viewID ?? WidgetViewChoice.load(widget.id, ids: views.map(\.id))
        return views.first { $0.id == id } ?? views.first
    }
    private var blocks: [WidgetBlock]? {
        guard widget.ok != false else { return nil }
        return view?.blocks ?? widget.blocks?.elements
    }
    private var viewKey: String { view?.id ?? "" }
    private var acts: Bool { stepless && widget.peer == nil && api != nil }
    private var actLive: Bool { acts && live }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            head
            if let views, let view { viewSwitch(views, chosen: view).padding(.horizontal, 16).padding(.top, 2).padding(.bottom, 4) }
            content
                .padding(.horizontal, 16).padding(.top, 6).padding(.bottom, hasFooter ? 8 : 14)
                .frame(maxHeight: box == nil ? nil : .infinity, alignment: .topLeading)
                .clipped()
            if hasFooter { footer.padding(.horizontal, 16).padding(.bottom, 14) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        // The panel's cards are borderless glass; colour inside a card is data.
        .glass(bordered: false)
        .overlay {
            if box?.resizing == true {
                RoundedRectangle(cornerRadius: Theme.radius + 4, style: .continuous).strokeBorder(Theme.accent, lineWidth: 2).padding(-4)
                    .allowsHitTesting(false)
            }
        }
        .opacity(widget.stale == true ? 0.6 : 1)
        .onChange(of: blocks, initial: true) { _, now in model.observe(key: viewKey, blocks: now) }
    }

    // MARK: Head

    private var head: some View {
        HStack(spacing: 10) {
            Button { open(nil) } label: {
                HStack(spacing: 10) {
                    EntryIcon(icon: widget.icon, fallback: "rectangle.3.group", icons: icons, size: 26)
                    Text(verbatim: Lang.pick(widget.title, widget.i18n, \.title)).font(.subheadline.weight(.medium)).foregroundStyle(.secondary).lineLimit(1)
                    if let peer = widget.peer { Text(verbatim: peer).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .layoutPriority(1)
            Spacer(minLength: 4)
            if stepless { asOf }
            if let readout = box?.readout {
                Text(verbatim: readout).font(.caption2.weight(.semibold)).monospacedDigit()
                    .foregroundStyle(box?.resizing == true ? AnyShapeStyle(Theme.accent) : AnyShapeStyle(.secondary))
                    .fixedSize()
            }
            Button { open(nil) } label: {
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHidden(true)
        }
        .padding(.horizontal, 16).padding(.top, 14).padding(.bottom, 4)
    }

    /// The time the Space last read the app; on a widget of this Space a click reads it again now.
    @ViewBuilder private var asOf: some View {
        if widget.ok != false, let iso = widget.asOf, let date = Times.parse(iso) {
            let outdated = WidgetLayout.isOutdated(asOf: iso, staleAfterMs: widget.staleAfterMs)
            let label = outdated ? String(localized: "Out of date · \(Times.ago(date))") : Times.ago(date)
            let text = Text(verbatim: label).font(.caption2.weight(outdated ? .semibold : .regular)).monospacedDigit()
                .foregroundStyle(outdated ? AnyShapeStyle(Theme.warning) : AnyShapeStyle(.tertiary))
            if acts, let api {
                Button { model.refresh(widget: widget, api: api, replace: replace) } label: {
                    RefreshLabel(text: text, busy: model.refreshing)
                }
                .buttonStyle(.plain)
                .disabled(!actLive)
                .help(Text(verbatim: "\(date.formatted(date: .abbreviated, time: .standard)) · \(String(localized: "Refresh now"))"))
                .accessibilityLabel(Text(verbatim: "\(label) · \(model.refreshing ? String(localized: "Refreshing…") : String(localized: "Refresh now"))"))
            } else {
                text.help(Text(verbatim: date.formatted(date: .abbreviated, time: .standard))).fixedSize()
            }
        }
    }

    private func viewSwitch(_ views: [WidgetViewDef], chosen: WidgetViewDef) -> some View {
        HStack(spacing: 2) {
            ForEach(views) { v in
                let on = v.id == chosen.id
                Button { choose(v.id) } label: {
                    Text(verbatim: v.label.text()).font(.caption.weight(.medium)).lineLimit(1)
                        .padding(.horizontal, 10).frame(minHeight: 22)
                        .foregroundStyle(on ? AnyShapeStyle(Theme.text) : AnyShapeStyle(.secondary))
                        .background(on ? Theme.text.opacity(0.1) : Color.clear, in: Capsule())
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .disabled(!live)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
        .padding(2)
        .background(Theme.text.opacity(0.04), in: Capsule())
        .focusable(live)
        .onKeyPress(keys: [.leftArrow, .rightArrow]) { press in
            guard live, let i = views.firstIndex(where: { $0.id == chosen.id }) else { return .ignored }
            choose(views[(i + (press.key == .rightArrow ? 1 : views.count - 1)) % views.count].id)
            return .handled
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("Views"))
    }

    private func choose(_ id: String) {
        model.viewID = id
        WidgetViewChoice.save(widget.id, view: id)
    }

    // MARK: Content

    private var ctx: BlockContext {
        var c = BlockContext(live: live, acts: acts, actLive: actLive, busy: model.busy, ticked: model.ticked)
        if let api {
            let widget = widget, replace = replace, model = model
            c.onAction = { a in model.request(a, widget: widget, api: api, replace: replace) }
        }
        return c
    }

    @ViewBuilder private var content: some View {
        if widget.ok == false {
            Label { Text(verbatim: widget.error ?? String(localized: "not answering")) } icon: { Image(systemName: "exclamationmark.circle") }
                .font(.callout).foregroundStyle(.secondary)
        } else if widget.kind == "embed" {
            Text("Drawn by the app. Open it to see.").font(.callout).foregroundStyle(.secondary)
        } else if let blocks, !blocks.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                WidgetBlocksView(blocks: blocks, size: box?.sizeClass ?? widget.size, paged: stepless, fit: box != nil, ctx: ctx,
                                 flash: model.flash?.key == viewKey ? model.flash?.value : nil, open: { open($0) })
                    .id(viewKey)
                    .frame(maxHeight: box == nil ? nil : .infinity, alignment: .topLeading)
                if widget.stale == true {
                    Text("Last known; its machine is offline.").font(.caption).foregroundStyle(.secondary)
                } else if !stepless, WidgetLayout.isOutdated(asOf: widget.asOf, staleAfterMs: widget.staleAfterMs), let date = widget.asOf.flatMap(Times.parse) {
                    Text("Updated \(Times.ago(date))").font(.caption).monospacedDigit().foregroundStyle(.tertiary)
                }
            }
        } else if let items = widget.items, !items.isEmpty {
            let tall = (box?.sizeClass ?? widget.size)?.hasSuffix("x2") == true
            VStack(alignment: .leading, spacing: 9) {
                ForEach(Array(items.prefix(tall ? 8 : 4).enumerated()), id: \.offset) { _, item in
                    Button { open(item.url) } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(verbatim: item.text).font(.callout).foregroundStyle(Theme.text).lineLimit(2).multilineTextAlignment(.leading)
                            Spacer(minLength: 8)
                            if let date = item.time.flatMap(Times.parse) {
                                Text(verbatim: Times.ago(date)).font(.caption).foregroundStyle(.secondary).lineLimit(1).layoutPriority(1)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                if widget.stale == true {
                    Text("Last known; its machine is offline.").font(.caption).foregroundStyle(.secondary)
                }
            }
        } else {
            Text("Nothing to show.").font(.callout).foregroundStyle(.secondary)
        }
    }

    // MARK: Footer

    private var cardActions: [WidgetAction] { acts ? widget.cardActions : [] }
    private var hasFooter: Bool { !cardActions.isEmpty || model.asking != nil || model.message != nil }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let asking = model.asking, let api {
                // Asked inside the card, never with a system alert; Esc says no.
                HStack(spacing: 6) {
                    Text(verbatim: asking.action.confirm?.text() ?? "").font(.callout).foregroundStyle(Theme.text)
                        .lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                    Button("Cancel") { model.answer(false, widget: widget, api: api, replace: replace) }
                        .buttonStyle(.bordered).controlSize(.small)
                    Button { model.answer(true, widget: widget, api: api, replace: replace) } label: { Text(verbatim: asking.action.label.text()) }
                        .buttonStyle(.borderedProminent).controlSize(.small)
                }
                .onExitCommand { model.answer(false, widget: widget, api: api, replace: replace) }
                .accessibilityElement(children: .contain)
                .accessibilityLabel(Text(verbatim: asking.action.confirm?.text() ?? ""))
            } else if !cardActions.isEmpty {
                HStack(spacing: 6) {
                    if let input = cardActions.first(where: { $0.kind == .input }) { field(input) }
                    ForEach(cardActions.filter { $0.kind == .button }, id: \.id) { a in
                        WidgetActionPill(action: a, ctx: ctx)
                    }
                }
            }
            if let message = model.message {
                Text(verbatim: message.text).font(.caption).foregroundStyle(message.isError ? AnyShapeStyle(Theme.danger) : AnyShapeStyle(.secondary))
                    .lineLimit(1).truncationMode(.tail)
                    .accessibilityAddTraits(.updatesFrequently)
            }
        }
    }

    /// One text field with its send button; the text stays when the action fails.
    private func field(_ input: WidgetAction) -> some View {
        let label = input.label.text()
        let text = String(model.draft.trimmingCharacters(in: .whitespacesAndNewlines).prefix(WidgetAction.maxValue))
        let submit = {
            guard let api, !text.isEmpty else { return }
            model.request(input, value: text, widget: widget, api: api, replace: replace)
        }
        return HStack(spacing: 6) {
            TextField(input.placeholder?.text() ?? label, text: $model.draft)
                .textFieldStyle(.plain)
                .font(.callout)
                .padding(.horizontal, 10).frame(minHeight: 26)
                .background(Theme.text.opacity(0.06), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .disabled(!actLive || model.busy != nil)
                .onSubmit(submit)
                .accessibilityLabel(Text(verbatim: label))
            Button(action: submit) {
                Group {
                    if model.busy == input.id { ProgressView().controlSize(.mini) } else { Image(systemName: "arrow.up").font(.system(size: 11, weight: .bold)) }
                }
                .frame(width: 26, height: 26)
                .foregroundStyle(Color.white)
                .background(Theme.accent.opacity(text.isEmpty ? 0.4 : 1), in: Circle())
                .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .disabled(!actLive || model.busy != nil || text.isEmpty)
            .help(Text(verbatim: label))
            .accessibilityLabel(Text(verbatim: label))
        }
        .frame(maxWidth: .infinity)
    }
}

/// The as-of time with the refresh mark beside it, shown under the pointer and while it reads again.
private struct RefreshLabel<Label: View>: View {
    let text: Label
    let busy: Bool
    @State private var hovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "arrow.clockwise").font(.system(size: 9, weight: .semibold)).foregroundStyle(.secondary)
                .rotationEffect(.degrees(busy && !reduceMotion ? 360 : 0))
                .animation(busy && !reduceMotion ? .linear(duration: 0.8).repeatForever(autoreverses: false) : .default, value: busy)
                .opacity(hovering || busy ? 1 : 0)
            text
        }
        .padding(.horizontal, 6).padding(.vertical, 2)
        .background(hovering ? Theme.text.opacity(0.07) : Color.clear, in: Capsule())
        .contentShape(Capsule())
        .onHover { hovering = $0 }
        .fixedSize()
    }
}
