import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

struct SpaceSettingsTests {
    static let services = """
    {"ok":true,"services":[
      {"app":"todo","title":"Todo","i18n":{"zh":{"title":"待办"}},"icon":"/api/apps/todo/icon","port":8801,"health":"ok","status":"active","hidden":false,"supervisor":"space"},
      {"app":"reader","title":"Reader","icon":"📰","port":8803,"health":"down","status":"active","hidden":false},
      {"app":"sleeper","title":"Sleeper","port":8804,"health":"down","status":"paused","hidden":false},
      {"app":"old","title":"Old","port":8805,"health":"ok","status":"archived","hidden":false},
      {"app":"voice","peer":"david","title":"Voice","port":8811,"hidden":false},
      {"title":"No app"}
    ],"peers":[]}
    """
    static let backups = """
    {"ok":true,"target":"s3://bucket/backups/","maxAgeHours":48,"backups":[
      {"app":"todo","count":12,"lastAt":1791832080137,"lastStatus":"ok","lastOkAt":1791832080137,"lastOkBytes":11745,"stale":false,"retired":false},
      {"app":"reader","count":3,"lastStatus":"ok","lastOkAt":1791000000000,"stale":true,"retired":false},
      {"app":"notes","count":1,"lastStatus":"error","lastError":"disk full","lastOkAt":1791000000000,"stale":true,"retired":false},
      {"app":"gone","count":5,"lastStatus":"ok","lastOkAt":1791000000000,"stale":true,"retired":true},
      {"app":"fresh","count":0,"stale":false,"retired":false}
    ]}
    """

    @Test func readsServicesAndTheirStates() {
        let s = SpaceSettings.decode(services: Data(Self.services.utf8), backups: nil)
        // An archived app's service is not shown; a row without an app is skipped.
        #expect(s.services.map(\.id) == ["todo", "reader", "sleeper", "david/voice"])
        #expect(s.services.map(\.state) == [.running, .down, .paused, .unknown])
        #expect(s.backups.isEmpty)
    }

    @Test func readsBackupsAndTheirStates() {
        let s = SpaceSettings.decode(services: nil, backups: Data(Self.backups.utf8))
        #expect(s.backupTarget == "s3://bucket/backups/")
        #expect(s.backups.map(\.state) == [.ok, .stale, .failed, .retired, .none])
        #expect(s.backups[0].lastOk == Date(timeIntervalSince1970: 1791832080.137))
    }

    @Test func readsTheDefaultModelAndItsOptions() {
        let body = """
        {"ok":true,"defaultModel":"codex/basic","appDefault":"codex/basic","baseDefault":"claude/junior","options":[
          {"value":"claude/junior","runtime":"claude","tier":"junior","model":"sonnet","capabilities":{"chat":true}},
          {"value":"codex/basic","runtime":"codex","tier":"basic","model":"gpt-6-luna"},
          {"runtime":"broken"}
        ]}
        """
        let m = SpaceSettings.decode(services: nil, backups: nil, models: Data(body.utf8)).models
        #expect(m?.defaultModel == "codex/basic")
        #expect(m?.options.map(\.value) == ["claude/junior", "codex/basic"])
        #expect(m?.label("codex/basic") == "codex · Basic · gpt-6-luna")
        #expect(m?.label("gone/model") == "gone/model")
        // The environment's defaults: no model is set.
        let unset = SpaceSettings.decode(services: nil, backups: nil, models: Data(#"{"ok":true,"defaultModel":null,"options":[]}"#.utf8)).models
        #expect(unset != nil && unset?.defaultModel == nil)
    }

    @Test func anAnswerThatIsNotTheRouteIsEmpty() {
        let s = SpaceSettings.decode(services: Data("<html>Sign in</html>".utf8), backups: Data("{}".utf8))
        #expect(s == SpaceSettings())
    }
}
