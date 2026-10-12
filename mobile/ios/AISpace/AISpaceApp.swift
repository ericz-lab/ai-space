import SwiftUI
import UIKit

@main
struct AISpaceApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            RootView(model: model)
                .tint(Theme.accent)
                .onOpenURL { model.handle($0) }
                .onReceive(NotificationCenter.default.publisher(for: .quickAction)) { note in
                    if let url = note.object as? URL { model.handle(url) }
                }
                .onChange(of: phase) { _, now in
                    if now == .active { model.becameActive() }
                }
                .onAppear {
                    if let url = AppDelegate.launchAction {
                        AppDelegate.launchAction = nil
                        model.handle(url)
                    }
                    #if DEBUG
                    DebugLaunch.apply(to: model)
                    #endif
                }
        }
    }
}

extension Notification.Name {
    static let quickAction = Notification.Name("dev.ai-space.ios.quickAction")
}

/// Home-screen quick actions reach the app through the scene delegate; each carries an
/// `aispace://` link, which goes the same way as a link from another app.
final class AppDelegate: NSObject, UIApplicationDelegate {
    /// The action the app was launched with, picked up once the first view is there.
    @MainActor static var launchAction: URL?

    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        if let item = options.shortcutItem { Self.launchAction = SceneDelegate.url(of: item) }
        let config = UISceneConfiguration(name: nil, sessionRole: session.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}

final class SceneDelegate: NSObject, UIWindowSceneDelegate {
    func windowScene(_ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem,
                     completionHandler: @escaping (Bool) -> Void) {
        let url = Self.url(of: shortcutItem)
        if let url { NotificationCenter.default.post(name: .quickAction, object: url) }
        completionHandler(url != nil)
    }

    #if targetEnvironment(macCatalyst)
    /// The Mac Catalyst build exists to check the phone's layout on a Mac: keep the window phone-sized.
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let size = CGSize(width: 430, height: 900)
        scene.sizeRestrictions?.minimumSize = size
        scene.sizeRestrictions?.maximumSize = size
    }
    #endif

    static func url(of item: UIApplicationShortcutItem) -> URL? {
        guard item.type == QuickAction.type, let text = item.userInfo?["url"] as? String else { return nil }
        return URL(string: text)
    }
}
