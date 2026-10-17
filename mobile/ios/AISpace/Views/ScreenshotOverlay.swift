import Combine
import PhotosUI
import SwiftUI
import UIKit

/// The screenshot offer and its card, in a window of their own above the app's, so they show over
/// whatever is on screen: Home, an app's page or one of the Space's pages, each of which may be a
/// full-screen cover. While only the offer is up, touches outside it go through to the app.
@MainActor
final class ScreenshotOverlay {
    private let capture: ScreenshotCapture
    private var window: OverlayWindow?
    private var watch: AnyCancellable?

    init(capture: ScreenshotCapture) {
        self.capture = capture
        watch = capture.$phase.receive(on: RunLoop.main).sink { [weak self] phase in self?.show(phase) }
    }

    private func show(_ phase: ScreenshotCapture.Phase) {
        if phase == .idle {
            window?.isHidden = true
            // The app's own window takes the keyboard and the touches back.
            window?.windowScene?.windows.first { !($0 is OverlayWindow) }?.makeKey()
            return
        }
        let window = self.window ?? makeWindow()
        guard let window else { return }
        let card: Bool
        switch phase {
        case .offered, .saved: card = false
        default: card = true
        }
        window.takesAllTouches = card
        window.isHidden = false
        if card { window.makeKey() }
    }

    private func makeWindow() -> OverlayWindow? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        guard let scene = scenes.first(where: { $0.activationState == .foregroundActive }) ?? scenes.first else { return nil }
        let window = OverlayWindow(windowScene: scene)
        window.windowLevel = .normal + 1
        window.backgroundColor = .clear
        let host = UIHostingController(rootView: ScreenshotOverlayView(capture: capture) { [weak window] rect in window?.offerFrame = rect })
        host.view.backgroundColor = .clear
        window.rootViewController = host
        // The app's look: its theme and its light or dark choice.
        window.overrideUserInterfaceStyle = scene.windows.first?.overrideUserInterfaceStyle ?? .unspecified
        self.window = window
        return window
    }
}

/// Touches go through outside the offer unless the card is up.
final class OverlayWindow: UIWindow {
    var takesAllTouches = false
    var offerFrame: CGRect = .zero

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard takesAllTouches || offerFrame.contains(point) else { return nil }
        return super.hitTest(point, with: event)
    }
}

struct ScreenshotOverlayView: View {
    @ObservedObject var capture: ScreenshotCapture
    /// Where the offer is drawn, in the window's coordinates.
    let reportOffer: (CGRect) -> Void
    @State private var pickerItem: PhotosPickerItem?
    @FocusState private var writing: Bool

    var body: some View {
        ZStack(alignment: .bottom) {
            switch capture.phase {
            case .idle:
                Color.clear
            case .offered:
                offer
            case .saved(let id, let url):
                saved(id: id, url: url)
            default:
                Color.black.opacity(0.35)
                    .ignoresSafeArea()
                    .onTapGesture { if capture.phase != .saving { writing = false } }
                card
                    .padding(.horizontal, 16)
                    .frame(maxHeight: .infinity, alignment: writing ? .top : .center)
                    .padding(.top, writing ? 12 : 0)
            }
        }
        .animation(.snappy, value: capture.phase)
        .animation(.snappy, value: writing)
        .photosPicker(isPresented: $capture.showingPicker, selection: $pickerItem, matching: .screenshots)
        .onChange(of: pickerItem) { _, item in
            guard let item else { return }
            pickerItem = nil
            Task { capture.picked(try? await item.loadTransferable(type: Data.self)) }
        }
    }

    // MARK: The offer and the receipt

    private var offer: some View {
        bar {
            Image(systemName: "camera.viewfinder").font(.title3).foregroundStyle(Theme.accent)
            VStack(alignment: .leading, spacing: 2) {
                Text("Keep this screenshot?").font(.subheadline.weight(.semibold))
                Text("Save it to Spark").font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Button("Save") { capture.accept() }
                .buttonStyle(.borderedProminent).controlSize(.small)
            Button { capture.dismiss() } label: { Image(systemName: "xmark").font(.footnote.weight(.semibold)) }
                .buttonStyle(.plain).foregroundStyle(.secondary)
                .accessibilityLabel(Text("Dismiss"))
        }
    }

    private func saved(id: Int, url: URL?) -> some View {
        bar {
            Image(systemName: "checkmark.circle.fill").font(.title3).foregroundStyle(Theme.success)
            Text("Saved to Spark #\(id)").font(.subheadline.weight(.semibold))
            Spacer(minLength: 8)
            if let url {
                Button("Open") { capture.open(url) }.buttonStyle(.bordered).controlSize(.small)
            }
            Button { capture.dismiss() } label: { Image(systemName: "xmark").font(.footnote.weight(.semibold)) }
                .buttonStyle(.plain).foregroundStyle(.secondary)
                .accessibilityLabel(Text("Dismiss"))
        }
    }

    private func bar<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        HStack(spacing: 12, content: content)
            .padding(.horizontal, 16).padding(.vertical, 12)
            .modifier(Glass(radius: 22))
            .padding(.horizontal, 16).padding(.bottom, 12)
            .background(GeometryReader { g in
                Color.clear
                    .onAppear { reportOffer(g.frame(in: .global)) }
                    .onChange(of: g.frame(in: .global)) { _, frame in reportOffer(frame) }
            })
            .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    // MARK: The card

    private var card: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Save to Spark").font(.headline)
                Spacer()
                Button("Cancel") { capture.dismiss() }.disabled(capture.phase == .saving)
            }
            switch capture.phase {
            case .loading:
                HStack(spacing: 10) { ProgressView(); Text("Reading the screenshot…").foregroundStyle(.secondary) }
                    .frame(maxWidth: .infinity, minHeight: 120)
            case .needsPick(let reason):
                Text(reason).font(.subheadline).foregroundStyle(.secondary)
                Button { capture.showingPicker = true } label: {
                    Label("Pick the Screenshot", systemImage: "photo.on.rectangle").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
            default:
                compose
            }
        }
        .padding(18)
        .modifier(Glass(radius: 24))
    }

    @ViewBuilder private var compose: some View {
        if let picture = capture.picture {
            Image(uiImage: picture.preview)
                .resizable().scaledToFit()
                .frame(maxWidth: .infinity, maxHeight: writing ? 140 : 320)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.hairline))
        }
        TextField(String(localized: "Add a line (optional)"), text: $capture.text, axis: .vertical)
            .lineLimit(1...4)
            .focused($writing)
            .padding(10)
            .background(.background.opacity(0.6), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .disabled(capture.phase == .saving)
        if case .failed(let message) = capture.phase {
            Text(message).font(.footnote).foregroundStyle(Theme.danger)
        }
        Button {
            writing = false
            capture.save()
        } label: {
            HStack {
                if capture.phase == .saving { ProgressView().tint(.white) }
                Text(capture.isFailed ? "Retry" : "Save").frame(maxWidth: .infinity)
            }
        }
        .buttonStyle(.borderedProminent)
        .disabled(capture.phase == .saving || capture.picture == nil)
    }
}

extension ScreenshotCapture {
    var isFailed: Bool { if case .failed = phase { return true } else { return false } }
}
