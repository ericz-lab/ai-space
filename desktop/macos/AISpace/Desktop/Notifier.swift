import AppKit
import UserNotifications

/// Inbox threads as Mac notifications, with Mark as Read and Done on the notification itself,
/// and the unread count on the Dock icon. The inbox stays the record; a notification is a pointer.
@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let category = "inbox"
    static let markRead = "mark-read"
    static let markDone = "mark-done"

    /// The app routes a click (open the item) and the two actions back to the right connection.
    var onOpen: (_ connection: UUID, _ url: String?) -> Void = { _, _ in }
    var onMark: (_ connection: UUID, _ thread: String, _ done: Bool) -> Void = { _, _, _ in }

    private var center: UNUserNotificationCenter { .current() }
    private var asked = false

    func setUp() {
        center.delegate = self
        center.setNotificationCategories([
            UNNotificationCategory(identifier: Self.category, actions: [
                UNNotificationAction(identifier: Self.markRead, title: String(localized: "Mark as Read")),
                UNNotificationAction(identifier: Self.markDone, title: String(localized: "Done")),
            ], intentIdentifiers: []),
        ])
    }

    func post(_ items: [InboxItem], from connection: Connection, showName: Bool) {
        guard Preferences.shared.notifications, !items.isEmpty else { return }
        Task {
            if !asked {
                asked = true
                do {
                    _ = try await center.requestAuthorization(options: [.alert, .sound])
                } catch {
                    NSLog("ai-space: notifications not allowed: \(error.localizedDescription)")
                }
            }
            for item in items.prefix(5) {
                let content = UNMutableNotificationContent()
                content.title = item.title?.isEmpty == false ? item.title! : item.app
                content.subtitle = showName ? "\(item.app) · \(connection.name)" : item.app
                content.body = String(item.text.prefix(400))
                content.categoryIdentifier = Self.category
                content.threadIdentifier = "\(connection.id.uuidString)/\(item.thread)"
                content.userInfo = ["connection": connection.id.uuidString, "thread": item.thread, "url": item.url ?? ""]
                if item.level == "alert" || item.level == "warn" { content.sound = .default }
                let request = UNNotificationRequest(identifier: "\(connection.id.uuidString)/\(item.thread)/\(item.lastAt)", content: content, trigger: nil)
                do {
                    try await center.add(request)
                } catch {
                    NSLog("ai-space: could not post a notification: \(error.localizedDescription)")
                }
            }
        }
    }

    func setBadge(_ unread: Int) {
        NSApp.dockTile.badgeLabel = unread > 0 ? (unread > 99 ? "99+" : String(unread)) : nil
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        guard let id = (info["connection"] as? String).flatMap(UUID.init(uuidString:)), let thread = info["thread"] as? String else { return }
        let url = info["url"] as? String
        let action = response.actionIdentifier
        await MainActor.run {
            switch action {
            case Self.markRead: onMark(id, thread, false)
            case Self.markDone: onMark(id, thread, true)
            default: onOpen(id, url?.isEmpty == false ? url : nil)
            }
        }
    }
}
