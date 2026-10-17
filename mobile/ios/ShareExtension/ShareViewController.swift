import SwiftUI
import UniformTypeIdentifiers

/// The system supplies the image; no photo-library permission or containing-app launch is needed.
final class ShareViewController: UIViewController {
    private let model = SharedCaptureModel()
    private var importTask: Task<Void, Never>?

    override func viewDidLoad() {
        super.viewDidLoad()
        let host = UIHostingController(rootView: SharedCaptureView(model: model) { [weak self] in
            self?.extensionContext?.completeRequest(returningItems: nil)
        })
        addChild(host)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        host.didMove(toParent: self)
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
                    provider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { url, error in
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
                await self?.model.receive(data)
            } catch { self?.model.report(error.localizedDescription) }
        }
    }
}
