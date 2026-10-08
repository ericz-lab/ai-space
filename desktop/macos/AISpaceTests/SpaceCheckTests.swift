import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

struct SpaceCheckTests {
    @Test func aSpaceAnswerIsReady() {
        let body = #"{"ok":true,"layout":{"order":[],"hidden":[]}}"#
        #expect(SpaceCheck.classify(status: 200, contentType: "application/json;charset=utf-8", body: body) == .ready)
        #expect(SpaceCheck.classify(scriptResult: [NSNumber(value: 200), "application/json", body]) == .ready)
    }

    @Test func aReachablePortAloneIsNotReady() {
        #expect(SpaceCheck.classify(status: 200, contentType: "text/html", body: "<html>") != .ready)
        #expect(SpaceCheck.classify(status: 200, contentType: "application/json", body: #"{"ok":true}"#) != .ready)
        #expect(SpaceCheck.classify(status: 404, contentType: "text/plain", body: "Not Found") == .incompatible("HTTP 404"))
        #expect(SpaceCheck.classify(scriptResult: "garbage") != .ready)
    }

    @Test func accessLayerAnswersMeanSignIn() {
        for status in [0, 302, 401, 403] {
            #expect(SpaceCheck.classify(status: status, contentType: "", body: "") == .authenticationRequired)
        }
    }

    @Test func networkErrors() {
        let refused = NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotConnectToHost)
        #expect(SpaceCheck.classify(error: refused)?.isFailure == true)
        #expect(SpaceCheck.classify(error: NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled)) == nil)
        #expect(SpaceCheck.classify(error: NSError(domain: "WebKitErrorDomain", code: 102)) == nil)
    }
}
