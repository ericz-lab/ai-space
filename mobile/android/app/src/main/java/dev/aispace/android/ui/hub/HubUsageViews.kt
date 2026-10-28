package dev.aispace.android.ui.hub

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.aispace.android.R
import dev.aispace.android.core.AppUsageRow
import dev.aispace.android.core.Catalogue
import dev.aispace.android.core.HubFormat
import dev.aispace.android.core.ISO8601
import dev.aispace.android.core.ModelTotals
import dev.aispace.android.core.SpaceApi
import dev.aispace.android.live.AppModelsStore
import dev.aispace.android.live.AppUsageStore
import dev.aispace.android.live.IconImages
import dev.aispace.android.live.ModelUsageStore
import dev.aispace.android.ui.theme.AiTheme
import dev.aispace.android.ui.theme.ThemeTokens
import kotlinx.coroutines.launch
import java.text.NumberFormat

/**
 * What the model service recorded (src/web/Usage.tsx), read-only. Token figures are what the
 * runtime reported; a call with none shows a dash, nothing is estimated.
 */
@Composable
internal fun ModelUsagePage(api: SpaceApi) {
    val scope = rememberCoroutineScope()
    val store = remember(api) { ModelUsageStore(api, scope) }
    LaunchedEffect(store) { store.refresh() }
    HubScaffold(stringResource(R.string.hub_model_usage)) { padding ->
        val usage = store.usage
        val calls = store.calls
        val window = store.window
        HubList(padding, onRefresh = { store.refresh() }) {
            group(
                key = "totals",
                footer = {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        // Whose ledger this is: a peer's apps are in its own, or here on a hub as peer/app.
                        val whose = listOfNotNull(
                            usage?.space?.let { stringResource(R.string.usage_space, it) },
                            usage?.backend?.let { stringResource(R.string.hub_backend, it) },
                        )
                        if (whose.isNotEmpty()) Text(whose.joinToString(" · "))
                        if (usage?.space != null) Text(stringResource(R.string.usage_space_hint))
                        Text(stringResource(R.string.hub_costs_note))
                    }
                },
            ) {
                Segmented(ModelUsageStore.windows.map { it to it }, window) { store.choose(it) }
                HubNotice(store)
                for (p in usage?.absentPeers ?: emptyList()) {
                    val time = p.asOf?.let { ISO8601.parse(it) }
                    Warning(
                        if (time != null) stringResource(R.string.usage_peer_stale, p.name, p.error ?: "", dateTime(time))
                        else stringResource(R.string.usage_peer_missing, p.name, p.error ?: ""),
                    )
                }
                usage?.totals?.let { t ->
                    val errors = t.errors ?: 0.0
                    StatCards(
                        listOf(
                            HubFormat.count(t.calls) + (if (errors > 0) " · ${errors.toInt()}⚠︎" else "") to stringResource(R.string.hub_stat_calls),
                            HubFormat.tokens(t.tokens) to stringResource(R.string.hub_stat_tokens),
                            HubFormat.cost(t.costUsd) to stringResource(R.string.hub_stat_cost),
                            HubFormat.duration(t.durationMs) to stringResource(R.string.hub_stat_time),
                        ),
                    )
                    if ((t.calls ?: 0.0) == 0.0) NoteCell(stringResource(R.string.hub_no_calls))
                }
            }
            val byTag = usage?.byTag ?: emptyList()
            if (byTag.isNotEmpty()) {
                groupItems(byTag.withIndex().toList(), key = { "tag:${it.index}" }, headerContent = { Header(stringResource(R.string.hub_by_app_tag)) }) { (_, r) ->
                    val title = listOfNotNull(r.app?.let { store.title(it) }, r.tag).filter { it.isNotEmpty() }.joinToString(" · ")
                    UsageRow(title, r.modelOn, r.totals)
                }
            }
            // The models, then the backends each with where its calls came from (dimmer, as the panel's table).
            val byModel = (usage?.byModel ?: emptyList()).map { it to false } + (usage?.byBackend ?: emptyList()).map { it to true }
            if (byModel.isNotEmpty()) {
                groupItems(byModel.withIndex().toList(), key = { "model:${it.index}" }, headerContent = { Header(stringResource(R.string.hub_by_model)) }) { (_, row) ->
                    val (r, backend) = row
                    if (backend) {
                        UsageRow(listOfNotNull(r.backend, originLabel(r.origin)).joinToString(" · "), null, r.totals, dim = true)
                    } else {
                        UsageRow(r.modelOn ?: "", null, r.totals)
                    }
                }
            }
            val history = usage?.history?.totals
            if (usage != null && history != null && (history.calls ?: 0.0) > 0) {
                group(key = "history", headerContent = { Header(stringResource(R.string.hub_history)) }) {
                    val days = usage.daysRecorded()
                    val weeks = usage.weekly({ it.tokens })
                    val perDay = if (days > 0) (history.costUsd ?: 0.0) / days else 0.0
                    StatCards(
                        listOf(
                            "$days" to stringResource(R.string.hub_stat_days_recorded),
                            HubFormat.count(history.calls) to stringResource(R.string.hub_stat_calls),
                            HubFormat.tokens(history.tokens) to stringResource(R.string.hub_stat_tokens),
                            HubFormat.cost(history.costUsd) to stringResource(R.string.hub_a_day, HubFormat.cost(perDay)),
                        ),
                    )
                    if (weeks.isNotEmpty()) {
                        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            MiniBars(weeks.map { it.value }, Modifier.fillMaxWidth().height(56.dp))
                            Row(Modifier.fillMaxWidth()) {
                                val style = MaterialTheme.typography.labelSmall
                                val color = AiTheme.tokens.secondaryText
                                Text(monthDay(weeks.first().week), style = style, color = color)
                                Spacer(Modifier.weight(1f))
                                Text(stringResource(R.string.hub_tokens_by_week), style = style, color = color)
                                Spacer(Modifier.weight(1f))
                                Text(monthDay(weeks.last().week), style = style, color = color)
                            }
                        }
                    }
                }
            }
            if (calls.isNotEmpty()) {
                groupItems(calls, key = { "call:${it.id}" }, headerContent = { Header(stringResource(R.string.hub_recent_calls)) }) { call ->
                    val t = AiTheme.tokens
                    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                            Dot(if (call.status == "ok") ThemeTokens.success else ThemeTokens.danger)
                            // `<machine>:<model>` can be long: one line, cut, never over the time.
                            Text(call.modelOn ?: "", color = t.text, maxLines = 1, overflow = TextOverflow.Ellipsis, softWrap = false, modifier = Modifier.weight(1f))
                            call.startedAt?.let { ISO8601.parse(it) }?.let {
                                Text(HubFormat.relative(it), style = MaterialTheme.typography.bodySmall, color = t.secondaryText)
                            }
                        }
                        val parts = listOfNotNull(
                            listOfNotNull(store.title(call.app), call.tag).joinToString(" · "),
                            call.usage?.let { HubFormat.tokens(it.total) },
                            call.costUsd?.let { HubFormat.cost(it) },
                            call.durationMs?.let { HubFormat.duration(it) },
                        )
                        Text(parts.joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = t.secondaryText, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        call.error?.takeIf { it.isNotEmpty() }?.let {
                            Text(it, style = MaterialTheme.typography.bodySmall, color = ThemeTokens.danger, maxLines = 4, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
        }
    }
}

@Composable
internal fun Header(text: String) {
    Text(text, style = MaterialTheme.typography.labelLarge, color = AiTheme.tokens.secondaryText)
}

/** Where a backend's calls came from (Usage.tsx's backend rows). */
@Composable
private fun originLabel(origin: String?): String? = when (origin) {
    null, "" -> null
    "task" -> stringResource(R.string.usage_origin_task)
    "import" -> stringResource(R.string.usage_origin_import)
    "peer" -> stringResource(R.string.usage_origin_peer)
    else -> stringResource(R.string.usage_origin_run)
}

@Composable
private fun UsageRow(title: String, detail: String?, t: ModelTotals, dim: Boolean = false) {
    val tokens = AiTheme.tokens
    val errors = (t.errors ?: 0.0).toInt()
    Row(Modifier.fillMaxWidth().alpha(if (dim) 0.7f else 1f).padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.Top) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, color = tokens.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
            val line = listOfNotNull(
                detail,
                stringResource(R.string.hub_n_calls, (t.calls ?: 0.0).toInt()),
                if (errors > 0) stringResource(R.string.hub_n_errors, errors) else null,
            ).joinToString(" · ")
            Text(line, style = MaterialTheme.typography.bodySmall, color = if (errors > 0) ThemeTokens.danger else tokens.secondaryText, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                stringResource(R.string.hub_tokens_split, HubFormat.tokens(t.inputTokens), HubFormat.tokens(t.cacheReadTokens), HubFormat.tokens(t.outputTokens)),
                style = MaterialTheme.typography.labelSmall,
                color = tokens.secondaryText,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Spacer(Modifier.size(8.dp))
        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(HubFormat.tokens(t.tokens), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, color = tokens.text)
            Text(HubFormat.cost(t.costUsd), style = MaterialTheme.typography.bodySmall, color = tokens.secondaryText)
        }
    }
}

/** How often each app, agent and panel window was opened and for how long (src/web/Activity.tsx). */
@Composable
internal fun AppUsagePage(api: SpaceApi, catalogue: Catalogue?) {
    val scope = rememberCoroutineScope()
    val store = remember(api) { AppUsageStore(api, scope) }
    LaunchedEffect(store) { store.refresh() }
    HubScaffold(stringResource(R.string.hub_app_usage)) { padding ->
        val rows = store.rows
        val month = store.month
        val window = store.window
        val kind = store.kind
        val loaded = store.loaded
        val windows = AppUsageStore.windows.map { w -> w to (if (w == "all") stringResource(R.string.hub_all_time) else w) }
        val kinds = listOf(
            "all" to stringResource(R.string.hub_all),
            "app" to stringResource(R.string.hub_apps),
            "agent" to stringResource(R.string.hub_agents),
            "builtin" to stringResource(R.string.hub_panel),
        )
        HubList(padding, onRefresh = { store.refresh() }) {
            group(key = "totals", footer = { Text(stringResource(R.string.hub_app_usage_footer)) }) {
                Segmented(windows, window) { store.choose(window = it) }
                Segmented(kinds, kind) { store.choose(kind = it) }
                HubNotice(store)
                if (loaded) {
                    StatCards(
                        listOf(
                            NumberFormat.getIntegerInstance().format(store.opens.toLong()) to stringResource(R.string.hub_stat_opens),
                            (if (store.activeMs > 0) HubFormat.duration(store.activeMs) else "—") to stringResource(R.string.hub_stat_time_in_use),
                            (rows.firstOrNull()?.let { usageName(it, catalogue) } ?: "—") to stringResource(R.string.hub_stat_most_used),
                        ),
                    )
                    if (rows.isEmpty()) NoteCell(stringResource(R.string.hub_nothing_opened))
                }
            }
            groupItems(rows, key = { "usage:${it.id}" }) { row ->
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(usageName(row, catalogue), color = AiTheme.tokens.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(usageDetail(row), style = MaterialTheme.typography.bodySmall, color = AiTheme.tokens.secondaryText, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                    MiniBars((month[row.id] ?: row).spark(), Modifier.size(width = 90.dp, height = 22.dp))
                }
            }
        }
    }
}

/** The entry's title from the catalogue; the panel's own windows by their names. */
@Composable
private fun usageName(row: AppUsageRow, catalogue: Catalogue?): String = when (row.kind) {
    "app" -> catalogue?.apps?.firstOrNull { it.ref == row.key }?.displayTitle() ?: row.key
    "agent" -> catalogue?.agents?.firstOrNull { it.ref == row.key }?.displayTitle() ?: row.key
    else -> when (row.key) {
        "inbox" -> stringResource(R.string.hub_inbox)
        "terminal" -> stringResource(R.string.terminal_title)
        "settings" -> stringResource(R.string.hub_settings)
        "chat" -> stringResource(R.string.hub_chat)
        else -> row.key
    }
}

@Composable
private fun usageDetail(row: AppUsageRow): String {
    val parts = arrayListOf(stringResource(R.string.hub_n_opens, row.opens))
    row.activeMs?.let { parts.add(HubFormat.duration(it)) }
    row.averageMs?.let { parts.add(stringResource(R.string.hub_avg, HubFormat.duration(it))) }
    row.lastAt?.let { ISO8601.parse(it) }?.let { parts.add(HubFormat.relative(it)) }
    return parts.joinToString(" · ")
}

/**
 * Which model each app's calls run on when they name none (src/web/AppModels.tsx). A choice
 * here is the panel's override: it saves at once and changes the Space.
 */
@Composable
internal fun AppModelsPage(api: SpaceApi, icons: IconImages) {
    val scope = rememberCoroutineScope()
    val store = remember(api) { AppModelsStore(api, scope) }
    LaunchedEffect(store) { store.refresh() }
    HubScaffold(stringResource(R.string.hub_app_models)) { padding ->
        val apps = store.sorted
        val labels = store.labels
        HubList(padding, onRefresh = { store.refresh() }) {
            group(key = "notice", footer = { Text(stringResource(R.string.hub_app_models_footer)) }) {
                HubNotice(store)
            }
            for (app in apps) {
                groupItems(
                    app.rows,
                    key = { "am:${app.app}:${it.id}" },
                    headerContent = { AppHeader(labels[app.app]?.icon, store.title(app.app), icons) },
                ) { row ->
                    ModelMenu(
                        options = store.options,
                        current = row.override,
                        none = stringResource(R.string.hub_no_override),
                        disabled = store.isSaving,
                        pick = { value -> scope.launch { store.setModel(app.app, row.tag, value) } },
                    ) {
                        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(row.tag ?: stringResource(R.string.hub_all_calls), color = AiTheme.tokens.text)
                            Text(
                                listOfNotNull(row.model, modelSource(row.source)).joinToString(" · "),
                                style = MaterialTheme.typography.bodySmall,
                                color = AiTheme.tokens.secondaryText,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }
            }
        }
    }
}

/** The layer that chose the model a row runs on. */
@Composable
private fun modelSource(source: String?): String? = when (source) {
    "override-tag" -> stringResource(R.string.hub_source_override_tag)
    "override-app" -> stringResource(R.string.hub_source_override_app)
    "manifest-tag" -> stringResource(R.string.hub_source_manifest_tag)
    "manifest-default" -> stringResource(R.string.hub_source_manifest_default)
    "default" -> stringResource(R.string.hub_source_default)
    else -> source
}
