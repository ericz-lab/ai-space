package dev.aispace.android.core

import org.json.JSONObject

/*
 * Settings → Models: which agent CLIs each machine has (docs/model-machines.md#inventory,
 * src/web/MachineClis.tsx). `GET /api/model/inventory`; `POST /api/model/status/probe` checks
 * again now and answers the same way; `POST /api/model/runtimes {kind}` adds a CLI found on the
 * Space's own machine to runtimes.yaml (operator only; the Space takes the path from its probe).
 */

/** One agent CLI on one machine. [installed] and [signedIn] are null until it has been checked. */
data class CliInfo(
    val cli: String,
    val kind: String,
    val installed: Boolean? = null,
    val signedIn: Boolean? = null,
    val version: String? = null,
    val path: String? = null,
    val detail: String? = null,
    val checkedAt: String? = null,
    /** A runtime of that machine uses it. */
    val configured: Boolean = false,
    val runtimes: List<String> = emptyList(),
) {
    enum class State { Unknown, Missing, SignedIn, SignedOut, Installed }

    /** As the table's cell reads it (MachineClis.tsx `CliCell`). */
    val state: State
        get() = when {
            installed == null -> State.Unknown
            !installed -> State.Missing
            signedIn == false -> State.SignedOut
            signedIn == true -> State.SignedIn
            else -> State.Installed
        }

    /** Installed and not known to be signed out: a model choice on it can be picked. */
    val usable: Boolean get() = installed == true && signedIn != false

    companion object : JsonReader<CliInfo> {
        override fun from(o: JSONObject): CliInfo? {
            val cli = o.str("cli") ?: return null
            return CliInfo(
                cli = cli,
                kind = o.str("kind") ?: cli,
                installed = o.bool("installed"),
                signedIn = o.bool("signedIn"),
                version = o.str("version"),
                path = o.str("path"),
                detail = o.str("detail"),
                checkedAt = o.str("checkedAt"),
                configured = o.bool("configured") == true,
                runtimes = o.strings("runtimes") ?: emptyList(),
            )
        }
    }
}

/** One machine's CLIs: the Space's own ([machine] ""), one reached over ssh, or a peer. */
data class MachineInventory(
    val machine: String,
    /** local, ssh or peer. */
    val via: String,
    val reachable: Boolean? = null,
    val stale: Boolean? = null,
    /** A peer whose ai-space is too old to list its CLIs. */
    val old: Boolean? = null,
    val clis: List<CliInfo> = emptyList(),
) {
    enum class Note { None, Ssh, Peer, Unreachable, Offline, Old }

    /** What the machine's heading says beside its name. */
    val note: Note
        get() = when {
            old == true -> Note.Old
            stale == true -> Note.Offline
            reachable == false -> Note.Unreachable
            via == "local" -> Note.None
            via == "ssh" -> Note.Ssh
            else -> Note.Peer
        }

    /** Its figures are not live: shown dimmed. */
    val isOff: Boolean get() = stale == true || reachable == false

    val isLocal: Boolean get() = via == "local"

    fun cli(name: String): CliInfo? = clis.firstOrNull { it.cli == name }

    /** The CLIs a chat there can use, for the chat's machine menu: "claude, codex". */
    val usableClis: List<String> get() = clis.filter { it.usable }.map { it.cli }

    /**
     * Whether a CLI on this machine can be added to runtimes.yaml from here: found on the Space's own
     * machine, used by no runtime, and not already added since the Space started ([pending] kinds).
     */
    fun canAdd(c: CliInfo, pending: Set<String> = emptySet()): Boolean =
        isLocal && old != true && c.installed == true && !c.configured && c.kind !in pending

    companion object : JsonReader<MachineInventory> {
        override fun from(o: JSONObject): MachineInventory? {
            return MachineInventory(
                machine = o.str("machine") ?: return null,
                via = o.str("via") ?: "peer",
                reachable = o.bool("reachable"),
                stale = o.bool("stale"),
                old = o.bool("old"),
                clis = o.arr("clis")?.let { Json.lossy(it, CliInfo) } ?: emptyList(),
            )
        }
    }
}

object Inventory {
    const val PATH = "/api/model/inventory"
    const val PROBE = "/api/model/status/probe"
    const val ADD = "/api/model/runtimes"

    fun decode(text: String): List<MachineInventory> = Hub.rows("machines", text, MachineInventory)

    /** Every CLI name any machine lists, in the order first seen: the columns of the panel's table. */
    fun cliNames(rows: List<MachineInventory>): List<String> = rows.flatMap { r -> r.clis.map { it.cli } }.distinct()

    /** The latest check of any CLI, as the Space wrote it. */
    fun lastChecked(rows: List<MachineInventory>): String? =
        rows.flatMap { r -> r.clis.mapNotNull { it.checkedAt?.ifEmpty { null } } }.maxOrNull()

    /** The machine of an agent's variant: a peer's name, or "" for the Space's own. */
    fun machine(rows: List<MachineInventory>, peer: String?): MachineInventory? = rows.firstOrNull { it.machine == (peer ?: "") }

    /** The body of an add, and the runtime name its answer gives. */
    fun addBody(kind: String): JSONObject = JSONObject().put("kind", kind)

    fun addedRuntime(answer: String): String? = Json.obj(answer)?.str("runtime")
}
