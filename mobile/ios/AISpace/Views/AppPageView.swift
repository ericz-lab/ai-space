import SwiftUI

/// A stable cover lets the selected tab change without dismissing the browser.
struct AppBrowserView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        if let page = model.page {
            AppPageView(model: model, page: page, session: page.session, screens: model.screens)
                .id(page.id)
        }
    }
}

struct AppPageView: View {
    @ObservedObject var model: AppModel
    let page: OpenPage
    @ObservedObject var session: WebSession
    @ObservedObject var screens: ScreenStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
    @State private var menuOpen = false
    @AppStorage("pageControlPlacement") private var storedPlacement = PageControlPlacement().stored
    /// The button's centre while a finger is moving it.
    @State private var dragCenter: CGPoint?

    private var controlsVisible: Bool { menuOpen || voiceOver || !session.controlsHidden || session.state.isFailure }

    var body: some View {
        VStack(spacing: 0) {
            // Named once its page is there to be read, not while its redirects pass.
            if session.hasContent, !session.showsSpacePage, let host = session.currentURL?.host {
                SignInBar(host: host)
            }
            ZStack {
                Color(uiColor: session.pageBackground)
                // The page runs to the screen's bottom edge; WebKit keeps the end of the page
                // and its fixed bars above the home indicator.
                WebContainer(session: session)
                    .ignoresSafeArea(.container, edges: .bottom)
                    .opacity(session.state.isFailure ? 0 : 1)
                WebFailure(session: session)
                if !session.hasContent, !session.state.isFailure {
                    // Reaching the app, through its access layer when it has one, draws nothing
                    // in the web view; the mark stands in until a page does.
                    VStack(spacing: 14) {
                        ConnectingMark()
                        Text("Connecting…").font(.subheadline).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Theme.ground.ignoresSafeArea())
                    .accessibilityElement(children: .combine)
                    .transition(.opacity)
                }
            }
        }
        .overlay(alignment: .top) {
            ProgressView(value: session.progress).progressViewStyle(.linear).tint(Theme.accent)
                .opacity(session.isLoading ? 1 : 0).frame(height: 2)
        }
        .overlay {
            GeometryReader { geometry in
                let size = geometry.size
                let placement = PageControlPlacement(stored: storedPlacement)
                let rest = placement.center(in: size)
                let above = placement.menuAbove(in: size)
                let room = placement.menuRoom(in: size)
                let alignment = Alignment(horizontal: placement.side == .left ? .leading : .trailing,
                                          vertical: above ? .bottom : .top)
                ZStack {
                    if menuOpen {
                        Color.black.opacity(0.12).ignoresSafeArea()
                            .onTapGesture { menuOpen = false }
                            .accessibilityLabel(Text("Dismiss page controls"))
                        menu
                            .frame(maxWidth: 440)
                            .frame(maxHeight: room.height, alignment: above ? .bottom : .top)
                            .padding(.horizontal, PageControlPlacement.sideMargin)
                            .padding(above ? .bottom : .top, room.inset)
                            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: alignment)
                            .transition(.move(edge: above ? .bottom : .top).combined(with: .opacity))
                    }
                    roundIcon("ellipsis")
                        .scaleEffect(dragCenter == nil ? 1 : 1.08)
                        .onTapGesture { menuOpen.toggle() }
                        .gesture(drag(from: rest, in: size))
                        .accessibilityLabel(Text("Page controls"))
                        .accessibilityValue(menuOpen ? Text("Expanded") : Text("Collapsed"))
                        .accessibilityAddTraits(.isButton)
                        .accessibilityAction(named: Text("Move to Other Side")) { storedPlacement = placement.opposite.stored }
                        .position(dragCenter ?? rest)
                        // A hidden button leaves over the edge it rests against.
                        .offset(x: controlsVisible ? 0 : (placement.side == .left ? -96 : 96))
                        .opacity(controlsVisible ? 1 : 0)
                        .allowsHitTesting(controlsVisible)
                        .accessibilityHidden(!controlsVisible)
                }
            }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: controlsVisible)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: menuOpen)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.25), value: session.hasContent)
        .background(Color(uiColor: session.pageBackground).ignoresSafeArea())
        .ignoresSafeArea(.keyboard, edges: .bottom)
        .modifier(DownloadOutcome(session: session))
        .onAppear {
            session.showControls()
            #if DEBUG
            menuOpen = ProcessInfo.processInfo.environment["AISPACE_APP_MENU"] == "1"
            #endif
        }
    }

    /// The button follows the finger, then snaps to the nearer edge at the height it was let go.
    private func drag(from rest: CGPoint, in size: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 8, coordinateSpace: .global)
            .onChanged { value in
                menuOpen = false
                dragCenter = PageControlPlacement.clamped(
                    CGPoint(x: rest.x + value.translation.width, y: rest.y + value.translation.height), in: size)
            }
            .onEnded { value in
                // The predicted end lets a flick carry the button across the page.
                let end = CGPoint(x: rest.x + value.predictedEndTranslation.width,
                                  y: rest.y + value.predictedEndTranslation.height)
                withAnimation(reduceMotion ? nil : .spring(response: 0.32, dampingFraction: 0.78)) {
                    storedPlacement = PageControlPlacement.settled(at: end, in: size).stored
                    dragCenter = nil
                }
            }
    }

    private func roundIcon(_ symbol: String) -> some View {
        Image(systemName: symbol)
            .font(.system(size: 22, weight: .semibold))
            .foregroundStyle(.primary)
            .frame(width: PageControlPlacement.diameter, height: PageControlPlacement.diameter)
            .background(.regularMaterial, in: Circle())
            .overlay(Circle().strokeBorder(.primary.opacity(0.12)))
            .shadow(color: .black.opacity(0.16), radius: 8, y: 3)
            .contentShape(Circle())
    }

    private var menu: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(verbatim: page.title).font(.headline)
                        Text(verbatim: session.currentURL?.host ?? session.home.host ?? "")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    HStack(spacing: 24) {
                        Button { session.webView.goBack(); menuOpen = false } label: { Label("Back", systemImage: "chevron.backward") }
                            .disabled(!session.canGoBack)
                        Button { session.webView.goForward(); menuOpen = false } label: { Label("Forward", systemImage: "chevron.forward") }
                            .disabled(!session.canGoForward)
                        Spacer(minLength: 0)
                        if session.isLoading {
                            Button { session.stop(); menuOpen = false } label: { Label("Stop", systemImage: "xmark.circle") }
                        } else {
                            Button { session.reload(); menuOpen = false } label: { Label("Reload", systemImage: "arrow.clockwise") }
                        }
                    }
                    .labelStyle(.iconOnly).font(.title2).frame(minHeight: 44)
                    Divider()
                    Button { menuOpen = false; model.returnToSpace() } label: { Label("Return to Space", systemImage: "house").frame(maxWidth: .infinity, alignment: .leading) }
                    ShareLink(item: session.shareURL) { Label("Share", systemImage: "square.and.arrow.up").frame(maxWidth: .infinity, alignment: .leading) }
                    Button { model.openInBrowser(session.shareURL); menuOpen = false } label: { Label("Open in Safari", systemImage: "safari").frame(maxWidth: .infinity, alignment: .leading) }
                    if let key = page.key, let connection = model.store.connection(page.connection) {
                        Button {
                            model.togglePin(key, screen: Screens.home, in: connection)
                            menuOpen = false
                        } label: {
                            if screens.isPinned(key, page.connection) { Label("Remove from Panel", systemImage: "checkmark.rectangle.stack.fill") }
                            else { Label("Add to Panel", systemImage: "plus.rectangle.on.rectangle") }
                        }
                    }
                    Button(role: .destructive) { model.closeTab(page.id) } label: { Label("Close Tab", systemImage: "xmark") }
                }
                .padding(20)
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(maxHeight: 380)
            Divider()
            VStack(alignment: .leading, spacing: 10) {
                Text("Open Tabs").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                ScrollView(.horizontal) {
                    HStack(spacing: 10) {
                        ForEach(model.appTabs.filter { $0.connection == page.connection }) { tab in
                            HStack(spacing: 0) {
                                Button { menuOpen = false; model.showTab(tab.id) } label: {
                                    Label { Text(verbatim: tab.title).lineLimit(1) } icon: {
                                        if let connection = model.store.connection(tab.connection) {
                                            AppTabIcon(tab: tab, loader: model.loader(for: connection), icons: model.icons(for: connection))
                                        } else {
                                            Image(systemName: "globe")
                                        }
                                    }
                                    .padding(.leading, 12).padding(.trailing, 8).frame(minHeight: 44)
                                }
                                .accessibilityAddTraits(tab.id == page.id ? .isSelected : [])
                                Button { model.closeTab(tab.id) } label: {
                                    Image(systemName: "xmark").frame(width: 44, height: 44)
                                }
                                .accessibilityLabel(Text("Close Tab") + Text(verbatim: ": " + tab.title))
                            }
                            .frame(maxWidth: 260)
                            .background(tab.id == page.id ? Theme.accent.opacity(0.16) : Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 14))
                        }
                    }
                }
                .scrollIndicators(.hidden)
            }
            .padding(16)
        }
        .buttonStyle(.plain)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 24))
        .overlay(RoundedRectangle(cornerRadius: 24).strokeBorder(.primary.opacity(0.12)))
        .shadow(color: .black.opacity(0.15), radius: 18, y: 4)
    }
}

/// Resolve the logo from the tab's own Space and follow catalogue and icon refreshes.
private struct AppTabIcon: View {
    let tab: OpenPage
    @ObservedObject var loader: CatalogueLoader
    let icons: IconStore

    var body: some View {
        let entry = tab.key.flatMap { loader.catalogue?.entry($0) }
        EntryIcon(icon: entry?.icon, fallback: "globe", icons: icons, size: 24,
                  isRound: entry?.kind == .agent)
    }
}
