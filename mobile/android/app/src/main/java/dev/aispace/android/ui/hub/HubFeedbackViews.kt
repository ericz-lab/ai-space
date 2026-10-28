package dev.aispace.android.ui.hub

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.UnfoldMore
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.aispace.android.AppModel
import dev.aispace.android.R
import dev.aispace.android.core.Connection
import dev.aispace.android.core.FeedbackApp
import dev.aispace.android.core.FeedbackItem
import dev.aispace.android.core.FeedbackPatch
import dev.aispace.android.core.FeedbackSettings
import dev.aispace.android.core.SpaceApi
import dev.aispace.android.core.Times
import dev.aispace.android.core.Urls
import dev.aispace.android.live.FeedbackStore
import dev.aispace.android.ui.theme.AiTheme
import dev.aispace.android.ui.theme.ThemeTokens
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Settings → Feedback (src/web/FeedbackSettings.tsx): the feedback button on app pages, what
 * happens to what is sent with it, where the Fix Engineer runs and on which model, which apps show
 * the button (a hub's peers' apps too), and the feedback sent lately with a way to start the waiting
 * ones. Every choice changes the Space for every client and saves at once.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun FeedbackPage(model: AppModel, connection: Connection, api: SpaceApi) {
    val scope = rememberCoroutineScope()
    val store = remember(api) { FeedbackStore(api, scope) }
    LaunchedEffect(store) { store.refresh() }
    // While something is being fixed, the list follows it.
    val moving = store.isMoving
    LaunchedEffect(moving) {
        while (moving) {
            delay(10_000)
            store.refresh()
        }
    }
    HubScaffold(stringResource(R.string.feedback_title)) { padding ->
        val view = store.view
        HubList(padding, onRefresh = { store.refresh() }) {
            group(key = "notice") { HubNotice(store) }
            if (view == null) return@HubList
            val s = view.settings

            group(key = "settings", footer = { Text(stringResource(R.string.feedback_trust)) }) {
                SwitchCell(stringResource(R.string.feedback_enabled), s.enabled) { store.save(FeedbackPatch(enabled = it)) }
                Text(
                    stringResource(R.string.feedback_enabled_help), style = MaterialTheme.typography.bodySmall, color = AiTheme.tokens.secondaryText,
                    modifier = Modifier.padding(start = 16.dp, end = 16.dp, bottom = 10.dp),
                )
                MenuCell(
                    stringResource(R.string.feedback_mode), s.mode,
                    listOf("auto" to stringResource(R.string.feedback_mode_auto), "later" to stringResource(R.string.feedback_mode_later)),
                ) { store.save(FeedbackPatch(mode = it)) }
                val machines = view.machines.map { m ->
                    m.value to if (m.value.isEmpty()) stringResource(R.string.feedback_this_machine, m.label) else m.label
                }
                if (machines.isNotEmpty()) MenuCell(stringResource(R.string.feedback_machine), s.machine, machines) { store.save(FeedbackPatch(machine = it)) }
                ModelMenu(
                    options = view.models,
                    current = s.model.ifEmpty { null },
                    none = stringResource(R.string.feedback_model_default),
                    disabled = false,
                    pick = { store.save(FeedbackPatch(model = it ?: "")) },
                ) { Text(stringResource(R.string.feedback_model), color = AiTheme.tokens.text) }
                MenuCell(
                    stringResource(R.string.feedback_effort), s.effort,
                    listOf(
                        "high" to stringResource(R.string.feedback_effort_high),
                        "xhigh" to stringResource(R.string.feedback_effort_xhigh),
                        "max" to stringResource(R.string.feedback_effort_max),
                    ),
                ) { store.save(FeedbackPatch(effort = it)) }
                SwitchCell(stringResource(R.string.feedback_errors), s.errors) { store.save(FeedbackPatch(errors = it)) }
                LabeledRow(stringResource(R.string.feedback_shortcut)) {
                    Text(view.shortcut, fontFamily = FontFamily.Monospace, color = AiTheme.tokens.secondaryText)
                }
            }

            group(key = "apps", headerContent = { Header(stringResource(R.string.feedback_apps)) }, footer = { Text(stringResource(R.string.feedback_apps_help)) }) {
                SwitchCell(stringResource(R.string.feedback_apps_default), s.appsDefault) { store.save(FeedbackPatch(appsDefault = it)) }
                for (a in view.apps) AppSwitch(a, s) { store.save(FeedbackPatch(apps = mapOf(a.app to it))) }
            }

            for (p in view.peers) {
                group(
                    key = "peer:${p.name}",
                    headerContent = { Header(stringResource(R.string.feedback_peer_apps, p.name)) },
                    footer = { if (p.ok && p.apps.isNotEmpty()) Text(stringResource(R.string.feedback_peer_apps_help, p.name)) },
                ) {
                    when {
                        !p.ok -> Warning(stringResource(R.string.feedback_peer_down, p.name, p.error ?: ""))
                        p.apps.isEmpty() -> NoteCell(stringResource(R.string.feedback_peer_none, p.name))
                        else -> for (a in p.apps) AppSwitch(a, s) { store.save(FeedbackPatch(apps = mapOf(a.app to it))) }
                    }
                    if (p.ok && !p.synced) Warning(stringResource(R.string.feedback_peer_unsynced, p.name, p.error ?: ""))
                }
            }

            group(key = "recent", headerContent = { Header(stringResource(R.string.feedback_recent)) }) {
                if (store.items.isEmpty()) NoteCell(stringResource(R.string.feedback_none))
                for (item in store.items) {
                    FeedbackRow(item, view.appTitle(item.app, item.peer), busy = store.isFixing, open = { url ->
                        Urls.resolve(connection.url, url)?.let { model.openFromHub(it, url, connection) }
                    }) { scope.launch { store.fix(peer = item.peer, ids = listOf(item.id)) } }
                }
                FlowRow(
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    val waiting = view.later
                    if (waiting > 0) {
                        OutlinedButton(enabled = !store.isFixing, onClick = { scope.launch { store.fix() } }) {
                            Text(stringResource(R.string.feedback_fix_waiting, waiting))
                        }
                    }
                    for (p in view.peers.filter { it.ok && it.later > 0 }) {
                        OutlinedButton(enabled = !store.isFixing, onClick = { scope.launch { store.fix(peer = p.name) } }) {
                            Text(stringResource(R.string.feedback_fix_waiting_on, p.later, p.name))
                        }
                    }
                    OutlinedButton(enabled = !store.isLoading, onClick = { store.refreshLater() }) { Text(stringResource(R.string.feedback_refresh)) }
                }
                store.notice?.let { NoteCell(it) }
            }
        }
    }
}

/** An app's own choice: the default (and what it is), on or off; the line under it says what its pages show now. */
@Composable
private fun AppSwitch(a: FeedbackApp, s: FeedbackSettings, pick: (String) -> Unit) {
    val on = stringResource(R.string.feedback_on)
    val off = stringResource(R.string.feedback_off)
    MenuCell(
        a.displayTitle(),
        s.apps[a.app] ?: "default",
        listOf(
            "default" to stringResource(R.string.feedback_app_default, if (s.appsDefault) on else off),
            "on" to on,
            "off" to off,
        ),
        detail = stringResource(if (a.enabled) R.string.feedback_app_shown else R.string.feedback_app_hidden),
        pick = pick,
    )
}

@Composable
private fun FeedbackRow(item: FeedbackItem, title: String, busy: Boolean, open: (String) -> Unit, fix: () -> Unit) {
    val t = AiTheme.tokens
    Cell {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                buildString {
                    append(title)
                    if (item.text.isNotEmpty()) append(" · ").append(item.text)
                },
                color = t.text, maxLines = 3, overflow = TextOverflow.Ellipsis,
            )
            val parts = listOfNotNull(
                item.peer,
                feedbackStatus(item.status),
                item.runMachine,
                item.created?.let { Times.ago(it) },
                item.reason,
            )
            Text(parts.joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = t.secondaryText, maxLines = 2, overflow = TextOverflow.Ellipsis)
            item.todoId?.let { n ->
                val label = stringResource(R.string.feedback_todo, n)
                val url = item.todoUrl
                if (url != null) {
                    Text(label, style = MaterialTheme.typography.bodySmall, color = ThemeTokens.link, textDecoration = TextDecoration.Underline, modifier = Modifier.clickable { open(url) })
                } else {
                    Text(label, style = MaterialTheme.typography.bodySmall, color = t.secondaryText)
                }
            }
        }
        if (item.canFix) {
            OutlinedButton(enabled = !busy, onClick = fix) {
                Text(stringResource(if (item.status == "later") R.string.feedback_fix_now else R.string.feedback_fix_again), maxLines = 1)
            }
        }
    }
}

/** A status in the reader's words; one this client does not know, as the Space sends it. */
@Composable
private fun feedbackStatus(status: String): String = when (status) {
    "later" -> stringResource(R.string.feedback_status_later)
    "queued" -> stringResource(R.string.feedback_status_queued)
    "fixing" -> stringResource(R.string.feedback_status_fixing)
    "review" -> stringResource(R.string.feedback_status_review)
    "failed" -> stringResource(R.string.feedback_status_failed)
    "skipped" -> stringResource(R.string.feedback_status_skipped)
    "recorded" -> stringResource(R.string.feedback_status_recorded)
    "accepted" -> stringResource(R.string.feedback_status_accepted)
    "dropped" -> stringResource(R.string.feedback_status_dropped)
    else -> status
}

@Composable
private fun SwitchCell(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Cell {
        Text(label, color = AiTheme.tokens.text, modifier = Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

/** A row whose value is picked from a short menu; [detail] under the label. */
@Composable
internal fun MenuCell(
    label: String,
    current: String,
    options: List<Pair<String, String>>,
    detail: String? = null,
    enabled: Boolean = true,
    pick: (String) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    val t = AiTheme.tokens
    Box {
        Cell(onClick = { open = true }, enabled = enabled) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(label, color = t.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
                detail?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = t.secondaryText, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            }
            Text(
                options.firstOrNull { it.first == current }?.second ?: current,
                color = t.accent, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false),
            )
            Icon(Icons.Filled.UnfoldMore, contentDescription = null, tint = t.accent, modifier = Modifier.size(16.dp))
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            val check: @Composable () -> Unit = { Icon(Icons.Filled.Check, contentDescription = null) }
            for ((value, text) in options) {
                DropdownMenuItem(
                    text = { Text(text, fontWeight = if (value == current) FontWeight.SemiBold else FontWeight.Normal) },
                    trailingIcon = if (value == current) check else null,
                    onClick = {
                        open = false
                        if (value != current) pick(value)
                    },
                )
            }
        }
    }
}
