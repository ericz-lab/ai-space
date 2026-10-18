import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// Handle Paste in the actual first responder. SwiftUI's TextField owns a field editor that
/// consumes the Paste command before an onPasteCommand modifier can receive image providers.
@MainActor
final class ChatTextEditor: NSTextView {
    var onImage: (Data) -> Void = { _ in }
    var onImageFile: (URL) -> Void = { _ in }
    var onSend: () -> Void = {}
    var pasteboard: () -> NSPasteboard = { .general }
    var onFocus: (Bool) -> Void = { _ in }

    override func becomeFirstResponder() -> Bool {
        let accepted = super.becomeFirstResponder()
        if accepted { onFocus(true) }
        return accepted
    }

    override func resignFirstResponder() -> Bool {
        let accepted = super.resignFirstResponder()
        if accepted { onFocus(false) }
        return accepted
    }

    @discardableResult
    func pasteImages(from pasteboard: NSPasteboard) -> Bool {
        // Finder may also supply a TIFF icon: prefer the copied files over that icon.
        if let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL],
           !urls.isEmpty, urls.allSatisfy({ UTType(filenameExtension: $0.pathExtension)?.conforms(to: .image) == true }) {
            urls.forEach(onImageFile)
            return true
        }
        if let data = pasteboard.data(forType: .png) ?? pasteboard.data(forType: .tiff) {
            onImage(data)
            return true
        }
        return false
    }

    override func paste(_ sender: Any?) {
        if !pasteImages(from: pasteboard()) { super.paste(sender) }
    }

    override func keyDown(with event: NSEvent) {
        if (event.keyCode == 36 || event.keyCode == 76), !event.modifierFlags.contains(.shift), !hasMarkedText() {
            onSend()
        } else {
            super.keyDown(with: event)
        }
    }

    override func validateUserInterfaceItem(_ item: NSValidatedUserInterfaceItem) -> Bool {
        if item.action == #selector(paste(_:)), pasteboard().canReadItem(withDataConformingToTypes: [UTType.image.identifier, UTType.fileURL.identifier]) {
            return true
        }
        return super.validateUserInterfaceItem(item)
    }
}

struct ChatTextInput: NSViewRepresentable {
    @Binding var text: String
    @Binding var focused: Bool
    var placeholder: String
    var onImage: (Data) -> Void
    var onImageFile: (URL) -> Void
    var onSend: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        let editor = ChatTextEditor(frame: .zero)
        editor.isRichText = false
        editor.importsGraphics = false
        editor.drawsBackground = false
        editor.font = .systemFont(ofSize: 14)
        editor.textColor = .labelColor
        editor.insertionPointColor = .labelColor
        editor.textContainerInset = .zero
        editor.textContainer?.lineFragmentPadding = 0
        editor.minSize = NSSize(width: 0, height: 20)
        editor.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        editor.isVerticallyResizable = true
        editor.isHorizontallyResizable = false
        editor.autoresizingMask = [.width]
        editor.textContainer?.widthTracksTextView = true
        editor.delegate = context.coordinator
        scroll.documentView = editor
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let editor = scroll.documentView as? ChatTextEditor else { return }
        context.coordinator.parent = self
        editor.onImage = onImage
        editor.onImageFile = onImageFile
        editor.onSend = onSend
        editor.onFocus = { value in
            DispatchQueue.main.async { focused = value }
        }
        editor.setAccessibilityLabel(placeholder)
        if editor.string != text && !editor.hasMarkedText() { editor.string = text }
        if focused && !context.coordinator.wasFocused {
            DispatchQueue.main.async { [weak editor] in
                guard let editor else { return }
                editor.window?.makeFirstResponder(editor)
            }
        }
        context.coordinator.wasFocused = focused
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSScrollView, context: Context) -> CGSize? {
        guard let width = proposal.width, let editor = nsView.documentView as? ChatTextEditor,
              let container = editor.textContainer, let layout = editor.layoutManager else { return nil }
        editor.setFrameSize(NSSize(width: width, height: editor.frame.height))
        container.containerSize = NSSize(width: width, height: .greatestFiniteMagnitude)
        layout.ensureLayout(for: container)
        let height = max(20, ceil(layout.usedRect(for: container).height + layout.extraLineFragmentRect.height))
        editor.setFrameSize(NSSize(width: width, height: height))
        return CGSize(width: width, height: min(160, height))
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ChatTextInput
        var wasFocused = false
        init(_ parent: ChatTextInput) { self.parent = parent }
        func textDidChange(_ notification: Notification) {
            guard let editor = notification.object as? NSTextView else { return }
            parent.text = editor.string
        }
    }
}
