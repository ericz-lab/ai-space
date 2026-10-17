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
                    if let target = note.object as? QuickAction.Target { model.handle(target) }
                }
                .onReceive(NotificationCenter.default.publisher(for: UIApplication.userDidTakeScreenshotNotification)) { _ in
                    model.screenshotTaken()
                }
                .onChange(of: phase) { _, now in
                    if now == .active { model.becameActive() }
                }
                .onAppear {
                    if let target = AppDelegate.launchAction {
                        AppDelegate.launchAction = nil
                        model.handle(target)
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
/// `aispace://` link, which goes the same way as a link from another app, and the Space it is for.
final class AppDelegate: NSObject, UIApplicationDelegate {
    /// The action the app was launched with, picked up once the first view is there.
    @MainActor static var launchAction: QuickAction.Target?

    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        if let item = options.shortcutItem { Self.launchAction = SceneDelegate.target(of: item) }
        let config = UISceneConfiguration(name: nil, sessionRole: session.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}

final class SceneDelegate: NSObject, UIWindowSceneDelegate {
    func windowScene(_ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem,
                     completionHandler: @escaping (Bool) -> Void) {
        let target = Self.target(of: shortcutItem)
        if let target { NotificationCenter.default.post(name: .quickAction, object: target) }
        completionHandler(target != nil)
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

    static func target(of item: UIApplicationShortcutItem) -> QuickAction.Target? {
        guard item.type == QuickAction.type else { return nil }
        return QuickAction.target(userInfo: item.userInfo)
    }
}
