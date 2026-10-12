import SwiftUI
import WebKit

/// Hosts a session's web view. The view belongs to the session, not to SwiftUI, so it survives
/// the window being hidden, the content being rebuilt and a tab moving to its own window.
/// The most recently made container owns the web view: a container on its way out (the main
/// window's tab while the page moves to a window) still gets updates, and must not take it back.
struct PanelWebView: NSViewRepresentable {
    let session: PanelSession

    func makeNSView(context: Context) -> NSView {
        let container = NSView()
        session.container = container
        attach(to: container)
        return container
    }

    func updateNSView(_ container: NSView, context: Context) {
        guard session.container === container, container.subviews.first !== session.webView else { return }
        attach(to: container)
    }

    static func dismantleNSView(_ container: NSView, coordinator: ()) {
        container.subviews.forEach { $0.removeFromSuperview() }
    }

    private func attach(to container: NSView) {
        let web = session.webView
        container.subviews.filter { $0 !== web }.forEach { $0.removeFromSuperview() }
        web.removeFromSuperview()
        web.frame = container.bounds
        web.autoresizingMask = [.width, .height]
        container.addSubview(web)
    }
}
