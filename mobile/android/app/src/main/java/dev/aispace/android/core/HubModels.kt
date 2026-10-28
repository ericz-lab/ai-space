package dev.aispace.android.core

import org.json.JSONArray
import org.json.JSONObject
import java.text.NumberFormat
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException
import java.time.temporal.ChronoUnit

/*
 * What the Space's own pages read (src/web/api.ts has the full shapes): tasks, model usage, app
 * usage, app models, events, packages, the inbox and chat. Every field a page can live without
 * is optional, so a newer or older Space still decodes; a malformed row is skipped.
 */

object Hub {
    /**
     * The rows under one key of a route's answer: `{"ok":true,"tasks":[…]}`. A missing key is an
     * empty list; an answer that is not a JSON object, or a key that is not a list, throws
     * [DecodingException].
     */
    fun <T> rows(key: String, data: String, reader: JsonReader<T>): List<T> {
        val o = Json.requireObj(data)
        if (o.isNullOrAbsent(key)) return emptyList()
        val a = o.arr(key) ?: throw DecodingException("\"$key\" is not a list")
        return Json.lossy(a, reader)
    }

    /** One value of the answer; throws [DecodingException] when it is not one. */
    fun <T> decode(data: String, reader: JsonReader<T>): T = Json.decode(data, reader)
}

/** Any JSON value, for an event's free-form data. */
sealed class JSONValue {
    data object Null : JSONValue()
    data class Bool(val value: Boolean) : JSONValue()
    data class Number(val value: Double) : JSONValue()
    data class Str(val value: String) : JSONValue()
    data class Array(val values: List<JSONValue>) : JSONValue()
    data class Object(val fields: Map<String, JSONValue>) : JSONValue()

    /** The value on one line: a string bare, anything else as JSON. */
    val compact: String
        get() = when (this) {
            Null -> "null"
            is Bool -> if (value) "true" else "false"
            is Number -> if (value == Math.rint(value) && Math.abs(value) < 1e15) value.toLong().toString() else value.toString()
            is Str -> value
            is Array -> "[" + values.joinToString(",") { it.quoted } + "]"
            is Object -> "{" + fields.entries.sortedBy { it.key }.joinToString(",") { "\"${it.key}\":${it.value.quoted}" } + "}"
        }

    private val quoted: String get() = if (this is Str) "\"$value\"" else compact

    companion object {
        /** An org.json value (as `opt` returns it) as a [JSONValue]; null for something that is not JSON. */
        fun of(v: Any?): JSONValue? {
            return when (v) {
                null, JSONObject.NULL -> Null
                is Boolean -> Bool(v)
                is kotlin.Number -> Number(v.toDouble())
                is String -> Str(v)
                is JSONArray -> Array((0 until v.length()).map { of(v.opt(it)) ?: return null })
                is JSONObject -> Object(fieldsOf(v) ?: return null)
                else -> null
            }
        }

        fun fieldsOf(o: JSONObject): Map<String, JSONValue>? {
            val m = LinkedHashMap<String, JSONValue>()
            for (k in o.keyList()) m[k] = of(o.opt(k)) ?: return null
            return m
        }
    }
}

/**
 * An app's name and icon for a heading; `GET /api/apps?all=1` also names headless and hidden apps.
 * [id] is `<peer>/<app>` for a peer's app, as its model calls name it.
 */
data class AppLabel(val name: String, val title: String, val i18n: I18n? = null, val icon: String? = null, val id: String = name) {
    fun displayTitle(lang: String = Lang.current): String = Lang.pick(title, i18n, Lang.title, lang)

    companion object : JsonReader<AppLabel> {
        override fun from(o: JSONObject): AppLabel? {
            val name = o.str("name") ?: return null
            return AppLabel(name, o.str("title") ?: return null, I18nReader.read(o), o.str("icon"), o.str("id") ?: name)
        }

        /** Labels by id and, for the bare name a row may carry, the first app of that name (local before peers). */
        fun index(apps: List<AppLabel>): Map<String, AppLabel> {
            val map = LinkedHashMap<String, AppLabel>()
            for (a in apps) map.putIfAbsent(a.id, a)
            for (a in apps) map.putIfAbsent(a.name, a)
            return map
        }
    }
}

/**
 * A runtime and tier a task or an app's calls may run on. [unavailable] says why it is shown but
 * cannot be picked (docs/model-machines.md#inventory): `signed-out` or `offline`; null is offered.
 */
data class ModelChoice(
    val value: String,
    val runtime: String? = null,
    val tier: String? = null,
    val model: String? = null,
    val capabilities: Capabilities? = null,
    val unavailable: String? = null,
) {
    data class Capabilities(val agent: Boolean? = null, val complete: Boolean? = null) {
        companion object : JsonReader<Capabilities> {
            override fun from(o: JSONObject) = Capabilities(o.bool("agent"), o.bool("complete"))
        }
    }

    val id: String get() = value
    val label: String get() = modelLabel(value, runtime, tier, model)

    companion object : JsonReader<ModelChoice> {
        override fun from(o: JSONObject): ModelChoice? {
            return ModelChoice(
                value = o.str("value") ?: return null,
                runtime = o.str("runtime"),
                tier = o.str("tier"),
                model = o.str("model"),
                capabilities = o.obj("capabilities")?.let { Capabilities.from(it) },
                unavailable = o.str("unavailable"),
            )
        }
    }
}

/**
 * How every model picker shows its choices (src/web/model-choices.tsx): the Space already left out
 * what is missing on its machine; a choice that is not signed in, or on a peer that is offline,
 * comes with `unavailable` and is shown greyed; a saved value no longer offered stays shown, marked,
 * so nothing is rewritten behind the person's back.
 */
object ModelChoices {
    /** Why a choice cannot be picked, as the menu marks it. */
    enum class Reason { SignedOut, Offline }

    /** The reason of an `unavailable` value; an unknown one still greys the choice. */
    fun reason(unavailable: String?): Reason? = when (unavailable) {
        null, "" -> null
        "offline" -> Reason.Offline
        else -> Reason.SignedOut
    }

    /** The saved value when the Space no longer offers it: shown on its own row, marked, not pickable. */
    fun savedMissing(current: String?, offered: List<String>): String? =
        current?.takeIf { it.isNotEmpty() && it !in offered }
}

// Tasks (docs/scheduler.md)

data class TaskSchedule(
    val kind: String,
    val at: String? = null,
    val everyMs: Double? = null,
    val expr: String? = null,
    val tz: String? = null,
) {
    companion object : JsonReader<TaskSchedule> {
        override fun from(o: JSONObject): TaskSchedule? {
            return TaskSchedule(o.str("kind") ?: return null, o.str("at"), o.dbl("everyMs"), o.str("expr"), o.str("tz"))
        }
    }
}

data class SpaceTask(
    val id: String,
    val app: String,
    val name: String,
    val description: String? = null,
    val source: String? = null,
    val orphaned: Boolean? = null,
    val enabled: Boolean? = null,
    val schedule: TaskSchedule,
    val target: Target? = null,
    val triggers: List<Trigger>? = null,
    val overrides: Overrides? = null,
    val model: String? = null,
    val modelSelectable: Boolean? = null,
    val base: Base? = null,
    val state: State? = null,
) {
    data class Target(val kind: String? = null) {
        companion object : JsonReader<Target> {
            override fun from(o: JSONObject) = Target(o.str("kind"))
        }
    }

    data class Trigger(val event: String) {
        companion object : JsonReader<Trigger> {
            override fun from(o: JSONObject): Trigger? {
                return Trigger(o.str("event") ?: return null)
            }
        }
    }

    data class Overrides(val enabled: Boolean? = null, val schedule: TaskSchedule? = null, val model: String? = null) {
        val isEmpty: Boolean get() = enabled == null && schedule == null && model == null

        companion object : JsonReader<Overrides> {
            override fun from(o: JSONObject) =
                Overrides(o.bool("enabled"), o.obj("schedule")?.let { TaskSchedule.from(it) }, o.str("model"))
        }
    }

    data class Base(val model: String? = null) {
        companion object : JsonReader<Base> {
            override fun from(o: JSONObject) = Base(o.str("model"))
        }
    }

    data class Pending(val events: Int, val dueAt: String? = null) {
        companion object : JsonReader<Pending> {
            override fun from(o: JSONObject): Pending? {
                return Pending(o.int("events") ?: return null, o.str("dueAt"))
            }
        }
    }

    data class State(
        val nextRunAt: String? = null,
        val runningAt: String? = null,
        val lastRunAt: String? = null,
        val lastStatus: String? = null,
        val lastError: String? = null,
        val lastDurationMs: Double? = null,
        val consecutiveErrors: Int? = null,
        val pending: Pending? = null,
    ) {
        companion object : JsonReader<State> {
            override fun from(o: JSONObject) = State(
                nextRunAt = o.str("nextRunAt"),
                runningAt = o.str("runningAt"),
                lastRunAt = o.str("lastRunAt"),
                lastStatus = o.str("lastStatus"),
                lastError = o.str("lastError"),
                lastDurationMs = o.dbl("lastDurationMs"),
                consecutiveErrors = o.int("consecutiveErrors"),
                pending = o.obj("pending")?.let { Pending.from(it) },
            )
        }
    }

    sealed class Status {
        /** Its app or manifest entry is gone. */
        data object Orphaned : Status()
        data object Off : Status()
        data object Running : Status()
        data object Ok : Status()

        /** Failed, this many times in a row. */
        data class Error(val times: Int) : Status()
        data object Skipped : Status()
        data object NeverRan : Status()
    }

    /** As the panel's row reads it (Tasks.tsx `rowStatus`). */
    val status: Status
        get() {
            if (orphaned == true) return Status.Orphaned
            if (enabled == false) return Status.Off
            if (state?.runningAt != null) return Status.Running
            return when (state?.lastStatus) {
                "ok" -> Status.Ok
                "error" -> Status.Error(Math.max(state?.consecutiveErrors ?: 1, 1))
                "skipped" -> Status.Skipped
                else -> Status.NeverRan
            }
        }

    val isActive: Boolean get() = enabled != false && orphaned != true
    val isFailing: Boolean get() = isActive && state?.lastStatus == "error"

    /** The models this task may be given: an agent task needs a runtime that runs agents. */
    fun eligible(options: List<ModelChoice>): List<ModelChoice> =
        options.filter { if (target?.kind == "agent") it.capabilities?.agent == true else it.capabilities?.complete == true }

    companion object : JsonReader<SpaceTask> {
        override fun from(o: JSONObject): SpaceTask? {
            return SpaceTask(
                id = o.str("id") ?: return null,
                app = o.str("app") ?: return null,
                name = o.str("name") ?: return null,
                description = o.str("description"),
                source = o.str("source"),
                orphaned = o.bool("orphaned"),
                enabled = o.bool("enabled"),
                schedule = o.obj("schedule")?.let { TaskSchedule.from(it) } ?: return null,
                target = o.obj("target")?.let { Target.from(it) },
                triggers = o.arr("triggers")?.let { Json.all(it, Trigger) },
                overrides = o.obj("overrides")?.let { Overrides.from(it) },
                model = o.str("model"),
                modelSelectable = o.bool("modelSelectable"),
                base = o.obj("base")?.let { Base.from(it) },
                state = o.obj("state")?.let { State.from(it) },
            )
        }
    }
}

data class TaskRun(
    val id: Int,
    /** Milliseconds since 1970. */
    val startedAt: Double,
    val endedAt: Double? = null,
    val status: String,
    val error: String? = null,
    val output: String? = null,
    val trigger: String? = null,
    val eventIds: List<Int>? = null,
) {
    val started: Instant get() = Times.fromMillis(startedAt)
    val durationMs: Double? get() = endedAt?.let { it - startedAt }

    companion object : JsonReader<TaskRun> {
        override fun from(o: JSONObject): TaskRun? {
            return TaskRun(
                id = o.int("id") ?: return null,
                startedAt = o.dbl("startedAt") ?: return null,
                endedAt = o.dbl("endedAt"),
                status = o.str("status") ?: return null,
                error = o.str("error"),
                output = o.str("output"),
                trigger = o.str("trigger"),
                eventIds = o.ints("eventIds"),
            )
        }
    }
}

// Model usage (docs/model.md)

data class ModelTotals(
    val calls: Double? = null,
    val errors: Double? = null,
    val inputTokens: Double? = null,
    val cacheWriteTokens: Double? = null,
    val cacheReadTokens: Double? = null,
    val outputTokens: Double? = null,
    val tokens: Double? = null,
    val costUsd: Double? = null,
    val durationMs: Double? = null,
) {
    companion object : JsonReader<ModelTotals> {
        override fun from(o: JSONObject) = ModelTotals(
            o.dbl("calls"), o.dbl("errors"), o.dbl("inputTokens"), o.dbl("cacheWriteTokens"), o.dbl("cacheReadTokens"),
            o.dbl("outputTokens"), o.dbl("tokens"), o.dbl("costUsd"), o.dbl("durationMs"),
        )
    }
}

/**
 * Totals for one app, tag, model, backend or day: the totals and whichever names the row has. On a
 * hub a peer's app is `<peer>/<app>`, and [machine] names the machine that ran the model when it is
 * not this one (docs/model-machines.md#ledger).
 */
data class ModelUsageRow(
    val totals: ModelTotals,
    val app: String? = null,
    val tag: String? = null,
    val model: String? = null,
    val backend: String? = null,
    /** task, run, import, or peer (calls this Space ran for other Spaces). */
    val origin: String? = null,
    val day: String? = null,
    val machine: String? = null,
) {
    /** The model with the machine that ran it: `david:gpt-6-luna` (Usage.tsx `modelOn`). */
    val modelOn: String? get() = model?.let { ModelUsage.modelOn(it, machine) }

    companion object : JsonReader<ModelUsageRow> {
        override fun from(o: JSONObject) = ModelUsageRow(
            ModelTotals.from(o), o.str("app"), o.str("tag"), o.str("model"), o.str("backend"), o.str("origin"), o.str("day"),
            o.str("machine")?.ifEmpty { null },
        )
    }
}

/** One week's figure: the Monday it starts on (UTC) and the sum. */
data class WeeklyValue(val week: LocalDate, val value: Double)

data class ModelUsage(
    val window: String? = null,
    val backend: String? = null,
    val totals: ModelTotals,
    val byApp: List<ModelUsageRow>? = null,
    val byTag: List<ModelUsageRow>? = null,
    val byModel: List<ModelUsageRow>? = null,
    val history: History? = null,
    /** The Space whose ledger this is; a newer Space names itself. */
    val space: String? = null,
    val byBackend: List<ModelUsageRow>? = null,
    /** On a hub: each peer, whether its rows are in, and from when. */
    val peers: List<Peer>? = null,
) {
    /** A peer's part of a hub's figures: [ok] in, else missing or ([asOf]) from its last answer. */
    data class Peer(val name: String, val ok: Boolean, val asOf: String? = null, val error: String? = null) {
        companion object : JsonReader<Peer> {
            override fun from(o: JSONObject): Peer? {
                return Peer(o.str("name") ?: return null, o.bool("ok") == true, o.str("asOf"), o.str("error"))
            }
        }
    }

    /** The peers whose figures are not all in now. */
    val absentPeers: List<Peer> get() = peers?.filter { !it.ok } ?: emptyList()

    data class History(val firstAt: String? = null, val totals: ModelTotals? = null, val days: List<ModelUsageRow>? = null) {
        companion object : JsonReader<History> {
            override fun from(o: JSONObject) = History(
                o.str("firstAt"), o.obj("totals")?.let { ModelTotals.from(it) }, o.arr("days")?.let { Json.lossy(it, ModelUsageRow) },
            )
        }
    }

    /** Whole days since the first recorded call, at least one; 0 when nothing was recorded. */
    fun daysRecorded(now: Instant = Instant.now()): Int {
        val first = history?.firstAt?.let { ISO8601.parse(it) } ?: return 0
        val days = Duration.between(first, now).toMillis() / 86_400_000.0
        return Math.max(1, Math.ceil(days).toInt())
    }

    /**
     * The last weeks' totals of one figure, oldest first; weeks are UTC and start on Monday,
     * like the ledger's days (Usage.tsx `History`).
     */
    fun weekly(figure: (ModelTotals) -> Double?, last: Int = 12): List<WeeklyValue> {
        val sums = sortedMapOf<LocalDate, Double>()
        for (row in history?.days ?: emptyList()) {
            val day = row.day?.let {
                try {
                    LocalDate.parse(it, DateTimeFormatter.ISO_LOCAL_DATE)
                } catch (e: DateTimeParseException) {
                    null
                }
            } ?: continue
            val week = day.minusDays((day.dayOfWeek.value - 1).toLong())
            sums[week] = (sums[week] ?: 0.0) + (figure(row.totals) ?: 0.0)
        }
        return sums.entries.map { WeeklyValue(it.key, it.value) }.takeLast(last)
    }

    companion object : JsonReader<ModelUsage> {
        override fun from(o: JSONObject): ModelUsage? {
            return ModelUsage(
                window = o.str("window"),
                backend = o.str("backend"),
                totals = o.obj("totals")?.let { ModelTotals.from(it) } ?: return null,
                byApp = o.arr("byApp")?.let { Json.lossy(it, ModelUsageRow) },
                byTag = o.arr("byTag")?.let { Json.lossy(it, ModelUsageRow) },
                byModel = o.arr("byModel")?.let { Json.lossy(it, ModelUsageRow) },
                history = o.obj("history")?.let { History.from(it) },
                space = o.str("space")?.ifEmpty { null },
                byBackend = o.arr("byBackend")?.let { Json.lossy(it, ModelUsageRow) },
                peers = o.arr("peers")?.let { Json.lossy(it, Peer) },
            )
        }

        /** `<machine>:<model>` when another machine ran it, else the model. */
        fun modelOn(model: String, machine: String?): String = if (machine.isNullOrEmpty()) model else "$machine:$model"
    }
}

data class ModelCall(
    /** Negative for a peer's call on a hub, so ids never collide. */
    val id: Int,
    /** `<peer>/<app>` for a peer's call on a hub. */
    val app: String,
    val tag: String? = null,
    val model: String? = null,
    /** The machine that ran the model, when it is not this one. */
    val machine: String? = null,
    /** The peer this call comes from, on a hub. */
    val peer: String? = null,
    val origin: String? = null,
    val status: String? = null,
    val error: String? = null,
    val startedAt: String? = null,
    val durationMs: Double? = null,
    val usage: Tokens? = null,
    val costUsd: Double? = null,
) {
    data class Tokens(
        val inputTokens: Double? = null,
        val cacheWriteTokens: Double? = null,
        val cacheReadTokens: Double? = null,
        val outputTokens: Double? = null,
    ) {
        val total: Double get() = (inputTokens ?: 0.0) + (cacheWriteTokens ?: 0.0) + (cacheReadTokens ?: 0.0) + (outputTokens ?: 0.0)

        companion object : JsonReader<Tokens> {
            override fun from(o: JSONObject) =
                Tokens(o.dbl("inputTokens"), o.dbl("cacheWriteTokens"), o.dbl("cacheReadTokens"), o.dbl("outputTokens"))
        }
    }

    /** The model with the machine that ran it: `david:gpt-6-luna`. */
    val modelOn: String? get() = model?.let { ModelUsage.modelOn(it, machine) }

    companion object : JsonReader<ModelCall> {
        override fun from(o: JSONObject): ModelCall? {
            return ModelCall(
                id = o.int("id") ?: return null,
                app = o.str("app") ?: return null,
                tag = o.str("tag"),
                model = o.str("model"),
                machine = o.str("machine")?.ifEmpty { null },
                peer = o.str("peer")?.ifEmpty { null },
                origin = o.str("origin"),
                status = o.str("status"),
                error = o.str("error"),
                startedAt = o.str("startedAt"),
                durationMs = o.dbl("durationMs"),
                usage = o.obj("usage")?.let { Tokens.from(it) },
                costUsd = o.dbl("costUsd"),
            )
        }
    }
}

// App usage (docs/usage.md)

data class AppUsageRow(
    val kind: String,
    val key: String,
    val opens: Int,
    /** null when the entry does not measure time in use. */
    val activeMs: Double? = null,
    val sessions: Int? = null,
    val lastAt: String? = null,
    val daily: List<Day>? = null,
) {
    data class Day(val day: String, val opens: Double? = null, val activeMs: Double? = null) {
        companion object : JsonReader<Day> {
            override fun from(o: JSONObject): Day? {
                return Day(o.str("day") ?: return null, o.dbl("opens"), o.dbl("activeMs"))
            }
        }
    }

    val id: String get() = "$kind:$key"

    val averageMs: Double?
        get() {
            val active = activeMs ?: return null
            val s = sessions ?: return null
            return if (s > 0) active / s else null
        }

    /** The last UTC days as bars: time in use when the entry measures it, opens otherwise. */
    fun spark(days: Int = 30, now: Instant = Instant.now()): List<Double> {
        val byDay = LinkedHashMap<String, Day>()
        for (d in daily ?: emptyList()) byDay.putIfAbsent(d.day, d)
        return (0 until days).map { i ->
            val label = now.minus((days - 1 - i).toLong(), ChronoUnit.DAYS).atOffset(ZoneOffset.UTC).toLocalDate()
            val d = byDay[label.toString()] ?: return@map 0.0
            (if (activeMs != null) d.activeMs else d.opens) ?: 0.0
        }
    }

    companion object : JsonReader<AppUsageRow> {
        override fun from(o: JSONObject): AppUsageRow? {
            return AppUsageRow(
                kind = o.str("kind") ?: return null,
                key = o.str("key") ?: return null,
                opens = o.int("opens") ?: return null,
                activeMs = o.dbl("activeMs"),
                sessions = o.int("sessions"),
                lastAt = o.str("lastAt"),
                daily = o.arr("daily")?.let { Json.all(it, Day) },
            )
        }
    }
}

// App models (docs/model.md#app-models)

data class AppModelRows(val app: String, val rows: List<Row>) {
    data class Row(
        /** null is the row for the whole app. */
        val tag: String? = null,
        /** What space.yaml declares. */
        val manifest: String? = null,
        /** What the panel set over it. */
        val override: String? = null,
        /** What the calls run on now. */
        val model: String,
        val source: String? = null,
    ) {
        val id: String get() = tag ?: ""

        companion object : JsonReader<Row> {
            override fun from(o: JSONObject): Row? {
                return Row(o.str("tag"), o.str("manifest"), o.str("override"), o.str("model") ?: return null, o.str("source"))
            }
        }
    }

    val id: String get() = app

    companion object : JsonReader<AppModelRows> {
        override fun from(o: JSONObject): AppModelRows? {
            return AppModelRows(o.str("app") ?: return null, Json.all(o.arr("rows"), Row) ?: return null)
        }
    }
}

/**
 * One peer's part of the App models page, on a hub (docs/peers.md): its apps' rows and its own
 * choices, since the calls run there; or why there are none. Read through
 * `GET /api/peers/:peer/model/apps`, which an older core does not have.
 */
data class PeerAppModels(
    val peer: String,
    /** null while it is being read, or when it could not be. */
    val apps: List<AppModelRows>? = null,
    val options: List<ModelChoice> = emptyList(),
    val error: String? = null,
    /** The peer runs a core without the route. */
    val old: Boolean = false,
) {
    val isLoading: Boolean get() = apps == null && error == null && !old

    /** The same peer with one app's rows as a save answered them. */
    fun replacing(rows: AppModelRows): PeerAppModels = copy(apps = apps?.map { if (it.app == rows.app) rows else it })

    companion object {
        /** A success's body: an older core answers a path it does not know with its page, not JSON. */
        fun answer(peer: String, body: String): PeerAppModels {
            val o = Json.obj(body) ?: return PeerAppModels(peer, old = true)
            if (o.bool("ok") == false) return PeerAppModels(peer, error = o.str("error") ?: "not ok")
            val apps = o.arr("apps")?.let { Json.lossy(it, AppModelRows) } ?: emptyList()
            val options = o.arr("options")?.let { Json.lossy(it, ModelChoice) } ?: emptyList()
            return PeerAppModels(peer, apps, options)
        }

        /** A refusal: a 404 that is not the hub's "unknown peer" means the peer's core has no such route. */
        fun failure(peer: String, code: Int, message: String): PeerAppModels =
            if (code == 404 && !message.startsWith("unknown peer")) PeerAppModels(peer, old = true)
            else PeerAppModels(peer, error = message.ifEmpty { "HTTP $code" })

        fun path(peer: String): String = "/api/peers/${SpacePath.escape(peer)}/model/apps"

        /** Where an app's override is set: the Space's own route, or the peer's through the hub. */
        fun savePath(app: String, peer: String?): String =
            if (peer == null) "/api/panel/apps/${SpacePath.escape(app)}/model"
            else "/api/peers/${SpacePath.escape(peer)}/apps/${SpacePath.escape(app)}/model"

        /** A peer app's icon on the peer, for one the hub's list leaves out. */
        fun iconPath(peer: String, app: String): String = "/api/peers/${SpacePath.escape(peer)}/apps/${SpacePath.escape(app)}/icon"
    }
}

// Events (docs/events.md)

data class SpaceEvent(
    val id: Int,
    val name: String,
    val app: String? = null,
    val at: String,
    val peer: String? = null,
    val data: Map<String, JSONValue>? = null,
) {
    /** The first few fields of the data on one line (Events.tsx `previewData`). */
    val preview: String
        get() {
            val s = (data ?: emptyMap()).entries.sortedBy { it.key }.take(4).joinToString(" · ") { "${it.key}: ${it.value.compact}" }
            return if (s.length > 120) s.take(119) + "…" else s
        }

    companion object : JsonReader<SpaceEvent> {
        override fun from(o: JSONObject): SpaceEvent? {
            return SpaceEvent(
                id = o.int("id") ?: return null,
                name = o.str("name") ?: return null,
                app = o.str("app"),
                at = o.str("at") ?: return null,
                peer = o.str("peer"),
                data = o.obj("data")?.let { JSONValue.fieldsOf(it) },
            )
        }
    }
}

data class EventDelivery(
    val id: Int,
    val app: String,
    val kind: String? = null,
    val method: String? = null,
    val path: String? = null,
    val status: String,
    val attempts: Int? = null,
    val lastError: String? = null,
) {
    companion object : JsonReader<EventDelivery> {
        override fun from(o: JSONObject): EventDelivery? {
            return EventDelivery(
                id = o.int("id") ?: return null,
                app = o.str("app") ?: return null,
                kind = o.str("kind"),
                method = o.str("method"),
                path = o.str("path"),
                status = o.str("status") ?: return null,
                attempts = o.int("attempts"),
                lastError = o.str("lastError"),
            )
        }
    }
}

data class CapabilityApp(
    val app: String,
    val peer: String? = null,
    val provides: List<Provided>? = null,
    val publishes: List<Published>? = null,
    val consumes: List<Consumed>? = null,
    val stats: List<Stat>? = null,
) {
    data class Provided(val name: String, val description: String? = null, val method: String? = null, val path: String? = null) {
        companion object : JsonReader<Provided> {
            override fun from(o: JSONObject): Provided? {
                return Provided(o.str("name") ?: return null, o.str("description"), o.str("method"), o.str("path"))
            }
        }
    }

    data class Published(val name: String, val description: String? = null) {
        companion object : JsonReader<Published> {
            override fun from(o: JSONObject): Published? {
                return Published(o.str("name") ?: return null, o.str("description"))
            }
        }
    }

    data class Consumed(
        val event: String,
        val kind: String? = null,
        val task: String? = null,
        val method: String? = null,
        val path: String? = null,
    ) {
        companion object : JsonReader<Consumed> {
            override fun from(o: JSONObject): Consumed? {
                return Consumed(o.str("event") ?: return null, o.str("kind"), o.str("task"), o.str("method"), o.str("path"))
            }
        }
    }

    data class Stat(val capability: String, val calls: Int? = null, val failures: Int? = null) {
        companion object : JsonReader<Stat> {
            override fun from(o: JSONObject): Stat? {
                return Stat(o.str("capability") ?: return null, o.int("calls"), o.int("failures"))
            }
        }
    }

    val id: String get() = peer?.let { "$it/$app" } ?: app
    val isEmpty: Boolean get() = provides.isNullOrEmpty() && publishes.isNullOrEmpty() && consumes.isNullOrEmpty()

    companion object : JsonReader<CapabilityApp> {
        override fun from(o: JSONObject): CapabilityApp? {
            return CapabilityApp(
                app = o.str("app") ?: return null,
                peer = o.str("peer"),
                provides = o.arr("provides")?.let { Json.all(it, Provided) },
                publishes = o.arr("publishes")?.let { Json.all(it, Published) },
                consumes = o.arr("consumes")?.let { Json.all(it, Consumed) },
                stats = o.arr("stats")?.let { Json.all(it, Stat) },
            )
        }
    }
}

// Packages and connections (docs/packages.md)

data class PackageApp(
    val app: String,
    val title: String? = null,
    val version: String? = null,
    val url: String? = null,
    val page: Boolean? = null,
    val state: String? = null,
) {
    val id: String get() = app

    companion object : JsonReader<PackageApp> {
        override fun from(o: JSONObject): PackageApp? {
            return PackageApp(o.str("app") ?: return null, o.str("title"), o.str("version"), o.str("url"), o.bool("page"), o.str("state"))
        }
    }
}

data class PackageCatalogue(
    val spaceId: String? = null,
    val apps: List<PackageApp>? = null,
    val remotes: List<Remote>? = null,
) {
    data class Remote(
        val connectionId: String,
        val spaceId: String? = null,
        val available: Boolean? = null,
        val apps: List<PackageApp>? = null,
    ) {
        val id: String get() = connectionId

        companion object : JsonReader<Remote> {
            override fun from(o: JSONObject): Remote? {
                return Remote(
                    o.str("connectionId") ?: return null, o.str("spaceId"), o.bool("available"),
                    o.arr("apps")?.let { Json.lossy(it, PackageApp) },
                )
            }
        }
    }

    companion object : JsonReader<PackageCatalogue> {
        override fun from(o: JSONObject) = PackageCatalogue(
            o.str("spaceId"), o.arr("apps")?.let { Json.lossy(it, PackageApp) }, o.arr("remotes")?.let { Json.lossy(it, Remote) },
        )
    }
}

/** A connection to another Space, and the apps this Space shares over it. */
data class SpaceLink(
    val id: String,
    val remoteSpaceId: String? = null,
    val direction: String? = null,
    val url: String? = null,
    val apps: List<String>? = null,
    val enabled: Boolean? = null,
    val connected: Boolean? = null,
) {
    companion object : JsonReader<SpaceLink> {
        override fun from(o: JSONObject): SpaceLink? {
            return SpaceLink(
                o.str("id") ?: return null, o.str("remoteSpaceId"), o.str("direction"), o.str("url"),
                o.strings("apps"), o.bool("enabled"), o.bool("connected"),
            )
        }
    }
}

// Inbox (docs/notify.md#inbox)

data class InboxThread(
    val thread: String,
    val app: String,
    val level: String? = null,
    val title: String? = null,
    val text: String,
    val url: String? = null,
    val count: Int? = null,
    val firstAt: String? = null,
    val lastAt: String? = null,
    /** The level asks for something (alert or warn). */
    val action: Boolean? = null,
    val unread: Boolean? = null,
    val done: Boolean? = null,
) {
    val id: String get() = thread

    /** The row's heading: the title, or the text's first line. */
    val heading: String get() = title?.ifEmpty { null } ?: firstLine(text)

    companion object : JsonReader<InboxThread> {
        fun firstLine(text: String): String {
            val line = text.split("\n", limit = 2).first()
            return if (line.length > 140) line.take(139) + "…" else line
        }

        override fun from(o: JSONObject): InboxThread? {
            return InboxThread(
                thread = o.str("thread") ?: return null,
                app = o.str("app") ?: return null,
                level = o.str("level"),
                title = o.str("title"),
                text = o.str("text") ?: return null,
                url = o.str("url"),
                count = o.int("count"),
                firstAt = o.str("firstAt"),
                lastAt = o.str("lastAt"),
                action = o.bool("action"),
                unread = o.bool("unread"),
                done = o.bool("done"),
            )
        }
    }
}

/** `GET /api/inbox`: the threads of a filter and the counts. */
data class InboxPage(val items: List<InboxThread>? = null, val summary: InboxSummary? = null) {
    companion object : JsonReader<InboxPage> {
        override fun from(o: JSONObject) =
            InboxPage(o.arr("items")?.let { Json.lossy(it, InboxThread) }, o.obj("summary")?.let { InboxSummary.from(it) })
    }
}

enum class InboxFilter {
    all, unread, handle, done;

    val id: String get() = name

    /** The query of `GET /api/inbox` (Inbox.tsx `QUERY`). */
    val query: String
        get() = when (this) {
            all -> "filter=all"
            unread -> "filter=unread"
            handle -> "filter=open&action=1"
            done -> "filter=done"
        }
}

// Chat (docs/panel.md#chat)

data class ChatSessionInfo(
    val sid: String,
    val title: String? = null,
    /** Milliseconds since 1970. */
    val ts: Double? = null,
    val model: String? = null,
) {
    val id: String get() = sid

    companion object : JsonReader<ChatSessionInfo> {
        override fun from(o: JSONObject): ChatSessionInfo? {
            return ChatSessionInfo(o.str("sid") ?: return null, o.str("title"), o.dbl("ts"), o.str("model"))
        }
    }
}

/**
 * One message of a stored session. An answer of the agent carries its work: `steps`, its text and
 * tool calls in order with each call's input and output, from a Space that records them; else the
 * flat `tools` list of names and hints.
 */
data class ChatStored(
    val role: String,
    val text: String? = null,
    val steps: List<ChatStep> = emptyList(),
    val tools: List<Tool> = emptyList(),
) {
    data class Tool(val name: String, val hint: String = "")

    /** What the reply shows of its work: the recorded steps, or else the tools it called, without results. */
    val work: List<ChatStep>
        get() = steps.ifEmpty {
            tools.mapIndexed { i, tool -> ChatStep("history-tool:$i", ChatStepKind.Tool, title = tool.name, text = tool.hint, state = ChatStepState.Incomplete) }
        }

    companion object : JsonReader<ChatStored> {
        override fun from(o: JSONObject): ChatStored? {
            val tools = o.arr("tools")?.let { a ->
                (0 until a.length()).mapNotNull { i ->
                    val tool = a.opt(i) as? JSONObject ?: return@mapNotNull null
                    Tool(tool.str("name") ?: return@mapNotNull null, tool.str("hint") ?: "")
                }
            } ?: emptyList()
            return ChatStored(o.str("role") ?: return null, o.str("text"), ChatStep.history(o.arr("steps")), tools)
        }
    }
}

object ChatRoute {
    /**
     * The route base of an agent's chat from its catalogue ref: `<app>/<name>`, behind `<peer>/`
     * when the agent lives on a peer (src/web/api.ts `agentBase`).
     */
    fun base(ref: String, peer: String?): String? {
        var parts = ref.split("/").filter { it.isNotEmpty() }
        if (peer != null && parts.firstOrNull() == peer) parts = parts.drop(1)
        if (parts.size != 2) return null
        val prefix = peer?.let { "/api/peers/${SpacePath.escape(it)}" } ?: "/api"
        return "$prefix/agents/${SpacePath.escape(parts[0])}/${SpacePath.escape(parts[1])}"
    }
}

// Figures

object HubFormat {
    /** 1234 → 1.2K, 1234567 → 1.23M, 2689400000 → 2.69B; a missing figure is a dash (Usage.tsx `fmtTokens`). */
    fun tokens(n: Double?): String {
        if (n == null) return "–"
        if (n >= 1e9) return String.format(java.util.Locale.ROOT, "%.2fB", n / 1e9)
        if (n >= 1e6) return String.format(java.util.Locale.ROOT, if (n >= 1e7) "%.1fM" else "%.2fM", n / 1e6)
        if (n >= 1e3) return String.format(java.util.Locale.ROOT, if (n >= 1e4) "%.0fK" else "%.1fK", n / 1e3)
        return n.toInt().toString()
    }

    fun cost(usd: Double?): String {
        if (usd == null) return "–"
        if (usd >= 100) return String.format(java.util.Locale.ROOT, "$%.0f", usd)
        if (usd >= 1) return String.format(java.util.Locale.ROOT, "$%.2f", usd)
        return String.format(java.util.Locale.ROOT, "$%.3f", usd)
    }

    /** A whole number with the reader's grouping. */
    fun count(n: Double?, lang: String = Lang.current): String {
        if (n == null) return "–"
        return NumberFormat.getIntegerInstance(BlockFormat.locale(lang)).format(n.toLong())
    }

    /** A length of time in at most two units, in the reader's language; under a second in milliseconds. */
    fun duration(ms: Double?, lang: String = Lang.current): String {
        if (ms == null) return "–"
        if (ms < 1000) return "${roundHalfAway(Math.max(0.0, ms)).toLong()} ms"
        var s = roundHalfAway(ms / 1000).toLong()
        val d = s / 86400
        s %= 86400
        val h = s / 3600
        s %= 3600
        val m = s / 60
        s %= 60
        val units = if (lang == "zh") arrayOf("天", "小时", "分钟", "秒") else arrayOf("d", "h", "m", "s")
        val parts = listOf(d, h, m, s).mapIndexedNotNull { i, v -> if (v > 0) "$v${units[i]}" else null }.take(2)
        if (parts.isEmpty()) return if (lang == "zh") "0秒" else "0s"
        return parts.joinToString(if (lang == "zh") "" else " ")
    }

    /** "in 5m" or "2h ago". */
    fun relative(date: Instant, now: Instant = Instant.now(), lang: String = Lang.current): String = Times.relative(date, now, lang)
}
