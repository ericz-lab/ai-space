import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

@MainActor
struct ConnectionStoreTests {
    let file = FileManager.default.temporaryDirectory
        .appendingPathComponent("ai-space-tests-\(UUID().uuidString)", isDirectory: true)
        .appendingPathComponent("connections.json")

    @Test func firstConnectionBecomesDefaultAndPersists() {
        let store = ConnectionStore(fileURL: file)
        let a = store.add(name: "  ", url: URL(string: "http://127.0.0.1:8700/")!)
        let b = store.add(name: "Seoul", url: URL(string: "https://seoul.example.com/")!)
        #expect(a.name == "127.0.0.1")
        #expect(store.defaultConnection?.id == a.id)

        store.setDefault(b.id)
        let reread = ConnectionStore(fileURL: file)
        #expect(reread.connections.map(\.id) == [a.id, b.id])
        #expect(reread.connections.filter(\.isDefault).map(\.id) == [b.id])
    }

    @Test func removingTheDefaultPromotesAnother() {
        let store = ConnectionStore(fileURL: file)
        let a = store.add(name: "Local", url: URL(string: "http://127.0.0.1:8700/")!)
        let b = store.add(name: "Seoul", url: URL(string: "https://seoul.example.com/")!)
        store.remove(a.id)
        #expect(store.connections.map(\.id) == [b.id])
        #expect(store.defaultConnection?.id == b.id && store.connections[0].isDefault)
        store.remove(b.id)
        #expect(store.defaultConnection == nil)
    }

    @Test func updateKeepsIdentity() {
        let store = ConnectionStore(fileURL: file)
        let a = store.add(name: "Local", url: URL(string: "http://127.0.0.1:8700/")!)
        store.update(a.id, name: "Mac", url: URL(string: "http://127.0.0.1:8799/")!)
        #expect(store.connection(a.id)?.name == "Mac")
        #expect(store.connection(a.id)?.url.port == 8799)
    }

    @Test func unreadableFileIsSetAsideNotOverwritten() throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("not json".utf8).write(to: file)
        let store = ConnectionStore(fileURL: file)
        #expect(store.connections.isEmpty)
        let aside = try #require(store.loadError)
        #expect(try String(contentsOfFile: aside, encoding: .utf8) == "not json")
    }

    /// A file written by the retired Local edition marks the Space it installed `managed`; its
    /// Spaces all load, and the next save leaves the flag out.
    @Test func aLocalEditionFileLoadsAndLosesItsManagedFlagOnSave() throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        let old = #"""
        [{"id":"6F1C1B7E-3C39-4D55-9D1E-0C5C2A6B8F10","name":"This Mac","url":"http://127.0.0.1:8700/","isDefault":true,"managed":true},
         {"id":"0B8E2A9C-5D4F-4E1A-8C3B-2F6D7E8A9B0C","name":"Seoul","url":"https://seoul.example.com/","isDefault":false,"managed":false},
         {"id":"1A2B3C4D-5E6F-4A7B-8C9D-0E1F2A3B4C5D","name":"Old","url":"https://old.example.com/","isDefault":false}]
        """#
        try Data(old.utf8).write(to: file)
        let store = ConnectionStore(fileURL: file)
        #expect(store.loadError == nil)
        #expect(store.connections.map(\.name) == ["This Mac", "Seoul", "Old"])
        #expect(store.defaultConnection?.name == "This Mac")

        store.setDefault(store.connections[1].id)
        let saved = try String(contentsOf: file, encoding: .utf8)
        #expect(!saved.contains("managed"))
        #expect(ConnectionStore(fileURL: file).connections.map(\.name) == ["This Mac", "Seoul", "Old"])
    }
}
