import AppKit
import Combine
import SwiftUI
import WebKit

/// Apps the operator moved out of the main window, each in its own window with its own saved
/// frame. A window takes over the app's existing page, so moving it keeps its state; moving it
/// back hands the page to the main window again. Closing the window ends the page.
@MainActor
final class AppWindows: NSObject, NSWindowDelegate {
    private struct Entry {
        let window: NSWindow
        let session: PanelSession
        let app: AppInfo
        let connection: Connection
        /// Redraws Back and Forward as the page's history changes.
        let history: AnyCancellable
    }

    private var windows: [String: Entry] = [:]
    /// Moves a window's page back into the main window as a tab.
    var onMoveBack: (AppInfo, Connection, PanelSession) -> Void = { _, _, _ in }
    /// Called when a window opens or closes, so the sidebar can show where each app is.
    var onChange: () -> Void = {}

    static func key(_ connection: UUID, _ app: String) -> String { "\(connection.uuidString)/\(app)" }

    var foregroundApp: (connection: Connection, app: String)? {
        guard let id = NSApp.keyWindow?.identifier?.rawValue, let entry = windows[id] else { return nil }
        return (entry.connection, entry.app.id)
    }

    func isOpen(_ app: String, connection: UUID) -> Bool { windows[Self.key(connection, app)] != nil }

    /// Brings an app's window forward, loading `url` in it first when given. False when it has none.
    @discardableResult
    func focus(_ app: String, connection: UUID, url: URL? = nil) -> Bool {
        guard let entry = windows[Self.key(connection, app)] else { return false }
        if let url, entry.session.webView.url != url { entry.session.webView.load(URLRequest(url: url)) }
        entry.window.makeKeyAndOrderFront(nil)
        NSApp.activate()
        return true
    }

    /// Opens a window around a page that is already loaded (moved out of the main window) or new.
    func show(_ session: PanelSession, app: AppInfo, connection: Connection) {
        let key = Self.key(connection.id, app.id)
        if focus(app.id, connection: connection.id) { return }
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1100, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = app.displayTitle
        window.subtitle = app.peer ?? (connection.isLocal ? "" : connection.name)
        window.tabbingMode = .disallowed
        // Plain AppKit: the page moves in as it is and nothing in SwiftUI can claim it back.
        let container = NSView()
        session.container = container
        let web = session.webView
        web.removeFromSuperview()
        web.frame = container.bounds
        web.autoresizingMask = [.width, .height]
        container.addSubview(web)
        window.contentView = container
        let toolbar = NSToolbar(identifier: "AppWindow")
        toolbar.delegate = self
        toolbar.displayMode = .iconOnly
        window.toolbar = toolbar
        window.toolbarStyle = .unified
        window.delegate = self
        window.identifier = NSUserInterfaceItemIdentifier(key)
        window.setFrameAutosaveName("App-\(app.id)")
        if !window.setFrameUsingName("App-\(app.id)") { window.center() }
        let history = session.$canGoBack.combineLatest(session.$canGoForward)
            .receive(on: DispatchQueue.main)
            .sink { [weak toolbar] _ in toolbar?.validateVisibleItems() }
        windows[key] = Entry(window: window, session: session, app: app, connection: connection, history: history)
        onChange()
        if session.webView.url == nil { session.load() }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }

    /// The front app window's key, for the menu command that moves it back.
    var keyWindowApp: String? {
        guard let id = NSApp.keyWindow?.identifier?.rawValue, windows[id] != nil else { return nil }
        return id
    }

    /// The front app window's page, for the menu commands that act on what is in front.
    var keyWindowSession: PanelSession? { keyWindowApp.flatMap { windows[$0]?.session } }

    func moveBack(_ key: String) {
        guard let entry = windows.removeValue(forKey: key) else { return }
        // Hand the page over before the window goes, so closing it does not stop the page.
        entry.window.delegate = nil
        entry.session.container = nil
        entry.window.contentView = nil
        entry.window.close()
        onMoveBack(entry.app, entry.connection, entry.session)
    }

    /// Closes the windows of a connection that was removed or changed.
    func close(connection id: UUID) {
        for (key, entry) in windows where key.hasPrefix(id.uuidString) {
            entry.window.close()
        }
    }

    func windowWillClose(_ notification: Notification) {
        guard let window = notification.object as? NSWindow, let key = window.identifier?.rawValue else { return }
        windows[key]?.session.webView.stopLoading()
        windows[key] = nil
        onChange()
    }
}

/// An app's page, with its connection state over it.
struct AppPageView: View {
    @ObservedObject var session: PanelSession

    var body: some View {
        ZStack(alignment: .top) {
            PanelWebView(session: session)
            // The mark stands in for the page until the page has something to show.
            if !session.hasContent, !session.state.isFailure, session.state != .authenticationRequired {
                Connecting().background(Theme.ground)
            }
            if session.isLoading, session.hasContent, session.progress < 1 {
                ProgressView(value: session.progress).progressViewStyle(.linear).tint(Theme.accent).frame(height: 2)
            }
            switch session.state {
            case .unreachable(let detail):
                FailureView(session: session, title: "Cannot reach this app", detail: detail)
            default:
                EmptyView()
            }
        }
        .frame(minWidth: 480, minHeight: 320)
    }
}

extension AppWindows: NSToolbarDelegate, NSToolbarItemValidation {
    private static let moveBackItem = NSToolbarItem.Identifier("moveBack")
    private static let backItem = NSToolbarItem.Identifier("back")
    private static let forwardItem = NSToolbarItem.Identifier("forward")
    private static let reloadItem = NSToolbarItem.Identifier("reload")

    /// The page's controls first, as on the main window's tab (AppTabView), then Move to Main Window.
    private static let items: [NSToolbarItem.Identifier] = [backItem, forwardItem, reloadItem, .flexibleSpace, moveBackItem]

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { Self.items }

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { Self.items }

    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier id: NSToolbarItem.Identifier, willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        switch id {
        case Self.moveBackItem:
            return item(id, title: String(localized: "Move to Main Window"), help: String(localized: "Move to Main Window (⌥⌘T)"),
                        symbol: "rectangle.stack", action: #selector(moveBackFromToolbar(_:)))
        case Self.backItem:
            return item(id, title: String(localized: "Back"), help: String(localized: "Back"), symbol: "chevron.left", action: #selector(goBack(_:)))
        case Self.forwardItem:
            return item(id, title: String(localized: "Forward"), help: String(localized: "Forward"), symbol: "chevron.right", action: #selector(goForward(_:)))
        case Self.reloadItem:
            return item(id, title: String(localized: "Reload"), help: String(localized: "Reload"), symbol: "arrow.clockwise", action: #selector(reloadPage(_:)))
        default:
            return nil
        }
    }

    private func item(_ id: NSToolbarItem.Identifier, title: String, help: String, symbol: String, action: Selector) -> NSToolbarItem {
        let item = NSToolbarItem(itemIdentifier: id)
        item.label = title
        item.toolTip = help
        item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: title)
        item.isBordered = true
        item.target = self
        item.action = action
        return item
    }

    /// Back and Forward follow the page's history.
    func validateToolbarItem(_ item: NSToolbarItem) -> Bool {
        guard let entry = entry(of: item) else { return false }
        switch item.itemIdentifier {
        case Self.backItem: return entry.session.webView.canGoBack
        case Self.forwardItem: return entry.session.webView.canGoForward
        default: return true
        }
    }

    private func key(of item: NSToolbarItem) -> String? {
        item.toolbar.flatMap { toolbar in windows.first { $0.value.window.toolbar === toolbar }?.key }
    }

    private func entry(of item: NSToolbarItem) -> Entry? { key(of: item).flatMap { windows[$0] } }

    @objc private func moveBackFromToolbar(_ sender: NSToolbarItem) {
        guard let key = key(of: sender) else { return }
        moveBack(key)
    }

    @objc private func goBack(_ sender: NSToolbarItem) { entry(of: sender)?.session.webView.goBack() }

    @objc private func goForward(_ sender: NSToolbarItem) { entry(of: sender)?.session.webView.goForward() }

    @objc private func reloadPage(_ sender: NSToolbarItem) { entry(of: sender)?.session.reload() }
}
