import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

@MainActor
struct DeviceUsagePageTests {
    private func api() -> SpaceAPI { SpaceAPI(base: URL(string: "https://space.example")!, cookies: { [] }) }
    private let deviceJSON = #"{"ok":true,"devices":[{"deviceId":"iphone-001","client":"ios","sessions":2,"activeMs":60000,"lastAt":"2026-10-17T08:00:00.000Z"},{"deviceId":"iphone-002","client":"ios","sessions":1,"activeMs":30000,"lastAt":"2026-10-17T08:01:00.000Z"}]}"#
    private let appsJSON = #"{"ok":true,"usage":[{"kind":"app","key":"todo","opens":1,"activeMs":0}]}"#

    @Test func decodesPerDeviceAppsAndDistinguishesUnmeasuredTime() throws {
        let row = try Hub.decode(DeviceUsageRow.self, from: Data(#"{"deviceId":"iphone-001","client":"ios","sessions":1,"activeMs":60000,"lastAt":"2026-10-17T08:00:00.000Z","apps":[{"key":"ai-todo","opens":2,"activeMs":60000,"lastAt":"2026-10-17T08:00:00.000Z"},{"key":"ai-notes","opens":1,"activeMs":null,"lastAt":"2026-10-17T08:00:00.000Z"}]}"#.utf8))
        #expect(row.apps?.map(\.opens) == [2, 1])
        #expect(row.apps?.first?.activeMs == 60000)
        #expect(row.apps?.last?.activeMs == nil)
        #expect(DeviceUsageReporter.appKey("app:peer/ai-todo") == "peer/ai-todo")
        #expect(DeviceUsageReporter.appKey("agent:space/assistant") == nil)
        #expect(DeviceUsageReporter.appKey("widget:ai-todo/next") == nil)
    }

    @Test func loadsSeparatePhonesWithTheSelectedWindowButWithoutAppKindFilter() async {
        var paths: [String] = []
        let store = AppUsageStore(api: api(), fetch: { path in
            paths.append(path)
            return Data((path.hasPrefix("/api/usage/devices") ? deviceJSON : appsJSON).utf8)
        })
        store.window = "7d"
        store.kind = "agent"
        await store.refresh()
        #expect(paths.contains("/api/usage/devices?window=7d"))
        #expect(paths.contains("/api/usage?window=7d&kind=agent"))
        #expect(store.devicesLoaded && store.devicesError == nil)
        #expect(store.devices.map(\.activeMs) == [60000, 30000])
        #expect(Set(store.devices.map(\.id)).count == 2)
        #expect(store.devices.map(\.clientName) == ["iOS", "iOS"])
        #expect(store.devices[0].shortID != store.devices[1].shortID)
    }

    @Test func anOldSpaceKeepsApplicationUsageAndShowsDeviceAvailability() async {
        let store = AppUsageStore(api: api(), fetch: { path in
            if path.hasPrefix("/api/usage/devices") { throw SpaceAPIError.http(404, "not found") }
            return Data(appsJSON.utf8)
        })
        await store.refresh()
        #expect(store.loaded && store.error == nil && store.opens == 1)
        #expect(!store.devicesLoaded && store.devicesError != nil)
    }

    @Test func failedRefreshDoesNotShowOldDeviceDurationsAsTheNewWindow() async {
        var fail = false
        let store = AppUsageStore(api: api(), fetch: { path in
            if path.hasPrefix("/api/usage/devices") {
                if fail { throw URLError(.notConnectedToInternet) }
                return Data(deviceJSON.utf8)
            }
            return Data(appsJSON.utf8)
        })
        await store.refresh()
        #expect(store.devices.count == 2)
        fail = true
        store.window = "7d"
        await store.refresh()
        #expect(store.devices.isEmpty && store.devicesError != nil)
        #expect(store.opens == 1)
    }

    @Test func deviceDataStillLoadsWhenTheApplicationReportFails() async {
        let store = AppUsageStore(api: api(), fetch: { path in
            if path.hasPrefix("/api/usage/devices") { return Data(deviceJSON.utf8) }
            throw URLError(.notConnectedToInternet)
        })
        await store.refresh()
        #expect(store.devicesLoaded && store.devices.count == 2)
        #expect(store.error != nil)
    }
}
