package dev.aispace.android.ui.hub

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.aispace.android.R
import dev.aispace.android.core.HubFormat
import dev.aispace.android.core.ISO8601
import dev.aispace.android.core.SpaceApi
import dev.aispace.android.core.SpaceTask
import dev.aispace.android.core.TaskRun
import dev.aispace.android.core.TaskSchedule
import dev.aispace.android.live.IconImages
import dev.aispace.android.live.TasksStore
import dev.aispace.android.ui.theme.AiTheme
import dev.aispace.android.ui.theme.ThemeTokens
import kotlinx.coroutines.launch
import java.time.Instant

// Tasks

@Composable
internal fun statusColor(status: SpaceTask.Status): Color = when (status) {
    is SpaceTask.Status.Ok -> ThemeTokens.success
    is SpaceTask.Status.Error -> ThemeTokens.danger
    is SpaceTask.Status.Running -> AiTheme.tokens.accent
    is SpaceTask.Status.Skipped -> ThemeTokens.warning
    else -> AiTheme.tokens.secondaryText
}

@Composable
internal fun statusText(status: SpaceTask.Status): String = when (status) {
    is SpaceTask.Status.Orphaned -> stringResource(R.string.hub_status_orphaned)
    is SpaceTask.Status.Off -> stringResource(R.string.hub_status_off)
    is SpaceTask.Status.Running -> stringResource(R.string.hub_status_running)
    is SpaceTask.Status.Ok -> stringResource(R.string.hub_status_ok)
    is SpaceTask.Status.Error ->
        if (status.times > 1) stringResource(R.string.hub_status_failed_times, status.times) else stringResource(R.string.hub_status_failed)
    is SpaceTask.Status.Skipped -> stringResource(R.string.hub_status_skipped)
    is SpaceTask.Status.NeverRan -> stringResource(R.string.hub_status_never_ran)
}

/** As the panel writes it (api.ts `scheduleText`). */
@Composable
internal fun scheduleText(s: TaskSchedule): String = when (s.kind) {
    "every" -> stringResource(R.string.hub_schedule_every, HubFormat.duration(s.everyMs))
    "cron" -> s.tz?.let { "${s.expr ?: ""} ($it)" } ?: (s.expr ?: "")
    "at" -> stringResource(R.string.hub_schedule_once_at, s.at?.let { ISO8601.parse(it) }?.let { dateTime(it) } ?: s.at ?: "")
    else -> stringResource(R.string.hub_schedule_manual)
}

/** A run that is due within half a minute, or overdue, is due now. */
@Composable
internal fun nextText(date: Instant, prefixed: Boolean): String {
    val soon = date.toEpochMilli() - System.currentTimeMillis() < 30_000
    return when {
        soon -> stringResource(R.string.hub_due_now)
        prefixed -> stringResource(R.string.hub_next, HubFormat.relative(date))
        else -> HubFormat.relative(date)
    }
}

@Composable
internal fun TasksPage(api: SpaceApi, icons: IconImages) {
    val scope = rememberCoroutineScope()
    val store = remember(api) { TasksStore(api, scope) }
    val listState = rememberLazyListState()
    val nav = LocalHubNav.current
    LaunchedEffect(store) { store.refresh() }
    when (val top = nav.top) {
        is HubDest.Task -> TaskDetail(store, top.id)
        else -> HubScaffold(stringResource(R.string.hub_tasks)) { padding ->
            val tasks = store.tasks
            val loaded = store.loaded
            val groups = store.groups
            val labels = store.labels
            val active = stringResource(R.string.hub_stat_active)
            val count = stringResource(R.string.hub_stat_tasks)
            val failing = stringResource(R.string.hub_stat_failing)
            val none = stringResource(R.string.hub_no_tasks)
            HubList(padding, onRefresh = { store.refresh() }, state = listState) {
                group(key = "notice") {
                    HubNotice(store)
                    if (loaded) {
                        StatCards(
                            listOf(
                                "${tasks.count { it.isActive }}" to active,
                                "${tasks.size}" to count,
                                "${tasks.count { it.isFailing }}" to failing,
                            ),
                        )
                        if (tasks.isEmpty()) NoteCell(none)
                    }
                }
                for ((app, list) in groups) {
                    groupItems(
                        list,
                        key = { "task:${it.id}" },
                        headerContent = { AppHeader(labels[app]?.icon, store.title(app), icons) },
                    ) { task ->
                        Cell(onClick = { nav.push(HubDest.Task(task.id)) }, chevron = true) { TaskRow(task, Modifier.weight(1f)) }
                    }
                }
            }
        }
    }
}

@Composable
private fun TaskRow(task: SpaceTask, modifier: Modifier) {
    val t = AiTheme.tokens
    val status = task.status
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top) {
        Dot(statusColor(status), Modifier.padding(top = 6.dp))
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(task.name, color = if (task.isActive) t.text else t.secondaryText, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                if (task.source == "api") Badge("api")
                if (task.overrides?.isEmpty == false) Badge(stringResource(R.string.hub_override))
            }
            Text(line(task, status), style = MaterialTheme.typography.bodySmall, color = t.secondaryText, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
private fun line(task: SpaceTask, status: SpaceTask.Status): String {
    val parts = ArrayList<String>()
    for (trigger in task.triggers ?: emptyList()) parts.add(stringResource(R.string.hub_on_event, trigger.event))
    if (task.schedule.kind != "manual" || parts.isEmpty()) parts.add(scheduleText(task.schedule))
    parts.add(statusText(status))
    task.state?.lastRunAt?.let { ISO8601.parse(it) }?.let { parts.add(HubFormat.relative(it)) }
    if (task.isActive) task.state?.nextRunAt?.let { ISO8601.parse(it) }?.let { parts.add(nextText(it, prefixed = true)) }
    return parts.joinToString(" · ")
}

/** One task: what it is, the model it runs on, and its last runs. */
@Composable
private fun TaskDetail(store: TasksStore, id: String) {
    val scope = rememberCoroutineScope()
    LaunchedEffect(id) { store.loadRuns(id) }
    val task = store.task(id)
    HubScaffold(task?.name ?: "") { padding ->
        HubList(padding, onRefresh = {
            store.refresh()
            store.loadRuns(id)
        }) {
            if (task == null) return@HubList
            group(key = "about") {
                task.description?.takeIf { it.isNotEmpty() }?.let {
                    Cell { Text(it, style = MaterialTheme.typography.bodyMedium, color = AiTheme.tokens.secondaryText) }
                }
                LabeledRow(stringResource(R.string.hub_status)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Dot(statusColor(task.status))
                        Text(statusText(task.status), color = AiTheme.tokens.secondaryText)
                    }
                }
                LabeledRow(stringResource(R.string.hub_schedule), scheduleText(task.schedule))
                for (trigger in task.triggers ?: emptyList()) LabeledRow(stringResource(R.string.hub_trigger), trigger.event)
                task.target?.kind?.let { LabeledRow(stringResource(R.string.hub_kind), it) }
                task.state?.lastRunAt?.let { ISO8601.parse(it) }?.let { last ->
                    val text = listOfNotNull(HubFormat.relative(last), task.state?.lastDurationMs?.let { HubFormat.duration(it) }).joinToString(" · ")
                    LabeledRow(stringResource(R.string.hub_last_run), text)
                }
                if (task.isActive) {
                    task.state?.nextRunAt?.let { ISO8601.parse(it) }?.let { LabeledRow(stringResource(R.string.hub_next_run), nextText(it, prefixed = false)) }
                }
                task.state?.pending?.let { LabeledRow(stringResource(R.string.hub_events_waiting), "${it.events}") }
                val error = task.state?.lastError
                if (error != null && task.state?.lastStatus == "error") {
                    Cell { Text(error, style = MaterialTheme.typography.bodySmall, color = ThemeTokens.danger) }
                }
            }
            group(
                key = "model",
                header = null,
                headerContent = { ModelHeader() },
                footer = { if (task.modelSelectable == true) Text(stringResource(R.string.hub_task_model_footer)) },
            ) {
                if (task.modelSelectable == true) {
                    ModelMenu(
                        options = task.eligible(store.options),
                        current = task.overrides?.model,
                        none = stringResource(R.string.hub_default_model, task.base?.model ?: stringResource(R.string.hub_the_spaces)),
                        disabled = store.isSaving || task.orphaned == true,
                        pick = { value -> scope.launch { store.setModel(id, value) } },
                    ) { Text(stringResource(R.string.hub_model), color = AiTheme.tokens.text) }
                    store.saveError?.let { NoteCell(stringResource(R.string.hub_not_saved, it), ThemeTokens.danger) }
                } else {
                    NoteCell(stringResource(R.string.hub_task_no_model))
                }
            }
            val runs = store.runs[id]
            val runError = store.runErrors[id]
            if (runs != null) {
                if (runs.isEmpty()) {
                    group(key = "runs", header = null, headerContent = { RunsHeader() }) { NoteCell(stringResource(R.string.hub_no_runs)) }
                } else {
                    groupItems(runs, key = { "run:${it.id}" }, headerContent = { RunsHeader() }) { RunRow(it) }
                }
            } else {
                group(key = "runs", headerContent = { RunsHeader() }) {
                    if (runError != null) {
                        NoteCell(stringResource(R.string.hub_unavailable, runError))
                    } else {
                        Cell { CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = AiTheme.tokens.accent) }
                    }
                }
            }
        }
    }
}

@Composable
private fun ModelHeader() {
    Text(stringResource(R.string.hub_model), style = MaterialTheme.typography.labelLarge, color = AiTheme.tokens.secondaryText)
}

@Composable
private fun RunsHeader() {
    Text(stringResource(R.string.hub_runs), style = MaterialTheme.typography.labelLarge, color = AiTheme.tokens.secondaryText)
}

@Composable
private fun RunRow(run: TaskRun) {
    val t = AiTheme.tokens
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            Dot(
                when (run.status) {
                    "ok" -> ThemeTokens.success
                    "error" -> ThemeTokens.danger
                    else -> ThemeTokens.warning
                },
            )
            Text(
                when (run.status) {
                    "ok" -> stringResource(R.string.hub_status_ok)
                    "error" -> stringResource(R.string.hub_status_failed)
                    else -> stringResource(R.string.hub_status_skipped)
                },
                color = t.text,
            )
            if (run.trigger == "manual") Badge(stringResource(R.string.hub_schedule_manual))
            val n = run.eventIds?.size ?: 0
            if (n > 0) Badge(stringResource(R.string.hub_n_events, n))
            Spacer(Modifier.weight(1f))
            Text(
                listOfNotNull(HubFormat.relative(run.started), run.durationMs?.let { HubFormat.duration(it) }).joinToString(" · "),
                style = MaterialTheme.typography.bodySmall,
                color = t.secondaryText,
            )
        }
        run.error?.takeIf { it.isNotEmpty() }?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = ThemeTokens.danger) }
        run.output?.takeIf { it.isNotEmpty() }?.let {
            SelectionContainer {
                Text(it, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, color = t.secondaryText, maxLines = 12, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}
