import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

struct SpaceInstallerTests {
    let temp = FileManager.default.temporaryDirectory.appendingPathComponent("ai-space-tests-\(UUID().uuidString)", isDirectory: true)

    final class Seen: @unchecked Sendable {
        private let lock = NSLock()
        private var _lines: [String] = []
        private var _command: SpaceInstaller.Command?
        private var _script: String?
        var lines: [String] { lock.withLock { _lines } }
        var command: SpaceInstaller.Command? { lock.withLock { _command } }
        var script: String? { lock.withLock { _script } }
        func add(_ line: String) { lock.withLock { _lines.append(line) } }
        func ran(_ c: SpaceInstaller.Command) {
            lock.withLock {
                _command = c
                _script = try? String(contentsOfFile: c.arguments[0], encoding: .utf8)
            }
        }
    }

    @Test func theInstallerIsTheLatestReleasesOwn() {
        #expect(SpaceInstaller.scriptURL(environment: [:]).absoluteString
            == "https://github.com/ericz-lab/ai-space/releases/latest/download/install.sh")
        #expect(SpaceInstaller.scriptURL(environment: ["AI_SPACE_DOWNLOAD": "  "]).absoluteString
            == "https://github.com/ericz-lab/ai-space/releases/latest/download/install.sh")
    }

    @Test func aMirrorReplacesTheBase() {
        #expect(SpaceInstaller.scriptURL(environment: ["AI_SPACE_DOWNLOAD": "https://mirror.example.com/ai-space/"]).absoluteString
            == "https://mirror.example.com/ai-space/install.sh")
        #expect(SpaceInstaller.scriptURL(environment: ["AI_SPACE_DOWNLOAD": "file:///tmp/release"]).absoluteString
            == "file:///tmp/release/install.sh")
    }

    @Test func theCommandIsBashWithTheSystemsToolsAndNoBrowser() {
        let script = URL(fileURLWithPath: "/tmp/x/install.sh")
        let bare = SpaceInstaller.command(script: script, environment: ["HOME": "/Users/someone"])
        #expect(bare.executable.path == "/bin/bash")
        #expect(bare.arguments == ["/tmp/x/install.sh"])
        #expect(bare.environment["AI_SPACE_NO_OPEN"] == "1")
        #expect(bare.environment["PATH"] == "/usr/bin:/bin:/usr/sbin:/sbin")
        #expect(bare.environment["HOME"] == "/Users/someone")

        let rich = SpaceInstaller.command(script: script, environment: [
            "PATH": "/opt/homebrew/bin:/usr/bin:/bin", "AI_SPACE_DOWNLOAD": "file:///r", "SPACE_HOME": "/srv/space",
        ])
        #expect(rich.environment["PATH"] == "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin")
        // The installer takes its archive from the same place, and installs where the app looks.
        #expect(rich.environment["AI_SPACE_DOWNLOAD"] == "file:///r")
        #expect(rich.environment["SPACE_HOME"] == "/srv/space")
        #expect(rich.environment["HOME"]?.isEmpty == false)
    }

    @Test func theTailIsTheLastLinesThatSaySomething() {
        let lines = (1...20).map { "line \($0)" } + ["", "ai-space install: could not download", "  "]
        #expect(SpaceInstaller.tail(lines, count: 3) == ["line 19", "line 20", "ai-space install: could not download"])
        #expect(SpaceInstaller.tail([]) == [])
    }

    @Test func linesAreCutAsTheyComplete() {
        var buffer = LineBuffer()
        #expect(buffer.append(Data("ai-space: look".utf8)) == [])
        #expect(buffer.append(Data("ing\r\ndownloading\n\npart".utf8)) == ["ai-space: looking", "downloading", ""])
        #expect(buffer.finish() == ["part"])
        #expect(buffer.finish() == [])
    }

    @Test func aDownloadedInstallerRunsFromItsOwnTemporaryFile() async {
        let seen = Seen()
        var installer = SpaceInstaller(environment: ["HOME": "/Users/someone"], temporary: temp)
        installer.download = { url in
            #expect(url.absoluteString == "https://github.com/ericz-lab/ai-space/releases/latest/download/install.sh")
            return Data("echo hello\n".utf8)
        }
        installer.run = { command, onLine in
            seen.ran(command)
            onLine("ai-space is running.")
            return 0
        }
        #expect(await installer.install(onLine: seen.add) == .installed)
        #expect(seen.script == "echo hello\n")
        #expect(seen.command?.executable.path == "/bin/bash")
        #expect(seen.command?.arguments.first?.hasPrefix(temp.path) == true)
        #expect(seen.command?.environment["AI_SPACE_NO_OPEN"] == "1")
        #expect(seen.lines == ["ai-space is running."])
        // The file is gone once the installer ended.
        #expect(!FileManager.default.fileExists(atPath: seen.command?.arguments.first ?? ""))
    }

    @Test func aFailedDownloadRunsNothing() async {
        let seen = Seen()
        var installer = SpaceInstaller(environment: [:], temporary: temp)
        installer.download = { _ in throw SpaceInstaller.HTTPFailure(status: 404) }
        installer.run = { command, _ in
            seen.ran(command)
            return 0
        }
        let outcome = await installer.install(onLine: seen.add)
        #expect(outcome == .downloadFailed("https://github.com/ericz-lab/ai-space/releases/latest/download/install.sh: HTTP 404"))
        #expect(seen.command == nil)

        installer.download = { _ in Data() }
        guard case .downloadFailed = await installer.install(onLine: seen.add) else {
            Issue.record("an empty installer must not run")
            return
        }
        #expect(seen.command == nil)
    }

    @Test func aNonZeroExitIsAFailureWithItsCode() async {
        var installer = SpaceInstaller(environment: [:], temporary: temp)
        installer.download = { _ in Data("exit 3\n".utf8) }
        installer.run = { _, onLine in
            onLine("ai-space install: tar is not installed")
            return 3
        }
        let seen = Seen()
        #expect(await installer.install(onLine: seen.add) == .failed(3))
        #expect(seen.lines == ["ai-space install: tar is not installed"])
    }

    /// The real download and process, against a stand-in release: a folder with an `install.sh`
    /// that only prints and leaves a mark, taken through `AI_SPACE_DOWNLOAD=file://…`.
    @Test func aStandInReleaseRunsThroughTheRealProcess() async throws {
        let release = temp.appendingPathComponent("release", isDirectory: true)
        let home = temp.appendingPathComponent("home", isDirectory: true)
        try FileManager.default.createDirectory(at: release, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: temp) }
        let script = """
        echo "ai-space: stand-in installer"
        echo "no-open=$AI_SPACE_NO_OPEN base=$AI_SPACE_DOWNLOAD" >&2
        command -v curl tar launchctl >/dev/null || exit 9
        pwd > "$HOME/mark"
        printf 'last line without newline'
        exit ${STAND_IN_EXIT:-0}
        """
        try Data(script.utf8).write(to: release.appendingPathComponent("install.sh"))
        var env = ["HOME": home.path, "PATH": "", "AI_SPACE_DOWNLOAD": release.absoluteString]

        let seen = Seen()
        #expect(await SpaceInstaller(environment: env, temporary: temp).install(onLine: seen.add) == .installed)
        #expect(seen.lines == ["ai-space: stand-in installer", "no-open=1 base=\(release.absoluteString)", "last line without newline"])
        let mark = try String(contentsOf: home.appendingPathComponent("mark"), encoding: .utf8)
        #expect(URL(fileURLWithPath: mark.trimmingCharacters(in: .whitespacesAndNewlines)).resolvingSymlinksInPath().path == home.resolvingSymlinksInPath().path)

        env["STAND_IN_EXIT"] = "7"
        #expect(await SpaceInstaller(environment: env, temporary: temp).install(onLine: { _ in }) == .failed(7))

        env["AI_SPACE_DOWNLOAD"] = temp.appendingPathComponent("nowhere", isDirectory: true).absoluteString
        guard case .downloadFailed = await SpaceInstaller(environment: env, temporary: temp).install(onLine: { _ in }) else {
            Issue.record("a missing installer is a failed download")
            return
        }
    }
}
