import SwiftUI
import UIKit

/// The terminal's row above the soft keyboard, in place of SwiftTerm's own accessory: the keys of
/// `TerminalKeys` (the table the Android client and the panel share), the ones that scroll on the
/// left, the arrows and hide-keyboard fixed on the right. It only draws the keys and reports
/// presses; `TerminalTab` sends the bytes and keeps Ctrl and Alt in SwiftTerm's view, so a Ctrl
/// armed here also applies to the next letter typed on the keyboard.
///
/// - A key acts when it is let go inside it, so a swipe along the row scrolls it without typing;
///   an arrow acts at once on the press and repeats while held, like a keyboard's arrow.
/// - The keys are controls, never the first responder, so the keyboard stays up.
final class TerminalKeyRow: UIInputView, UIInputViewAudioFeedback {
    /// A key was pressed (an arrow: once per repeat too).
    var onKey: (TerminalKeys.Key) -> Void = { _ in }

    private let height: CGFloat
    private var caps: [String: KeyCap] = [:]
    private var repeating: Timer?

    init() {
        height = UIDevice.current.userInterfaceIdiom == .phone ? 44 : 50
        // The system gives it the keyboard's width.
        super.init(frame: CGRect(x: 0, y: 0, width: 320, height: height), inputViewStyle: .keyboard)
        allowsSelfSizing = true
        autoresizingMask = .flexibleWidth

        let scroll = KeyScroll()
        scroll.showsHorizontalScrollIndicator = false
        scroll.alwaysBounceHorizontal = true
        // Keys light up at once; a drag still turns into a scroll (KeyScroll lets it cancel them).
        scroll.delaysContentTouches = false
        let scrolling = Self.stack(TerminalKeys.scrolling.map(cap))
        let fixed = Self.stack(TerminalKeys.fixed.map(cap))
        fixed.setContentCompressionResistancePriority(.required, for: .horizontal)
        scroll.addSubview(scrolling)
        addSubview(scroll)
        addSubview(fixed)
        for view in [scroll, scrolling, fixed] as [UIView] { view.translatesAutoresizingMaskIntoConstraints = false }
        let edges = safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: edges.leadingAnchor, constant: 4),
            scroll.topAnchor.constraint(equalTo: topAnchor),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
            scroll.trailingAnchor.constraint(equalTo: fixed.leadingAnchor, constant: -5),
            fixed.trailingAnchor.constraint(equalTo: edges.trailingAnchor, constant: -4),
            fixed.centerYAnchor.constraint(equalTo: centerYAnchor),
            scrolling.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
            scrolling.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
            scrolling.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            scrolling.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
            scrolling.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not in a nib") }

    override var intrinsicContentSize: CGSize { CGSize(width: UIView.noIntrinsicMetric, height: height) }

    /// The keyboard's click on each key, as the system keys make it.
    var enableInputClicksWhenVisible: Bool { true }

    /// Shows Ctrl and Alt as armed or not (SwiftTerm's view holds the state).
    func showArmed(ctrl: Bool, alt: Bool) {
        caps["ctrl"]?.isSelected = ctrl
        caps["alt"]?.isSelected = alt
    }

    override func willMove(toWindow newWindow: UIWindow?) {
        super.willMove(toWindow: newWindow)
        if newWindow == nil { stopRepeating() }
    }

    private static func stack(_ views: [UIView]) -> UIStackView {
        let stack = UIStackView(arrangedSubviews: views)
        stack.axis = .horizontal
        stack.alignment = .center
        stack.spacing = 5
        return stack
    }

    private func cap(_ key: TerminalKeys.Key) -> KeyCap {
        let cap = KeyCap(key: key)
        caps[key.id] = cap
        if key.repeats {
            cap.addTarget(self, action: #selector(beginRepeat(_:)), for: .touchDown)
            cap.addTarget(self, action: #selector(endRepeat), for: [.touchUpInside, .touchUpOutside, .touchCancel])
        } else {
            cap.addTarget(self, action: #selector(tapped(_:)), for: .touchUpInside)
        }
        return cap
    }

    private func fire(_ key: TerminalKeys.Key) {
        UIDevice.current.playInputClick()
        onKey(key)
    }

    @objc private func tapped(_ cap: KeyCap) { fire(cap.key) }

    @objc private func beginRepeat(_ cap: KeyCap) {
        stopRepeating()
        let key = cap.key
        fire(key)
        repeating = Timer.scheduledTimer(withTimeInterval: TerminalKeys.repeatDelay, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.repeating = Timer.scheduledTimer(withTimeInterval: TerminalKeys.repeatInterval, repeats: true) { [weak self] _ in
                    MainActor.assumeIsolated { self?.onKey(key) }
                }
            }
        }
    }

    @objc private func endRepeat() { stopRepeating() }

    private func stopRepeating() {
        repeating?.invalidate()
        repeating = nil
    }
}

/// The row's scrolling part: a drag along it scrolls even when it starts on a key.
private final class KeyScroll: UIScrollView {
    override func touchesShouldCancel(in view: UIView) -> Bool { true }
}

/// One key: a rounded cap as the system keyboard draws its keys, with a label or (hide-keyboard) a symbol.
private final class KeyCap: UIControl {
    let key: TerminalKeys.Key
    private let content: UIView
    private let ground = UIColor { $0.userInterfaceStyle == .dark ? UIColor(white: 0.42, alpha: 1) : .white }
    private let pressedGround = UIColor { $0.userInterfaceStyle == .dark ? UIColor(white: 0.3, alpha: 1) : UIColor(white: 0.82, alpha: 1) }

    init(key: TerminalKeys.Key) {
        self.key = key
        if key.kind == .hideKeyboard {
            let image = UIImageView(image: UIImage(systemName: "keyboard.chevron.compact.down"))
            image.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 15)
            content = image
        } else {
            let label = UILabel()
            label.text = key.label
            label.font = .monospacedSystemFont(ofSize: key.repeats ? 17 : 15, weight: .regular)
            content = label
        }
        super.init(frame: .zero)
        layer.cornerRadius = 6
        layer.cornerCurve = .continuous
        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOffset = CGSize(width: 0, height: 1)
        layer.shadowRadius = 0
        layer.shadowOpacity = 0.3
        content.isUserInteractionEnabled = false
        content.translatesAutoresizingMaskIntoConstraints = false
        addSubview(content)
        NSLayoutConstraint.activate([
            content.centerXAnchor.constraint(equalTo: centerXAnchor),
            content.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
        setContentHuggingPriority(.required, for: .horizontal)
        setContentCompressionResistancePriority(.required, for: .horizontal)

        isAccessibilityElement = true
        accessibilityLabel = Self.spokenName(key.id) ?? key.label
        restyle()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not in a nib") }

    /// At least 38 points wide, with 9 on each side of the label; 34 high.
    override var intrinsicContentSize: CGSize {
        CGSize(width: max(38, content.intrinsicContentSize.width + 18), height: 34)
    }

    override var isHighlighted: Bool { didSet { restyle() } }
    override var isSelected: Bool { didSet { restyle() } }

    override var accessibilityTraits: UIAccessibilityTraits {
        get { isSelected ? [.button, .selected] : .button }
        set {}
    }

    /// The ground and ink for the state: the accent when armed (Ctrl, Alt), darker while pressed.
    /// The colours are dynamic, so light and dark follow the system without a redraw here.
    private func restyle() {
        let armed = isSelected
        backgroundColor = armed ? UIColor(Theme.accent) : isHighlighted ? pressedGround : ground
        let ink: UIColor = armed ? .white : .label
        (content as? UILabel)?.textColor = ink
        content.tintColor = ink
    }

    /// Spoken names for the keys whose label says little; the rest read their label.
    private static func spokenName(_ id: String) -> String? {
        switch id {
        case "esc": return String(localized: "Escape")
        case "backTab": return String(localized: "Shift-Tab")
        case "ctrl": return String(localized: "Control, applies to the next key")
        case "alt": return String(localized: "Alt, applies to the next key")
        case "ctrlC": return String(localized: "Control-C, interrupt")
        case "pageUp": return String(localized: "Page Up")
        case "pageDown": return String(localized: "Page Down")
        case "left": return String(localized: "Left arrow")
        case "down": return String(localized: "Down arrow")
        case "up": return String(localized: "Up arrow")
        case "right": return String(localized: "Right arrow")
        case "hideKeyboard": return String(localized: "Hide keyboard")
        default: return nil
        }
    }
}
