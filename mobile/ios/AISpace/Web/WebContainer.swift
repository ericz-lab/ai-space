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

/// The system share sheet for a downloaded file.
struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
