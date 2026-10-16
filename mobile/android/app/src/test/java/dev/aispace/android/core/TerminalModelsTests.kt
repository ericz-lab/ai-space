package dev.aispace.android.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.URI

class TerminalModelsTests {
    private val status = """
    {"ok":true,"enabled":true,"backend":"python","shell":"/bin/zsh -l","passphrase":true,"idleMs":1800000,"maxSessions":4,"active":1,
     "machines":[{"name":"seoul","enabled":true,"health":"ok"},{"name":"david","peer":"david","enabled":true,"health":"ok"},
                 {"name":"attic","peer":"attic","enabled":false,"health":"ok"},{"name":"away","peer":"away","enabled":true,"health":"down"}],
     "sessions":[{"id":"b"}],
     "recent":[{"id":"b","startedAt":1791948031365,"agent":"x","bytesIn":3,"bytesOut":9,"cols":52,"rows":47},
               {"id":"a","startedAt":1791947976587,"endedAt":1791947983947,"exitCode":null,"reason":"closed","agent":"x","bytesIn":114,"bytesOut":446,"cols":52,"rows":47},
               {"id":"z","startedAt":1791947000000,"endedAt":1791947060000,"exitCode":2,"reason":"exit","agent":"x","bytesIn":1,"bytesOut":2}]}
    """.trimIndent()

    @Test fun readsTheMachinesAndWhatRan() {
        val s = Json.decode(status, TerminalStatus)
        assertTrue(s.enabled && s.passphrase)
        assertEquals(listOf("seoul", "david", "attic", "away"), s.machines.map { it.name })
        // The Space's own machine has no peer; one that is off or down is listed and cannot open.
        assertEquals(listOf(true, true, false, false), s.machines.map { it.canOpen })
        assertNull(s.machines[0].peer)
        assertEquals(listOf(true, false, false), s.recent.map { it.isOpen })
        assertTrue(s.recent[1].exitCode == null && s.recent[1].reason == "closed")
        assertEquals(2, s.recent[2].exitCode)
        assertEquals(60.0, s.recent[2].duration!!, 0.0)
    }

    @Test fun aSpaceWithoutATerminalReadsAsOff() {
        val s = Json.decode("""{"ok":true}""", TerminalStatus)
        assertTrue(!s.enabled && s.machines.isEmpty() && s.recent.isEmpty())
    }

    @Test fun routesFollowTheMachine() {
        val own = TerminalMachine(name = "seoul")
        val peer = TerminalMachine(name = "my box", peer = "my box")
        assertEquals("/api/terminal/sessions", TerminalRoute.sessions(own))
        assertEquals("/api/peers/my%20box/terminal/sessions", TerminalRoute.sessions(peer))
        assertEquals(
            "wss://space.example.com/api/terminal/ws?ticket=a+b/c%3D",
            TerminalRoute.socket(own, "a+b/c=", URI("https://space.example.com/"))?.toString(),
        )
        assertEquals(
            "ws://127.0.0.1:8700/api/peers/my%20box/terminal/ws?ticket=t",
            TerminalRoute.socket(peer, "t", URI("http://127.0.0.1:8700"))?.toString(),
        )
        assertEquals("""{"type":"resize","cols":52,"rows":47}""", TerminalRoute.resize(52, 47))
    }

    @Test fun theAnswerToOpeningASession() {
        fun read(status: Int, body: String) = TerminalTicket.read(status, body)
        assertEquals(TerminalTicket.Ticket("abc"), read(200, """{"ok":true,"id":"s","ticket":"abc","expiresIn":30}"""))
        // The terminal's own 401 is about the passphrase; the access layer's is a sign-in.
        assertEquals(TerminalTicket.Passphrase("passphrase required"), read(401, """{"ok":false,"error":"passphrase required"}"""))
        assertEquals(TerminalTicket.Passphrase("passphrase wrong"), read(401, """{"ok":false,"error":"passphrase wrong"}"""))
        assertEquals(TerminalTicket.SignIn, read(401, "<html>login</html>"))
        assertEquals(TerminalTicket.SignIn, read(302, ""))
        assertEquals(TerminalTicket.SignIn, read(403, "<html>forbidden</html>"))
        assertEquals(TerminalTicket.Refused("cross-origin request refused"), read(403, """{"ok":false,"error":"cross-origin request refused"}"""))
        assertEquals(
            TerminalTicket.Refused("terminal is not enabled (SPACE_TERMINAL_ENABLED)"),
            read(404, """{"ok":false,"error":"terminal is not enabled (SPACE_TERMINAL_ENABLED)"}"""),
        )
        assertEquals(
            TerminalTicket.Refused("too many wrong passphrases; try again in a minute"),
            read(429, """{"ok":false,"error":"too many wrong passphrases; try again in a minute"}"""),
        )
        assertEquals(TerminalTicket.Refused("HTTP 502"), read(502, ""))
        assertEquals(TerminalTicket.Refused("no ticket"), read(200, """{"ok":true}"""))
    }

    @Test fun controlMessages() {
        assertEquals(TerminalControl.Ready, TerminalControl.read("""{"type":"ready","id":"s","backend":"python","shell":"/bin/zsh","idleMs":1800000}"""))
        assertEquals(TerminalControl.Exit(0, null), TerminalControl.read("""{"type":"exit","code":0}"""))
        assertEquals(TerminalControl.Exit(null, "no such shell"), TerminalControl.read("""{"type":"exit","code":null,"detail":"no such shell"}"""))
        assertEquals(TerminalControl.Error("boom"), TerminalControl.read("""{"type":"error","error":"boom"}"""))
        assertEquals(TerminalControl.Closed("idle"), TerminalControl.read("""{"type":"closed","reason":"idle"}"""))
        assertNull(TerminalControl.read("""{"type":"pong"}"""))
        assertNull(TerminalControl.read("not json"))
    }

    @Test fun noticesAreDimOrRed() {
        assertEquals("\r\n\u001B[2m[closed]\u001B[0m\r\n", TerminalNotice.dim("closed"))
        assertEquals("\r\n\u001B[31mboom\u001B[0m\r\n", TerminalNotice.red("boom"))
    }
}
