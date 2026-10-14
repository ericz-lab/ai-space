import SwiftTerm
import SwiftUI
import UIKit

/// The terminal's colours: the ground and text of the panel's terminal (`terminal` and
/// `terminalText` in src/web/theme.ts), and its ANSI sets, the darker one on a light ground so
/// program output keeps its contrast.
enum TerminalPalette {
    static let ground = UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: 0x0B0D12) : UIColor(hex: 0xFBFBFD) }
    static let text = UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: 0xE6E8EE) : UIColor(hex: 0x1D1D1F) }

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

private extension UIColor {
    convenience init(hex: UInt32) {
        self.init(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}

/// One session's terminal on screen: the emulator view, kept with its scrollback while the
/// session's tab exists, and the wiring between it and the session's socket.
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
        _ = host.terminal.becomeFirstResponder()
    }

    /// Types a line into the shell, as the keyboard would.
    func type(_ line: String) {
        session.send(ArraySlice(Array((line + "\r").utf8)))
    }
}

/// SwiftTerm's delegate, which is not bound to the main actor; UIKit calls it there.
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
        if let text = String(data: content, encoding: .utf8) { UIPasteboard.general.string = text }
    }

    func setTerminalTitle(source: TerminalView, title: String) {}
    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    func scrolled(source: TerminalView, position: Double) {}
    func bell(source: TerminalView) {}
    func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}
    func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
}

/// Holds the emulator view at its edges, colours it for light and dark, and says when it has a size.
final class TerminalHostView: UIView {
    let terminal: TerminalView
    var onFirstLayout: (() -> Void)?

    init() {
        let compact = UIDevice.current.userInterfaceIdiom == .phone
        terminal = TerminalView(frame: .zero, font: .monospacedSystemFont(ofSize: compact ? 12 : 13, weight: .regular))
        super.init(frame: .zero)
        // A hardware keyboard's focus ring would frame the whole terminal.
        terminal.focusEffect = nil
        addSubview(terminal)
        colour()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: TerminalHostView, _) in view.colour() }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not in a nib") }

    override func layoutSubviews() {
        super.layoutSubviews()
        terminal.frame = bounds.insetBy(dx: 6, dy: 0)
        guard bounds.width > 40, bounds.height > 40, let begin = onFirstLayout else { return }
        onFirstLayout = nil
        terminal.layoutIfNeeded()
        begin()
    }

    private func colour() {
        let ground = TerminalPalette.ground.resolvedColor(with: traitCollection)
        let text = TerminalPalette.text.resolvedColor(with: traitCollection)
        backgroundColor = ground
        terminal.installColors(TerminalPalette.ansi(dark: traitCollection.userInterfaceStyle == .dark))
        terminal.nativeForegroundColor = text
        terminal.nativeBackgroundColor = ground
        terminal.backgroundColor = ground
        terminal.caretColor = text
        terminal.caretTextColor = ground
        terminal.selectedTextBackgroundColor = UIColor(Theme.accent).resolvedColor(with: traitCollection).withAlphaComponent(0.3)
    }
}

/// The current tab's terminal in the page.
struct TerminalSurface: UIViewRepresentable {
    let tab: TerminalTab

    func makeUIView(context: Context) -> TerminalHostView { tab.host }
    func updateUIView(_ view: TerminalHostView, context: Context) {}
}
