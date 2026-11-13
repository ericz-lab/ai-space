import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

/// The same cases as the panel's src/web/terminal-keys.test.ts and the Android client's
/// TerminalKeysTests.kt: the three tables must send the same bytes.
struct TerminalKeysTests {
    static let ctrl = TerminalKeys.Modifiers(ctrl: true)
    static let alt = TerminalKeys.Modifiers(alt: true)
    static let both = TerminalKeys.Modifiers(ctrl: true, alt: true)

    func send(_ id: String, appCursor: Bool = false, mods: TerminalKeys.Modifiers = TerminalKeys.Modifiers()) -> String? {
        guard let key = TerminalKeys.key(id) else { return "no key \(id)" }
        return TerminalKeys.bytes(key, appCursor: appCursor, mods: mods)?.map { String(format: "%02x", $0) }.joined(separator: " ")
    }

    @Test func theRowsOrder() {
        #expect(TerminalKeys.scrolling.map(\.id) == ["esc", "tab", "backTab", "ctrl", "alt", "ctrlC", "pageUp", "pageDown", "home", "end", "tilde", "pipe", "slash", "dash",
                                                    "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10"])
        #expect(TerminalKeys.scrolling.map(\.label) == ["Esc", "Tab", "⇧Tab", "Ctrl", "Alt", "^C", "PgUp", "PgDn", "Home", "End", "~", "|", "/", "-",
                                                       "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10"])
        #expect(TerminalKeys.fixed.map(\.id) == ["left", "down", "up", "right", "hideKeyboard"])
        #expect((TerminalKeys.scrolling + TerminalKeys.fixed).filter(\.repeats).map(\.id) == ["left", "down", "up", "right"])
    }

    @Test func eachKeysBytesInNormalCursorMode() {
        let expected: KeyValuePairs<String, String?> = [
            "esc": "1b", "tab": "09", "backTab": "1b 5b 5a", "ctrl": nil, "alt": nil, "ctrlC": "03",
            "pageUp": "1b 5b 35 7e", "pageDown": "1b 5b 36 7e", "home": "1b 5b 48", "end": "1b 5b 46",
            "tilde": "7e", "pipe": "7c", "slash": "2f", "dash": "2d",
            "f1": "1b 4f 50", "f2": "1b 4f 51", "f3": "1b 4f 52", "f4": "1b 4f 53",
            "f5": "1b 5b 31 35 7e", "f6": "1b 5b 31 37 7e", "f7": "1b 5b 31 38 7e", "f8": "1b 5b 31 39 7e",
            "f9": "1b 5b 32 30 7e", "f10": "1b 5b 32 31 7e",
            "left": "1b 5b 44", "down": "1b 5b 42", "up": "1b 5b 41", "right": "1b 5b 43", "hideKeyboard": nil,
        ]
        for (id, bytes) in expected {
            #expect(send(id) == bytes, "\(id)")
        }
    }

    @Test func arrowsHomeAndEndFollowApplicationCursorMode() {
        #expect(["up", "down", "right", "left", "home", "end"].map { send($0, appCursor: true) }
            == ["1b 4f 41", "1b 4f 42", "1b 4f 43", "1b 4f 44", "1b 4f 48", "1b 4f 46"])
        #expect(send("pageUp", appCursor: true) == "1b 5b 35 7e")
        #expect(send("f1", appCursor: true) == "1b 4f 50")
        #expect(send("backTab", appCursor: true) == "1b 5b 5a")
    }

    @Test func stickyCtrlAndAltOnTheRowsKeys() {
        // Special keys take xterm's modifier parameter, in either cursor mode.
        #expect(send("left", mods: Self.ctrl) == "1b 5b 31 3b 35 44")
        #expect(send("up", appCursor: true, mods: Self.alt) == "1b 5b 31 3b 33 41")
        #expect(send("home", mods: Self.both) == "1b 5b 31 3b 37 48")
        #expect(send("pageUp", mods: Self.both) == "1b 5b 35 3b 37 7e")
        #expect(send("f1", mods: Self.ctrl) == "1b 5b 31 3b 35 50")
        #expect(send("f5", mods: Self.alt) == "1b 5b 31 35 3b 33 7e")
        // Fixed bytes: Alt puts an Escape before them, Ctrl leaves them.
        #expect(send("esc", mods: Self.alt) == "1b 1b")
        #expect(send("tab", mods: Self.ctrl) == "09")
        #expect(send("ctrlC", mods: Self.alt) == "1b 03")
        // Characters: Ctrl gives the control code when there is one.
        #expect(send("slash", mods: Self.ctrl) == "1f")
        #expect(send("dash", mods: Self.ctrl) == "2d")
        #expect(send("tilde", mods: Self.alt) == "1b 7e")
        #expect(send("slash", mods: Self.both) == "1b 1f")
    }

    @Test func controlCodesFollowTermuxsRules() {
        #expect(Array("aczACZ").map(TerminalKeys.controlCode) == [1, 3, 26, 1, 3, 26])
        #expect(Array(" 2[3\\4]5^6_7/8").map(TerminalKeys.controlCode) == [0, 0, 27, 27, 28, 28, 29, 29, 30, 30, 31, 31, 31, 127])
        #expect(Array("-~|é").map(TerminalKeys.controlCode) == [nil, nil, nil, nil])
    }
}
