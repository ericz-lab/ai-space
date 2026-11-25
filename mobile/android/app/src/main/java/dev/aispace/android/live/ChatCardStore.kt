package dev.aispace.android.live

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.aispace.android.R
import dev.aispace.android.core.CardItemState
import dev.aispace.android.core.CardRoute
import dev.aispace.android.core.CardRules
import dev.aispace.android.core.ShownCard
import dev.aispace.android.core.SpaceApi
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * The cards of one conversation as they are shown (src/web/ChatCards.tsx): each card's items' current
 * state, merged from the state route every time the card is shown and from Undo's answer; whether it
 * turned read-only; its note. The token stays in the card it came with, in memory: nothing here is
 * stored on the phone.
 *
 * Kept by the [ChatStore], so a card scrolled away and back keeps what Undo did. Main thread.
 */
class ChatCardStore(private val api: SpaceApi, base: String, private val scope: CoroutineScope) {
    private val route: CardRoute? = CardRoute.of(base)

    /** One shown card's state. */
    class Shown {
        var states by mutableStateOf<Map<String, CardItemState>>(emptyMap())
            internal set
        var busy by mutableStateOf(false)
            internal set
        var readOnly by mutableStateOf(false)
            internal set
        /** The read-only note, or why Undo failed. */
        var note by mutableStateOf<String?>(null)
            internal set
    }

    private val shown = HashMap<String, Shown>()
    private var generation = 0

    /** The state of a card under the message [bubble], by its place among that message's cards. */
    fun of(bubble: String, position: Int): Shown = shown.getOrPut("$bubble:$position") { Shown() }

    /** Asks the app for the items' current state (cards with `state` only); called each time the card is shown. */
    suspend fun refresh(state: Shown, card: ShownCard) {
        val route = route ?: return
        if (card.card.state == null) return
        val generation = this.generation
        val items = try {
            CardRules.stateItems(api.send("POST", route.state, CardRules.stateBody(route.agent, card.card)))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // As the panel: a card whose state cannot be read shows what was printed.
            return
        }
        if (generation == this.generation && items.isNotEmpty()) state.states = CardRules.merge(state.states, items)
    }

    /** Undoes [ids] of the card: only the token, the card's index in its event, `undo` and the ids go. */
    fun undo(state: Shown, card: ShownCard, ids: List<String>) {
        val route = route ?: return
        val token = card.token ?: return
        if (ids.isEmpty() || state.busy) return
        val generation = this.generation
        state.busy = true
        state.note = null
        scope.launch {
            val outcome = try {
                val answer = api.answer("POST", route.action, CardRules.undoBody(token, card.index, ids))
                CardRules.outcome(answer.status, answer.body)
            } catch (e: CancellationException) {
                state.busy = false
                throw e
            } catch (e: Exception) {
                CardRules.Outcome.Failed(HubStore.message(e))
            }
            state.busy = false
            if (generation != this@ChatCardStore.generation) return@launch
            when (outcome) {
                is CardRules.Outcome.ReadOnly -> {
                    state.readOnly = true
                    state.note = HubText.get(R.string.chat_card_read_only)
                }
                is CardRules.Outcome.Failed -> state.note = outcome.message
                is CardRules.Outcome.Items -> state.states = CardRules.merge(state.states, outcome.items)
            }
        }
    }

    /** A new conversation, another one opened, or sign-out: nothing of the old cards is kept. */
    fun clear() {
        generation += 1
        shown.clear()
    }
}
