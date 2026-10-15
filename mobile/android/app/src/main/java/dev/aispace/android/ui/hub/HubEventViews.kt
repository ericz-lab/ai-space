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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ListAlt
import androidx.compose.material.icons.automirrored.filled.Undo
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Circle
import androidx.compose.material.icons.filled.Language
import androidx.compose.material.icons.filled.NorthEast
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.aispace.android.AppModel
import dev.aispace.android.R
import dev.aispace.android.core.CapabilityApp
import dev.aispace.android.core.Connection
import dev.aispace.android.core.HubFormat
import dev.aispace.android.core.ISO8601
import dev.aispace.android.core.InboxFilter
import dev.aispace.android.core.InboxThread
import dev.aispace.android.core.PackageApp
import dev.aispace.android.core.SpaceApi
import dev.aispace.android.core.SpaceEvent
import dev.aispace.android.core.Urls
import dev.aispace.android.live.EventsStore
import dev.aispace.android.live.InboxStore
import dev.aispace.android.live.PackagesStore
import dev.aispace.android.ui.theme.AiTheme
import dev.aispace.android.ui.theme.ThemeTokens
import kotlinx.coroutines.launch

/**
 * The bus, read-only (src/web/Events.tsx): what apps provide, publish and consume, and the
 * recent events with where each delivery stands.
 */
@Composable
internal fun EventsPage(api: SpaceApi) {
    val scope = rememberCoroutineScope()
    val store = remember(api) { EventsStore(api, scope) }
    val listState = rememberLazyListState()
    val nav = LocalHubNav.current
    LaunchedEffect(store) { store.refresh() }
    when (val top = nav.top) {
        is HubDest.Event -> EventDetail(store, top.event)
        is HubDest.Capabilities -> CapabilitiesPage(store)
        else -> HubScaffold(stringResource(R.string.hub_events)) { padding ->
            val events = store.events
            val capabilities = store.capabilities
            val loaded = store.loaded
            HubList(padding, onRefresh = { store.refresh() }, state = listState) {
                group(key = "notice") {
                    HubNotice(store)
                    if (loaded) {
                        StatCards(
                            listOf(
                                "${events.size}" to stringResource(R.string.hub_stat_recent_events),
                                "${capabilities.count { !it.provides.isNullOrEmpty() }}" to stringResource(R.string.hub_stat_apps_providing),
                                "${capabilities.count { !it.publishes.isNullOrEmpty() }}" to stringResource(R.string.hub_stat_apps_publishing),
                            ),
                        )
                        Cell(onClick = { nav.push(HubDest.Capabilities) }, chevron = true) {
                            Icon(Icons.AutoMirrored.Filled.ListAlt, contentDescription = null, tint = AiTheme.tokens.accent)
                            Text(stringResource(R.string.hub_capabilities), color = AiTheme.tokens.text, modifier = Modifier.weight(1f))
                        }
                    }
                }
                if (loaded && events.isEmpty()) {
                    group(key = "none", headerContent = { Header(stringResource(R.string.hub_recent_events)) }) { NoteCell(stringResource(R.string.hub_no_events)) }
                }
                groupItems(events, key = { "event:${it.id}" }, headerContent = { Header(stringResource(R.string.hub_recent_events)) }) { event ->
                    Cell(onClick = { nav.push(HubDest.Event(event)) }, chevron = true) {
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                                Text(event.name, color = AiTheme.tokens.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                                event.peer?.let { Badge(it) }
                                Spacer(Modifier.weight(1f))
                                ISO8601.parse(event.at)?.let {
                                    Text(HubFormat.relative(it), style = MaterialTheme.typography.bodySmall, color = AiTheme.tokens.secondaryText)
                                }
                            }
                            if (event.preview.isNotEmpty()) {
                                Text(event.preview, style = MaterialTheme.typography.bodySmall, color = AiTheme.tokens.secondaryText, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun EventDetail(store: EventsStore, event: SpaceEvent) {
    LaunchedEffect(event.id) { store.loadDeliveries(event.id) }
    HubScaffold(event.name) { padding ->
        val rows = store.deliveries[event.id]
        val error = store.deliveryErrors[event.id]
        HubList(padding, onRefresh = { store.loadDeliveries(event.id) }) {
            group(key = "about") {
                event.app?.let { LabeledRow(stringResource(R.string.hub_app), it) }
                ISO8601.parse(event.at)?.let { LabeledRow(stringResource(R.string.hub_time), dateTime(it, seconds = true)) }
                for ((key, value) in (event.data ?: emptyMap()).entries.sortedBy { it.key }) {
                    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(key, style = MaterialTheme.typography.bodySmall, color = AiTheme.tokens.secondaryText)
                        SelectionContainer {
                            Text(value.compact, style = MaterialTheme.typography.bodyMedium, fontFamily = FontFamily.Monospace, color = AiTheme.tokens.text)
                        }
                    }
                }
            }
            if (rows != null && rows.isNotEmpty()) {
                groupItems(rows, key = { "delivery:${it.id}" }, headerContent = { Header(stringResource(R.string.hub_deliveries)) }) { d ->
                    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                            Dot(deliveryColor(d.status))
                            Text(d.app, color = AiTheme.tokens.text)
                            d.kind?.let { Badge(it) }
                            Spacer(Modifier.weight(1f))
                            Text(deliveryStatus(d.status), style = MaterialTheme.typography.bodyMedium, color = AiTheme.tokens.secondaryText)
                        }
                        Text(
                            listOfNotNull(d.path, d.attempts?.let { stringResource(R.string.hub_n_attempts, it) }).joinToString(" · "),
                            style = MaterialTheme.typography.bodySmall,
                            color = AiTheme.tokens.secondaryText,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        d.lastError?.takeIf { it.isNotEmpty() }?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = ThemeTokens.danger) }
                    }
                }
            } else {
                group(key = "deliveries", headerContent = { Header(stringResource(R.string.hub_deliveries)) }) {
                    when {
                        rows != null -> NoteCell(stringResource(R.string.hub_no_consumers))
                        error != null -> NoteCell(stringResource(R.string.hub_unavailable, error))
                        else -> Cell { CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = AiTheme.tokens.accent) }
                    }
                }
            }
        }
    }
}

@Composable
private fun deliveryColor(status: String): Color = when (status) {
    "ok" -> ThemeTokens.success
    "dead" -> ThemeTokens.danger
    "sent" -> AiTheme.tokens.accent
    "pending" -> ThemeTokens.warning
    else -> AiTheme.tokens.secondaryText
}

@Composable
private fun deliveryStatus(status: String): String = when (status) {
    "ok" -> stringResource(R.string.hub_status_ok)
    "dead" -> stringResource(R.string.hub_gave_up)
    "sent" -> stringResource(R.string.hub_sent)
    "pending" -> stringResource(R.string.hub_pending)
    "skipped" -> stringResource(R.string.hub_status_skipped)
    else -> status
}

/** Which apps provide capabilities, publish events and consume them, with call counts. */
@Composable
private fun CapabilitiesPage(store: EventsStore) {
    HubScaffold(stringResource(R.string.hub_capabilities)) { padding ->
        val apps = store.capabilities
        HubList(padding, onRefresh = { store.refresh() }) {
            if (apps.isEmpty()) group(key = "none") { NoteCell(stringResource(R.string.hub_no_capabilities)) }
            for (app in apps) {
                group(key = "cap:${app.id}", header = app.peer?.let { "${app.app} · $it" } ?: app.app) {
                    CapabilityLines(app)
                }
            }
        }
    }
}

@Composable
private fun CapabilityLines(app: CapabilityApp) {
    for (c in app.provides ?: emptyList()) {
        val stat = app.stats?.firstOrNull { it.capability == c.name }
        val detail = listOfNotNull(c.description, stat?.let { stringResource(R.string.hub_calls_failed, it.calls ?: 0, it.failures ?: 0) }).joinToString(" · ")
        CapabilityLine(stringResource(R.string.hub_provides), c.name, detail)
    }
    for (p in app.publishes ?: emptyList()) CapabilityLine(stringResource(R.string.hub_publishes), p.name, p.description ?: "")
    for (c in app.consumes ?: emptyList()) {
        val detail = when (c.kind) {
            "task" -> stringResource(R.string.hub_runs_task, c.task ?: "")
            "http" -> "${c.method ?: ""} ${c.path ?: ""}"
            else -> stringResource(R.string.hub_over_stream)
        }
        CapabilityLine(stringResource(R.string.hub_consumes), c.event, detail)
    }
}

@Composable
private fun CapabilityLine(kind: String, name: String, detail: String) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            Badge(kind)
            Text(name, color = AiTheme.tokens.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (detail.isNotEmpty()) {
            Text(detail, style = MaterialTheme.typography.bodySmall, color = AiTheme.tokens.secondaryText, maxLines = 4, overflow = TextOverflow.Ellipsis)
        }
    }
}

/**
 * The packages of this Space and of the Spaces it is connected to, and the connections
 * (src/web/Packages.tsx). Sharing can be switched here; installing a package, removing one and
 * making a connection stay in the web panel.
 */
@Composable
internal fun PackagesPage(model: AppModel, connection: Connection, api: SpaceApi) {
    val scope = rememberCoroutineScope()
    val store = remember(api) { PackagesStore(api, scope) }
    LaunchedEffect(store) { store.refresh() }
    HubScaffold(stringResource(R.string.hub_packages)) { padding ->
        val catalogue = store.catalogue
        val local = catalogue?.apps ?: emptyList()
        val links = store.links
        val loaded = store.loaded
        val saving = store.isSaving
        HubList(padding, onRefresh = { store.refresh() }) {
            group(
                key = "local",
                header = null,
                headerContent = { Header(stringResource(R.string.hub_installed_here)) },
                footer = { catalogue?.spaceId?.let { id -> Text(stringResource(R.string.hub_this_space, id)) } },
            ) {
                HubNotice(store)
                if (loaded) {
                    if (local.isEmpty()) NoteCell(stringResource(R.string.hub_no_packages))
                    for (app in local) PackageRow(model, connection, app, opens = false)
                }
            }
            for (remote in catalogue?.remotes ?: emptyList()) {
                val apps = remote.apps ?: emptyList()
                group(
                    key = "remote:${remote.id}",
                    headerContent = { Header(stringResource(R.string.hub_shared_by, short(remote.spaceId ?: remote.connectionId))) },
                    footer = { if (remote.available == false) Text(stringResource(R.string.hub_not_answering)) },
                ) {
                    if (apps.isEmpty()) NoteCell(stringResource(R.string.hub_nothing_shared))
                    for (app in apps) PackageRow(model, connection, app, opens = remote.available != false)
                }
            }
            for (link in links) {
                group(
                    key = "link:${link.id}",
                    headerContent = { Header(stringResource(R.string.hub_connection_to, short(link.remoteSpaceId ?: link.id))) },
                    footer = { Text(stringResource(R.string.hub_connection_footer)) },
                ) {
                    LabeledRow(stringResource(R.string.hub_status)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                            Dot(if (link.connected == true) ThemeTokens.success else AiTheme.tokens.secondaryText)
                            Text(
                                stringResource(if (link.connected == true) R.string.hub_connected else R.string.hub_not_connected),
                                color = AiTheme.tokens.secondaryText,
                            )
                        }
                    }
                    link.direction?.let { direction ->
                        LabeledRow(
                            stringResource(R.string.hub_direction),
                            stringResource(if (direction == "outgoing") R.string.hub_direction_out else R.string.hub_direction_in),
                        )
                    }
                    link.url?.let { LabeledRow(stringResource(R.string.hub_address), it) }
                    SwitchRow(stringResource(R.string.hub_connection_on), link.enabled != false, enabled = !saving) { on ->
                        scope.launch { store.setEnabled(link, on) }
                    }
                    for (app in local) {
                        SwitchRow(stringResource(R.string.hub_share, app.title ?: app.app), (link.apps ?: emptyList()).contains(app.app), enabled = !saving) { on ->
                            scope.launch { store.setShared(link, app.app, on) }
                        }
                    }
                }
            }
            group(key = "web", footer = { Text(stringResource(R.string.hub_web_panel_footer)) }) {
                Cell(onClick = { model.webPanelFromHub() }) {
                    Icon(Icons.Filled.Language, contentDescription = null, tint = AiTheme.tokens.accent)
                    Text(stringResource(R.string.hub_web_panel_button), color = AiTheme.tokens.accent)
                }
            }
        }
    }
}

@Composable
private fun PackageRow(model: AppModel, connection: Connection, app: PackageApp, opens: Boolean) {
    val url = if (opens && app.page != false) app.url?.let { Urls.resolve(connection.url, it) } else null
    val title = app.title ?: app.app
    Cell(onClick = url?.let { { model.openFromHub(it, title, connection) } }) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, color = AiTheme.tokens.text)
            Text(listOfNotNull(app.version, app.state).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = AiTheme.tokens.secondaryText)
        }
        if (url != null) Icon(Icons.Filled.NorthEast, contentDescription = null, tint = AiTheme.tokens.secondaryText, modifier = Modifier.size(14.dp))
    }
}

@Composable
private fun SwitchRow(label: String, checked: Boolean, enabled: Boolean, onChange: (Boolean) -> Unit) {
    Cell {
        Text(label, color = AiTheme.tokens.text, modifier = Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = onChange, enabled = enabled)
    }
}

/** A Space's id is a UUID; its first group is enough to tell two apart. */
private fun short(id: String): String = id.take(8)

/**
 * Every app's notifications in one list (src/web/Inbox.tsx). Opening a row marks it read;
 * "done" closes a thread until a newer notification arrives in it.
 */
@Composable
internal fun InboxListPage(model: AppModel, connection: Connection, api: SpaceApi) {
    val scope = rememberCoroutineScope()
    val store = remember(api) { InboxStore(api, scope) }
    val listState = rememberLazyListState()
    val nav = LocalHubNav.current
    LaunchedEffect(store) { store.refresh() }
    when (val top = nav.top) {
        is HubDest.Inbox -> InboxDetail(model, connection, store, top.item)
        else -> HubScaffold(
            stringResource(R.string.hub_inbox),
            actions = {
                TextButton(
                    onClick = { scope.launch { store.readAll() } },
                    enabled = (store.summary?.unread ?: 0) > 0 && !store.isSaving,
                ) { Text(stringResource(R.string.hub_read_all)) }
            },
        ) { padding ->
            val items = store.items
            val filter = store.filter
            val loaded = store.loaded
            val summary = store.summary
            val filters = listOf(
                InboxFilter.all.name to stringResource(R.string.hub_all),
                InboxFilter.unread.name to stringResource(R.string.hub_unread),
                InboxFilter.handle.name to stringResource(R.string.hub_to_handle),
                InboxFilter.done.name to stringResource(R.string.hub_done),
            )
            HubList(padding, onRefresh = { store.refresh() }, state = listState) {
                group(
                    key = "filter",
                    footer = { summary?.let { s -> Text(stringResource(R.string.hub_inbox_summary, s.unread, s.open)) } },
                ) {
                    Segmented(filters, filter.name) { name -> store.choose(InboxFilter.valueOf(name)) }
                    HubNotice(store)
                    if (loaded && items.isEmpty()) {
                        NoteCell(stringResource(if (filter == InboxFilter.all) R.string.hub_inbox_empty else R.string.hub_inbox_no_match))
                    }
                }
                groupItems(items, key = { "thread:${it.thread}" }) { item ->
                    Cell(onClick = { nav.push(HubDest.Inbox(item)) }) {
                        InboxRow(item, Modifier.weight(1f))
                        val done = item.done == true
                        IconButton(onClick = { scope.launch { store.mark(item.thread, done = !done) } }) {
                            Icon(
                                if (done) Icons.AutoMirrored.Filled.Undo else Icons.Filled.Check,
                                contentDescription = stringResource(if (done) R.string.hub_reopen else R.string.hub_done),
                                tint = ThemeTokens.success,
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun InboxRow(item: InboxThread, modifier: Modifier) {
    val t = AiTheme.tokens
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top) {
        Dot(levelColor(item.level), Modifier.padding(top = 6.dp))
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    item.heading,
                    fontWeight = if (item.unread == true) FontWeight.SemiBold else FontWeight.Normal,
                    color = if (item.done == true) t.secondaryText else t.text,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                val n = item.count ?: 0
                if (n > 1) Badge("×$n")
            }
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                Badge(item.app)
                if (item.action == true && item.done != true) {
                    Text(stringResource(R.string.hub_needs_action), style = MaterialTheme.typography.bodySmall, color = ThemeTokens.warning)
                }
                if (item.done == true) Text(stringResource(R.string.hub_done_lower), style = MaterialTheme.typography.bodySmall, color = t.secondaryText)
                Spacer(Modifier.weight(1f))
                item.lastAt?.let { ISO8601.parse(it) }?.let {
                    Text(HubFormat.relative(it), style = MaterialTheme.typography.bodySmall, color = t.secondaryText)
                }
            }
        }
    }
}

@Composable
private fun levelColor(level: String?): Color = when (level) {
    "alert" -> ThemeTokens.danger
    "warn" -> ThemeTokens.warning
    "success" -> ThemeTokens.success
    else -> AiTheme.tokens.secondaryText.copy(alpha = 0.5f)
}

/** One thread; as it was in the list, since a filter may drop it from the list once it is read. */
@Composable
private fun InboxDetail(model: AppModel, connection: Connection, store: InboxStore, item: InboxThread) {
    val scope = rememberCoroutineScope()
    LaunchedEffect(item.thread) { if (item.unread == true) store.mark(item.thread, read = true) }
    val now = store.item(item.thread) ?: item
    HubScaffold(now.app) { padding ->
        HubList(padding, onRefresh = { store.refresh() }) {
            group(
                key = "message",
                footer = {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(listOfNotNull(now.app, now.lastAt?.let { ISO8601.parse(it) }?.let { dateTime(it) }).joinToString(" · "))
                        val n = now.count ?: 0
                        val first = now.firstAt?.let { ISO8601.parse(it) }
                        if (n > 1 && first != null) Text(stringResource(R.string.hub_times_since, n, dateTime(first)))
                    }
                },
            ) {
                Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    now.title?.takeIf { it.isNotEmpty() }?.let {
                        Text(it, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, color = AiTheme.tokens.text)
                    }
                    SelectionContainer { Text(now.text, color = AiTheme.tokens.text) }
                }
            }
            group(key = "actions") {
                val url = now.url?.let { Urls.resolve(store.api.base, it) }
                if (url != null) ActionCell(Icons.Filled.NorthEast, stringResource(R.string.hub_open_link)) { model.openFromHub(url, now.heading, connection) }
                val done = now.done == true
                ActionCell(if (done) Icons.AutoMirrored.Filled.Undo else Icons.Filled.Check, stringResource(if (done) R.string.hub_reopen else R.string.hub_mark_done)) {
                    scope.launch { store.mark(now.thread, done = !done) }
                }
                if (!done) {
                    ActionCell(Icons.Filled.Circle, stringResource(R.string.hub_mark_unread)) { scope.launch { store.mark(now.thread, read = false) } }
                }
                store.saveError?.let { NoteCell(stringResource(R.string.hub_not_saved, it), ThemeTokens.danger) }
            }
        }
    }
}

@Composable
private fun ActionCell(icon: ImageVector, label: String, onClick: () -> Unit) {
    Cell(onClick = onClick) {
        Icon(icon, contentDescription = null, tint = AiTheme.tokens.accent, modifier = Modifier.size(20.dp))
        Text(label, color = AiTheme.tokens.accent)
    }
}
