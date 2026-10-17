import SwiftUI
import UniformTypeIdentifiers

/// The system supplies the image; no photo-library permission or containing-app launch is needed.
final class ShareViewController: NSViewController {
    private let model = SharedCaptureModel()
    private var importTask: Task<Void, Never>?

    override func loadView() { view = NSView(frame: NSRect(x: 0, y: 0, width: 480, height: 560)) }

    override func viewDidLoad() {
        super.viewDidLoad()
        let host = NSHostingController(rootView: SharedCaptureView(model: model) { [weak self] in
            guard let self else { return }
            self.importTask?.cancel()
            if self.model.receipt != nil {
                self.extensionContext?.completeRequest(returningItems: nil)
            } else {
                self.extensionContext?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
            }
        }.frame(width: 480, height: 560))
        host.sizingOptions = []
        addChild(host)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        preferredContentSize = NSSize(width: 480, height: 560)
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? [])
            .flatMap { $0.attachments ?? [] }.filter { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }
        guard providers.count == 1, let provider = providers.first else {
            model.report(String(localized: "Share one picture at a time."))
            return
        }
        model.beginImport()
        importTask = Task { [weak self] in
            do {
                let data: Data = try await withCheckedThrowingContinuation { continuation in
                    provider.loadFileRepresentation(forTypeIdentifier: provider.registeredTypeIdentifiers.first(where: {
                        UTType($0)?.conforms(to: .image) == true
                    }) ?? UTType.image.identifier) { url, error in
                        do {
                            if let error { throw error }
                            guard let url else { throw CocoaError(.fileReadUnknown) }
                            let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                            guard size > 0 && size <= 40 * 1024 * 1024 else { throw CocoaError(.fileReadTooLarge) }
                            // The provider's temporary file is valid only during this callback.
                            continuation.resume(returning: try Data(contentsOf: url))
                        } catch { continuation.resume(throwing: error) }
                    }
                }
                guard !Task.isCancelled else { return }
                guard let picture = MacSharedPicture.data(data) else {
                    self?.model.report(String(localized: "That picture could not be read. Pick another one."))
                    return
                }
                await self?.model.receive(picture)
            } catch { self?.model.report(error.localizedDescription) }
        }
    }
}
