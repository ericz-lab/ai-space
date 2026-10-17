import Combine
import SwiftUI

@main
struct AISpaceApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @ObservedObject private var prefs = Preferences.shared

    var body: some Scene {
        Settings {
            TabView {
                GeneralSettings(prefs: prefs)
                    .tabItem { Label("General", systemImage: "gearshape") }
                ConnectionSettings(model: delegate.model, store: delegate.model.store)
                    .tabItem { Label("Connections", systemImage: "network") }
            }
        }
        .commands { SpaceCommands(model: delegate.model, store: delegate.model.store, showWindow: delegate.showWindow) }

        // MenuBarExtra writes this binding on every update; writing the same value back would
        // republish the preferences and re-render the app in a loop.
        MenuBarExtra(isInserted: Binding(get: { prefs.menuBar }, set: { if prefs.menuBar != $0 { prefs.menuBar = $0 } })) {
            MenuBarView(model: delegate.model, store: delegate.model.store)
        } label: {
            MenuBarLabel(model: delegate.model)
        }
        .menuBarExtraStyle(.window)
    }
}

/// Owns the main window in AppKit so closing it only hides it: the page, its streams and
/// any unsent text stay as they were, and the Dock icon brings the same window back.
/// Also owns what reaches the app from outside: the global shortcut, the Services menu and
/// `aispace://` links.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let model = AppModel(store: ConnectionStore())
    private var window: NSWindow?
    private lazy var quickChat = QuickChat(model: model)
    private lazy var hotKey = HotKey { [weak self] in self?.quickChat.toggle() }
    private var watchers: Set<AnyCancellable> = []
    private var activity: NSObjectProtocol?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.appearance = Preferences.shared.appearance.nsAppearance
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.identifier = NSUserInterfaceItemIdentifier("SpaceMain")
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.toolbarStyle = .unified
        let host = NSHostingView(rootView: MainView(model: model, store: model.store))
        host.sceneBridgingOptions = [.toolbars, .title]
        window.contentView = host
        window.setFrameAutosaveName("MainWindow")
        if !window.setFrameUsingName("MainWindow") { window.center() }
        window.tabbingMode = .disallowed
        self.window = window

        model.showWindow = { [weak self] in self?.showWindow() }
        model.quickChat = { [weak self] in self?.quickChat.show() }
        model.notifier.setUp()
        NSApp.servicesProvider = ServicesProvider(open: { [weak self] text in self?.quickChat.show(text: text) })
        NSUpdateDynamicServices()

        Preferences.shared.$quickChat.sink { [weak self] shortcut in
            guard let self else { return }
            if !hotKey.register(shortcut) {
                NSLog("ai-space: the Quick Chat shortcut \(shortcut.label) is taken by another app")
            }
        }.store(in: &watchers)

        // Inbox notifications and the menu bar need the 30-second refresh while the window is
        // hidden; App Nap would otherwise stretch it to minutes. Idle sleep stays allowed.
        activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiatedAllowingIdleSystemSleep], reason: "Watching the Space inbox")

        showWindow()
        #if DEBUG
        DebugSnapshot.schedule(window: window, model: model)
        #endif
    }

    func applicationDidBecomeActive(_ notification: Notification) { model.setUsageActive(true) }
    func applicationDidResignActive(_ notification: Notification) { model.setUsageActive(false) }
    func applicationWillTerminate(_ notification: Notification) { model.setUsageActive(false) }

    func showWindow() {
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate()
        model.setUsageActive(true)
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        if !NSApp.windows.contains(where: { $0.isVisible && $0.canBecomeKey }) { model.setUsageActive(false) }
        return false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showWindow() }
        return true
    }

    /// Quitting closes the UI only; a Space and its agents keep running wherever they run.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            switch DeepLink(url) {
            case .chat(let agent, let text): quickChat.show(agent: agent, text: text)
            case .open(let app):
                if let c = model.selected ?? model.store.defaultConnection, let entry = model.loader(for: c).catalogue?.app(named: app) {
                    model.open(entry)
                    model.showMainWindow()
                } else if let c = model.selected ?? model.store.defaultConnection, let info = model.lives[c.id]?.app(named: app) {
                    model.openApp(info, connection: c)
                } else {
                    model.showMainWindow()
                }
            case .inbox: model.showMainWindow(.hub(.inbox))
            case .show: model.showMainWindow(.launcher)
            case nil: break
            }
        }
    }
}

extension AppDelegate {
    /// The Dock menu: the first apps and agents of the first screen, as the iPhone's quick actions.
    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        let entries = model.dockEntries()
        guard !entries.isEmpty else { return nil }
        let menu = NSMenu()
        for entry in entries {
            let item = NSMenuItem(title: entry.displayTitle(), action: #selector(openDockEntry(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = entry.key
            menu.addItem(item)
        }
        return menu
    }

    @objc private func openDockEntry(_ sender: NSMenuItem) {
        guard let key = sender.representedObject as? String, let entry = model.dockEntries().first(where: { $0.key == key }) else { return }
        model.open(entry)
        showWindow()
    }
}

/// Services > Ask ai-space: the selected text goes into Quick Chat, unsent.
final class ServicesProvider: NSObject {
    private let open: @MainActor (String) -> Void

    init(open: @escaping @MainActor (String) -> Void) {
        self.open = open
    }

    @objc func askSpace(_ pasteboard: NSPasteboard, userData: String?, error: AutoreleasingUnsafeMutablePointer<NSString?>) {
        guard let text = pasteboard.string(forType: .string), !text.isEmpty else { return }
        MainActor.assumeIsolated { open(text) }
    }
}

struct SpaceCommands: Commands {
    @ObservedObject var model: AppModel
    @ObservedObject var store: ConnectionStore
    let showWindow: () -> Void

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("Quick Chat") { model.quickChat?() }
                .keyboardShortcut("k")
        }
        CommandGroup(after: .textEditing) {
            Button("Search Apps, Agents and Widgets") { model.search(); showWindow() }
                .keyboardShortcut("f")
                .disabled(model.selected == nil || model.destination != .launcher)
        }
        CommandMenu("Space") {
            Button("Share Picture…") { model.pictureSharing.choose() }
            Button("Paste Picture") { model.pictureSharing.paste() }
            Button("Pending Shares") { model.pictureSharing.show() }
            Divider()
            Button("Back to Space") { model.showMainWindow(.launcher) }
                .keyboardShortcut("h", modifiers: [.command, .shift])
            Button("Home") { model.showPage(Pager.home); showWindow() }
                .keyboardShortcut("l", modifiers: [.command, .shift])
            Button("Screens") { model.showScreens(); showWindow() }
                .keyboardShortcut("m", modifiers: [.command, .shift])
            Button("Settings of the Space") { model.showPage(Pager.settings); showWindow() }
                .keyboardShortcut(",", modifiers: [.command, .shift])
            Button("Previous Page") { withAnimation(.easeInOut(duration: 0.3)) { model.movePage(by: -1) } }
                .keyboardShortcut(.leftArrow, modifiers: [.command, .option])
                .disabled(model.selected == nil)
            Button("Next Page") { withAnimation(.easeInOut(duration: 0.3)) { model.movePage(by: 1) } }
                .keyboardShortcut(.rightArrow, modifiers: [.command, .option])
                .disabled(model.selected == nil)
            Divider()
            Button("Inbox") { model.showMainWindow(.hub(.inbox)) }
                .keyboardShortcut("i", modifiers: [.command, .shift])
            Button("Chat") { model.showMainWindow(.hub(.chat(agent: nil))) }
                .keyboardShortcut("c", modifiers: [.command, .shift])
            Button("Terminal") { model.showMainWindow(.hub(.terminal)) }
                .keyboardShortcut("t", modifiers: [.command, .shift])
            Button("Web Panel") { model.openWebPanel(); showWindow() }
                .keyboardShortcut("p", modifiers: [.command, .shift])
                .disabled(model.selected == nil)
            Button("Move App Between Tab and Window") { model.toggleAppPlacement() }
                .keyboardShortcut("t", modifiers: [.command, .option])
            Divider()
            Button("Reload") { model.reload() }
                .keyboardShortcut("r")
                .disabled(model.selected == nil)
            Button("Open in Browser") { model.openInBrowser() }
                .keyboardShortcut("o", modifiers: [.command, .shift])
                .disabled(model.selected == nil)
            Divider()
            ForEach(Array(store.connections.enumerated()), id: \.element.id) { i, c in
                let button = Button {
                    model.select(c.id)
                    showWindow()
                } label: {
                    if c.id == model.selectedID { Label(c.name, systemImage: "checkmark") } else { Text(c.name) }
                }
                if i < 9 {
                    button.keyboardShortcut(KeyEquivalent(Character(String(i + 1))))
                } else {
                    button
                }
            }
        }
        CommandGroup(before: .windowList) {
            Button("Main Window") { showWindow() }.keyboardShortcut("0")
            Divider()
        }
    }
}

#if DEBUG
/// For checking the layout without screen recording: `AISPACE_SNAPSHOT=<dir>` writes a PNG of the
/// main window for each page named in `AISPACE_PAGES` (`#home`, a screen id, `#settings`,
/// `hub:inbox`, `hub:chat`, `panel`, `query:<text>` typed into the first screen's box, `ask:<text>` asked of
/// Space Assistant), a few seconds apart. Debug builds only.
@MainActor
enum DebugSnapshot {
    static func schedule(window: NSWindow, model: AppModel) {
        let env = ProcessInfo.processInfo.environment
        guard let dir = env["AISPACE_SNAPSHOT"], !dir.isEmpty else { return }
        let pages = (env["AISPACE_PAGES"] ?? "home").split(separator: ",").map(String.init)
        for (i, page) in pages.enumerated() {
            DispatchQueue.main.asyncAfter(deadline: .now() + 6 + Double(i) * 4) {
                switch page {
                case "panel": model.openWebPanel()
                case "hub:inbox": model.destination = .hub(.inbox)
                case "hub:chat": model.destination = .hub(.chat(agent: nil))
                case "hub:terminal": model.destination = .hub(.terminal)
                case let p where p.hasPrefix("query:"):
                    model.showPage(Screens.home)
                    model.query = String(p.dropFirst(6))
                case let p where p.hasPrefix("ask:"): model.ask(String(p.dropFirst(4)))
                default: model.showPage(page)
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 9 + Double(i) * 4) {
                guard let view = window.contentView?.superview, let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
                view.cacheDisplay(in: view.bounds, to: rep)
                let typed = page.hasPrefix("query:") || page.hasPrefix("ask:")
                let name = typed ? String(page.prefix { $0 != ":" }) : page.replacingOccurrences(of: "#", with: "").replacingOccurrences(of: ":", with: "-")
                try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(i)-\(name).png"))
            }
        }
    }
}
#endif
