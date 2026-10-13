#if DEBUG
import SwiftUI
import UIKit
import WebKit

/// Launch-time switches for checking screens without touching the device, read from the
/// environment of a debug build only (`simctl launch` and `open --env` can set them):
///   AISPACE_DATA_DIR   keep saved Spaces and screens there instead of the app's own folders
///   AISPACE_CONNECT    add this Space on a first launch
///   AISPACE_TAB        home | panel | settings, or web for the Space's web panel over them
///   AISPACE_SCROLL_Y   scroll the visible native page to this offset for safe-area checks
///   AISPACE_SCROLL_BENCH seconds to drive the visible page up and down, then the pager across,
///                      logging the frames the main thread dropped (see ScrollBench)
///   AISPACE_SEARCH     the search text on Home
///   AISPACE_CHAT_SEND  with AISPACE_HUB=chat:<agent key>: this message is sent three seconds after launch
///   AISPACE_HUB        a page of the Space over the tabs: inbox | tasks | modelUsage | appUsage |
///                      appModels | events | packages | chat, or chat:<agent key> for one agent
///   AISPACE_OPEN_URL   an aispace:// link, handled as if another app had opened it
///   AISPACE_SCREEN     the screen on show on the Panel tab, by id
///   AISPACE_EDIT_SCREEN 1 opens the sheet that rearranges that screen
///   AISPACE_SCREEN_MENU 1 opens the actions a long press on a screen brings up
///   AISPACE_SIGN_OUT   1 signs the selected Space out after the screen is up
///   AISPACE_LOG_EXTERNAL 1 logs the addresses that would go to Safari instead of opening them
///   AISPACE_APP_MENU   1 expands the app browser menu for layout checks
///   AISPACE_PAGE_JS    a script to run in the open app page three seconds after launch
///   AISPACE_STYLE      light | dark, whatever the system uses
///   AISPACE_THEME      a theme's id, for this launch only
///   AISPACE_SNAPSHOT_BARE 1 leaves the pages' own content out of that PNG, to see what is drawn over them
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
        if let screen = env["AISPACE_SCREEN"] {
            model.pagerID = screen
            if env["AISPACE_EDIT_SCREEN"] == "1" { model.editingScreen = screen }
        }
        if env["AISPACE_SCREEN_MENU"] == "1" { model.showingScreenMenu = true }
        if let theme = env["AISPACE_THEME"] {
            // Drawn in it without keeping it: the saved choice is the operator's.
            let saved = UserDefaults.standard.string(forKey: "theme")
            model.themeID = theme
            UserDefaults.standard.set(saved, forKey: "theme")
        }
        if let text = env["AISPACE_SEARCH"] { model.query = text }
        if let message = env["AISPACE_CHAT_SEND"], let key = env["AISPACE_HUB"].flatMap({ $0.hasPrefix("chat:") ? String($0.dropFirst(5)) : nil }) {
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                guard let c = model.selected, let agent = model.loader(for: c).catalogue?.agents.first(where: { $0.key == key }),
                      let base = ChatRoute.base(ref: agent.ref, peer: agent.peer) else { return }
                let chat = model.chat(for: c, base: base)
                chat.draft = message
                chat.send()
            }
        }
        if let hub = env["AISPACE_HUB"] {
            let pages: [String: HubPage] = ["inbox": .inbox, "tasks": .tasks, "modelUsage": .modelUsage, "appUsage": .appUsage,
                                            "appModels": .appModels, "events": .events, "packages": .packages, "chat": .chat(agent: nil)]
            model.hubPage = hub.hasPrefix("chat:") ? .chat(agent: String(hub.dropFirst(5))) : pages[hub]
        }
        switch env["AISPACE_TAB"] {
        case "panel": model.tab = .panel
        case "settings": model.tab = .settings
        case "web": model.openWebPanel()
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
        if let offset = env["AISPACE_SCROLL_Y"].flatMap(Double.init) {
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
                for window in windows {
                    scrollVisiblePage(in: window, window: window, offset: CGFloat(offset))
                }
            }
        }
        if let seconds = env["AISPACE_SCROLL_BENCH"].flatMap(Double.init) {
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) { ScrollBench.run(seconds: seconds) }
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

    @MainActor private static func scrollVisiblePage(in view: UIView, window: UIWindow, offset: CGFloat) {
        if let scroll = view as? UIScrollView,
           scroll.contentSize.height > scroll.bounds.height + 100,
           scroll.bounds.height > 200,
           window.bounds.contains(scroll.convert(CGPoint(x: scroll.bounds.midX, y: scroll.bounds.midY), to: window)) {
            let maximum = scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom
            scroll.setContentOffset(CGPoint(x: scroll.contentOffset.x, y: min(maximum, offset)), animated: false)
        }
        for child in view.subviews { scrollVisiblePage(in: child, window: window, offset: offset) }
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
            // The shots cover whatever the app draws over a page; AISPACE_SNAPSHOT_BARE=1 leaves them out.
            if ProcessInfo.processInfo.environment["AISPACE_SNAPSHOT_BARE"] != "1" {
                for (frame, shot) in webShots { shot.draw(in: frame) }
            }
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

/// Scrolls the launcher by itself, as a finger would move it, so a profiler can be pointed at
/// the device without anyone touching it: the visible page up and down for the first half of
/// the time, then the pager from page to page. What it logs is the main thread's part only
/// (a late display link); frames the render server drops show in Instruments' Animation Hitches.
@MainActor
final class ScrollBench: NSObject {
    private static var running: ScrollBench?
    /// Points per second of the vertical sweep, about a brisk flick.
    private static let speed: CGFloat = 2400

    private let seconds: Double
    private var link: CADisplayLink?
    private var started: CFTimeInterval = 0
    private var last: CFTimeInterval = 0
    private struct Tally {
        var frames = 0, late = 0
        var lateTime: CFTimeInterval = 0, worst: CFTimeInterval = 0
    }
    private var vertical = Tally(), paging = Tally()
    private var direction: CGFloat = 1
    private var nextPage: CFTimeInterval = 0
    private var pageStep = 1
    private weak var page: UIScrollView?

    static func run(seconds: Double) {
        guard running == nil else { return }
        let bench = ScrollBench(seconds: seconds)
        running = bench
        bench.start()
    }

    private init(seconds: Double) { self.seconds = seconds }

    private func start() {
        let link = CADisplayLink(target: self, selector: #selector(tick))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 80, maximum: 120, preferred: 120)
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    private var window: UIWindow? {
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        return windows.first(where: \.isKeyWindow) ?? windows.first
    }

    private func scrollViews(in view: UIView) -> [UIScrollView] {
        ((view as? UIScrollView).map { [$0] } ?? []) + view.subviews.flatMap(scrollViews)
    }

    private func onShow(_ scroll: UIScrollView, in window: UIWindow) -> Bool {
        scroll.bounds.height > 200 && window.bounds.contains(scroll.convert(CGPoint(x: scroll.bounds.midX, y: scroll.bounds.midY), to: window))
    }

    private func count(_ gap: CFTimeInterval, expected: CFTimeInterval, in tally: inout Tally) {
        tally.frames += 1
        guard gap > expected * 1.5 else { return }
        tally.late += 1
        tally.lateTime += gap - expected
        tally.worst = max(tally.worst, gap)
    }

    @objc private func tick(_ link: CADisplayLink) {
        guard let window else { return }
        let now = link.timestamp
        if started == 0 { started = now; last = now; return }
        let gap = now - last
        last = now
        // A frame that came more than half an interval late is one the main thread missed.
        if now - started < seconds / 2 { count(gap, expected: link.duration, in: &vertical) } else { count(gap, expected: link.duration, in: &paging) }
        let elapsed = now - started
        if elapsed >= seconds { return finish(link) }
        if elapsed < seconds / 2 {
            // Looked up once: walking the window on every frame would be the bench's own cost.
            if page == nil { page = scrollViews(in: window).first { $0.contentSize.height > $0.bounds.height + 100 && onShow($0, in: window) } }
            guard let page else { return }
            let top = -page.adjustedContentInset.top
            let bottom = page.contentSize.height - page.bounds.height + page.adjustedContentInset.bottom
            var y = page.contentOffset.y + direction * Self.speed * CGFloat(gap)
            if y >= bottom { y = bottom; direction = -1 }
            if y <= top { y = top; direction = 1 }
            page.setContentOffset(CGPoint(x: page.contentOffset.x, y: y), animated: false)
        } else if now >= nextPage {
            guard let pager = scrollViews(in: window).first(where: { $0.contentSize.width > $0.bounds.width * 1.5 && onShow($0, in: window) }) else { return }
            nextPage = now + 0.7
            let width = pager.bounds.width
            let count = Int((pager.contentSize.width / width).rounded())
            var index = Int((pager.contentOffset.x / width).rounded()) + pageStep
            if index >= count || index < 0 { pageStep = -pageStep; index += 2 * pageStep }
            pager.setContentOffset(CGPoint(x: CGFloat(index) * width, y: pager.contentOffset.y), animated: true)
        }
    }

    private func finish(_ link: CADisplayLink) {
        link.invalidate()
        for (name, tally) in [("vertical", vertical), ("paging", paging)] {
            NSLog("ai-space: scroll bench %@ frames=%d late=%d lateMs=%.0f worstMs=%.1f", name, tally.frames, tally.late, tally.lateTime * 1000, tally.worst * 1000)
        }
        Self.running = nil
    }
}
#endif
