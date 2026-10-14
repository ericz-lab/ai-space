import AppKit
import SwiftTerm
import SwiftUI

/// The terminal's colours: the ground and text of the panel's terminal (`terminal` and
/// `terminalText` in src/web/theme.ts), and its ANSI sets, the darker one on a light ground so
/// program output keeps its contrast. The same as the iPhone client's.
enum TerminalPalette {
    static func ground(dark: Bool) -> NSColor { NSColor(hex: dark ? 0x0B0D12 : 0xFBFBFD) }
    static func text(dark: Bool) -> NSColor { NSColor(hex: dark ? 0xE6E8EE : 0x1D1D1F) }

    private static let lightANSI: [UInt32] = [
        0x1D1D1F, 0xDC2626, 0x16A34A, 0xB45309, 0x2563EB, 0x9333EA, 0x0E7490, 0xE5E5EA,
        0x6E6E73, 0xEF4444, 0x22C55E, 0xD97706, 0x3B82F6, 0xA855F7, 0x0891B2, 0xFFFFFF,
    ]
    /// xterm.js's defaults, with the ground as black and the three the panel changes.
    private static let darkANSI: [UInt32] = [
        0x0B0D12, 0xCC0000, 0x4E9A06, 0xC4A000, 0x3465A4, 0x75507B, 0x06989A, 0xD1D5DB,
        0x6B7280, 0xEF2929, 0x8AE234, 0xFCE94F, 0x729FCF, 0xAD7FA8, 0x34E2E2, 0xF9FAFB,
    ]

    static func ansi(dark: Bool) -> [SwiftTerm.Color] {
        (dark ? darkANSI : lightANSI).map {
            SwiftTerm.Color(red: UInt16(($0 >> 16) & 0xFF) * 257, green: UInt16(($0 >> 8) & 0xFF) * 257, blue: UInt16($0 & 0xFF) * 257)
        }
    }
}

/// One session's terminal on screen: the emulator view, kept with its scrollback while the
/// session's tab exists, and the wiring between it and the session's socket. TerminalStore
/// (shared with the iPhone client) makes these.
@MainActor
final class TerminalTab: ObservableObject, Identifiable {
    let id = UUID()
    let title: String
    let session: TerminalSession
    let host: TerminalHostView
    private let bridge = TerminalBridge()

    init(title: String, session: TerminalSession, passphrase: String?, openLink: @escaping (URL) -> Void) {
        self.title = title
        self.session = session
        host = TerminalHostView()
        let view = host.terminal
        view.terminalDelegate = bridge
        session.onOutput = { [weak view] bytes in view?.feed(byteArray: bytes) }
        bridge.onSend = { [weak session] bytes in session?.send(bytes) }
        bridge.onSize = { [weak session] cols, rows in session?.resize(cols: cols, rows: rows) }
        bridge.onLink = openLink
        // The shell opens at the size the view really has, so it starts after the first layout.
        host.onFirstLayout = { [weak session, weak view] in
            guard let session, let view else { return }
            let t = view.getTerminal()
            session.start(cols: t.cols, rows: t.rows, passphrase: passphrase)
        }
    }

    func focus() {
        DispatchQueue.main.async { [host] in host.window?.makeFirstResponder(host.terminal) }
    }
}

/// SwiftTerm's delegate, which is not bound to the main actor; AppKit calls it there.
private final class TerminalBridge: NSObject, TerminalViewDelegate {
    var onSend: @MainActor (ArraySlice<UInt8>) -> Void = { _ in }
    var onSize: @MainActor (Int, Int) -> Void = { _, _ in }
    var onLink: @MainActor (URL) -> Void = { _ in }

    func send(source: TerminalView, data: ArraySlice<UInt8>) {
        MainActor.assumeIsolated { onSend(data) }
    }

    func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
        MainActor.assumeIsolated { onSize(newCols, newRows) }
    }

    func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
        guard let url = URL(string: link), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return }
        MainActor.assumeIsolated { onLink(url) }
    }

    func clipboardCopy(source: TerminalView, content: Data) {
        guard let text = String(data: content, encoding: .utf8) else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    func setTerminalTitle(source: TerminalView, title: String) {}
    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    func scrolled(source: TerminalView, position: Double) {}
    func bell(source: TerminalView) { NSSound.beep() }
    func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}
    func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
}

/// Holds the emulator view at its edges, colours it for light and dark, and says when it has a size.
final class TerminalHostView: NSView {
    let terminal: TerminalView
    var onFirstLayout: (() -> Void)?

    init() {
        terminal = TerminalView(frame: .zero, font: .monospacedSystemFont(ofSize: 13, weight: .regular))
        super.init(frame: .zero)
        addSubview(terminal)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not in a nib") }

    override func layout() {
        super.layout()
        terminal.frame = bounds.insetBy(dx: 8, dy: 4)
        guard bounds.width > 40, bounds.height > 40, let begin = onFirstLayout else { return }
        onFirstLayout = nil
        terminal.layoutSubtreeIfNeeded()
        begin()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        colour()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        colour()
    }

    private func colour() {
        let dark = effectiveAppearance.isDark
        let ground = TerminalPalette.ground(dark: dark)
        let text = TerminalPalette.text(dark: dark)
        wantsLayer = true
        layer?.backgroundColor = ground.cgColor
        terminal.installColors(TerminalPalette.ansi(dark: dark))
        terminal.nativeForegroundColor = text
        terminal.nativeBackgroundColor = ground
        terminal.caretColor = text
        terminal.selectedTextBackgroundColor = NSColor(Theme.accent).withAlphaComponent(0.3)
    }
}

/// The current tab's terminal in the page.
struct TerminalSurface: NSViewRepresentable {
    let tab: TerminalTab

    func makeNSView(context: Context) -> TerminalHostView { tab.host }
    func updateNSView(_ view: TerminalHostView, context: Context) {}
}
