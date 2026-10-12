import SwiftUI
import WebKit

/// Hosts a session's web view. The view belongs to the session, not to SwiftUI, so it keeps its
/// page while tabs switch and the content is rebuilt.
struct WebContainer: UIViewRepresentable {
    let session: WebSession

    func makeUIView(context: Context) -> UIView {
        let container = UIView()
        attach(to: container)
        return container
    }

    func updateUIView(_ container: UIView, context: Context) {
        if session.webView.superview !== container { attach(to: container) }
    }

    private func attach(to container: UIView) {
        let web = session.webView
        container.subviews.filter { $0 !== web }.forEach { $0.removeFromSuperview() }
        web.removeFromSuperview()
        web.frame = container.bounds
        web.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        container.addSubview(web)
        session.start()
    }
}

/// What a page's download ends in, on whichever screen shows the page: the share sheet for the
/// file, or a word on why there is none.
struct DownloadOutcome: ViewModifier {
    @ObservedObject var session: WebSession

    func body(content: Content) -> some View {
        content
            .sheet(isPresented: Binding(get: { session.downloaded != nil }, set: { if !$0 { session.downloaded = nil } })) {
                if let file = session.downloaded { ShareSheet(items: [file]) }
            }
            .alert(Text("Download failed"), isPresented: Binding(get: { session.downloadFailure != nil }, set: { if !$0 { session.downloadFailure = nil } })) {
                Button("OK") {}
            } message: {
                Text(verbatim: session.downloadFailure ?? "")
            }
    }
}

/// The system share sheet for a downloaded file.
struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
