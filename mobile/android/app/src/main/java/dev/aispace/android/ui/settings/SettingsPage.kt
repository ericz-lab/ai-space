@file:OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)

package dev.aispace.android.ui.settings

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.text.format.Formatter
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.outlined.BarChart
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.CropSquare
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Forum
import androidx.compose.material.icons.outlined.Inbox
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material.icons.outlined.Memory
import androidx.compose.material.icons.outlined.Public
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material.icons.outlined.Timeline
import androidx.compose.material.icons.outlined.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MenuDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.PullToRefreshDefaults
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.aispace.android.AppModel
import dev.aispace.android.BuildConfig
import dev.aispace.android.HubPage
import dev.aispace.android.R
import dev.aispace.android.core.Connection
import dev.aispace.android.core.Lang
import dev.aispace.android.core.ModelPreferences
import dev.aispace.android.core.PeerStatus
import dev.aispace.android.core.SpaceBackup
import dev.aispace.android.core.SpaceService
import dev.aispace.android.core.SpaceSettings
import dev.aispace.android.core.Times
import dev.aispace.android.live.CatalogueLoader
import dev.aispace.android.live.IconStore
import dev.aispace.android.live.LoaderStatus
import dev.aispace.android.live.SettingsLoader
import dev.aispace.android.ui.common.EntryIcon
import dev.aispace.android.ui.home.HomeType
import dev.aispace.android.ui.theme.AiTheme
import dev.aispace.android.ui.theme.Appearance
import dev.aispace.android.ui.theme.ThemePreset
import dev.aispace.android.ui.theme.ThemeTokens
import dev.aispace.android.ui.theme.rgb
import kotlinx.coroutines.launch
import java.util.Locale

/**
 * Settings, as one page of the pager: first what belongs to this phone that is most often wanted (the
 * saved Spaces, its display), then the Space's own settings as its panel shows them (status, the default
 * model, its pages, peers, services, backups), read from the Space, and last the session and the app.
 * No title bar: the Spaces section is the first thing below the status bar.
 */
@Composable
fun SettingsPage(
    model: AppModel,
    connection: Connection,
    loader: CatalogueLoader,
    settings: SettingsLoader,
    icons: IconStore,
    modifier: Modifier = Modifier,
) {
    val status by loader.status.collectAsState()
    val catalogue by loader.catalogue.collectAsState()
    val space by settings.settings.collectAsState()
    val loading by settings.isLoading.collectAsState()
    val saving by settings.isSaving.collectAsState()
    val saveError by settings.saveError.collectAsState()
    val connections by model.store.connections.collectAsState()
    val scope = rememberCoroutineScope()
    var refreshing by remember { mutableStateOf(false) }
    val pull = rememberPullToRefreshState()
    val top = WindowInsets.statusBars.asPaddingValues().calculateTopPadding() + 12.dp
    val bottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding() + 24.dp

    // Read again whenever the catalogue's state moves: a sign-in, a sign-out, the Space coming back.
    LaunchedEffect(status) { settings.refresh() }

    val peers = catalogue?.peers ?: emptyList()
    val strings = SettingsStrings.current()

    PullToRefreshBox(
        isRefreshing = refreshing,
        onRefresh = {
            refreshing = true
            scope.launch {
                try {
                    loader.refresh()
                    settings.refresh()
                } finally {
                    refreshing = false
                }
            }
        },
        state = pull,
        modifier = modifier.fillMaxSize(),
        indicator = {
            PullToRefreshDefaults.Indicator(
                state = pull, isRefreshing = refreshing,
                modifier = Modifier.align(Alignment.TopCenter).padding(top = top - 12.dp),
            )
        },
    ) {
        LazyColumn(
            modifier = Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.displayCutout.only(WindowInsetsSides.Horizontal)),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = top, bottom = bottom),
        ) {
            spaces(model, connection, connections, strings)
            display(model)
            spaceStatus(connection, status, space, loading, peers)
            space?.models?.let { models(it, status, saving, saveError) { value -> scope.launch { settings.setDefaultModel(value) } } }
            pages(model)
            if (peers.isNotEmpty()) peerRows(peers)
            space?.let { s ->
                if (s.services.isNotEmpty()) serviceRows(s.services, icons)
                if (s.backups.isNotEmpty()) backupRows(s)
            }
            session(model)
            about()
        }
    }

    if (model.confirmingSignOut) {
        AlertDialog(
            onDismissRequest = { model.confirmingSignOut = false },
            title = { Text(stringResource(R.string.settings_sign_out_title, connection.name)) },
            text = { Text(stringResource(R.string.settings_sign_out_detail)) },
            confirmButton = {
                TextButton(onClick = {
                    model.confirmingSignOut = false
                    model.signOut(connection)
                }) { Text(stringResource(R.string.settings_sign_out), color = ThemeTokens.danger) }
            },
            dismissButton = {
                TextButton(onClick = { model.confirmingSignOut = false }) { Text(stringResource(R.string.settings_cancel)) }
            },
        )
    }
}

/** Texts the list needs outside composition (section headers are made in LazyListScope). */
private class SettingsStrings(val selected: String) {
    companion object {
        @Composable
        fun current() = SettingsStrings(selected = stringResource(R.string.settings_selected))
    }
}

// Sections

/** One row of a grouped section. */
private class SettingsRow(val key: String, val content: @Composable RowScope.() -> Unit, val onClick: (() -> Unit)? = null)

/**
 * A grouped section as iOS draws one: a header, its rows on one rounded surface with lines between them,
 * and a footer. Each row is an item of the page's LazyColumn, so a long list of services is lazy too.
 */
private fun LazyListScope.section(
    key: String,
    header: (@Composable () -> String)?,
    footer: (@Composable () -> Unit)? = null,
    rows: List<SettingsRow>,
) {
    if (header != null) {
        item(key = "$key-header") {
            val t = AiTheme.tokens
            Text(
                header(), style = HomeType.footnote, color = t.secondaryText,
                modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 22.dp, bottom = 6.dp).semantics { heading() },
            )
        }
    }
    rows.forEachIndexed { i, row ->
        item(key = "$key-${row.key}") {
            GroupedRow(first = i == 0, last = i == rows.size - 1, onClick = row.onClick, content = row.content)
        }
    }
    if (footer != null) {
        item(key = "$key-footer") {
            Box(Modifier.padding(start = 16.dp, end = 16.dp, top = 6.dp)) { footer() }
        }
    }
}

@Composable
private fun GroupedRow(first: Boolean, last: Boolean, onClick: (() -> Unit)?, content: @Composable RowScope.() -> Unit) {
    val t = AiTheme.tokens
    val r = t.radiusMedium
    val shape = RoundedCornerShape(
        topStart = if (first) r else 0.dp, topEnd = if (first) r else 0.dp,
        bottomEnd = if (last) r else 0.dp, bottomStart = if (last) r else 0.dp,
    )
    Box(Modifier.fillMaxWidth().background(t.glass, shape)) {
        Row(
            Modifier
                .fillMaxWidth()
                .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
                .heightIn(min = 48.dp)
                .padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            content = content,
        )
        if (!first) HorizontalDivider(color = t.hairline, thickness = 1.dp, modifier = Modifier.padding(start = 16.dp))
    }
}

@Composable
private fun Footer(text: String) {
    Text(text, style = HomeType.footnote, color = AiTheme.tokens.secondaryText)
}

/** A label and its value, as `LabeledContent`. */
@Composable
private fun RowScope.Labeled(label: String, value: String) {
    val t = AiTheme.tokens
    Text(label, style = HomeType.body, color = t.text, modifier = Modifier.weight(1f))
    Text(value, style = HomeType.body, color = t.secondaryText, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.End)
}

// This phone's Spaces

private fun LazyListScope.spaces(model: AppModel, connection: Connection, connections: List<Connection>, strings: SettingsStrings) {
    val rows = connections.map { c ->
        SettingsRow("space-${c.id}", content = {
            SpaceRow(model, c, selected = c.id == connection.id, selectedLabel = strings.selected)
        })
    } + SettingsRow("add", onClick = { model.showingAdd = true }, content = {
        val t = AiTheme.tokens
        Icon(Icons.Filled.Add, contentDescription = null, tint = t.accent, modifier = Modifier.size(22.dp))
        Text(stringResource(R.string.settings_add_space), style = HomeType.body, color = t.accent)
    })
    section(
        "spaces",
        header = { stringResource(R.string.settings_spaces) },
        footer = { Footer(stringResource(R.string.settings_spaces_footer)) },
        rows = rows,
    )
}

/** A saved Space: a tap switches to it; its menu (or a long press) removes it from this phone. */
@Composable
private fun RowScope.SpaceRow(model: AppModel, c: Connection, selected: Boolean, selectedLabel: String) {
    val t = AiTheme.tokens
    var menu by remember { mutableStateOf(false) }
    Row(
        Modifier
            .weight(1f)
            .combinedClickable(onLongClick = { menu = true }, onClick = { model.select(c.id) })
            .semantics { if (selected) stateDescription = selectedLabel },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(c.name, style = HomeType.body, color = t.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(c.url.toString(), style = HomeType.footnote, color = t.secondaryText, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (selected) Icon(Icons.Filled.Check, contentDescription = null, tint = t.accent, modifier = Modifier.size(22.dp))
    }
    Box {
        IconButton(onClick = { menu = true }, modifier = Modifier.size(36.dp)) {
            Icon(Icons.Filled.MoreVert, contentDescription = stringResource(R.string.settings_more), tint = t.secondaryText)
        }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.settings_remove)) },
                onClick = {
                    menu = false
                    model.remove(c.id)
                },
                leadingIcon = { Icon(Icons.Outlined.Delete, contentDescription = null) },
                colors = MenuDefaults.itemColors(textColor = ThemeTokens.danger, leadingIconColor = ThemeTokens.danger),
            )
        }
    }
}

// This phone's display

private fun LazyListScope.display(model: AppModel) {
    val rows = ArrayList<SettingsRow>()
    rows += SettingsRow("appearance", content = {
        val t = AiTheme.tokens
        Text(stringResource(R.string.settings_appearance), style = HomeType.body, color = t.text, modifier = Modifier.weight(1f))
        Segments(
            options = listOf(
                Appearance.System to stringResource(R.string.settings_system),
                Appearance.Light to stringResource(R.string.settings_light),
                Appearance.Dark to stringResource(R.string.settings_dark),
            ),
            selected = model.appearance,
            onSelect = { model.updateAppearance(it) },
        )
    })
    rows += ThemePreset.all.map { preset ->
        SettingsRow("theme-${preset.id}", onClick = { model.updateTheme(preset.id) }, content = {
            val t = AiTheme.tokens
            val on = model.themeID == preset.id
            Swatch(preset, t.dark)
            Text(preset.name, style = HomeType.body, color = t.text, modifier = Modifier.weight(1f))
            if (on) Icon(Icons.Filled.Check, contentDescription = stringResource(R.string.settings_selected), tint = t.accent, modifier = Modifier.size(22.dp))
        })
    }
    rows += SettingsRow("widgets", onClick = { model.updateShowsWidgets(!model.showsWidgets) }, content = {
        val t = AiTheme.tokens
        Text(stringResource(R.string.settings_widgets), style = HomeType.body, color = t.text, modifier = Modifier.weight(1f))
        Switch(checked = model.showsWidgets, onCheckedChange = { model.updateShowsWidgets(it) })
    })
    rows += SettingsRow("language", content = {
        val context = LocalContext.current
        val name = remember(Lang.current) {
            val locale = Locale.forLanguageTag(Lang.current)
            locale.getDisplayLanguage(locale).replaceFirstChar { it.titlecase(locale) }
        }
        Row(
            Modifier.weight(1f).clickable { openLanguageSettings(context) },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Labeled(stringResource(R.string.settings_language), name)
        }
    })
    section(
        "display",
        header = { stringResource(R.string.settings_display) },
        footer = { Footer(stringResource(R.string.settings_display_footer)) },
        rows = rows,
    )
}

/**
 * The app's language: Android 13 and later keep one per app, chosen in the system's settings for the
 * app (it lists the languages res/xml/locales_config.xml names); before that the app follows the phone.
 */
private fun openLanguageSettings(context: Context) {
    val perApp = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        Intent(Settings.ACTION_APP_LOCALE_SETTINGS, Uri.fromParts("package", context.packageName, null))
    } else {
        null
    }
    for (intent in listOfNotNull(perApp, Intent(Settings.ACTION_LOCALE_SETTINGS))) {
        try {
            context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            return
        } catch (_: ActivityNotFoundException) {
        }
    }
}

/** A theme as a small picture: its ground, its glows when it has them, its accent in the middle. */
@Composable
private fun Swatch(preset: ThemePreset, dark: Boolean) {
    val t = AiTheme.tokens
    val p = if (dark) preset.dark else preset.light
    val ground = rgb(p.ground)
    val accent = rgb(p.accent)
    val glows = if (preset.glow) listOf(rgb(p.glowA), rgb(p.glowB), rgb(p.glowC)) else emptyList()
    Canvas(Modifier.size(30.dp).border(1.dp, t.hairline, RoundedCornerShape(8.dp)).clearAndSetSemantics {}) {
        val w = size.width
        val corner = CornerRadius(8.dp.toPx())
        drawRoundRect(ground, cornerRadius = corner)
        val spots = listOf(Offset(w * 0.25f, w * 0.25f), Offset(w * 0.8f, w * 0.45f), Offset(w * 0.35f, w * 0.85f))
        glows.forEachIndexed { i, c -> drawCircle(c.copy(alpha = 0.8f), radius = w * 0.26f, center = spots[i]) }
        drawCircle(accent, radius = w * 0.17f, center = Offset(w / 2, w / 2))
    }
}

/** A small segmented control: the options side by side, the chosen one raised. */
@Composable
private fun <T> Segments(options: List<Pair<T, String>>, selected: T, onSelect: (T) -> Unit) {
    val t = AiTheme.tokens
    Row(
        Modifier.background(t.hairline, RoundedCornerShape(9.dp)).padding(2.dp),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        options.forEach { (value, label) ->
            val on = value == selected
            Box(
                Modifier
                    .then(if (on) Modifier.shadow(1.dp, RoundedCornerShape(7.dp)) else Modifier)
                    .background(if (on) t.solid else Color.Transparent, RoundedCornerShape(7.dp))
                    .clickable { onSelect(value) }
                    .semantics {
                        role = Role.RadioButton
                        this.selected = on
                    }
                    .padding(horizontal = 10.dp, vertical = 5.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(label, style = HomeType.footnote, fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal, color = t.text, maxLines = 1)
            }
        }
    }
}

// The Space

private fun LazyListScope.spaceStatus(
    connection: Connection,
    status: LoaderStatus,
    space: SpaceSettings?,
    loading: Boolean,
    peers: List<PeerStatus>,
) {
    val rows = ArrayList<SettingsRow>()
    rows += SettingsRow("status", content = { Labeled(stringResource(R.string.settings_status), statusText(status)) })
    if (space != null) {
        rows += SettingsRow("services", content = {
            Labeled(
                stringResource(R.string.settings_services),
                "${space.services.count { it.state == SpaceService.State.running }} / ${space.services.size}",
            )
        })
        if (peers.isNotEmpty()) {
            rows += SettingsRow("peers", content = {
                Labeled(stringResource(R.string.settings_peers), "${peers.count { !it.isOffline }} / ${peers.size}")
            })
        }
        if (space.backups.isNotEmpty()) {
            rows += SettingsRow("backups", content = {
                Labeled(
                    stringResource(R.string.settings_backups),
                    "${space.backups.count { it.state == SpaceBackup.State.ok }} / ${space.backups.count { it.state != SpaceBackup.State.retired }}",
                )
            })
        }
    } else if (loading) {
        rows += SettingsRow("loading", content = {
            CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
            Text(stringResource(R.string.settings_loading), style = HomeType.body, color = AiTheme.tokens.secondaryText)
        })
    }
    section(
        "space",
        header = { connection.name },
        footer = { Footer(connection.url.toString()) },
        rows = rows,
    )
}

@Composable
private fun statusText(status: LoaderStatus): String = stringResource(
    when (status) {
        LoaderStatus.Ok -> R.string.settings_connected
        LoaderStatus.Loading -> R.string.settings_connecting
        LoaderStatus.SignInNeeded -> R.string.settings_signed_out
        is LoaderStatus.Unreachable -> R.string.settings_unreachable
        is LoaderStatus.Incompatible -> R.string.settings_incompatible
        else -> R.string.settings_connecting
    },
)

/** The Space's default model: the one setting here that changes the Space itself. */
private fun LazyListScope.models(
    m: ModelPreferences,
    status: LoaderStatus,
    saving: Boolean,
    saveError: String?,
    choose: (String?) -> Unit,
) {
    val rows = ArrayList<SettingsRow>()
    rows += SettingsRow("default", content = {
        val t = AiTheme.tokens
        var open by remember { mutableStateOf(false) }
        val enabled = !saving && status == LoaderStatus.Ok
        val environment = stringResource(R.string.settings_environment_defaults)
        val current = m.defaultModel
        Text(stringResource(R.string.settings_default_model), style = HomeType.body, color = t.text, modifier = Modifier.weight(1f))
        Box {
            Row(
                Modifier
                    .clickable(enabled = enabled) { open = true }
                    .alpha(if (enabled) 1f else 0.5f)
                    .padding(vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    current?.let { m.label(it) } ?: environment, style = HomeType.body, color = t.secondaryText,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false),
                )
                Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = t.secondaryText, modifier = Modifier.size(18.dp))
            }
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                ModelChoice(environment, current == null) {
                    open = false
                    choose(null)
                }
                m.options.forEach { option ->
                    ModelChoice(option.label, current == option.value) {
                        open = false
                        choose(option.value)
                    }
                }
                if (current != null && m.options.none { it.value == current }) {
                    ModelChoice(current, true) { open = false }
                }
            }
        }
    })
    if (saveError != null) {
        rows += SettingsRow("error", content = {
            Icon(Icons.Outlined.Warning, contentDescription = null, tint = ThemeTokens.warning, modifier = Modifier.size(18.dp))
            Text(stringResource(R.string.settings_not_saved, saveError), style = HomeType.footnote, color = AiTheme.tokens.text)
        })
    }
    section(
        "models",
        header = { stringResource(R.string.settings_models) },
        footer = {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Footer(stringResource(R.string.settings_models_footer))
                val apps = m.appDefault
                val base = m.baseDefault
                if (apps != null && base != null) Footer(stringResource(R.string.settings_models_defaults, apps, base))
            }
        },
        rows = rows,
    )
}

@Composable
private fun ModelChoice(label: String, on: Boolean, onClick: () -> Unit) {
    DropdownMenuItem(
        text = { Text(label) },
        onClick = onClick,
        leadingIcon = if (on) {
            { Icon(Icons.Filled.Check, contentDescription = null) }
        } else {
            { Box(Modifier.size(24.dp)) }
        },
    )
}

/** The Space's own pages, drawn by the app from the Space's routes. */
private fun LazyListScope.pages(model: AppModel) {
    fun row(key: String, title: Int, icon: ImageVector, page: HubPage) = SettingsRow(key, onClick = { model.hubPage = page }, content = {
        val t = AiTheme.tokens
        Icon(icon, contentDescription = null, tint = t.accent, modifier = Modifier.size(22.dp))
        Text(stringResource(title), style = HomeType.body, color = t.text, modifier = Modifier.weight(1f))
        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = t.secondaryText.copy(alpha = 0.5f), modifier = Modifier.size(18.dp))
    })
    section(
        "pages",
        header = { stringResource(R.string.settings_space) },
        footer = { Footer(stringResource(R.string.settings_pages_footer)) },
        rows = listOf(
            row("inbox", R.string.settings_inbox, Icons.Outlined.Inbox, HubPage.Inbox),
            row("chat", R.string.settings_chat, Icons.Outlined.Forum, HubPage.Chat(null)),
            row("tasks", R.string.settings_tasks, Icons.Outlined.Schedule, HubPage.Tasks),
            row("model-usage", R.string.settings_model_usage, Icons.Outlined.BarChart, HubPage.ModelUsage),
            row("app-usage", R.string.settings_app_usage, Icons.Outlined.Timeline, HubPage.AppUsage),
            row("app-models", R.string.settings_app_models, Icons.Outlined.Memory, HubPage.AppModels),
            row("events", R.string.settings_events, Icons.Outlined.Bolt, HubPage.Events),
            row("packages", R.string.settings_packages, Icons.Outlined.Inventory2, HubPage.Packages),
            row("terminal", R.string.settings_terminal, Icons.Outlined.Terminal, HubPage.Terminal),
        ),
    )
}

private fun LazyListScope.peerRows(peers: List<PeerStatus>) {
    section(
        "peers",
        header = { stringResource(R.string.settings_peers) },
        rows = peers.map { peer ->
            SettingsRow("peer-${peer.name}", content = {
                StateRow(
                    dot = if (peer.isOffline) AiTheme.tokens.secondaryText else ThemeTokens.success,
                    title = peer.name,
                    detail = peerDetail(peer),
                    value = stringResource(if (peer.isOffline) R.string.settings_offline else R.string.settings_online),
                )
            })
        },
    )
}

private fun LazyListScope.serviceRows(services: List<SpaceService>, icons: IconStore) {
    section(
        "services",
        header = { stringResource(R.string.settings_services) },
        rows = services.distinctBy { it.id }.map { service ->
            SettingsRow("service-${service.id}", content = {
                val t = AiTheme.tokens
                EntryIcon(service.icon, Icons.Outlined.CropSquare, icons, size = 30.dp)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                    Text(service.displayTitle(), style = HomeType.body, color = t.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    val where = listOfNotNull(service.peer, service.port?.let { ":$it" }).joinToString(" ")
                    if (where.isNotEmpty()) Text(where, style = HomeType.caption, color = t.secondaryText, maxLines = 1)
                }
                ServiceState(service.state)
            })
        },
    )
}

private fun LazyListScope.backupRows(s: SpaceSettings) {
    val target = s.backupTarget
    val footer: (@Composable () -> Unit)? = target?.let { t -> @Composable { Footer(t) } }
    section(
        "backups",
        header = { stringResource(R.string.settings_backups) },
        footer = footer,
        rows = s.backups.distinctBy { it.id }.map { backup ->
            SettingsRow("backup-${backup.id}", content = {
                StateRow(dot = backupColor(backup.state), title = backup.app, detail = backupDetail(backup), value = backupText(backup.state))
            })
        },
    )
}

/** A dot for the state, a title with its detail, and the state in words. */
@Composable
private fun RowScope.StateRow(dot: Color, title: String, detail: String?, value: String) {
    val t = AiTheme.tokens
    Box(Modifier.size(9.dp).background(dot, CircleShape))
    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
        Text(title, style = HomeType.body, color = t.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (!detail.isNullOrEmpty()) Text(detail, style = HomeType.caption, color = t.secondaryText, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
    Text(value, style = HomeType.subheadline, color = t.secondaryText, maxLines = 1)
}

@Composable
private fun ServiceState(state: SpaceService.State) {
    val t = AiTheme.tokens
    val (color, text) = when (state) {
        SpaceService.State.running -> ThemeTokens.success to R.string.settings_running
        SpaceService.State.down -> ThemeTokens.danger to R.string.settings_not_answering
        SpaceService.State.paused -> t.secondaryText to R.string.settings_paused
        SpaceService.State.unknown -> t.secondaryText to R.string.settings_unknown
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(Modifier.size(9.dp).background(color, CircleShape))
        Text(stringResource(text), style = HomeType.subheadline, color = t.secondaryText, maxLines = 1)
    }
}

@Composable
private fun peerDetail(peer: PeerStatus): String {
    val res = LocalContext.current.resources
    val parts = ArrayList<String>()
    peer.apps?.let { parts += res.getQuantityString(R.plurals.settings_count_apps, it, it) }
    peer.agents?.let { parts += res.getQuantityString(R.plurals.settings_count_agents, it, it) }
    peer.widgets?.let { parts += res.getQuantityString(R.plurals.settings_count_widgets, it, it) }
    if (peer.isOffline) peer.asOf?.let { Times.parse(it) }?.let { parts += Times.ago(it) }
    return parts.joinToString(" · ")
}

@Composable
private fun backupColor(state: SpaceBackup.State): Color = when (state) {
    SpaceBackup.State.ok -> ThemeTokens.success
    SpaceBackup.State.stale -> ThemeTokens.warning
    SpaceBackup.State.failed -> ThemeTokens.danger
    SpaceBackup.State.retired, SpaceBackup.State.none -> AiTheme.tokens.secondaryText
}

@Composable
private fun backupText(state: SpaceBackup.State): String = stringResource(
    when (state) {
        SpaceBackup.State.ok -> R.string.settings_backup_ok
        SpaceBackup.State.stale -> R.string.settings_backup_stale
        SpaceBackup.State.failed -> R.string.settings_backup_failed
        SpaceBackup.State.retired -> R.string.settings_backup_retired
        SpaceBackup.State.none -> R.string.settings_backup_none
    },
)

@Composable
private fun backupDetail(backup: SpaceBackup): String {
    val context = LocalContext.current
    val parts = ArrayList<String>()
    backup.count?.let { parts += context.resources.getQuantityString(R.plurals.settings_count_snapshots, it, it) }
    backup.lastOk?.let { parts += Times.ago(it) }
    backup.lastOkBytes?.let { parts += Formatter.formatShortFileSize(context, it.toLong()) }
    if (backup.state == SpaceBackup.State.failed) backup.lastError?.let { parts += it }
    return parts.joinToString(" · ")
}

// The session and the app

private fun LazyListScope.session(model: AppModel) {
    section(
        "session",
        header = { stringResource(R.string.settings_session) },
        footer = { Footer(stringResource(R.string.settings_session_footer)) },
        rows = listOf(
            SettingsRow("web-panel", onClick = { model.openWebPanel() }, content = {
                val t = AiTheme.tokens
                Icon(Icons.Outlined.Public, contentDescription = null, tint = t.accent, modifier = Modifier.size(22.dp))
                Text(stringResource(R.string.settings_open_web_panel), style = HomeType.body, color = t.text, modifier = Modifier.weight(1f))
            }),
            SettingsRow("sign-out", onClick = { model.confirmingSignOut = true }, content = {
                Text(stringResource(R.string.settings_sign_out), style = HomeType.body, color = ThemeTokens.danger)
            }),
        ),
    )
}

private fun LazyListScope.about() {
    section(
        "about",
        header = { stringResource(R.string.settings_about) },
        rows = listOf(
            SettingsRow("version", content = { Labeled(stringResource(R.string.settings_version), BuildConfig.VERSION_NAME) }),
        ),
    )
}
