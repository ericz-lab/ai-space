import Foundation

/// Where the app keeps its own files: saved Spaces and screens under Application Support,
/// the last catalogue under Caches. Nothing here is a Space workspace.
enum AppPaths {
    static let bundleID = Bundle.main.bundleIdentifier ?? "dev.ai-space.ios"

    static var support: URL {
        #if DEBUG
        if let dir = ProcessInfo.processInfo.environment["AISPACE_DATA_DIR"], !dir.isEmpty {
            return URL(fileURLWithPath: dir, isDirectory: true)
        }
        #endif
        // The bundle id keeps a Mac Catalyst build, which is not sandboxed, apart from the Mac client's files.
        return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(bundleID, isDirectory: true)
    }

    static var caches: URL {
        #if DEBUG
        if let dir = ProcessInfo.processInfo.environment["AISPACE_DATA_DIR"], !dir.isEmpty {
            return URL(fileURLWithPath: dir, isDirectory: true).appendingPathComponent("caches", isDirectory: true)
        }
        #endif
        return FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(bundleID, isDirectory: true)
    }

    /// Files a page downloaded, on their way to the share sheet; emptied at launch.
    static var downloads: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent(bundleID, isDirectory: true)
            .appendingPathComponent("downloads", isDirectory: true)
    }

    static func icons(_ connection: UUID) -> URL {
        caches.appendingPathComponent("icons", isDirectory: true).appendingPathComponent(connection.uuidString, isDirectory: true)
    }

    /// The themes' artwork as it was last drawn for a Space (BackdropStore).
    static func backdrops(_ connection: UUID) -> URL {
        caches.appendingPathComponent("backdrops", isDirectory: true).appendingPathComponent(connection.uuidString, isDirectory: true)
    }

    static var connections: URL { support.appendingPathComponent("connections.json") }
    static var screens: URL { support.appendingPathComponent("screens.json") }
}
