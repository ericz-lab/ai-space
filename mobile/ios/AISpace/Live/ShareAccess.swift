import Foundation
import Security

/// Only cookies matching the capture endpoint are shared, isolated by saved Space and origin.
/// Credentials stay in a device-only shared Keychain group; App Group files hold no cookies.
enum ShareAccess {
    static var appGroup: String {
        #if os(macOS)
        return Bundle.main.object(forInfoDictionaryKey: "ShareAppGroup") as? String ?? ""
        #else
        return "group.dev.ai-space.ios"
        #endif
    }

    static func store() throws -> SharedCaptureStore {
        guard !appGroup.isEmpty, !appGroup.contains("$("), let url = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else {
            throw ShareAccessError.unavailable
        }
        return SharedCaptureStore(directory: url.appendingPathComponent("Capture", isDirectory: true))
    }

    private static func query(_ connection: Connection) throws -> [String: Any] {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "ShareKeychainGroup") as? String,
              !group.contains("$("), !group.isEmpty else { throw ShareAccessError.unavailable }
        var result: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: "ai-space.capture-session",
                kSecAttrAccount as String: "\(connection.id.uuidString)|\(connection.url.absoluteString)",
                kSecAttrAccessGroup as String: group]
        #if os(macOS)
        result[kSecUseDataProtectionKeychain as String] = true
        #endif
        return result
    }

    static func publish(_ cookies: [HTTPCookie], for connection: Connection) throws {
        let endpoint = URL(string: "/api/capture/image", relativeTo: connection.url)!.absoluteURL
        let selected = Cookies.matching(cookies, for: endpoint)
        let properties = selected.map { cookie -> [String: Any] in
            // Use an explicit property-list shape; WebKit may include URL-valued properties.
            var values: [String: Any] = [
                HTTPCookiePropertyKey.name.rawValue: cookie.name,
                HTTPCookiePropertyKey.value.rawValue: cookie.value,
                HTTPCookiePropertyKey.domain.rawValue: cookie.domain,
                HTTPCookiePropertyKey.path.rawValue: cookie.path,
                HTTPCookiePropertyKey.secure.rawValue: cookie.isSecure ? "TRUE" : "FALSE",
                HTTPCookiePropertyKey.version.rawValue: String(cookie.version)
            ]
            if let expires = cookie.expiresDate { values[HTTPCookiePropertyKey.expires.rawValue] = expires }
            if cookie.isHTTPOnly { values["HttpOnly"] = "TRUE" }
            return values
        }
        let data = try PropertyListSerialization.data(fromPropertyList: properties, format: .binary, options: 0)
        let q = try query(connection)
        let attributes: [String: Any] = [kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status = SecItemUpdate(q as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound { status = SecItemAdd(q.merging(attributes) { _, new in new } as CFDictionary, nil) }
        guard status == errSecSuccess else { throw ShareAccessError.keychain(status) }
    }

    static func cookies(for connection: Connection) throws -> [HTTPCookie] {
        var q = try query(connection)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess, let data = result as? Data else { throw ShareAccessError.keychain(status) }
        guard let raw = try PropertyListSerialization.propertyList(from: data, format: nil) as? [[String: Any]] else {
            throw SpaceAPIError.invalidResponse
        }
        return raw.compactMap { HTTPCookie(properties: Dictionary(uniqueKeysWithValues: $0.map { (HTTPCookiePropertyKey($0.key), $0.value) })) }
    }

    static func clear(_ connection: Connection) throws {
        let status = SecItemDelete(try query(connection) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw ShareAccessError.keychain(status) }
    }
}

enum ShareAccessError: LocalizedError {
    case unavailable, keychain(OSStatus)
    var errorDescription: String? {
        switch self {
        case .unavailable: return String(localized: "Sharing is not configured in this build.")
        case .keychain: return String(localized: "The shared sign-in could not be read or updated. Open ai-space and sign in again.")
        }
    }
}
