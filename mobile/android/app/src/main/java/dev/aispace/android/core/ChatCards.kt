package dev.aispace.android.core

import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException
import java.util.Locale

/**
 * Chat cards (docs/chat-cards.md, and the v2 styles and item fields): what an app agent's tools did in
 * a turn, shown under the reply. ai-space extracts and checks the cards and hands them over as a
 * `{"type":"cards","cards":[...],"token":"..."}` run event, or as `cards` on a restored session's `ai`
 * message (no token). The client only draws them, reads their items' state and sends Undo.
 *
 * Decoding follows the server's rules (src/space/agents/cards.ts `parseCard`): a card that breaks a rule
 * is dropped whole; only an unknown name (`style`, a tag's `tone`, an `icon`) degrades. Unknown fields
 * are ignored. The card's JSON is kept as it came, since the state route takes the card back.
 */

enum class CardKind { receipt, list, value }

/** How a card is drawn (v2 11.1); `rows` is the first version's look and the fallback. */
enum class CardStyle { rows, compact, gallery, agenda, stat }

enum class CardItemStatus { active, done, removed }

enum class CardTone { neutral, accent, positive, warning, negative }

/** The icons an item may name (v2 11.2); any other name is as if none were given. */
enum class CardIcon { check, note, link, calendar, image, file, person, chart, clock, flag, bell, folder }

data class CardTag(val text: String, val tone: CardTone = CardTone.neutral)

/** An item's date and, when given, its time, in the app's time zone (`YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`). */
data class CardDate(val day: LocalDate, val time: LocalTime? = null) {
    companion object {
        private val pattern = Regex("""^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$""")

        fun parse(s: String): CardDate? {
            if (!pattern.matches(s)) return null
            return try {
                if (s.length == 10) CardDate(LocalDate.parse(s))
                else LocalDateTime.parse(s).let { CardDate(it.toLocalDate(), it.toLocalTime()) }
            } catch (e: DateTimeParseException) {
                null
            }
        }
    }
}

/** The v2 fields an item, or an answer of its state, may carry. */
data class CardExtras(
    val `when`: String? = null,
    val date: CardDate? = null,
    val tags: List<CardTag>? = null,
    val image: String? = null,
    val icon: CardIcon? = null,
    val value: String? = null,
    val progress: Double? = null,
) {
    /** These fields with [over]'s in place of any it carries (a state answer over the printed item). */
    fun merged(over: CardExtras): CardExtras = CardExtras(
        `when` = over.`when` ?: `when`,
        date = over.date ?: date,
        tags = over.tags ?: tags,
        image = over.image ?: image,
        icon = over.icon ?: icon,
        value = over.value ?: value,
        progress = over.progress ?: progress,
    )

    companion object {
        /** The v2 fields of [o], or null when one breaks a rule (a wrong type, too long, out of range). */
        fun read(o: JSONObject): CardExtras? {
            val whenText = CardJson.line(o, "when", 40) ?: return null
            val value = CardJson.line(o, "value", 24) ?: return null
            var date: CardDate? = null
            if (!o.isNullOrAbsent("date")) date = CardDate.parse(o.opt("date") as? String ?: return null) ?: return null
            var tags: List<CardTag>? = null
            if (!o.isNullOrAbsent("tags")) {
                val a = o.opt("tags") as? JSONArray ?: return null
                if (a.length() > 4) return null
                tags = (0 until a.length()).map { i ->
                    val t = a.opt(i) as? JSONObject ?: return null
                    val text = CardJson.line(t, "text", 24) ?: return null
                    if (text.value == null) return null
                    val tone = if (t.isNullOrAbsent("tone")) CardTone.neutral else {
                        val name = t.opt("tone") as? String ?: return null
                        CardTone.entries.firstOrNull { it.name == name } ?: CardTone.neutral
                    }
                    CardTag(text.value, tone)
                }
            }
            var image: String? = null
            if (!o.isNullOrAbsent("image")) {
                image = o.opt("image") as? String ?: return null
                if (image.length > 2000 || !CardJson.linkOk(image)) return null
            }
            var icon: CardIcon? = null
            if (!o.isNullOrAbsent("icon")) {
                val name = o.opt("icon") as? String ?: return null
                icon = CardIcon.entries.firstOrNull { it.name == name }
            }
            var progress: Double? = null
            if (!o.isNullOrAbsent("progress")) {
                val n = o.opt("progress") as? Number ?: return null
                val d = n.toDouble()
                if (!d.isFinite() || d < 0.0 || d > 1.0) return null
                progress = d
            }
            return CardExtras(whenText.value, date, tags, image, icon, value.value, progress)
        }
    }
}

data class CardItem(
    val id: String,
    val title: String,
    val detail: String? = null,
    val url: String? = null,
    val version: Int? = null,
    val extras: CardExtras = CardExtras(),
)

data class Card(
    val kind: CardKind,
    val title: String? = null,
    val items: List<CardItem> = emptyList(),
    /** A `value` card's value as shown. */
    val text: String? = null,
    /** The capability that answers the items' current state; without it the card shows what was printed. */
    val state: String? = null,
    /** The capability of the `undo` action; other actions are not known to this version. */
    val undo: String? = null,
    /** The style the card asks for; an unknown name is [CardStyle.rows]. */
    val style: CardStyle = CardStyle.rows,
    /** The card's JSON as it came, sent back to the state route. */
    val json: JSONObject = JSONObject(),
) {
    /**
     * The style the card is drawn in: the one it asks for when every item has the field that style needs
     * (gallery `image`, agenda `date`, stat `value`, and stat only on a `list` or `value` card), else rows.
     */
    val drawnStyle: CardStyle
        get() {
            if (items.isEmpty()) return CardStyle.rows
            val ok = when (style) {
                CardStyle.rows, CardStyle.compact -> true
                CardStyle.gallery -> items.all { it.extras.image != null }
                CardStyle.agenda -> items.all { it.extras.date != null }
                CardStyle.stat -> kind != CardKind.receipt && items.all { it.extras.value != null }
            }
            return if (ok) style else CardStyle.rows
        }

    companion object : JsonReader<Card> {
        private val capability = Regex("^[a-z0-9][a-z0-9._-]{0,63}$", RegexOption.IGNORE_CASE)
        const val MAX_ITEMS = 20

        override fun from(o: JSONObject): Card? {
            if (Json.exactInt(o.opt("v") as? Number) != 1L) return null
            val kind = CardKind.entries.firstOrNull { it.name == o.opt("kind") } ?: return null
            val title = CardJson.line(o, "title", 200) ?: return null
            var style = CardStyle.rows
            if (!o.isNullOrAbsent("style")) {
                val name = o.opt("style") as? String ?: return null
                style = CardStyle.entries.firstOrNull { it.name == name } ?: CardStyle.rows
            }
            val rawItems = if (o.isNullOrAbsent("items")) JSONArray() else o.opt("items") as? JSONArray ?: return null
            if (rawItems.length() > MAX_ITEMS) return null
            val items = (0 until rawItems.length()).map { i -> item(rawItems.opt(i) as? JSONObject ?: return null) ?: return null }
            if (items.map { it.id }.toSet().size != items.size) return null
            val text = CardJson.line(o, "text", 200) ?: return null
            if (if (kind == CardKind.value) text.value == null else items.isEmpty()) return null
            var state: String? = null
            if (!o.isNullOrAbsent("state")) {
                state = o.opt("state") as? String ?: return null
                if (!capability.matches(state)) return null
            }
            var undo: String? = null
            if (!o.isNullOrAbsent("actions")) {
                val actions = o.opt("actions") as? JSONObject ?: return null
                if (kind != CardKind.receipt) return null
                for (name in actions.keyList()) {
                    val cap = actions.opt(name) as? String ?: return null
                    if (!capability.matches(cap)) return null
                    if (name == "undo") undo = cap
                }
            }
            return Card(kind, title.value, items, text.value, state, undo, style, o)
        }

        private fun item(o: JSONObject): CardItem? {
            val id = CardJson.id(o) ?: return null
            val title = CardJson.line(o, "title", 300)?.value ?: return null
            val detail = CardJson.line(o, "detail", 300) ?: return null
            var url: String? = null
            if (!o.isNullOrAbsent("url")) {
                url = o.opt("url") as? String ?: return null
                if (url.length > 2000 || !CardJson.linkOk(url)) return null
            }
            var version: Int? = null
            if (!o.isNullOrAbsent("version")) {
                version = o.int("version") ?: return null
                if (version < 0) return null
            }
            val extras = CardExtras.read(o) ?: return null
            return CardItem(id, title, detail.value, url, version, extras)
        }

        /** The cards of an event or a restored message; one that cannot be read is left out. */
        fun list(a: JSONArray?): List<Card> = Json.lossy(a, Card)
    }
}

/** One item as a card's `state` or action capability answers it. */
data class CardItemState(
    val id: String,
    val status: CardItemStatus,
    val title: String? = null,
    val detail: String? = null,
    val url: String? = null,
    val version: Int? = null,
    val changed: Boolean = false,
    val extras: CardExtras = CardExtras(),
) {
    companion object : JsonReader<CardItemState> {
        /** An item of an answer, or null when it breaks a rule (it is then skipped, as ai-space skips it). */
        override fun from(o: JSONObject): CardItemState? {
            val status = CardItemStatus.entries.firstOrNull { it.name == o.opt("status") } ?: return null
            val id = CardJson.id(o) ?: return null
            val url = (o.opt("url") as? String)?.takeIf { it.length <= 2000 && CardJson.linkOk(it) }
            val version = o.int("version")?.takeIf { it >= 0 }
            return CardItemState(
                id = id,
                status = status,
                title = CardJson.line(o, "title", 300)?.value,
                detail = CardJson.line(o, "detail", 300)?.value,
                url = url,
                version = version,
                changed = o.bool("changed") == true,
                extras = CardExtras.read(o) ?: return null,
            )
        }

        fun list(a: JSONArray?): List<CardItemState> = Json.lossy(a, CardItemState)
    }
}

/** A card as a message holds it: its index in its cards event (what an action names) and that event's token. */
data class ShownCard(val card: Card, val index: Int, val token: String? = null) {
    companion object {
        /** A live `cards` event's cards; the token, when there is one, lives in memory only. */
        fun event(ev: JSONObject): List<ShownCard> {
            val a = ev.arr("cards") ?: return emptyList()
            val token = ev.str("token")?.takeIf { it.isNotEmpty() }
            // The index is the card's place in the event as sent: a card this client cannot read keeps
            // the others' places, so an action names the card the Space means.
            return (0 until a.length()).mapNotNull { i ->
                val o = a.opt(i) as? JSONObject ?: return@mapNotNull null
                Card.from(o)?.let { ShownCard(it, i, token) }
            }
        }

        /** A restored message's cards: read-only, without a token. */
        fun restored(a: JSONArray?): List<ShownCard> {
            if (a == null) return emptyList()
            return (0 until a.length()).mapNotNull { i ->
                val o = a.opt(i) as? JSONObject ?: return@mapNotNull null
                Card.from(o)?.let { ShownCard(it, i) }
            }
        }
    }
}

/** An item as it is drawn: what was printed with the latest answer of its state over it. */
data class CardItemView(
    val id: String,
    val title: String,
    val detail: String?,
    val url: String?,
    val status: CardItemStatus,
    val changed: Boolean,
    val extras: CardExtras,
) {
    val removed: Boolean get() = status == CardItemStatus.removed
    val done: Boolean get() = status == CardItemStatus.done

    /** `detail` split on ` · ` into its segments (docs/chat-cards.md). */
    val segments: List<String> get() = detail?.split(" · ")?.filter { it.isNotEmpty() } ?: emptyList()

    /** The pill at the end of the row: undone, changed elsewhere, done; null for none. */
    val pill: CardPill?
        get() = when {
            removed -> CardPill.Undone
            changed -> CardPill.Changed
            done -> CardPill.Done
            else -> null
        }
}

enum class CardPill { Undone, Changed, Done }

/** The header button's words (src/web/ChatCards.tsx `undoLabel`). */
sealed class UndoLabel {
    data object One : UndoLabel()
    data object All : UndoLabel()
    data class Rest(val n: Int) : UndoLabel()
}

/**
 * The rules of src/web/ChatCards.tsx, without the views: what a card shows, which items can be undone,
 * the header button and the requests.
 */
object CardRules {
    /**
     * Whether the cards of the message at [index] may act: only the conversation's latest reply, that is
     * while no message of the person follows it (src/web/Chat.tsx). The token is checked apart.
     */
    fun actionable(isUser: List<Boolean>, index: Int): Boolean = (index + 1 until isUser.size).none { isUser[it] }

    /** Whether the card shows Undo at all: actionable, not turned read-only, with a token and an undo action. */
    fun canUndo(shown: ShownCard, actionable: Boolean, readOnly: Boolean): Boolean =
        actionable && !readOnly && !shown.token.isNullOrEmpty() && shown.card.undo != null

    /** An item that can still be undone: the card can act, and the item was neither undone nor changed. */
    fun undoable(canUndo: Boolean, state: CardItemState?): Boolean =
        canUndo && state?.status != CardItemStatus.removed && state?.changed != true

    /** The ids the header button undoes, in the card's order. */
    fun open(card: Card, canUndo: Boolean, states: Map<String, CardItemState>): List<String> =
        card.items.filter { undoable(canUndo, states[it.id]) }.map { it.id }

    fun undoLabel(total: Int, open: Int): UndoLabel = when {
        total <= 1 -> UndoLabel.One
        open == total -> UndoLabel.All
        else -> UndoLabel.Rest(open)
    }

    /** Whether an item has its own undo button: several items, the style has row buttons (not compact or stat), and it can be undone. */
    fun rowUndo(card: Card, style: CardStyle, undoable: Boolean): Boolean =
        card.items.size > 1 && undoable && style != CardStyle.compact && style != CardStyle.stat

    /** The answer's items over the ones known before, by id. */
    fun merge(current: Map<String, CardItemState>, items: List<CardItemState>): Map<String, CardItemState> =
        current + items.associateBy { it.id }

    /**
     * An item as drawn: an undone item keeps its printed title and drops its secondary line and link (the
     * web's rule), and the v2 fields of the answer replace the printed ones. An undone item keeps its
     * image, icon, value and date, so a gallery tile, a stat or an agenda day stays in place; its `when`,
     * tags and progress, which belong to the secondary line, go with it.
     */
    fun view(item: CardItem, state: CardItemState?): CardItemView {
        val removed = state?.status == CardItemStatus.removed
        val extras = if (state == null) item.extras else item.extras.merged(state.extras)
        return CardItemView(
            id = item.id,
            title = (if (removed) null else state?.title) ?: item.title,
            detail = if (removed) null else state?.detail ?: item.detail,
            url = if (removed) null else state?.url ?: item.url,
            status = state?.status ?: CardItemStatus.active,
            changed = state?.changed == true,
            extras = if (removed) extras.copy(`when` = null, tags = null, progress = null) else extras,
        )
    }

    /** `POST …/agents/cards/state`: the agent (`<app>/<name>`) and the card as it came. */
    fun stateBody(agent: String, card: Card): JSONObject = JSONObject().put("agent", agent).put("card", card.json)

    /** `POST …/agents/cards/action`: the token, the card's index in its event, `undo`, and the chosen ids; nothing else. */
    fun undoBody(token: String, index: Int, ids: List<String>): JSONObject =
        JSONObject().put("token", token).put("card", index).put("action", "undo").put("items", JSONArray(ids))

    /** How an action's answer ends. */
    sealed class Outcome {
        data class Items(val items: List<CardItemState>) : Outcome()
        /** 409 `{readOnly:true}`: the token is gone; the card turns read-only with its note. */
        data object ReadOnly : Outcome()
        data class Failed(val message: String) : Outcome()
    }

    /** An action's answer, by its status and body (src/web/ChatCards.tsx `undo`). */
    fun outcome(status: Int, body: String): Outcome {
        val o = Json.obj(body)
        if (o?.bool("readOnly") == true) return Outcome.ReadOnly
        if (status !in 200..299 || o?.bool("ok") != true) return Outcome.Failed(o?.str("error")?.takeIf { it.isNotEmpty() } ?: "HTTP $status")
        return Outcome.Items(CardItemState.list(o.arr("items")))
    }

    /** A state answer's items; an answer that is not `ok` changes nothing. */
    fun stateItems(body: String): List<CardItemState> {
        val o = Json.obj(body) ?: return emptyList()
        if (o.bool("ok") != true) return emptyList()
        return CardItemState.list(o.arr("items"))
    }
}

/** Where an agent's card routes are: the Space's own, or the peer's that owns the agent. */
data class CardRoute(
    /** `/api`, or `/api/peers/<peer>` for a peer's agent. */
    val prefix: String,
    /** `<app>/<name>`, as the state route names the agent. */
    val agent: String,
) {
    val state: String get() = "$prefix/agents/cards/state"
    val action: String get() = "$prefix/agents/cards/action"

    companion object {
        /** From a chat's route base ([ChatRoute.base]): `<prefix>/agents/<app>/<name>`. */
        fun of(base: String): CardRoute? {
            val at = base.lastIndexOf("/agents/")
            if (at < 0) return null
            val parts = base.substring(at + "/agents/".length).split("/")
            if (parts.size != 2 || parts.any { it.isEmpty() }) return null
            val (app, name) = parts.map { java.net.URLDecoder.decode(it.replace("+", "%2B"), "UTF-8") }
            return CardRoute(base.substring(0, at), "$app/$name")
        }
    }
}

/**
 * The days of an agenda card's date blocks (v2 11.3): an item whose day is the one before it shows no
 * block. Null for an item without a block.
 */
object CardAgenda {
    fun blocks(dates: List<CardDate?>): List<CardDate?> =
        dates.mapIndexed { i, d -> if (d == null || (i > 0 && dates[i - 1]?.day == d.day)) null else d }

    /** Whether the block names the month under the weekday: its month or year is not today's. */
    fun showsMonth(day: LocalDate, today: LocalDate): Boolean = day.year != today.year || day.month != today.month

    /** The time an agenda row shows, `HH:MM`, when the date has one. */
    fun time(date: CardDate?): String? = date?.time?.let { "%02d:%02d".format(it.hour, it.minute) }

    /** The weekday under the day, in the interface's language: 「周四」, "Thu". */
    fun weekday(day: LocalDate, locale: Locale): String = DateTimeFormatter.ofPattern("EEE", locale).format(day)

    /** The month under the weekday when it is not this month: 「12月」, "Dec". */
    fun month(day: LocalDate, locale: Locale): String = DateTimeFormatter.ofPattern("MMM", locale).format(day)
}

/** The app heading an agent's cards: its icon and, when the catalogue lists it on the same machine, its entry (for the name). */
data class CardApp(val icon: String? = null, val entry: CatalogueEntry? = null) {
    companion object {
        /**
         * The agent's `appIcon` over its app's icon, and the app of the same name on the same machine
         * (src/web/ChatCards.tsx `cardApp`). An app the catalogue does not list gets no name.
         */
        fun of(agent: CatalogueEntry, apps: List<CatalogueEntry>): CardApp {
            var parts = agent.ref.split("/").filter { it.isNotEmpty() }
            if (agent.peer != null && parts.firstOrNull() == agent.peer) parts = parts.drop(1)
            val name = parts.firstOrNull() ?: return CardApp(agent.appIcon)
            val peer = agent.peer
            val app = apps.firstOrNull { a ->
                a.peer == peer && (a.ref == name || (peer != null && a.ref == "$peer/$name"))
            }
            return CardApp(agent.appIcon?.takeIf { it.isNotEmpty() } ?: app?.icon, app)
        }
    }
}

internal object CardJson {
    /** A field's text: [Text] with null when absent, null when it is not a one-line text of at most [max] characters. */
    data class Text(val value: String?)

    fun line(o: JSONObject, key: String, max: Int): Text? {
        if (o.isNullOrAbsent(key)) return Text(null)
        val s = o.opt(key) as? String ?: return null
        val one = s.replace(Regex("\\s+"), " ").trim()
        if (one.length > max) return null
        return Text(one.ifEmpty { null })
    }

    /** An item's id: a string, or a whole number taken as its string. */
    fun id(o: JSONObject): String? {
        val raw = o.opt("id")
        val id = when (raw) {
            is String -> raw
            is Number -> Json.exactInt(raw)?.toString() ?: return null
            else -> return null
        }
        if (id.isBlank() || id.length > 100) return null
        return id.trim()
    }

    /** A link the app gives: a path on its own page, or an http(s) URL. */
    fun linkOk(v: String): Boolean =
        (v.startsWith("/") && !v.startsWith("//")) || Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(v)
}
