package dev.aispace.android.core

import java.time.Instant

/** Answers shaped like a real Space's (a hub with one peer), trimmed. */
object Fixture {
    val apps = """
    {"ok":true,"apps":[
      {"id":"docs","name":"docs","title":"Bun Docs","i18n":{"zh":{"title":"Bun 文档"}},"icon":"📚","url":"https://bun.sh/docs","status":"active","manifestOnly":true,"hidden":false,"agents":[],"widgets":[]},
      {"id":"todo","name":"todo","title":"Todo","description":"Tasks and reminders.","i18n":{"zh":{"title":"待办","description":"任务与提醒。"}},"icon":"/api/apps/todo/icon","url":"https://todo.example.com/?lang={lang}","status":"active","manifestOnly":false,"hidden":false,"service":{"port":8801,"health":"ok"},"agents":[],"widgets":[]},
      {"id":"reader","name":"reader","title":"Reader","icon":"📰","url":"https://reader.example.com/","status":"active","hidden":false,"service":{"port":8803,"health":"down"}},
      {"id":"sleeper","name":"sleeper","title":"Sleeper","url":"https://sleeper.example.com/","status":"paused","hidden":false,"service":{"port":8804,"health":"down"}},
      {"id":"secret","name":"secret","title":"Secret","url":"https://secret.example.com/","status":"active","hidden":true},
      {"id":"old","name":"old","title":"Old","url":"https://old.example.com/","status":"archived","hidden":false},
      {"id":"worker","name":"worker","title":"Worker","status":"active","hidden":false,"service":{"port":8805,"health":"ok"}},
      {"id":"broken","title":42},
      {"id":"david/voice-studio","name":"voice-studio","peer":"david","stale":true,"title":"Voice Studio","i18n":{"zh":{"title":"语音工作室"}},"icon":"🎙️","url":"https://voice.example.com/","status":"active","hidden":false,"service":{"port":8811,"health":"ok"}}
    ],"builtins":{"inbox":"/inbox.svg"},"asOf":"2026-10-12T03:34:23.759Z"}
    """.trimIndent()

    val agents = """
    {"ok":true,"agents":[
      {"id":"space/assistant","app":"space","name":"assistant","title":"Space Assistant","i18n":{"zh":{"title":"空间助手"}},"avatar":"/assistant.svg","appIcon":"✨","runtime":"claude","modelOptions":[{"value":"claude/basic","runtime":"claude","tier":"basic","model":"haiku"}]},
      {"id":"todo/planner","app":"todo","name":"planner","title":"Planner","description":"Plans the day.","i18n":{"zh":{"title":"规划师"}},"avatar":"✅","appIcon":"✅"}
    ]}
    """.trimIndent()

    val widgets = """
    {"ok":true,"widgets":[
      {"id":"todo/today","app":"todo","name":"today","title":"Todo · Today","i18n":{"zh":{"title":"待办 · 今天"}},"icon":"✅","link":"https://todo.example.com/","kind":"items","size":"2x1","refreshMs":60000,"ok":true,"items":[{"text":"Review","url":"https://todo.example.com/1","time":"2026-10-12T03:34:23.784Z"}]},
      {"id":"reader/unread","app":"reader","name":"unread","title":"Reader","icon":"📰","link":"https://reader.example.com/","kind":"items","size":"1x1","refreshMs":60000,"ok":false,"error":"widget source unavailable"}
    ],"hidden":[]}
    """.trimIndent()

    val peers = """
    {"ok":true,"peers":[{"name":"david","url":"http://127.0.0.1:18710","health":"down","asOf":"2026-10-12T03:34:17.782Z","error":"fetch failed","stale":true,"apps":1,"agents":0,"widgets":0,"services":1,"duplicates":[]}]}
    """.trimIndent()

    val layout = """
    {"ok":true,"layout":{"order":{"apps":[],"agents":[],"widgets":[]},"hidden":[],"sizes":{},"hiddenWidgets":[],"screens":[{"id":"home","name":"Home","items":["app:todo","builtin:inbox","agent:space/assistant","app:todo","widget:todo/today","app:gone"]},{"id":"s2","name":"","items":["app:docs"]}]}}
    """.trimIndent()

    val router = """
    {"ok":true,"router":"caddy","domain":"Example.com","port":8080,"routes":[]}
    """.trimIndent()

    val fetchedAt: Instant = Instant.ofEpochSecond(1_790_000_000)

    fun payload(
        apps: String = this.apps,
        agents: String = this.agents,
        widgets: String = this.widgets,
        peers: String? = this.peers,
        layout: String? = this.layout,
        router: String? = this.router,
    ) = CataloguePayload(apps, agents, widgets, peers, layout, router, fetchedAt)

    val catalogue: Catalogue get() = Catalogue.decode(payload())
}
