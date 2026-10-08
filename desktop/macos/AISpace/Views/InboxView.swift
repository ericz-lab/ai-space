import SwiftUI

/// The Space's inbox, natively: open threads newest first, with read and done.
struct InboxView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var live: SpaceLive

    var body: some View {
        Group {
            if live.inbox.isEmpty {
                ContentUnavailableView(live.status == .signInNeeded ? "Sign in on Home first" : "Nothing open",
                                       systemImage: "tray")
            } else {
                List(live.inbox) { item in
                    InboxRow(model: model, live: live, item: item)
                }
                .listStyle(.inset)
            }
        }
        .navigationTitle("Inbox")
        .toolbar {
            ToolbarItem {
                Button {
                    Task { await live.mark(live.inbox.filter(\.unread).map(\.thread), read: true) }
                } label: { Label("Mark All as Read", systemImage: "envelope.open") }
                    .disabled(!live.inbox.contains(where: \.unread))
            }
        }
        .task { await live.refresh() }
    }
}

private struct InboxRow: View {
    let model: AppModel
    let live: SpaceLive
    let item: InboxItem

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Circle().fill(item.unread ? Color.accentColor : .clear).frame(width: 8, height: 8).padding(.top, 6)
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(item.title?.isEmpty == false ? item.title! : item.app).font(.headline).lineLimit(1)
                    if item.count > 1 { Text("×\(item.count)").font(.caption).foregroundStyle(.secondary) }
                    Spacer()
                    Text(Self.when(item.lastAt)).font(.caption).foregroundStyle(.secondary)
                }
                Text(item.app).font(.caption).foregroundStyle(.secondary)
                Text(item.text).lineLimit(4).foregroundStyle(item.level == "alert" ? .red : .primary)
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .onTapGesture(count: 2) { open() }
        .contextMenu {
            if item.url != nil { Button("Open") { open() } }
            Button(item.unread ? "Mark as Read" : "Mark as Unread") { Task { await live.mark([item.thread], read: item.unread) } }
            Button("Done") { Task { await live.mark([item.thread], read: true, done: true) } }
        }
        .swipeActions {
            Button("Done") { Task { await live.mark([item.thread], read: true, done: true) } }.tint(.green)
        }
    }

    private func open() {
        model.openInboxItem(connection: live.connection.id, url: item.url)
        if item.unread { Task { await live.mark([item.thread], read: true) } }
    }

    /// Server timestamps are ISO 8601 instants; shown relative, in the Mac's own zone (docs/time.md).
    static func when(_ iso: String) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return "" }
        return RelativeDateTimeFormatter().localizedString(for: date, relativeTo: Date())
    }
}
