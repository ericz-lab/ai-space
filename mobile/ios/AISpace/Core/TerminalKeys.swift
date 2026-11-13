import Foundation

/// The terminal's key row above the soft keyboard: the keys a phone keyboard lacks, as one table
/// the three phone clients share. The panel's `src/web/terminal-keys.ts` and the Android client's
/// `core/TerminalKeys.kt` hold the same rows, the same byte rules and the same tests; change all
/// three together (docs/terminal.md, Keys on a phone).
///
/// A key is only what goes to the shell: nothing here knows the socket, the screen or the view.
/// - The row is two parts: keys that scroll (left), and the arrows and hide-keyboard that stay (right).
/// - Arrows, Home and End follow the terminal's application cursor mode (DECCKM): `ESC O A`
///   instead of `ESC [ A` while a full-screen program has asked for it.
/// - Ctrl and Alt are sticky: a tap arms them for the next key, from the row or the keyboard. On a
///   key of the row they become xterm's modifier parameter (`ESC [ 1 ; 5 A` for Ctrl+Up); on a
///   character Ctrl gives its control code (Termux's rules) and Alt puts an Escape before it.
enum TerminalKeys {
    enum Modifier: Sendable, Equatable { case ctrl, alt }

    enum Kind: Sendable, Equatable {
        /// Fixed bytes; Alt puts an Escape before them, Ctrl leaves them as they are.
        case bytes([UInt8])
        /// A character, as the keyboard would type it.
        case text(Character)
        /// `ESC [ x`, or `ESC O x` in application cursor mode: the arrows, Home and End.
        case cursor(Character)
        /// `ESC O x`: F1 to F4.
        case ss3(Character)
        /// `ESC [ n ~`: Page Up and Down, F5 to F10.
        case tilde(Int)
        /// Ctrl or Alt: arms the next key.
        case modifier(Modifier)
        /// Puts the keyboard away.
        case hideKeyboard
    }

    /// One key of the row. `label` is what it shows (the hide-keyboard key draws an icon);
    /// `repeats`: held down, it repeats like a keyboard's arrow.
    struct Key: Sendable, Equatable, Identifiable {
        let id: String
        let label: String
        let kind: Kind
        var repeats = false
    }

    struct Modifiers: Sendable, Equatable {
        var ctrl = false
        var alt = false
    }

    /// A held key repeats after this long, then at this interval.
    static let repeatDelay: TimeInterval = 0.4
    static let repeatInterval: TimeInterval = 0.07

    /// The part that scrolls, in the order a phone needs them most: Claude Code's Esc, Tab and Shift+Tab first.
    static let scrolling: [Key] = editingKeys + functionKeys

    private static let editingKeys: [Key] = [
        Key(id: "esc", label: "Esc", kind: .bytes([0x1B])),
        Key(id: "tab", label: "Tab", kind: .bytes([0x09])),
        Key(id: "backTab", label: "⇧Tab", kind: .bytes([0x1B, 0x5B, 0x5A])),
        Key(id: "ctrl", label: "Ctrl", kind: .modifier(.ctrl)),
        Key(id: "alt", label: "Alt", kind: .modifier(.alt)),
        Key(id: "ctrlC", label: "^C", kind: .bytes([0x03])),
        Key(id: "pageUp", label: "PgUp", kind: .tilde(5)),
        Key(id: "pageDown", label: "PgDn", kind: .tilde(6)),
        Key(id: "home", label: "Home", kind: .cursor("H")),
        Key(id: "end", label: "End", kind: .cursor("F")),
        Key(id: "tilde", label: "~", kind: .text("~")),
        Key(id: "pipe", label: "|", kind: .text("|")),
        Key(id: "slash", label: "/", kind: .text("/")),
        Key(id: "dash", label: "-", kind: .text("-")),
    ]

    /// F1 to F4 as `ESC O P` to `ESC O S`, F5 to F10 as `ESC [ 15 ~` to `ESC [ 21 ~`.
    private static let functionKeys: [Key] = {
        let ss3: [Character] = ["P", "Q", "R", "S"]
        let tilde = [15, 17, 18, 19, 20, 21]
        var keys: [Key] = []
        for (i, letter) in ss3.enumerated() {
            keys.append(Key(id: "f\(i + 1)", label: "F\(i + 1)", kind: .ss3(letter)))
        }
        for (i, code) in tilde.enumerated() {
            keys.append(Key(id: "f\(i + 5)", label: "F\(i + 5)", kind: .tilde(code)))
        }
        return keys
    }()

    /// The part that stays at the right: the arrows (held, they repeat) and hide-keyboard.
    static let fixed: [Key] = [
        Key(id: "left", label: "←", kind: .cursor("D"), repeats: true),
        Key(id: "down", label: "↓", kind: .cursor("B"), repeats: true),
        Key(id: "up", label: "↑", kind: .cursor("A"), repeats: true),
        Key(id: "right", label: "→", kind: .cursor("C"), repeats: true),
        Key(id: "hideKeyboard", label: "", kind: .hideKeyboard),
    ]

    static func key(_ id: String) -> Key? {
        (scrolling + fixed).first { $0.id == id }
    }

    /// A character's control code under Ctrl, as Termux's view gives it
    /// (`TerminalView.inputCodePoint`), or nil when Ctrl leaves it as it is.
    static func controlCode(_ char: Character) -> UInt8? {
        guard let ascii = char.asciiValue else { return nil }
        switch char {
        case "a"..."z", "A"..."Z": return ascii & 0x1F
        case " ", "2": return 0
        case "[", "3": return 27
        case "\\", "4": return 28
        case "]", "5": return 29
        case "^", "6": return 30
        case "_", "7", "/": return 31
        case "8": return 127
        default: return nil
        }
    }

    /// What a key of the row sends, or nil for Ctrl, Alt and hide-keyboard, which send nothing.
    /// - Parameters:
    ///   - appCursor: the terminal's application cursor mode (SwiftTerm's `Terminal.applicationCursor`).
    ///   - mods: the sticky modifiers this key spends.
    static func bytes(_ key: Key, appCursor: Bool, mods: Modifiers = Modifiers()) -> [UInt8]? {
        // xterm's modifier parameter: 1 plus 2 for Alt and 4 for Ctrl (Shift, 1, is not on the row).
        let m = 1 + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0)
        let esc: [UInt8] = mods.alt ? [0x1B] : []
        let text: String
        switch key.kind {
        case .bytes(let bytes):
            return esc + bytes
        case .text(let char):
            if mods.ctrl, let code = controlCode(char) { return esc + [code] }
            return esc + Array(String(char).utf8)
        case .cursor(let letter):
            text = m > 1 ? "\u{1B}[1;\(m)\(letter)" : "\u{1B}\(appCursor ? "O" : "[")\(letter)"
        case .ss3(let letter):
            text = m > 1 ? "\u{1B}[1;\(m)\(letter)" : "\u{1B}O\(letter)"
        case .tilde(let code):
            text = m > 1 ? "\u{1B}[\(code);\(m)~" : "\u{1B}[\(code)~"
        case .modifier, .hideKeyboard:
            return nil
        }
        return Array(text.utf8)
    }
}
