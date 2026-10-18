import CryptoKit
import Foundation

/// The Local edition keeping itself current (docs/local.md#updates): the newest published release
/// on GitHub, its Local DMG for this Mac, and the SHA-256 its manifest.json gives for it. Drafts
/// and prereleases are never offered (GitHub's `releases/latest` skips them), nor unsigned DMGs.
struct AppUpdate: Equatable {
    let version: String
    let page: URL
    let dmg: URL
    let dmgName: String
    let sha256: String
    let size: Int
}

enum AppUpdateFeed {
    static let latest = URL(string: "https://api.github.com/repos/ericz-lab/ai-space/releases/latest")!

    struct Release: Decodable {
        struct Asset: Decodable {
            var name: String
            var browser_download_url: URL
            var size: Int
        }

        var tag_name: String
        var html_url: URL
        var draft: Bool?
        var prerelease: Bool?
        var assets: [Asset]
    }

    /// release/manifest.ts's manifest.json, as far as an update needs it.
    struct Manifest: Decodable {
        struct Artifact: Decodable {
            var name: String
            var size: Int
            var sha256: String
        }

        var version: String
        var artifacts: [Artifact]
    }

    /// `arm64` or `x64`, as desktop/macos/scripts/package.sh names its DMGs.
    static var arch: String {
        #if arch(arm64)
        return "arm64"
        #else
        return "x64"
        #endif
    }

    static func dmgName(version: String, arch: String = arch) -> String {
        "ai-space-local-\(version)-macos-\(arch).dmg"
    }

    /// The release's version from its tag (`v1.2.3` → `1.2.3`).
    static func version(tag: String) -> String {
        tag.hasPrefix("v") ? String(tag.dropFirst()) : tag
    }

    /// Published updates use three numeric version components. Invalid versions never win.
    static func newer(_ a: String, than b: String) -> Bool {
        func parts(_ v: String) -> [Int]? {
            let core = v.split(separator: "-", maxSplits: 1).first.map(String.init) ?? v
            let fields = core.split(separator: ".", omittingEmptySubsequences: false)
            guard fields.count == 3, fields.allSatisfy({ !$0.isEmpty && $0.allSatisfy({ $0.isASCII && $0.isNumber }) }) else { return nil }
            let numbers = fields.compactMap { Int($0) }
            return numbers.count == 3 ? numbers : nil
        }
        guard let pa = parts(a), let pb = parts(b) else { return false }
        for i in 0..<3 where pa[i] != pb[i] { return pa[i] > pb[i] }
        return false
    }

    /// The release's manifest.json asset, to read before picking the DMG.
    static func manifestURL(_ release: Release) -> URL? {
        release.assets.first { $0.name == "manifest.json" }?.browser_download_url
    }

    /// The update to offer, or nil: the release is a draft or prerelease, not newer than `current`,
    /// has no signed Local DMG for this Mac, or the manifest does not vouch for that DMG.
    static func pick(_ release: Release, manifest: Manifest, current: String, arch: String = arch) -> AppUpdate? {
        guard release.draft != true, release.prerelease != true else { return nil }
        let version = version(tag: release.tag_name)
        guard !version.contains("-"), manifest.version == version, newer(version, than: current) else { return nil }
        let name = dmgName(version: version, arch: arch)
        guard let asset = release.assets.first(where: { $0.name == name }),
              let listed = manifest.artifacts.first(where: { $0.name == name }),
              listed.size > 0, listed.size == asset.size, listed.sha256.count == 64,
              listed.sha256.allSatisfy({ $0.isASCII && $0.isHexDigit }),
              asset.browser_download_url.scheme == "https", release.html_url.scheme == "https"
        else { return nil }
        return AppUpdate(version: version, page: release.html_url, dmg: asset.browser_download_url, dmgName: name, sha256: listed.sha256.lowercased(), size: asset.size)
    }

    static func sha256(of file: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty { hasher.update(data: chunk) }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    /// `TeamIdentifier=` from `codesign -dv` (it prints to stderr); nil for ad-hoc or unsigned code.
    static func teamIdentifier(codesignOutput: String) -> String? {
        for line in codesignOutput.split(separator: "\n") where line.hasPrefix("TeamIdentifier=") {
            let team = line.dropFirst("TeamIdentifier=".count).trimmingCharacters(in: .whitespaces)
            return team.isEmpty || team == "not set" ? nil : team
        }
        return nil
    }
}


/// Invoked by an independent process after the app quits. Paths are positional arguments,
/// never interpolated shell source. Keep the old bundle for manual recovery after a successful swap.
enum AppReplacement {
    static let script = """
    while kill -0 "$1" 2>/dev/null; do sleep 0.2; done
    old="$2"; new="$3"; aside="$4"; opener="$5"
    [ ! -e "$aside" ] || exit 1
    if mv "$old" "$aside"; then
        if mv "$new" "$old"; then
            if "$opener" "$old"; then exit 0; fi
            mv "$old" "$new" || exit 1
        fi
        mv "$aside" "$old" || exit 1
    fi
    "$opener" "$old"
    exit 1
    """
}
