import Photos
import SwiftUI
import UIKit

/// A screenshot taken while the app is on screen, offered to the apps of the Space that keep pictures.
///
/// iOS says only that a screenshot was taken (`userDidTakeScreenshotNotification`, after the
/// fact, with no image). So the app offers to keep it; on the operator's tap it reads the newest
/// screenshot from Photos (read access is asked for then, not before), lets them add a line and
/// sends it where they chose on the offer, one of the Space's capture targets (Spark, Notes,
/// Todo, …; `GET /api/capture`), to `POST /api/capture/image?to=<target>`, which hands it to that app as the operator. When Photos cannot give the screenshot (access refused or limited, or it is
/// not there yet), the operator picks it. Nothing is kept on the phone after the answer.
@MainActor
final class ScreenshotCapture: ObservableObject {
    enum Phase: Equatable {
        case idle
        /// The offer at the bottom of the screen, after a screenshot at this time.
        case offered(Date)
        case loading
        /// The picture could not be read from Photos; `reason` says why, and the operator picks one.
        case needsPick(String)
        case composing
        case saving
        case saved(label: String, url: URL?)
        case failed(String)
    }

    struct Picture {
        let data: Data
        let kind: ScreenshotRules.Kind
        let preview: UIImage
        /// Kept for every retry of this picture.
        let id = UUID()
    }

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var picture: Picture?
    @Published var text = ""
    @Published var showingPicker = false
    /// Where the Space can keep the picture, and the one chosen (remembered across launches).
    @Published private(set) var targets: [ScreenshotRules.Target] = []
    @Published private(set) var target: ScreenshotRules.Target?
    private static let lastTargetKey = "screenshotTarget"

    /// The Space screenshots go to, and whether it can keep them (nil: not asked yet); set by the app model.
    private var api: SpaceAPI?
    private var available: Bool?
    private var dismissTask: Task<Void, Never>?
    /// Opens a Spark idea's page in the app.
    var openPage: ((URL) -> Void)?

    var isOffer: Bool { if case .offered = phase { return true } else { return false } }

    /// The Space on show; another one is asked again whether it has an image capturer.
    func use(_ api: SpaceAPI?) {
        if self.api?.base != api?.base { available = nil }
        self.api = api
    }

    /// Forget the answer, so the next screenshot asks again (the app came back to the foreground).
    func recheck() { available = nil }

    /// The operator took a screenshot with the app on screen.
    func screenshotTaken(at date: Date = Date()) {
        guard let api else { return }
        Task {
            if available == nil {
                let answer = try? await api.get("/api/capture", as: ScreenshotRules.Availability.self)
                guard self.api?.base == api.base else { return }
                available = answer?.image ?? false
                targets = answer?.targets ?? []
                target = ScreenshotRules.preferred(targets, last: UserDefaults.standard.string(forKey: Self.lastTargetKey))
            }
            guard available == true else { return }
            offer(at: date)
        }
    }

    private func offer(at date: Date) {
        // A picture already on its way or being written for is not interrupted.
        switch phase {
        case .idle, .offered, .saved: break
        default: return
        }
        picture = nil
        text = ""
        phase = .offered(date)
        dismissTask?.cancel()
        dismissTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(ScreenshotRules.offerSeconds))
            guard let self, !Task.isCancelled, self.isOffer else { return }
            withAnimation { self.phase = .idle }
        }
    }

    func dismiss() {
        dismissTask?.cancel()
        withAnimation { phase = .idle }
        picture = nil
        text = ""
    }

    /// The offer was taken for `target` (none: an older Space that names no targets): find the screenshot in Photos.
    func accept(_ target: ScreenshotRules.Target? = nil) {
        guard case .offered(let noticed) = phase else { return }
        if let target { choose(target) }
        dismissTask?.cancel()
        phase = .loading
        Task {
            let status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
            guard status == .authorized || status == .limited else {
                phase = .needsPick(String(localized: "Photos access is off, so pick the screenshot."))
                return
            }
            if let data = await Self.newestScreenshot(after: noticed), let picture = Self.picture(from: data) {
                self.picture = picture
                phase = .composing
            } else {
                phase = .needsPick(status == .limited
                    ? String(localized: "Photos access is limited to some pictures, so pick the screenshot.")
                    : String(localized: "The screenshot is not in Photos yet, so pick it."))
            }
        }
    }

    /// A picture the operator picked instead.
    func picked(_ data: Data?) {
        guard let data, let picture = Self.picture(from: data) else {
            phase = .needsPick(String(localized: "That picture could not be read. Pick another one."))
            return
        }
        self.picture = picture
        phase = .composing
    }

    func choose(_ target: ScreenshotRules.Target) {
        self.target = target
        UserDefaults.standard.set(target.id, forKey: Self.lastTargetKey)
    }

    /// Send the picture and the words to the chosen target; a retry sends the same id.
    func save() {
        guard let api, let picture else { return }
        let target = self.target
        phase = .saving
        Task {
            do {
                let data = try await api.upload(
                    ScreenshotRules.uploadPath(to: target), field: "file", filename: "screenshot.\(picture.kind.fileExtension)",
                    mimeType: picture.kind.mimeType, data: picture.data,
                    fields: ScreenshotRules.fields(id: picture.id, text: text, via: "screenshot"), timeout: 60)
                let answer = try JSONDecoder().decode(ScreenshotRules.Answer.self, from: data)
                phase = .saved(label: ScreenshotRules.receipt(answer, target: target), url: answer.url.flatMap(URL.init(string:)))
                dismissTask?.cancel()
                dismissTask = Task {
                    try? await Task.sleep(for: .seconds(4))
                    guard !Task.isCancelled, case .saved = self.phase else { return }
                    self.dismiss()
                }
            } catch SpaceAPIError.http(let status, let message) {
                phase = .failed(String(localized: "Not saved (\(status)): \(message)"))
            } catch SpaceAPIError.authenticationRequired {
                phase = .failed(String(localized: "Sign in to the Space again, then retry."))
            } catch {
                phase = .failed(String(localized: "Not saved: \(error.localizedDescription)"))
            }
        }
    }

    func open(_ url: URL) {
        dismiss()
        openPage?(url)
    }

    // MARK: Photos and encoding

    /// The newest screenshot in Photos taken around the notice. iOS may write it a moment after
    /// telling the app, so the library is asked a few times.
    private static func newestScreenshot(after noticed: Date) async -> Data? {
        for attempt in 0..<6 {
            if attempt > 0 { try? await Task.sleep(for: .milliseconds(500)) }
            let options = PHFetchOptions()
            options.predicate = NSPredicate(format: "(mediaSubtypes & %d) != 0", PHAssetMediaSubtype.photoScreenshot.rawValue)
            options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
            options.fetchLimit = 1
            guard let asset = PHAsset.fetchAssets(with: .image, options: options).firstObject,
                  ScreenshotRules.isFresh(created: asset.creationDate, noticed: noticed) else { continue }
            return await data(of: asset)
        }
        return nil
    }

    private static func data(of asset: PHAsset) async -> Data? {
        await withCheckedContinuation { continuation in
            let options = PHImageRequestOptions()
            options.isNetworkAccessAllowed = true
            options.deliveryMode = .highQualityFormat
            options.version = .current
            PHImageManager.default().requestImageDataAndOrientation(for: asset, options: options) { data, _, _, _ in
                continuation.resume(returning: data)
            }
        }
    }

    static func picture(from data: Data) -> Picture? {
        guard let prepared = CapturePicture.prepare(data) else { return nil }
        return Picture(data: prepared.data, kind: prepared.kind, preview: prepared.preview)
    }
}
