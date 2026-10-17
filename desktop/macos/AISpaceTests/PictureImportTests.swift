import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

struct PictureImportTests {
    @Test func acceptsFileAndRejectsDirectoryAndEmptyFile() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        #expect(throws: CocoaError.self) { try PictureImport.read(directory) }
        let file = directory.appendingPathComponent("picture")
        try Data().write(to: file)
        #expect(throws: CocoaError.self) { try PictureImport.read(file) }
        let bytes = Data([1, 2, 3])
        try bytes.write(to: file)
        #expect(try PictureImport.read(file) == bytes)
        let handle = try FileHandle(forWritingTo: file)
        try handle.truncate(atOffset: 40 * 1024 * 1024 + 1)
        try handle.close()
        #expect(throws: CocoaError.self) { try PictureImport.read(file) }
    }
}
