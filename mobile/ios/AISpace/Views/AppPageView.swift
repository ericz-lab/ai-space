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

    private var controlsVisible: Bool { menuOpen || voiceOver || !session.controlsHidden || session.state.isFailure }

    var body: some View {
        VStack(spacing: 0) {
            if !session.showsSpacePage, let host = session.currentURL?.host {
                SignInBar(host: host)
            }
            ZStack {
                Theme.ground
                WebContainer(session: session)
                    .opacity(session.state.isFailure ? 0 : 1)
                WebFailure(session: session)
            }
        }
        .overlay(alignment: .top) {
            ProgressView(value: session.progress).progressViewStyle(.linear).tint(Theme.accent)
                .opacity(session.isLoading ? 1 : 0).frame(height: 2)
        }
        .overlay {
            GeometryReader { geometry in
                ZStack(alignment: .bottom) {
                    if menuOpen {
                        Color.black.opacity(0.12).ignoresSafeArea()
                            .onTapGesture { menuOpen = false }
                            .accessibilityLabel(Text("Dismiss page controls"))
                    }
                    VStack(spacing: 12) {
                        if menuOpen {
                            menu
                                .frame(maxWidth: 440)
                                .frame(maxHeight: max(120, geometry.size.height - 92), alignment: .bottom)
                                .transition(.move(edge: .bottom).combined(with: .opacity))
                        }
                        HStack {
                            Button { model.returnToSpace() } label: {
                                roundIcon("house")
                            }
                            .accessibilityLabel(Text("Return to Space"))
                            Spacer()
                            Button { menuOpen.toggle() } label: {
                                roundIcon("ellipsis")
                            }
                            .accessibilityLabel(Text("Page controls"))
                            .accessibilityValue(menuOpen ? Text("Expanded") : Text("Collapsed"))
                        }
                        .buttonStyle(.plain)
                        .opacity(controlsVisible ? 1 : 0)
                        .offset(y: controlsVisible ? 0 : 76)
                        .allowsHitTesting(controlsVisible)
                        .accessibilityHidden(!controlsVisible)
                    }
                    .padding(.horizontal, 20)
                    .padding(.bottom, 12)
                }
            }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: controlsVisible)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: menuOpen)
        .background(Theme.ground.ignoresSafeArea())
        .ignoresSafeArea(.keyboard, edges: .bottom)
        .modifier(DownloadOutcome(session: session))
        .onAppear {
            session.showControls()
            #if DEBUG
            menuOpen = ProcessInfo.processInfo.environment["AISPACE_APP_MENU"] == "1"
            #endif
        }
    }

    private func roundIcon(_ symbol: String) -> some View {
        Image(systemName: symbol)
            .font(.system(size: 22, weight: .semibold))
            .foregroundStyle(.primary)
            .frame(width: 56, height: 56)
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
                                        Image(systemName: tab.id == page.id ? "checkmark.circle.fill" : "globe")
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
