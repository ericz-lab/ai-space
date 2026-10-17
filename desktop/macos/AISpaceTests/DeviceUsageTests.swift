import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

@MainActor
struct DeviceUsageTests {
    @Test func navigationUsesOneVisitWithIncreasingSequenceAndBackgroundClosesIt() async {
        var bodies: [[String: Any]] = []
        var opens: [[String: Any]] = []
        let reporter = DeviceUsageReporter(send: { _, path, body in
            if path.hasSuffix("/open") { opens.append(body) } else { bodies.append(body) }
        })
        let api = SpaceAPI(base: URL(string: "https://usage-test.example/\(UUID().uuidString)")!, cookies: { [] })
        var app: String? = "ai-todo"
        reporter.setActive(true) { (api, app) }
        for _ in 0..<1000 where bodies.count < 1 { await Task.yield() }
        app = "ai-notes"
        reporter.refresh()
        for _ in 0..<1000 where bodies.count < 2 { await Task.yield() }
        app = nil
        reporter.refresh()
        for _ in 0..<1000 where bodies.count < 3 { await Task.yield() }
        reporter.setActive(false) { nil }
        for _ in 0..<1000 where bodies.count < 4 { await Task.yield() }
        #expect(bodies.count == 4)
        #expect(opens.compactMap { $0["key"] as? String } == ["ai-todo", "ai-notes"])
        #expect(bodies.compactMap { $0["sequence"] as? Int } == [1, 2, 3, 4])
        #expect(bodies.compactMap { $0["active"] as? Bool } == [true, true, true, false])
        #expect(Set(bodies.compactMap { $0["session"] as? String }).count == 1)
        #expect(bodies.first?["app"] as? String == "ai-todo")
        #expect(bodies.dropFirst().first?["app"] as? String == "ai-notes")
        #expect(bodies.last?["app"] is NSNull)
        UserDefaults.standard.removeObject(forKey: "space-usage-device:\(api.base.absoluteString)")
    }

    @Test func identityPersistsButInstallationsAndSpacesAreSeparate() {
        let suiteA = "usage-test-\(UUID().uuidString)"
        let suiteB = "usage-test-\(UUID().uuidString)"
        let a = UserDefaults(suiteName: suiteA)!
        let b = UserDefaults(suiteName: suiteB)!
        defer {
            a.removePersistentDomain(forName: suiteA)
            b.removePersistentDomain(forName: suiteB)
        }
        let origin = "https://space.example/"
        let first = DeviceUsageReporter.identity(for: origin, defaults: a)
        #expect(UUID(uuidString: first) != nil)
        #expect(first == DeviceUsageReporter.identity(for: origin, defaults: a))
        #expect(first != DeviceUsageReporter.identity(for: origin, defaults: b))
        #expect(first != DeviceUsageReporter.identity(for: "https://other.example/", defaults: a))
    }
}
