package dev.aispace.android.core

import org.json.JSONObject
import java.time.Instant

/*
 * What the Space's own settings show about itself (src/web/SettingsStatus.tsx): the services it
 * knows of and the backups of its apps, from `GET /api/services` and `GET /api/backups`. Peers
 * come with the catalogue. A malformed row is skipped, as in the catalogue.
 */

data class SpaceService(
    val app: String,
    val peer: String? = null,
    val title: String,
    val i18n: I18n? = null,
    val icon: String? = null,
    val port: Int? = null,
    val health: String? = null,
    val status: String? = null,
    /** Who runs the process: the Space, or the operator (docs/supervision.md). */
    val supervisor: String? = null,
) {
    val id: String get() = peer?.let { "$it/$app" } ?: app

    fun displayTitle(lang: String = Lang.current): String = Lang.pick(title, i18n, Lang.title, lang)

    enum class State { running, down, paused, unknown }

    val state: State
        get() {
            if (status == "paused" || status == "archived") return State.paused
            return when (health) {
                "ok" -> State.running
                "down" -> State.down
                else -> State.unknown
            }
        }

    companion object : JsonReader<SpaceService> {
        override fun from(o: JSONObject): SpaceService? {
            return SpaceService(
                app = o.str("app") ?: return null,
                peer = o.str("peer"),
                title = o.str("title") ?: return null,
                i18n = I18nReader.read(o),
                icon = o.str("icon"),
                port = o.int("port"),
                health = o.str("health"),
                status = o.str("status"),
                supervisor = o.str("supervisor"),
            )
        }
    }
}

data class SpaceBackup(
    val app: String,
    val count: Int? = null,
    /** Milliseconds since 1970, as the route sends them. */
    val lastAt: Double? = null,
    val lastStatus: String? = null,
    val lastError: String? = null,
    val lastOkAt: Double? = null,
    val lastOkBytes: Double? = null,
    val stale: Boolean? = null,
    val retired: Boolean? = null,
) {
    val id: String get() = app
    val lastOk: Instant? get() = lastOkAt?.let { Times.fromMillis(it) }

    enum class State {
        /** The last run saved a snapshot, recently enough. */
        ok,

        /** The newest snapshot is older than the Space allows. */
        stale,
        failed,

        /** No backup task will run again; the snapshots are history. */
        retired,
        none,
    }

    val state: State
        get() {
            if (retired == true) return State.retired
            if (lastStatus == "error") return State.failed
            if (stale == true) return State.stale
            return if (lastOkAt == null) State.none else State.ok
        }

    companion object : JsonReader<SpaceBackup> {
        override fun from(o: JSONObject): SpaceBackup? {
            return SpaceBackup(
                app = o.str("app") ?: return null,
                count = o.int("count"),
                lastAt = o.dbl("lastAt"),
                lastStatus = o.str("lastStatus"),
                lastError = o.str("lastError"),
                lastOkAt = o.dbl("lastOkAt"),
                lastOkBytes = o.dbl("lastOkBytes"),
                stale = o.bool("stale"),
                retired = o.bool("retired"),
            )
        }
    }
}

/** "codex · Basic · gpt-6-luna", as the panel's menu writes a model choice. */
internal fun modelLabel(value: String, runtime: String?, tier: String?, model: String?): String {
    val parts = listOfNotNull(runtime, tier?.let { t -> t.take(1).uppercase() + t.drop(1) }, model).filter { it.isNotEmpty() }
    return if (parts.isEmpty()) value else parts.joinToString(" · ")
}

/**
 * The Space's default model (`GET` and `PUT /api/model/preferences`): what app requests and
 * new Space Assistant chats use when nothing chooses a model for them.
 */
data class ModelPreferences(
    /** null while the Space follows its environment's defaults. */
    val defaultModel: String? = null,
    val appDefault: String? = null,
    val baseDefault: String? = null,
    val options: List<Option> = emptyList(),
) {
    data class Option(val value: String, val runtime: String? = null, val tier: String? = null, val model: String? = null) {
        val id: String get() = value

        /** "codex · Basic · gpt-6-luna", as the panel's menu writes it. */
        val label: String get() = modelLabel(value, runtime, tier, model)

        companion object : JsonReader<Option> {
            override fun from(o: JSONObject): Option? {
                return Option(o.str("value") ?: return null, o.str("runtime"), o.str("tier"), o.str("model"))
            }
        }
    }

    /** The label of a value, also of one the Space no longer offers. */
    fun label(value: String): String = options.firstOrNull { it.value == value }?.label ?: value

    companion object : JsonReader<ModelPreferences> {
        override fun from(o: JSONObject): ModelPreferences? {
            return ModelPreferences(
                defaultModel = o.str("defaultModel"),
                appDefault = o.str("appDefault"),
                baseDefault = o.str("baseDefault"),
                options = Json.lossy(o.arr("options") ?: return null, Option),
            )
        }
    }
}

data class SpaceSettings(
    val services: List<SpaceService> = emptyList(),
    val backups: List<SpaceBackup> = emptyList(),
    val models: ModelPreferences? = null,
    /** Where the backups go, when the Space says. */
    val backupTarget: String? = null,
) {
    companion object {
        /** The Space's settings from the answers of its routes; an answer that is not the route's reads as empty. */
        fun decode(services: String?, backups: String?, models: String? = null): SpaceSettings {
            var out = SpaceSettings()
            Json.obj(services)?.arr("services")?.let { rows ->
                out = out.copy(services = Json.lossy(rows, SpaceService).filter { it.status != "archived" })
            }
            Json.obj(backups)?.let { body ->
                body.arr("backups")?.let { rows -> out = out.copy(backups = Json.lossy(rows, SpaceBackup), backupTarget = body.str("target")) }
            }
            out = out.copy(models = Json.obj(models)?.let { ModelPreferences.from(it) })
            return out
        }
    }
}
