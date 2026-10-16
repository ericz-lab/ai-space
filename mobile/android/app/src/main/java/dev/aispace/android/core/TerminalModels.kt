package dev.aispace.android.core

import org.json.JSONObject
import java.net.URI
import java.time.Instant

/** A machine a shell can open on: the Space itself, or one of its peers (docs/terminal.md). */
data class TerminalMachine(
    val name: String,
    /** Set for a peer; its routes are under `/api/peers/<peer>/terminal`. */
    val peer: String? = null,
    /** Whether that machine offers a terminal at all. */
    val enabled: Boolean = true,
    val health: String = "ok",
) {
    val id: String get() = peer ?: ""
    val isDown: Boolean get() = health != "ok"
    val canOpen: Boolean get() = enabled && !isDown

    companion object : JsonReader<TerminalMachine> {
        override fun from(o: JSONObject): TerminalMachine? {
            val name = o.str("name") ?: return null
            // A peer that is there but not a string fails the row, as iOS's decodeIfPresent does.
            if (!o.isNullOrAbsent("peer") && o.str("peer") == null) return null
            return TerminalMachine(name, o.str("peer"), o.bool("enabled") ?: false, o.str("health") ?: "ok")
        }
    }
}

/** One row of the Space's audit trail: a session that ran or still runs. Times are epoch milliseconds. */
data class TerminalRecent(
    val id: String,
    val startedAt: Double = 0.0,
    val endedAt: Double? = null,
    val exitCode: Int? = null,
    /** Why it ended: exit, closed (the client left), idle, killed, lost (ai-space restarted). */
    val reason: String? = null,
    val bytesIn: Int = 0,
    val bytesOut: Int = 0,
) {
    val isOpen: Boolean get() = endedAt == null
    val started: Instant get() = Times.fromMillis(startedAt)

    /** Seconds it ran, for one that ended. */
    val duration: Double? get() = endedAt?.let { Math.max(it - startedAt, 0.0) / 1000 }

    companion object : JsonReader<TerminalRecent> {
        override fun from(o: JSONObject): TerminalRecent? {
            return TerminalRecent(
                id = o.str("id") ?: return null,
                startedAt = o.dbl("startedAt") ?: 0.0,
                endedAt = o.dbl("endedAt"),
                exitCode = o.int("exitCode"),
                reason = o.str("reason"),
                bytesIn = o.int("bytesIn") ?: 0,
                bytesOut = o.int("bytesOut") ?: 0,
            )
        }
    }
}

/** `GET /api/terminal`: whether this Space offers a shell, where one can open, and what ran. */
data class TerminalStatus(
    val enabled: Boolean = false,
    val shell: String = "",
    /** A passphrase is asked for before the first session on the Space's own machine. */
    val passphrase: Boolean = false,
    val idleMs: Double = 0.0,
    val maxSessions: Int = 0,
    val machines: List<TerminalMachine> = emptyList(),
    val recent: List<TerminalRecent> = emptyList(),
) {
    companion object : JsonReader<TerminalStatus> {
        override fun from(o: JSONObject) = TerminalStatus(
            enabled = o.bool("enabled") ?: false,
            shell = o.str("shell") ?: "",
            passphrase = o.bool("passphrase") ?: false,
            idleMs = o.dbl("idleMs") ?: 0.0,
            maxSessions = o.int("maxSessions") ?: 0,
            machines = Json.all(o.arr("machines"), TerminalMachine) ?: emptyList(),
            recent = Json.all(o.arr("recent"), TerminalRecent) ?: emptyList(),
        )
    }
}

/** The terminal's routes and frames, as the panel's page uses them (src/web/Terminal.tsx). */
object TerminalRoute {
    const val status = "/api/terminal"
    const val passphraseHeader = "x-terminal-passphrase"

    fun base(machine: TerminalMachine): String {
        val peer = machine.peer ?: return "/api/terminal"
        return "/api/peers/${Urls.encodeComponent(peer)}/terminal"
    }

    fun sessions(machine: TerminalMachine): String = base(machine) + "/sessions"

    /** The session's socket: the Space's own address with the scheme a socket takes, and the one-time ticket. */
    fun socket(machine: TerminalMachine, ticket: String, space: URI): URI? {
        val authority = space.rawAuthority ?: return null
        val scheme = if (space.scheme?.lowercase() == "http") "ws" else "wss"
        // Already encoded: a peer's name is a segment of it.
        return Urls.parse("$scheme://$authority${base(machine)}/ws?ticket=${Urls.encodeQueryValue(ticket)}")
    }

    /** The text frame that tells the shell its window. */
    fun resize(cols: Int, rows: Int): String = "{\"type\":\"resize\",\"cols\":$cols,\"rows\":$rows}"
}

/** What the Space answered to the request that opens a session. */
sealed class TerminalTicket {
    data class Ticket(val ticket: String) : TerminalTicket()

    /** The machine wants its passphrase, or the one given was wrong; the Space's own words. */
    data class Passphrase(val message: String) : TerminalTicket()

    /** The access layer wants a sign-in. */
    data object SignIn : TerminalTicket()
    data class Refused(val message: String) : TerminalTicket()

    companion object {
        fun read(status: Int, body: String): TerminalTicket {
            val o = Json.obj(body)
            val message = o?.str("error")
            return when {
                status in 200..299 -> {
                    val ticket = o?.str("ticket")
                    if (!ticket.isNullOrEmpty()) Ticket(ticket) else Refused(message ?: "no ticket")
                }
                // The terminal's own 401 names the passphrase; any other is the access layer's.
                status == 401 && message?.startsWith("passphrase") == true -> Passphrase(message)
                status in 300..399 || status == 401 -> SignIn
                status == 403 && message == null -> SignIn
                else -> Refused(message ?: "HTTP $status")
            }
        }
    }
}

/** A control message on the session's socket: a JSON text frame from the Space. */
sealed class TerminalControl {
    data object Ready : TerminalControl()

    /** The shell ended; no code when a signal ended it. `detail` is why it could not start. */
    data class Exit(val code: Int?, val detail: String?) : TerminalControl()
    data class Error(val message: String) : TerminalControl()

    /** The Space is closing the session: idle, killed or shutdown. */
    data class Closed(val reason: String) : TerminalControl()

    companion object {
        fun read(text: String): TerminalControl? {
            val o = Json.obj(text) ?: return null
            return when (o.str("type")) {
                "ready" -> Ready
                "exit" -> Exit(o.int("code"), o.str("detail")?.ifEmpty { null })
                "error" -> o.str("error")?.let { Error(it) }
                "closed" -> Closed(o.str("reason") ?: "")
                else -> null
            }
        }
    }
}

/**
 * Lines the client writes into the terminal itself, as the panel's page does: dim for what
 * happened to the session, red for what went wrong.
 */
object TerminalNotice {
    fun dim(text: String): String = "\r\n\u001B[2m[$text]\u001B[0m\r\n"
    fun red(text: String): String = "\r\n\u001B[31m$text\u001B[0m\r\n"

    /** The reasons the Space names before it closes a socket; any other close reason is shown as it came. */
    val knownReasons: Set<String> = setOf("idle", "killed", "shutdown", "exit")
}
