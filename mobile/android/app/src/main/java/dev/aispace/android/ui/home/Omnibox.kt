@file:OptIn(ExperimentalMaterial3Api::class)

package dev.aispace.android.ui.home

import android.provider.Settings
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import kotlin.math.PI
import kotlin.math.sin
import android.Manifest
import android.app.DatePickerDialog
import android.app.TimePickerDialog
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.StopCircle
import androidx.compose.material.icons.outlined.AccountCircle
import androidx.compose.material.icons.outlined.AddCircleOutline
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.Calculate
import androidx.compose.material.icons.outlined.GridView
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import dev.aispace.android.AppModel
import dev.aispace.android.HubPage
import dev.aispace.android.R
import dev.aispace.android.core.Catalogue
import dev.aispace.android.core.CatalogueEntry
import dev.aispace.android.core.ChatRoute
import dev.aispace.android.core.Connection
import dev.aispace.android.core.EntryKind
import dev.aispace.android.core.HubFormat
import dev.aispace.android.core.JSONValue
import dev.aispace.android.core.LocalizedText
import dev.aispace.android.core.OmniboxRules
import dev.aispace.android.core.Reach
import dev.aispace.android.core.ShortcutAction
import dev.aispace.android.core.ShortcutAgentIntent
import dev.aispace.android.core.ShortcutIntent
import dev.aispace.android.core.ShortcutResult
import dev.aispace.android.core.SpaceApi
import dev.aispace.android.core.Times
import dev.aispace.android.core.Urls
import dev.aispace.android.live.OmniboxStore
import dev.aispace.android.live.OmniboxVoice
import dev.aispace.android.live.ShortcutExecution
import dev.aispace.android.live.zone
import dev.aispace.android.ui.theme.AiTheme
import dev.aispace.android.ui.theme.ThemeTokens
import dev.aispace.android.ui.theme.borderlessGlass
import dev.aispace.android.ui.theme.glass
import java.text.DateFormat
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * The first screen's command field: search, an action or a question for an agent, and voice input
 * that fills the field (never sends it). In the glass capsule of the library's search.
 */
@Composable
internal fun OmniboxField(
    query: String,
    onQuery: (String) -> Unit,
    api: SpaceApi,
    focused: Boolean,
    requester: FocusRequester,
    onFocusChange: (Boolean) -> Unit,
    onVoiceBusy: (Boolean) -> Unit,
    onSubmit: () -> Unit,
    modifier: Modifier = Modifier,
    /** Actions are being resolved for the text: three dots beside the microphone say so. */
    resolving: Boolean = false,
) {
    val t = AiTheme.tokens
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val voice = remember { OmniboxVoice(scope) }
    val idle = query.isEmpty() && !focused
    val title = stringResource(R.string.omnibox_universal_search)
    val label = stringResource(R.string.omnibox_field_label)
    val clear = stringResource(R.string.home_clear)
    val microphone = stringResource(R.string.omnibox_voice_microphone)
    val style = TextStyle(fontSize = 19.sp, lineHeight = 24.sp, color = t.text)
    val toggle = {
        voice.toggle(api, query) { text ->
            onQuery(text)
            requester.requestFocus()
        }
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) toggle() else voice.error = microphone
    }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        // Leaving the app ends the recording: the microphone is not held in the background.
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) voice.cancel() }
        lifecycle.addObserver(observer)
        onDispose {
            lifecycle.removeObserver(observer)
            voice.cancel()
            onVoiceBusy(false)
        }
    }
    LaunchedEffect(api) { voice.cancel() }
    val busy = voice.busy
    LaunchedEffect(busy) { onVoiceBusy(busy) }

    Box(
        modifier
            .padding(horizontal = 24.dp)
            .fillMaxWidth()
            .height(48.dp)
            .borderlessGlass(24.dp)
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { requester.requestFocus() }
            .padding(start = 18.dp, end = 12.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Icon(Icons.Filled.Search, contentDescription = null, tint = t.text, modifier = Modifier.size(22.dp).alpha(if (idle) 0f else 1f))
            BasicTextField(
                value = query,
                onValueChange = onQuery,
                enabled = !busy,
                modifier = Modifier
                    .weight(1f)
                    .focusRequester(requester)
                    .onFocusChanged { onFocusChange(it.isFocused) }
                    .semantics { contentDescription = label },
                singleLine = true,
                textStyle = style,
                cursorBrush = SolidColor(t.accent),
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.None,
                    autoCorrectEnabled = false,
                    keyboardType = KeyboardType.Text,
                    imeAction = ImeAction.Search,
                ),
                keyboardActions = KeyboardActions(onSearch = { if (!busy) onSubmit() }),
                decorationBox = { inner ->
                    Box(contentAlignment = Alignment.CenterStart) {
                        if (query.isEmpty() && focused) Text(title, style = style, color = t.secondaryText, maxLines = 1)
                        inner()
                    }
                },
            )
            if (resolving) ResolvingDots(t.secondaryText)
            val listening = voice.recording || voice.starting
            if (voice.transcribing) {
                CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = t.secondaryText)
            } else {
                Icon(
                    if (listening) Icons.Filled.StopCircle else Icons.Filled.Mic,
                    contentDescription = stringResource(if (listening) R.string.omnibox_stop_recording else R.string.omnibox_voice),
                    tint = if (listening) ThemeTokens.danger else t.text,
                    modifier = Modifier.size(24.dp).clip(RoundedCornerShape(12.dp)).clickable {
                        val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
                        if (busy || granted) toggle() else permission.launch(Manifest.permission.RECORD_AUDIO)
                    },
                )
            }
            if (query.isNotEmpty()) {
                Icon(
                    Icons.Filled.Cancel, contentDescription = clear, tint = t.secondaryText,
                    modifier = Modifier.size(22.dp).clickable(enabled = !busy) { onQuery("") },
                )
            }
        }
        if (idle) {
            Row(
                Modifier.align(Alignment.Center).clearAndSetSemantics {},
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Icon(Icons.Filled.Search, contentDescription = null, tint = t.text, modifier = Modifier.size(22.dp))
                Text(title, style = style, color = t.text)
            }
        }
    }
    voice.error?.let { message ->
        AlertDialog(
            onDismissRequest = { voice.error = null },
            confirmButton = { TextButton(onClick = { voice.error = null }) { Text(stringResource(R.string.omnibox_ok)) } },
            title = { Text(stringResource(R.string.omnibox_voice)) },
            text = { Text(message) },
        )
    }
}

/**
 * Three dots bouncing in turn while actions are resolved (src/web/Omnibox.tsx `omni-resolving`). They
 * stay still when the system turns animations off; the status still reaches TalkBack.
 */
@Composable
private fun ResolvingDots(color: Color) {
    val context = LocalContext.current
    val searching = stringResource(R.string.omnibox_searching)
    val still = remember {
        Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    }
    val transition = rememberInfiniteTransition(label = "resolving")
    val phase by transition.animateFloat(0f, 1f, infiniteRepeatable(tween(1000, easing = LinearEasing)), label = "phase")
    Row(
        Modifier.height(32.dp).semantics { contentDescription = searching; liveRegion = LiveRegionMode.Polite },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        for (i in 0 until 3) {
            // Each dot rises 4 dp a third of the way into its cycle, 0.15 s after the one before.
            val local = if (still) 0f else ((phase - i * 0.15f) % 1f + 1f) % 1f
            val lift = if (local < 0.6f) sin(local / 0.6f * PI.toFloat()) else 0f
            Box(
                Modifier.size(4.dp)
                    .graphicsLayer { translationY = -4.dp.toPx() * lift }
                    .clip(CircleShape)
                    .background(color),
            )
        }
    }
}

/** The Space's own pages, found by name like an app (the iPhone's built-in entries). */
private val builtinPages: List<Triple<String, Pair<String, String>, HubPage>> = listOf(
    Triple("inbox", "Inbox" to "收件箱", HubPage.Inbox),
    Triple("tasks", "Tasks" to "任务", HubPage.Tasks),
    Triple("model-usage", "Model Usage" to "模型用量", HubPage.ModelUsage),
    Triple("app-usage", "App Usage" to "应用使用情况", HubPage.AppUsage),
    Triple("app-models", "App Models" to "应用模型", HubPage.AppModels),
    Triple("events", "Events" to "事件", HubPage.Events),
    Triple("packages", "Packages" to "应用包", HubPage.Packages),
    Triple("terminal", "Terminal" to "终端", HubPage.Terminal),
)

private val builtinEntries: List<CatalogueEntry> = builtinPages.map { (id, titles, _) ->
    CatalogueEntry(EntryKind.app, "builtin/$id", titles.first, i18n = mapOf("zh" to LocalizedText(title = titles.second)), reach = Reach.link)
}

/**
 * What the field finds (the iPhone's OmniboxView): the catalogue at once, then what the Space's
 * resolver makes of the text, agents and actions as it ranks them, and always a question for Space
 * Assistant. [submit] counts the field's Search key: each new value activates the default row.
 */
@Composable
internal fun OmniboxResults(
    model: AppModel,
    query: String,
    onQuery: (String) -> Unit,
    connection: Connection,
    catalogue: Catalogue?,
    store: OmniboxStore,
    submit: Int,
    enabled: Boolean,
    modifier: Modifier = Modifier,
) {
    val t = AiTheme.tokens
    val clipboard = LocalClipboardManager.current
    var selection by remember { mutableStateOf<ShortcutIntent?>(null) }
    var pendingLink by remember { mutableStateOf<String?>(null) }
    var chatError by remember { mutableStateOf<String?>(null) }
    val busy = stringResource(R.string.omnibox_agent_busy)
    val resultTitle = stringResource(R.string.omnibox_result)

    val resolution = if (store.resolvedText == query) store.resolution else null
    val entries = remember(query, catalogue) { OmniboxRules.rank(query, (catalogue?.entries ?: emptyList()) + builtinEntries).take(6) }
    val strong = resolution?.intents?.filter { it.kind != "action" || it.strong == true } ?: emptyList()
    val loose = (resolution?.intents?.filter { it.kind == "action" && it.strong != true } ?: emptyList()).take(3)

    LaunchedEffect(query) {
        chatError = null
        store.resolve(query)
    }

    fun openEntry(entry: CatalogueEntry) {
        val builtin = builtinPages.firstOrNull { "builtin/${it.first}" == entry.ref }
        if (builtin != null) model.hubPage = builtin.third else model.open(entry)
        onQuery("")
    }

    fun ask(intent: ShortcutAgentIntent?) {
        val agent = intent?.agent ?: "space/assistant"
        val base = ChatRoute.base(agent, null) ?: return
        val chat = model.chat(connection, base)
        if (chat.isRunning) {
            chatError = busy
            return
        }
        chat.newChat()
        chat.draft.value = query
        chat.send(intentID = intent?.id, timezone = zone())
        model.hubPage = HubPage.Chat("agent:$agent")
        onQuery("")
    }

    fun open(link: String) {
        if (selection != null) {
            // The sheet goes first; the link opens once it is down.
            pendingLink = link
            selection = null
            return
        }
        val url = Urls.resolve(connection.url, link) ?: return
        if (Urls.scheme(url) !in setOf("http", "https")) return
        model.open(url, resultTitle, "shortcut:$url", connection)
    }

    fun copy(text: String?) {
        if (!text.isNullOrEmpty()) clipboard.setText(AnnotatedString(text))
    }

    fun activateDefault() {
        if (query.isBlank()) return
        if (resolution == null) {
            if (!store.resolving && OmniboxRules.opensByDefault(query, entries.firstOrNull())) openEntry(entries.first())
            return
        }
        if (resolution.ambiguous) return
        resolution.agentIntents.firstOrNull()?.let { agent ->
            if (agent.available) ask(agent)
            return
        }
        val intent = strong.firstOrNull()
        when {
            intent != null -> {
                if (intent.action?.available == false) return
                if (intent.kind == "calc") copy(store.preview?.text) else selection = intent
            }
            OmniboxRules.opensByDefault(query, entries.firstOrNull()) -> openEntry(entries.first())
            else -> ask(null)
        }
    }

    var handled by remember { mutableStateOf(submit) }
    LaunchedEffect(submit) {
        if (submit != handled) {
            handled = submit
            if (enabled) activateDefault()
        }
    }

    if (query.isBlank()) return
    Column(
        modifier.verticalScroll(rememberScrollState()).alpha(if (enabled) 1f else 0.5f),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (resolution?.ambiguous == true) {
            Text(stringResource(R.string.omnibox_choose_action), style = HomeType.subheadline, color = t.secondaryText, modifier = Modifier.padding(horizontal = 4.dp))
        }
        // The server returns agent and action candidates that exclude each other.
        for (intent in resolution?.agentIntents ?: emptyList()) {
            ResultRow(intent.title, intent.reason, Icons.Outlined.AutoAwesome, enabled = enabled && intent.available) { ask(intent) }
        }
        for (intent in strong) ActionRow(intent, store, enabled, ::copy, { selection = it }, ::open)
        if (resolution?.agentIntents.isNullOrEmpty()) {
            for (entry in entries) {
                ResultRow(
                    entry.displayTitle(), entry.peer,
                    if (entry.kind == EntryKind.agent) Icons.Outlined.AccountCircle else Icons.Outlined.GridView,
                    enabled = enabled,
                ) { openEntry(entry) }
            }
        }
        for (intent in loose) ActionRow(intent, store, enabled, ::copy, { selection = it }, ::open)
        ResultRow(stringResource(R.string.omnibox_ask_assistant), null, Icons.Outlined.AutoAwesome, enabled = enabled) { ask(null) }
        store.error?.let { Text(it, style = HomeType.footnote, color = ThemeTokens.danger, modifier = Modifier.padding(horizontal = 12.dp)) }
        chatError?.let { Text(it, style = HomeType.footnote, color = ThemeTokens.danger, modifier = Modifier.padding(horizontal = 12.dp)) }
    }

    selection?.let { intent ->
        val action = intent.action ?: return@let
        val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        ModalBottomSheet(onDismissRequest = { selection = null }, sheetState = sheet) {
            // The run belongs to the app's scope: closing the sheet does not abandon an accepted write.
            ShortcutActionSheet(store.api, action, intent.args ?: emptyMap(), model.scope, ::open) { selection = null }
        }
    }
    LaunchedEffect(selection, pendingLink) {
        // A link chosen in the sheet waits for the sheet to go, then opens.
        if (selection == null) pendingLink?.let { link ->
            pendingLink = null
            open(link)
        }
    }
}

@Composable
private fun ResultRow(title: String, detail: String?, icon: ImageVector, enabled: Boolean, onClick: () -> Unit) {
    val t = AiTheme.tokens
    Row(
        Modifier.fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .glass(16.dp, t.solid, t.hairline, elevation = 0.dp)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(12.dp)
            .alpha(if (enabled) 1f else 0.45f),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(icon, contentDescription = null, tint = t.accent, modifier = Modifier.size(22.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(title, style = HomeType.body, color = t.text)
            if (!detail.isNullOrEmpty()) Text(detail, style = HomeType.caption, color = t.secondaryText)
        }
    }
}

@Composable
private fun ActionRow(
    intent: ShortcutIntent,
    store: OmniboxStore,
    enabled: Boolean,
    copy: (String?) -> Unit,
    choose: (ShortcutIntent) -> Unit,
    open: (String) -> Unit,
) {
    val t = AiTheme.tokens
    val usable = enabled && intent.action?.available != false
    val tap = { if (intent.kind == "calc") copy(store.preview?.text) else choose(intent) }
    val preview = store.preview
    if ((intent.kind == "calc" || intent.kind == "convert") && preview != null) {
        Box(
            Modifier.fillMaxWidth()
                .clip(RoundedCornerShape(16.dp))
                .glass(16.dp, t.solid, t.hairline, elevation = 0.dp)
                .clickable(enabled = usable, onClick = tap)
                .padding(12.dp),
        ) { ShortcutResultView(preview, open) }
    } else {
        val icon = when {
            intent.kind == "calc" -> Icons.Outlined.Calculate
            intent.action?.effect == "write" -> Icons.Outlined.AddCircleOutline
            else -> Icons.Outlined.Bolt
        }
        ResultRow(intent.action?.displayTitle() ?: intent.expression ?: "", intent.action?.reason ?: intent.action?.peer, icon, usable, tap)
    }
}

/** An action's form, its run and the run's result (the iPhone's ShortcutActionSheet). */
@Composable
private fun ShortcutActionSheet(
    api: SpaceApi,
    action: ShortcutAction,
    args: Map<String, JSONValue>,
    scope: kotlinx.coroutines.CoroutineScope,
    open: (String) -> Unit,
    done: () -> Unit,
) {
    val t = AiTheme.tokens
    val execution = remember(action) { ShortcutExecution(api, action, args, scope) }
    LaunchedEffect(execution) { if (action.effect == "read" && execution.canSubmit) execution.submit() }
    Column(
        Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).padding(bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(action.displayTitle(), style = HomeType.headline, color = t.text, modifier = Modifier.weight(1f))
            TextButton(onClick = done) { Text(stringResource(R.string.omnibox_done)) }
        }
        if (!action.available) Text(action.reason ?: "", style = HomeType.subheadline, color = t.secondaryText)
        val locked = execution.busy || execution.hasSubmitted
        for (input in action.inputs) InputField(execution, action, input, enabled = !locked)
        if (action.inputs.any { it.type in setOf("date", "time", "period") }) {
            Text(execution.timezone, style = HomeType.caption, color = t.secondaryText)
        }
        if (execution.run == null) {
            val label = when {
                execution.hasSubmitted -> R.string.omnibox_retry
                action.effect == "write" -> R.string.omnibox_create
                action.effect == "run" -> R.string.omnibox_run
                else -> R.string.omnibox_show_result
            }
            Button(onClick = { execution.submit() }, enabled = execution.canSubmit) { Text(stringResource(label)) }
        }
        ExecutionView(execution, open)
    }
}

@Composable
private fun InputField(execution: ShortcutExecution, action: ShortcutAction, input: ShortcutAction.Input, enabled: Boolean) {
    val t = AiTheme.tokens
    val context = LocalContext.current
    val label = action.label(input)
    val value = execution.values[input.name] ?: ""
    fun set(v: String) {
        execution.values = execution.values + (input.name to v)
    }
    when (input.type) {
        "choice", "task" -> {
            var expanded by remember { mutableStateOf(false) }
            val options = input.options ?: emptyList()
            val shown = options.firstOrNull { it.value == value }?.let { action.optionLabel(it) } ?: ""
            ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { if (enabled) expanded = it }) {
                OutlinedTextField(
                    value = shown,
                    onValueChange = {},
                    readOnly = true,
                    enabled = enabled,
                    label = { Text(label) },
                    placeholder = { Text(stringResource(R.string.omnibox_choose)) },
                    trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded) },
                    modifier = Modifier.fillMaxWidth().menuAnchor(),
                )
                ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                    DropdownMenuItem(text = { Text(stringResource(R.string.omnibox_choose)) }, onClick = { set(""); expanded = false })
                    for (option in options) {
                        DropdownMenuItem(text = { Text(action.optionLabel(option)) }, onClick = { set(option.value); expanded = false })
                    }
                }
            }
        }
        "date", "time" -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            OutlinedTextField(value = value, onValueChange = ::set, enabled = enabled, singleLine = true, label = { Text(label) }, modifier = Modifier.fillMaxWidth())
            OutlinedButton(
                enabled = enabled,
                onClick = {
                    val zone = TimeZone.getTimeZone(execution.timezone)
                    val calendar = Calendar.getInstance(zone).apply { time = calendarValue(input.type, value, zone) }
                    if (input.type == "date") {
                        DatePickerDialog(context, { _, y, m, d ->
                            set(String.format(Locale.ROOT, "%04d-%02d-%02d", y, m + 1, d))
                        }, calendar.get(Calendar.YEAR), calendar.get(Calendar.MONTH), calendar.get(Calendar.DAY_OF_MONTH)).show()
                    } else {
                        TimePickerDialog(context, { _, h, min ->
                            set(String.format(Locale.ROOT, "%02d:%02d", h, min))
                        }, calendar.get(Calendar.HOUR_OF_DAY), calendar.get(Calendar.MINUTE), android.text.format.DateFormat.is24HourFormat(context)).show()
                    }
                },
            ) { Text(stringResource(if (input.type == "date") R.string.omnibox_choose_date else R.string.omnibox_choose_time)) }
        }
        else -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            OutlinedTextField(
                value = value,
                onValueChange = ::set,
                enabled = enabled,
                singleLine = input.type != "text",
                label = { Text(label) },
                keyboardOptions = KeyboardOptions(
                    keyboardType = if (input.type == "number") KeyboardType.Decimal else KeyboardType.Text,
                    autoCorrectEnabled = input.type == "text",
                ),
                modifier = Modifier.fillMaxWidth(),
            )
            if (input.type == "period") Text(stringResource(R.string.omnibox_period_hint), style = HomeType.caption, color = t.secondaryText)
        }
    }
}

/** A date or time field's value as a moment for its picker, in the run's zone; now when it is not one. */
private fun calendarValue(type: String, value: String, zone: TimeZone): Date {
    if (type == "date" && value in setOf("today", "tomorrow", "yesterday")) {
        val calendar = Calendar.getInstance(zone)
        calendar.add(Calendar.DAY_OF_MONTH, if (value == "tomorrow") 1 else if (value == "yesterday") -1 else 0)
        return calendar.time
    }
    val format = SimpleDateFormat(if (type == "date") "yyyy-MM-dd" else "HH:mm", Locale.ROOT).apply {
        timeZone = zone
        isLenient = false
    }
    return try {
        format.parse(value) ?: Date()
    } catch (e: Exception) {
        Date()
    }
}

@Composable
private fun ExecutionView(execution: ShortcutExecution, open: (String) -> Unit) {
    val t = AiTheme.tokens
    val run = execution.run
    if (execution.busy || run?.status == "running") CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp, color = t.secondaryText)
    if (run != null) {
        val status = when (run.status) {
            "ok" -> R.string.omnibox_completed
            "running" -> R.string.omnibox_running
            "unknown" -> R.string.omnibox_unknown
            else -> R.string.omnibox_failed
        }
        Text(stringResource(status), style = HomeType.subheadline, color = t.text)
        run.result?.let { ShortcutResultView(it, open) }
        run.error?.let { Text(it, style = HomeType.subheadline, color = ThemeTokens.danger) }
        if (execution.canRetry) OutlinedButton(onClick = { execution.retry() }) { Text(stringResource(R.string.omnibox_retry)) }
    }
    execution.error?.let { Text(it, style = HomeType.subheadline, color = ThemeTokens.danger) }
}

/** A run's or a preview's result: a value, a list of items, a task, its output and where it came from. */
@Composable
private fun ShortcutResultView(result: ShortcutResult, open: (String) -> Unit) {
    val t = AiTheme.tokens
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (result.kind == "value") {
            SelectionContainer { Text(result.text ?: result.value?.compact ?: "", style = HomeType.title3, color = t.text) }
        }
        for (item in result.items ?: emptyList()) {
            Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                val url = item.url
                if (url != null) {
                    Text(
                        item.title, style = HomeType.body.copy(textDecoration = TextDecoration.Underline), color = ThemeTokens.link,
                        modifier = Modifier.clickable { open(url) },
                    )
                } else {
                    Text(item.title, style = HomeType.body, color = t.text)
                }
                item.detail?.let { Text(it, style = HomeType.subheadline, color = t.text) }
                val at = item.at?.let { Times.parse(it) }?.let { DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date.from(it)) }
                val metadata = listOfNotNull(item.source, item.date, item.time, item.timezone, at).joinToString(" · ")
                if (metadata.isNotEmpty()) Text(metadata, style = HomeType.caption, color = t.secondaryText)
            }
        }
        result.task?.let { Text(it, style = HomeType.headline, color = t.text) }
        result.output?.let { SelectionContainer { Text(it, style = HomeType.caption.copy(fontFamily = FontFamily.Monospace), color = t.text) } }
        result.error?.let { Text(it, style = HomeType.subheadline, color = ThemeTokens.danger) }
        result.detail?.let { Text(it, style = HomeType.subheadline, color = t.text) }
        result.source?.let { Text(it, style = HomeType.caption, color = t.secondaryText) }
        result.asOf?.let { Times.parse(it) }?.let { Text(HubFormat.relative(it), style = HomeType.caption, color = t.secondaryText) }
        if (result.stale == true) Text(stringResource(R.string.omnibox_cached), style = HomeType.caption, color = t.secondaryText)
    }
}
