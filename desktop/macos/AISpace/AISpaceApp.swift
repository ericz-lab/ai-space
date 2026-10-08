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
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
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
    }

    func showWindow() {
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
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
                if let c = model.selected ?? model.store.defaultConnection, let info = model.lives[c.id]?.app(named: app) {
                    model.openApp(info, connection: c)
                } else {
                    model.showMainWindow()
                }
            case .inbox: model.showMainWindow(.inbox)
            case .show: model.showMainWindow()
            case nil: break
            }
        }
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
        CommandMenu("Space") {
            Button("Home") { model.showMainWindow(.panel) }
                .keyboardShortcut("h", modifiers: [.command, .shift])
            Button("Inbox") { model.showMainWindow(.inbox) }
                .keyboardShortcut("i", modifiers: [.command, .shift])
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
