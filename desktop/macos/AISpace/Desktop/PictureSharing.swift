import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// Owns the import window; the editor and retry contract are shared with the iPhone extension.
@MainActor
final class PictureSharing {
    private unowned let app: AppModel
    private var window: NSWindow?
    private var model: SharedCaptureModel?

    init(app: AppModel) { self.app = app }

    func show() {
        if let window, window.isVisible { window.makeKeyAndOrderFront(nil); return }
        let storage = (try? ShareAccess.store()) ?? SharedCaptureStore(
            directory: DesktopPaths.support.appendingPathComponent("PendingShares", isDirectory: true))
        let publicationError: Error?
        do { try storage.publish(app.store.connections); publicationError = nil }
        catch { publicationError = error }
        let model = SharedCaptureModel(store: storage, load: { [weak app] connection in
            guard let app, app.store.connections.contains(connection) else { throw SpaceAPIError.authenticationRequired }
            return try await app.loader(for: connection).api.get("/api/capture", as: ScreenshotRules.Availability.self)
        }, upload: { [weak app] connection, item, target in
            guard let app, app.store.connections.contains(connection),
                  let kind = ScreenshotRules.sendable(item.image) else { throw SpaceAPIError.authenticationRequired }
            let data = try await app.loader(for: connection).api.upload(ScreenshotRules.uploadPath(to: target),
                field: "file", filename: "shared.\(kind.fileExtension)", mimeType: kind.mimeType, data: item.image,
                fields: ScreenshotRules.fields(id: item.id, text: item.text, via: "share"), timeout: 60)
            return try JSONDecoder().decode(ScreenshotRules.Answer.self, from: data)
        })
        self.model = model
        if let publicationError { model.report(publicationError.localizedDescription) }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 650),
                              styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = String(localized: "Share Picture…")
        window.contentView = NSHostingView(rootView: SharedCaptureView(model: model) { [weak self] in
            self?.window?.orderOut(nil)
        }.frame(minWidth: 420, minHeight: 480))
        window.center()
        self.window = window
        window.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }

    func choose() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.image]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        show()
        do {
            let data = try PictureImport.read(url)
            receive(data)
        } catch { model?.report(error.localizedDescription) }
    }

    func paste() {
        show()
        let pasteboard = NSPasteboard.general
        if let data = pasteboard.data(forType: .png) ?? pasteboard.data(forType: .tiff) {
            receive(data)
        } else if let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], urls.count == 1 {
            do { receive(try PictureImport.read(urls[0])) }
            catch { model?.report(error.localizedDescription) }
        } else { model?.report(String(localized: "Copy one picture first.")) }
    }

    private func receive(_ data: Data) {
        guard let model, !model.busy, !model.receiving else { return }
        model.beginImport()
        Task { await model.receive(data) }
    }
}
