import AppKit
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
    }

    private var windows: [String: Entry] = [:]
    /// Moves a window's page back into the main window as a tab.
    var onMoveBack: (AppInfo, Connection, PanelSession) -> Void = { _, _, _ in }
    /// Called when a window opens or closes, so the sidebar can show where each app is.
    var onChange: () -> Void = {}

    static func key(_ connection: UUID, _ app: String) -> String { "\(connection.uuidString)/\(app)" }

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
        windows[key] = Entry(window: window, session: session, app: app, connection: connection)
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

extension AppWindows: NSToolbarDelegate {
    private static let moveBackItem = NSToolbarItem.Identifier("moveBack")

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { [.flexibleSpace, Self.moveBackItem] }

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { [.flexibleSpace, Self.moveBackItem] }

    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier id: NSToolbarItem.Identifier, willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        guard id == Self.moveBackItem else { return nil }
        let item = NSToolbarItem(itemIdentifier: id)
        let title = String(localized: "Move to Main Window")
        item.label = title
        item.toolTip = String(localized: "Move to Main Window (⌥⌘T)")
        item.image = NSImage(systemSymbolName: "rectangle.stack", accessibilityDescription: title)
        item.isBordered = true
        item.target = self
        item.action = #selector(moveBackFromToolbar(_:))
        return item
    }

    @objc private func moveBackFromToolbar(_ sender: NSToolbarItem) {
        guard let key = sender.toolbar.flatMap({ toolbar in windows.first { $0.value.window.toolbar === toolbar }?.key }) else { return }
        moveBack(key)
    }
}
