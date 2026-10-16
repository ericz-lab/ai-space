import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

struct MediaCapturePolicyTests {
    let space = URL(string: "https://space.example.com/")!
    let app = URL(string: "https://notes.space.example.com/")!

    func decide(_ kind: MediaCaptureKind = .microphone, page: String, frame: String? = nil, home: URL? = nil) -> MediaCaptureDecision {
        MediaCapturePolicy.decide(kind, page: URL(string: page), frame: URL(string: frame ?? page),
                                  home: home ?? app, connection: space)
    }

    @Test func theSessionsOwnPagesGetTheMicrophone() {
        #expect(decide(page: "https://notes.space.example.com/") == .grant)
        #expect(decide(page: "https://notes.space.example.com:443/voice") == .grant)
        #expect(decide(page: "https://space.example.com/apps/notes/") == .grant)
        #expect(decide(page: "https://space.example.com/", home: space) == .grant)
    }

    @Test func otherSitesAndFramesGetNothing() {
        #expect(decide(page: "https://evil.example.com/") == .deny)
        #expect(decide(page: "https://notes.space.example.com/", frame: "https://evil.example.com/") == .deny)
        #expect(decide(page: "http://notes.space.example.com/") == .deny)
        #expect(decide(page: "https://todo.space.example.com/") == .deny)
    }

    @Test func theCameraIsNeverGranted() {
        #expect(decide(.camera, page: "https://notes.space.example.com/") == .deny)
        #expect(decide(.cameraAndMicrophone, page: "https://notes.space.example.com/") == .deny)
    }

    @Test func securityOriginsBecomeURLs() {
        #expect(MediaCapturePolicy.url(scheme: "https", host: "space.example.com", port: 0)?.absoluteString == "https://space.example.com/")
        #expect(MediaCapturePolicy.url(scheme: "http", host: "127.0.0.1", port: 7777)?.absoluteString == "http://127.0.0.1:7777/")
        #expect(MediaCapturePolicy.decide(.microphone, page: nil, frame: nil, home: app, connection: space) == .deny)
    }
}
