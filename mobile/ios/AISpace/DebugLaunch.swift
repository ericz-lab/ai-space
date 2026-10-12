#if DEBUG
import SwiftUI
import UIKit
import WebKit

/// Launch-time switches for checking screens without touching the device, read from the
/// environment of a debug build only (`simctl launch` and `open --env` can set them):
///   AISPACE_DATA_DIR   keep saved Spaces and favourites there instead of the app's own folders
///   AISPACE_CONNECT    add this Space on a first launch
///   AISPACE_TAB        home | panel | settings
///   AISPACE_SEARCH     the search text on Home
///   AISPACE_OPEN_URL   an aispace:// link, handled as if another app had opened it
///   AISPACE_FAVORITE   entry keys to favourite, comma separated
///   AISPACE_SIGN_OUT   1 signs the selected Space out after the screen is up
///   AISPACE_LOG_EXTERNAL 1 logs the addresses that would go to Safari instead of opening them
///   AISPACE_PAGE_JS    a script to run in the open app page three seconds after launch
///   AISPACE_STYLE      light | dark, whatever the system uses
///   AISPACE_SNAPSHOT   write a PNG of the window there after AISPACE_SNAPSHOT_DELAY seconds, then quit
enum DebugLaunch {
    @MainActor private static var applied = false

    @MainActor static func apply(to model: AppModel) {
        guard !applied else { return }
        applied = true
        let env = ProcessInfo.processInfo.environment
        if let address = env["AISPACE_CONNECT"], model.store.connections.isEmpty, let url = try? ConnectionRules.normalize(address) {
            model.add(name: env["AISPACE_CONNECT_NAME"] ?? "", url: url)
        }
        if let keys = env["AISPACE_FAVORITE"], let c = model.selected {
            for key in keys.split(separator: ",").map(String.init) where !model.favorites.isFavorite(key, c.id) {
                model.favorites.toggle(key, c.id)
            }
        }
        if let text = env["AISPACE_SEARCH"] { model.query = text }
        switch env["AISPACE_TAB"] {
        case "panel": model.tab = .panel
        case "settings": model.tab = .settings
        default: break
        }
        if env["AISPACE_LOG_EXTERNAL"] == "1" {
            model.openInBrowser = { NSLog("ai-space: to the browser %@", $0.absoluteString) }
        }
        if let js = env["AISPACE_PAGE_JS"] {
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                model.page?.session.webView.evaluateJavaScript(js) { _, error in
                    if let error { NSLog("ai-space: page script failed: %@", error.localizedDescription) }
                }
            }
        }
        if let text = env["AISPACE_OPEN_URL"], let url = URL(string: text) { model.handle(url) }
        if env["AISPACE_SIGN_OUT"] == "1", let c = model.selected {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { model.signOut(c) }
        }
        if let style = env["AISPACE_STYLE"] {
            for window in UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).flatMap(\.windows) {
                window.overrideUserInterfaceStyle = style == "dark" ? .dark : .light
            }
        }
        if let path = env["AISPACE_SNAPSHOT"] {
            let delay = Double(env["AISPACE_SNAPSHOT_DELAY"] ?? "") ?? 5
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                Task { @MainActor in
                    await snapshot(to: URL(fileURLWithPath: path))
                    exit(0)
                }
            }
        }
    }

    /// The window as drawn, with each web view's own snapshot laid over its frame (a web view's
    /// content is composited out of process and is missing from the window's drawing).
    @MainActor private static func snapshot(to file: URL) async {
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        guard let window = windows.first(where: \.isKeyWindow) ?? windows.first else { return }
        var webShots: [(CGRect, UIImage)] = []
        for web in webViews(in: window) where web.alpha > 0.5 && !web.isHidden && web.bounds.width > 100 {
            let frame = web.convert(web.bounds, to: window)
            NSLog("ai-space: page %@ back=%d loading=%d", web.url?.absoluteString ?? "-", web.canGoBack ? 1 : 0, web.isLoading ? 1 : 0)
            if let image = await shot(of: web) { webShots.append((frame, image)) }
        }
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            for w in windows.sorted(by: { $0.windowLevel < $1.windowLevel }) {
                w.drawHierarchy(in: w.bounds, afterScreenUpdates: true)
            }
            for (frame, shot) in webShots { shot.draw(in: frame) }
        }
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? image.pngData()?.write(to: file)
        NSLog("ai-space: snapshot %@", file.path)
    }

    /// A web view in a window that is not on screen may never answer; give up after a while.
    @MainActor private static func shot(of web: WKWebView) async -> UIImage? {
        await withCheckedContinuation { continuation in
            var done = false
            let finish: (UIImage?) -> Void = { image in
                guard !done else { return }
                done = true
                continuation.resume(returning: image)
            }
            web.takeSnapshot(with: nil) { image, _ in finish(image) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) { finish(nil) }
        }
    }

    @MainActor private static func webViews(in view: UIView) -> [WKWebView] {
        var out: [WKWebView] = []
        if let web = view as? WKWebView { out.append(web) }
        for sub in view.subviews { out += webViews(in: sub) }
        // A presented controller's views live in the same window, under its transition view.
        return out
    }
}
#endif
