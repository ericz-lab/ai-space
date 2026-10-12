import SwiftUI

/// The Space's own web panel: chat with agents, the inbox, tasks and the Space's settings, as
/// the browser has them. It is also where a sign-in to the Space's access layer happens.
struct PanelView: View {
    @ObservedObject var model: AppModel
    let connection: Connection
    @ObservedObject var session: WebSession

    var body: some View {
        VStack(spacing: 0) {
            if !session.showsSpacePage, let host = session.currentURL?.host {
                SignInBar(host: host)
            }
            ZStack {
                Theme.ground.ignoresSafeArea()
                WebContainer(session: session)
                    .opacity(session.state.isFailure ? 0 : 1)
                WebFailure(session: session)
                if session.state == .connecting && session.currentURL == nil { ProgressView() }
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            ProgressView(value: session.progress).progressViewStyle(.linear).tint(Theme.accent)
                .opacity(session.isLoading ? 1 : 0).frame(height: 2)
        }
        .ignoresSafeArea(.keyboard, edges: .bottom)
        // The panel downloads too (a theme export, an attachment).
        .modifier(DownloadOutcome(session: session))
    }
}

/// Says whose page is on show while the view is off the Space, on an access layer's sign-in.
struct SignInBar: View {
    let host: String

    var body: some View {
        Label { Text("Signing in at \(host)") } icon: { Image(systemName: "person.badge.key.fill") }
            .font(.footnote).foregroundStyle(.secondary)
            .frame(maxWidth: .infinity).padding(.vertical, 6)
            .background(.bar)
    }
}

/// What a page shows in place of its content when it could not be loaded.
struct WebFailure: View {
    @ObservedObject var session: WebSession

    var body: some View {
        switch session.state {
        case .unreachable(let reason):
            ContentUnavailableView {
                Label("Cannot load this page", systemImage: "wifi.exclamationmark")
            } description: {
                Text(verbatim: reason)
            } actions: {
                Button("Retry") { session.reload() }.buttonStyle(.borderedProminent)
            }
        case .incompatible(let reason):
            ContentUnavailableView {
                Label("This address is not an ai-space panel", systemImage: "exclamationmark.triangle")
            } description: {
                Text(verbatim: reason)
            } actions: {
                Button("Retry") { session.reload() }.buttonStyle(.borderedProminent)
            }
        default:
            EmptyView()
        }
    }
}
