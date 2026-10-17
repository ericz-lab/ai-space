import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

@MainActor
struct DeviceUsageTests {
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
