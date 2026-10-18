import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

struct AppUpdateTests {
    private func feed() -> (AppUpdateFeed.Release, AppUpdateFeed.Manifest) {
        let name = AppUpdateFeed.dmgName(version: "1.2.0", arch: "arm64")
        return (
            .init(tag_name: "v1.2.0", html_url: URL(string: "https://example.com/release")!, draft: false, prerelease: false,
                  assets: [.init(name: name, browser_download_url: URL(string: "https://example.com/app.dmg")!, size: 42)]),
            .init(version: "1.2.0", artifacts: [.init(name: name, size: 42, sha256: String(repeating: "a", count: 64))])
        )
    }

    @Test func onlyMatchingStableNewerArtifactsAreOffered() {
        var (release, manifest) = feed()
        func pick() -> AppUpdate? { AppUpdateFeed.pick(release, manifest: manifest, current: "1.1.0", arch: "arm64") }
        #expect(pick()?.version == "1.2.0")
        #expect(AppUpdateFeed.pick(release, manifest: manifest, current: "1.2.0", arch: "arm64") == nil)
        #expect(AppUpdateFeed.pick(release, manifest: manifest, current: "1.1.0", arch: "x64") == nil)
        release.draft = true
        #expect(pick() == nil)
        release.draft = false
        release.prerelease = true
        #expect(pick() == nil)
        release.prerelease = false
        manifest.version = "1.3.0"
        #expect(pick() == nil)
        manifest.version = "1.2.0"
        manifest.artifacts[0].size = 43
        #expect(pick() == nil)
        manifest.artifacts[0].size = 42
        manifest.artifacts[0].sha256 = String(repeating: "z", count: 64)
        #expect(pick() == nil)
    }

    @Test func versionsDoNotDowngradeOrAcceptMalformedNumbers() throws {
        #expect(AppUpdateFeed.newer("1.10.0", than: "1.9.0"))
        #expect(!AppUpdateFeed.newer("1.2.0", than: "1.10.0"))
        #expect(!AppUpdateFeed.newer("2.invalid.0", than: "1.0.0"))
        #expect(!AppUpdateFeed.newer("2.0", than: "1.0.0"))
        var status = try LocalOutput.decode(LocalStatus.self, from: Data(LocalEditionTests.statusJSON.utf8))
        status.bundle?.version = "0.0.1"
        #expect(!status.updateAvailable)
        status.bundle?.version = status.installed!.version
        #expect(!status.updateAvailable)
    }

    @Test func hashesBytesAndRejectsUnsignedTeam() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: file) }
        try Data("abc".utf8).write(to: file)
        #expect(try AppUpdateFeed.sha256(of: file) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        #expect(AppUpdateFeed.teamIdentifier(codesignOutput: "TeamIdentifier=not set\n") == nil)
        #expect(AppUpdateFeed.teamIdentifier(codesignOutput: "Signature=adhoc\n") == nil)
        #expect(AppUpdateFeed.teamIdentifier(codesignOutput: "TeamIdentifier=TEAM123\n") == "TEAM123")
    }

    @Test func busyResponsePreservesRunningWork() throws {
        let json = #"{"ok":false,"code":"busy","error":"busy","activity":{"busy":true,"items":[{"kind":"task","label":"notes/digest"}]}}"#
        do {
            _ = try LocalOutput.decode(LocalStatus.self, from: Data(json.utf8))
            Issue.record("expected busy refusal")
        } catch let error as LocalFailure {
            #expect(error.activity?.summary == "notes/digest")
        }
    }

    @Test(arguments: ["success", "missing", "launch-failure"])
    func replacementKeepsOrRestoresPreviousApp(scenario: String) throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("update ' $ test \(UUID().uuidString)")
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: root) }
        let old = root.appendingPathComponent("AI Space.app")
        let new = root.appendingPathComponent("staged.app")
        let aside = root.appendingPathComponent("previous.app")
        try fm.createDirectory(at: old, withIntermediateDirectories: true)
        try Data("old".utf8).write(to: old.appendingPathComponent("version"))
        if scenario != "missing" {
            try fm.createDirectory(at: new, withIntermediateDirectories: true)
            try Data("new".utf8).write(to: new.appendingPathComponent("version"))
        }
        let opener = root.appendingPathComponent("open")
        let body = scenario == "launch-failure" ? "#!/bin/sh\n[ \"$(cat \"$1/version\")\" = old ]\n" : "#!/bin/sh\nexit 0\n"
        try Data(body.utf8).write(to: opener)
        try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: opener.path)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", AppReplacement.script, "test", "99999999", old.path, new.path, aside.path, opener.path]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        process.waitUntilExit()
        #expect(try String(contentsOf: old.appendingPathComponent("version"), encoding: .utf8) == (scenario == "success" ? "new" : "old"))
        #expect(process.terminationStatus == (scenario == "success" ? 0 : 1))
        if scenario == "success" {
            #expect(try String(contentsOf: aside.appendingPathComponent("version"), encoding: .utf8) == "old")
        }
    }
}
