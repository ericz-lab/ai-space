package dev.aispace.android.ui.hub

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.outlined.AttachFile
import androidx.compose.material.icons.outlined.History
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.sp
import dev.aispace.android.core.ChatSessionInfo
import dev.aispace.android.core.Times
import dev.aispace.android.ui.shell.rememberReduceMotion
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.Checklist
import androidx.compose.material.icons.outlined.Code
import androidx.compose.material.icons.outlined.Computer
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.EditNote
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.HelpOutline
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import dev.aispace.android.AppModel
import dev.aispace.android.R
import dev.aispace.android.core.AgentGroups
import dev.aispace.android.core.Catalogue
import dev.aispace.android.core.Inventory
import dev.aispace.android.core.MachineInventory
import dev.aispace.android.core.CatalogueEntry
import dev.aispace.android.core.ChatActivity
import dev.aispace.android.core.ChatApproval
import dev.aispace.android.core.ChatApprovalState
import dev.aispace.android.core.ChatImage
import dev.aispace.android.core.ChatQuestion
import dev.aispace.android.core.ChatStep
import dev.aispace.android.core.ChatStepKind
import dev.aispace.android.core.ChatStepState
import dev.aispace.android.core.ChatTools
import dev.aispace.android.core.ToolVariant
import dev.aispace.android.core.ChatRoute
import dev.aispace.android.core.Connection
import dev.aispace.android.live.CatalogueLoader
import dev.aispace.android.live.ChatImages
import dev.aispace.android.live.ChatStore
import dev.aispace.android.live.IconImages
import dev.aispace.android.ui.common.EntryIcon
import dev.aispace.android.ui.theme.AiTheme
import dev.aispace.android.ui.theme.ThemeTokens
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * An agent's conversation by its entry key, with the machines it runs on: switching machine calls
 * [onSwitch] with that machine's variant, which keeps its own conversation. False when the key is
 * not an agent the catalogue lists.
 */
@Composable
internal fun AgentChat(
    model: AppModel,
    connection: Connection,
    catalogue: Catalogue?,
    key: String,
    icons: IconImages,
    onSwitch: (CatalogueEntry) -> Unit,
): Boolean {
    val agent = catalogue?.agents?.firstOrNull { it.key == key } ?: return false
    val base = ChatRoute.base(agent.ref, agent.peer) ?: return false
    val group = catalogue.agentGroup(agent.key)
    val machines = group?.machines ?: listOf(agent)
    // Which agent CLIs each machine has, for the machine menu; read when there is a choice.
    var inventory by remember(group?.key) { mutableStateOf<List<MachineInventory>>(emptyList()) }
    LaunchedEffect(group?.key, machines.size > 1) {
        if (machines.size > 1) {
            inventory = try {
                Inventory.decode(model.loader(connection).api.text(Inventory.PATH))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                emptyList()
            }
        }
    }
    ChatPage(
        agent, model.chat(connection, base), icons,
        machines = machines,
        machineClis = { m -> Inventory.machine(inventory, m.peer)?.usableClis ?: emptyList() },
        onMachine = { m ->
            if (m.key != agent.key && !AgentGroups.isOffline(m)) {
                group?.let { model.rememberMachine(connection, it.key, m.peer) }
                onSwitch(m)
            }
        },
    )
    return true
}

/** The agents of the Space, once each whatever the machines, each leading to its conversation. */
@Composable
internal fun AgentsPage(model: AppModel, connection: Connection, loader: CatalogueLoader, icons: IconImages) {
    val nav = LocalHubNav.current
    val catalogue by loader.catalogue.collectAsState()
    val listState = rememberLazyListState()
    val top = nav.top
    if (top is HubDest.Agent) {
        if (AgentChat(model, connection, catalogue, top.key, icons) { nav.replace(HubDest.Agent(it.key)) }) return
    }
    HubScaffold(stringResource(R.string.hub_chat)) { padding ->
        val groups = catalogue?.agentGroups ?: emptyList()
        HubList(padding, onRefresh = { loader.refresh() }, state = listState) {
            if (groups.isEmpty()) group(key = "none") { NoteCell(stringResource(R.string.hub_no_agents)) }
            groupItems(groups.filter { ChatRoute.base(it.primary.ref, it.primary.peer) != null }, key = { "agent:${it.key}" }) { g ->
                val agent = g.primary
                val online = g.machines.any { !AgentGroups.isOffline(it) }
                Cell(onClick = { nav.push(HubDest.Agent(model.preferredAgent(connection, agent).key)) }, enabled = online, chevron = true) {
                    EntryIcon(agent.icon, Icons.Filled.Person, icons, size = 40.dp, isRound = true)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(agent.displayTitle(), color = AiTheme.tokens.text)
                        agent.displayDetail()?.let {
                            Text(it, style = MaterialTheme.typography.bodySmall, color = AiTheme.tokens.secondaryText, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                        if (g.machines.size > 1) {
                            Text(
                                stringResource(R.string.chat_on_machines, machineNames(g.machines)),
                                style = MaterialTheme.typography.labelSmall, color = AiTheme.tokens.secondaryText,
                                maxLines = 1, overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }
            }
        }
    }
}

/** "this machine, david (offline)", the machines of an agent in their order. */
@Composable
private fun machineNames(machines: List<CatalogueEntry>): String {
    val here = stringResource(R.string.chat_this_machine)
    val offline = stringResource(R.string.chat_machine_offline)
    val sep = stringResource(R.string.chat_machine_separator)
    return machines.joinToString(sep) { m -> (m.peer ?: here) + if (AgentGroups.isOffline(m)) " ($offline)" else "" }
}

/**
 * One agent's conversation, as the panel's chat on a phone (src/web/Chat.tsx, styles.css `.chat`): a
 * head with the agent, whether the conversation is new, in a session or thinking, and Stop, History and
 * New conversation; the messages, the reply as it streams in, and the field to write in, on the
 * translucent sheet. The model and the permission mode are the agent's defaults; the web panel's chat
 * can pick them.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun ChatPage(
    agent: CatalogueEntry,
    store: ChatStore,
    icons: IconImages,
    machines: List<CatalogueEntry> = listOf(agent),
    machineClis: (CatalogueEntry) -> List<String> = { emptyList() },
    onMachine: (CatalogueEntry) -> Unit = {},
) {
    // A machine that does not answer is shown, and nothing is sent there.
    val offline = AgentGroups.isOffline(agent)
    val scope = rememberCoroutineScope()
    val t = AiTheme.tokens
    val draft by store.draft.collectAsState()
    val bubbles = store.bubbles
    val running = store.isRunning
    val listState = rememberLazyListState()
    var history by remember { mutableStateOf(false) }
    val context = LocalContext.current
    // Photos being read: Send waits for them, so a message never leaves without its pictures.
    var reading by remember { mutableStateOf(0) }
    val unreadable = stringResource(R.string.chat_image_unreadable)
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(ChatImage.MAX_COUNT)) { uris ->
        if (uris.size + store.images.size > ChatImage.MAX_COUNT) {
            store.imageError = context.getString(R.string.chat_image_limits)
            return@rememberLauncherForActivityResult
        }
        for (uri in uris) {
            reading += 1
            scope.launch {
                try {
                    val image = ChatImages.read(context, uri)
                    if (image == null) store.imageError = unreadable else store.addImage(image)
                } finally {
                    reading -= 1
                }
            }
        }
    }

    LaunchedEffect(store) { if (store.isRunning) store.loadSessions() }
    LaunchedEffect(running) { if (!running) store.loadSessions() }
    // The end of the conversation stays in view as the reply grows.
    LaunchedEffect(bubbles.size, bubbles.lastOrNull()?.text, bubbles.lastOrNull()?.steps?.size) {
        // The intro (when there are no messages), the bubbles, then the end.
        listState.scrollToItem((if (bubbles.isEmpty()) 1 else 0) + bubbles.size)
    }

    Column(
        Modifier.fillMaxSize()
            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))
            .windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars).only(WindowInsetsSides.Bottom)),
    ) {
        ChatHead(
            agent, icons, store, running,
            machines = machines,
            machineClis = machineClis,
            onMachine = onMachine,
            history = history,
            onHistory = { history = !history },
            onNew = {
                history = false
                store.newChat()
            },
            onPick = { session ->
                history = false
                scope.launch { store.open(session) }
            },
        )
        LazyColumn(
            Modifier.weight(1f).fillMaxWidth(),
            state = listState,
            contentPadding = PaddingValues(horizontal = 18.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (bubbles.isEmpty()) item(key = "intro") { Intro(agent, icons) }
            items(bubbles, key = { it.id }) {
                ChatBubble(it, answer = if (it.live) { id, allow, answers -> store.answer(id, allow, answers) } else null)
            }
            item(key = "end") { Spacer(Modifier.height(1.dp)) }
        }
        store.error?.let {
            Text(
                stringResource(R.string.hub_unavailable, it),
                style = MaterialTheme.typography.bodySmall,
                color = ThemeTokens.danger,
                modifier = Modifier.padding(horizontal = 18.dp).padding(bottom = 6.dp),
            )
        }
        if (offline) {
            Text(
                stringResource(R.string.chat_machine_offline_note, agent.peer ?: stringResource(R.string.chat_this_machine)),
                style = MaterialTheme.typography.bodySmall,
                color = t.secondaryText,
                modifier = Modifier.padding(horizontal = 18.dp).padding(bottom = 6.dp),
            )
        }
        store.imageError?.let {
            Text(
                it,
                style = MaterialTheme.typography.bodySmall,
                color = t.secondaryText,
                modifier = Modifier.padding(horizontal = 18.dp).padding(bottom = 6.dp),
            )
        }
        if (store.images.isNotEmpty()) {
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                for (image in store.images) {
                    Box {
                        ImageThumb(image, 64.dp)
                        val remove = stringResource(R.string.chat_remove_image)
                        Icon(
                            Icons.Filled.Cancel, contentDescription = remove, tint = t.text,
                            modifier = Modifier.align(Alignment.TopEnd).padding(2.dp).size(20.dp)
                                .clip(RoundedCornerShape(10.dp)).background(t.solid)
                                .clickable(enabled = reading == 0) { store.removeImage(image.id) },
                        )
                    }
                }
            }
        }
        // The composer (`.chat-input`): a hairline above, the attach button, the field on glass, and
        // the round send button in the accent's gradient.
        HorizontalDivider(color = t.hairline)
        Row(
            Modifier.fillMaxWidth().padding(start = 10.dp, end = 14.dp, top = 12.dp, bottom = 12.dp),
            verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            IconButton(
                onClick = { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
                enabled = reading == 0 && store.images.size < ChatImage.MAX_COUNT,
                modifier = Modifier.size(40.dp),
            ) {
                Icon(Icons.Outlined.AttachFile, contentDescription = stringResource(R.string.chat_add_images), tint = t.secondaryText, modifier = Modifier.size(20.dp))
            }
            val shape = RoundedCornerShape(t.radiusSmall)
            BasicTextField(
                value = draft,
                onValueChange = { store.draft.value = it },
                maxLines = 6,
                textStyle = MaterialTheme.typography.bodyLarge.copy(color = t.text),
                cursorBrush = SolidColor(t.accent),
                modifier = Modifier.weight(1f).heightIn(min = 40.dp),
                decorationBox = { field ->
                    Box(
                        Modifier.clip(shape).background(t.sheetGlass).border(1.dp, t.hairline, shape).padding(horizontal = 12.dp, vertical = 9.dp),
                        contentAlignment = Alignment.CenterStart,
                    ) {
                        if (draft.isEmpty()) {
                            Text(
                                stringResource(if (running) R.string.chat_message_busy else R.string.chat_message),
                                style = MaterialTheme.typography.bodyLarge, color = t.secondaryText, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            )
                        }
                        field()
                    }
                },
            )
            // A message written during a turn joins it, so Send stays while the turn runs; Stop is in the head.
            val canSend = store.canSend && reading == 0 && !offline
            SendButton(enabled = canSend) { store.send() }
        }
    }
}

/** The chat's head (`.chat-head`): back or close, the agent, the conversation's state, and its buttons. */
@Composable
private fun ChatHead(
    agent: CatalogueEntry,
    icons: IconImages,
    store: ChatStore,
    running: Boolean,
    machines: List<CatalogueEntry>,
    machineClis: (CatalogueEntry) -> List<String>,
    onMachine: (CatalogueEntry) -> Unit,
    history: Boolean,
    onHistory: () -> Unit,
    onNew: () -> Unit,
    onPick: (ChatSessionInfo) -> Unit,
) {
    val nav = LocalHubNav.current
    val t = AiTheme.tokens
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().padding(start = 4.dp, end = 8.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (nav.depth == 0) {
                IconButton(onClick = { nav.close() }) { Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.hub_close), tint = t.accent) }
            } else {
                IconButton(onClick = { nav.back() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.hub_back), tint = t.accent) }
            }
            EntryIcon(agent.icon, Icons.Filled.Person, icons, size = 26.dp, isRound = true)
            Spacer(Modifier.width(10.dp))
            Text(
                agent.displayTitle(), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold, color = t.text,
                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false),
            )
            Spacer(Modifier.width(10.dp))
            Text(
                stringResource(
                    when {
                        running -> R.string.chat_thinking
                        store.sessionID != null -> R.string.chat_in_session
                        else -> R.string.chat_new_session
                    },
                ),
                style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Normal, color = t.secondaryText, maxLines = 1,
                overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
            )
            if (running) HeadButton(Icons.Filled.Stop, stringResource(R.string.chat_stop)) { store.stop() }
            HeadButton(Icons.Outlined.History, stringResource(R.string.chat_history), on = history, enabled = !running) { onHistory() }
            HeadButton(Icons.Outlined.EditNote, stringResource(R.string.chat_new_conversation), enabled = !running) { onNew() }
        }
        // The same agent on several machines: the machine it runs on, switched here (`.chat-machine`).
        if (machines.size > 1) MachineMenu(agent, machines, machineClis, onMachine)
        // The history button opens the past sessions under the head (`.chat-hist`).
        if (history) {
            val sessions = store.sessions
            Column(
                Modifier.fillMaxWidth().heightIn(max = 260.dp).verticalScroll(rememberScrollState()).padding(horizontal = 12.dp).padding(bottom = 8.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                if (sessions.isEmpty()) {
                    Text(
                        stringResource(R.string.chat_no_sessions), style = MaterialTheme.typography.labelMedium, color = t.secondaryText,
                        textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
                    )
                }
                for (session in sessions) {
                    val on = session.sid == store.sessionID
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp))
                            .background(if (on) t.text.copy(alpha = 0.10f) else Color.Transparent)
                            .clickable { onPick(session) }
                            .padding(horizontal = 10.dp, vertical = 9.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text(
                            session.title?.takeIf { it.isNotEmpty() } ?: stringResource(R.string.chat_untitled),
                            style = MaterialTheme.typography.bodyMedium, color = t.text, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                        session.ts?.let {
                            Text(Times.ago(Times.fromMillis(it)), style = MaterialTheme.typography.labelSmall, color = t.secondaryText, maxLines = 1)
                        }
                    }
                }
            }
        }
        HorizontalDivider(color = t.hairline)
    }
}

/**
 * The chat's machine menu: the machine this conversation runs on, and the others the agent runs on.
 * An offline machine is listed, greyed, and cannot be picked; each machine keeps its own conversation.
 */
@Composable
private fun MachineMenu(
    agent: CatalogueEntry,
    machines: List<CatalogueEntry>,
    clis: (CatalogueEntry) -> List<String>,
    onMachine: (CatalogueEntry) -> Unit,
) {
    val t = AiTheme.tokens
    var open by remember { mutableStateOf(false) }
    val here = stringResource(R.string.chat_this_machine)
    val offline = stringResource(R.string.chat_machine_offline)
    // "david · claude, codex (offline)": the machine, the CLIs it can chat with, whether it answers.
    fun label(m: CatalogueEntry): String {
        val found = clis(m)
        return (m.peer ?: here) + (if (found.isNotEmpty()) " · " + found.joinToString(", ") else "") +
            if (AgentGroups.isOffline(m)) " ($offline)" else ""
    }
    Box(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 8.dp)) {
        Row(
            Modifier.clip(RoundedCornerShape(8.dp)).background(t.text.copy(alpha = 0.06f))
                .clickable(role = Role.DropdownList) { open = true }
                .padding(horizontal = 10.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(Icons.Outlined.Computer, contentDescription = null, tint = t.secondaryText, modifier = Modifier.size(16.dp))
            Text(stringResource(R.string.chat_machine), style = MaterialTheme.typography.labelMedium, color = t.secondaryText)
            Text(label(agent), style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = t.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Icon(Icons.Outlined.ExpandMore, contentDescription = stringResource(R.string.chat_machine_title), tint = t.secondaryText, modifier = Modifier.size(16.dp))
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            for (m in machines) {
                val down = AgentGroups.isOffline(m) && m.key != agent.key
                DropdownMenuItem(
                    text = { Text(label(m), fontWeight = if (m.key == agent.key) FontWeight.SemiBold else FontWeight.Normal) },
                    enabled = !down,
                    onClick = {
                        open = false
                        onMachine(m)
                    },
                )
            }
        }
    }
}

/** A flat round button of the head (`.chat-hbtn`): muted, the link colour while [on]. */
@Composable
private fun HeadButton(icon: ImageVector, label: String, on: Boolean = false, enabled: Boolean = true, onClick: () -> Unit) {
    val t = AiTheme.tokens
    IconButton(onClick = onClick, enabled = enabled, modifier = Modifier.size(40.dp)) {
        Box(
            Modifier.size(32.dp).clip(RoundedCornerShape(8.dp))
                .background(if (on) ThemeTokens.link.copy(alpha = 0.14f) else Color.Transparent),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                icon, contentDescription = label, modifier = Modifier.size(18.dp),
                tint = when {
                    !enabled -> t.secondaryText.copy(alpha = 0.4f)
                    on -> ThemeTokens.link
                    else -> t.secondaryText
                },
            )
        }
    }
}

/** The send button (`.chat-send`): a 36 dp circle in the accent's gradient toward the link colour. */
@Composable
private fun SendButton(enabled: Boolean, onClick: () -> Unit) {
    val t = AiTheme.tokens
    Box(
        Modifier.size(40.dp).alpha(if (enabled) 1f else 0.4f).clip(CircleShape)
            .background(Brush.linearGradient(listOf(t.accent, ThemeTokens.link)))
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(Icons.Filled.ArrowUpward, contentDescription = stringResource(R.string.chat_send), tint = Color.White, modifier = Modifier.size(20.dp))
    }
}

@Composable
private fun Intro(agent: CatalogueEntry, icons: IconImages) {
    // `.chat-hello`: the agent's picture, its name and what it does, quiet and centred.
    Column(
        Modifier.fillMaxWidth().padding(top = 28.dp, start = 20.dp, end = 20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        EntryIcon(agent.icon, Icons.Filled.Person, icons, size = 52.dp, isRound = true)
        Spacer(Modifier.height(4.dp))
        Text(agent.displayTitle(), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold, color = AiTheme.tokens.text)
        agent.displayDetail()?.let {
            Text(it, style = MaterialTheme.typography.bodyMedium, color = AiTheme.tokens.secondaryText, textAlign = TextAlign.Center)
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ChatBubble(bubble: ChatStore.Bubble, answer: (suspend (String, Boolean, Map<String, List<String>>?) -> String?)?) {
    BoxWithConstraints(Modifier.fillMaxWidth()) { BubbleRow(bubble, answer, widest = maxWidth * 0.88f) }
}

/**
 * The person's message is a light bubble in the link colour, its lower trailing corner tucked in
 * (`.msg.user`); the reply has no bubble and runs at [widest], 88 % of the width (`.msg.ai`).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun BubbleRow(bubble: ChatStore.Bubble, answer: (suspend (String, Boolean, Map<String, List<String>>?) -> String?)?, widest: androidx.compose.ui.unit.Dp) {
    val t = AiTheme.tokens
    val r = t.radiusSmall
    val shape = RoundedCornerShape(topStart = r, topEnd = r, bottomEnd = 4.dp, bottomStart = r)
    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (bubble.isUser) Arrangement.End else Arrangement.Start) {
        Column(
            if (bubble.isUser) {
                Modifier.widthIn(max = widest)
                    .clip(shape)
                    .background(ThemeTokens.link.copy(alpha = 0.14f))
                    .border(1.dp, ThemeTokens.link.copy(alpha = 0.20f), shape)
                    .padding(horizontal = 12.dp, vertical = 8.dp)
            } else {
                Modifier.width(widest).padding(horizontal = 4.dp, vertical = 8.dp)
            },
            verticalArrangement = Arrangement.spacedBy(if (bubble.isUser) 6.dp else 14.dp),
        ) {
            if (bubble.isUser) {
                if (bubble.images.isNotEmpty()) {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        for (image in bubble.images) ImageThumb(image, 96.dp)
                    }
                }
                if (bubble.text.isNotEmpty()) RichText(bubble.text, t.text, ThemeTokens.link)
            } else {
                // The reply's work in the order it happened: text, runs of tool calls, approvals and
                // questions, messages added while it ran (src/web/Chat.tsx).
                val steps = bubble.steps
                for (group in ChatTools.groups(steps)) {
                    val step = group.first()
                    when (step.kind) {
                        // A past session opens on its answers: a run of calls folds to one line.
                        ChatStepKind.Tool -> if (bubble.historic && group.size > 1) ToolGroup(group) else ToolRows(group)
                        ChatStepKind.Text -> if (step.text.isNotEmpty()) RichText(step.text, t.text, ThemeTokens.link)
                        ChatStepKind.Approval -> {
                            val approval = step.approval ?: continue
                            val live = if (bubble.live) answer else null
                            if (step.questions.isNotEmpty()) {
                                val reply: (suspend (Boolean, Map<String, List<String>>?) -> String?)? =
                                    live?.let { send -> { allow, answers -> send(approval.id, allow, answers) } }
                                QuestionCard(step, reply)
                            } else {
                                val reply: (suspend (Boolean) -> String?)? = live?.let { send -> { allow -> send(approval.id, allow, null) } }
                                ApprovalCard(approval, answer = reply)
                            }
                        }
                        ChatStepKind.Steer -> SteerLine(step.text)
                    }
                }
                // Without text among the steps (a reply restored without them, or none yet), the
                // words follow the work; with it, only how the turn ended does.
                // How the turn ended is a quiet note (`.msg-note`); the agent's own words are text.
                if (steps.any { it.kind == ChatStepKind.Text }) {
                    bubble.note?.takeIf { it.isNotEmpty() }?.let { RichText(it, t.secondaryText, ThemeTokens.link) }
                } else if (bubble.text.isNotEmpty()) {
                    RichText(bubble.text, t.text, ThemeTokens.link)
                }
                for (text in bubble.pending) SteerLine(text, pending = true)
                val waiting = steps.filter { it.kind == ChatStepKind.Approval && it.state == ChatStepState.Waiting }
                if (bubble.live && waiting.isNotEmpty()) {
                    Text(
                        stringResource(if (waiting.any { it.questions.isNotEmpty() }) R.string.chat_waiting_answer else R.string.chat_waiting_approval),
                        style = MaterialTheme.typography.labelSmall, color = t.secondaryText,
                    )
                }
            }
            bubble.activity?.let { activity -> ActivityLine(activityText(activity)) }
        }
    }
}

/** What the turn is doing (`.msg-status`): muted words and a small dot pulsing after them. */
@Composable
private fun ActivityLine(text: String) {
    val t = AiTheme.tokens
    val still = rememberReduceMotion()
    val pulse = rememberInfiniteTransition(label = "status")
    val alpha by pulse.animateFloat(0.25f, 1f, infiniteRepeatable(tween(500), RepeatMode.Reverse), label = "dot")
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(text, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Normal, color = t.secondaryText)
        Box(Modifier.size(4.dp).alpha(if (still) 1f else alpha).clip(CircleShape).background(t.secondaryText))
    }
}

@Composable
private fun RichText(text: String, color: Color, link: Color) {
    val t = AiTheme.tokens
    val rendered = remember(text, color, link, t.dark) { inlineMarkdown(text, link = link, code = ThemeTokens.link.copy(alpha = 0.10f)) }
    // The panel's chat text: 13 px at 1.65 on a desktop; a phone reads it a little larger.
    SelectionContainer { Text(rendered, color = color, style = MaterialTheme.typography.bodyMedium.copy(fontSize = 15.sp, lineHeight = 24.sp)) }
}

@Composable
private fun ImageThumb(image: ChatImage, size: androidx.compose.ui.unit.Dp) {
    val t = AiTheme.tokens
    val bitmap = remember(image.id) { ChatImages.thumbnail(image, 256)?.asImageBitmap() }
    val shape = RoundedCornerShape(10.dp)
    Box(Modifier.size(size).clip(shape).background(Color(0x1F808080)).semantics { contentDescription = image.name }) {
        if (bitmap != null) Image(bitmap, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
    }
}

/**
 * A run of tool calls as quiet single lines: symbol, title, the call's first line. A failure turns
 * red, an unfinished call says so, and once a call ends its dot says how, red for a failure and
 * green for a success; a tap opens the full input and output.
 */
@Composable
private fun ToolRows(steps: List<ChatStep>) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        for (step in steps) ToolRow(step)
    }
}

/**
 * A run of calls from a past session folded to one line: what kind of work ran and how many calls,
 * with the calls one tap away (src/web/ChatToolRow.tsx `ToolGroup`).
 */
@Composable
private fun ToolGroup(steps: List<ChatStep>) {
    val t = AiTheme.tokens
    var open by remember(steps.first().id) { mutableStateOf(false) }
    val tint = if (open) t.text else t.secondaryText
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(
            Modifier.fillMaxWidth()
                .height(28.dp)
                .clip(RoundedCornerShape(6.dp))
                .background(if (open) t.text.copy(alpha = 0.05f) else Color.Transparent)
                .clickable { open = !open }
                .padding(start = 2.dp, end = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                if (open) Icons.Outlined.ExpandMore else Icons.Outlined.ChevronRight,
                contentDescription = null, tint = tint, modifier = Modifier.padding(end = 6.dp).size(16.dp),
            )
            Text(
                stringResource(if (ChatTools.allCommands(steps)) R.string.chat_tools_commands else R.string.chat_tools_called),
                fontSize = 13.sp, fontWeight = FontWeight.Medium, color = tint, maxLines = 1,
            )
            Text("${steps.size}", fontSize = 11.sp, color = tint.copy(alpha = tint.alpha * 0.7f), maxLines = 1, modifier = Modifier.padding(start = 6.dp))
        }
        if (open) Box(Modifier.padding(start = 22.dp, top = 2.dp, bottom = 4.dp)) { ToolRows(steps) }
    }
}

@Composable
private fun ToolRow(step: ChatStep) {
    val t = AiTheme.tokens
    var open by remember(step.id) { mutableStateOf(false) }
    val variant = ChatTools.variant(step.title)
    val title = toolTitle(variant, step.title)
    val summary = ChatTools.summary(step.text)
    val expandable = step.output.isNotEmpty() || step.text.trim() != summary
    val failed = step.state == ChatStepState.Failed
    val cue = when (step.state) {
        ChatStepState.Failed -> stringResource(R.string.chat_step_failed)
        ChatStepState.Incomplete -> stringResource(R.string.chat_step_incomplete)
        ChatStepState.Running -> stringResource(R.string.chat_step_running)
        else -> null
    }
    // `.chat-tool-row`: a 26 px line, glyph, title, dot and the call's first line; an open call's
    // line is lifted and its glyph turns into the chevron (on a touch screen there is no hover).
    val lead = if (open) t.text else t.secondaryText
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth()
                .height(28.dp)
                .clip(RoundedCornerShape(6.dp))
                .background(if (open) t.text.copy(alpha = 0.05f) else Color.Transparent)
                .clickable(enabled = expandable) { open = !open }
                .padding(start = 2.dp, end = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                if (open) Icons.Outlined.ExpandLess else toolIcon(variant), contentDescription = null, tint = lead,
                modifier = Modifier.padding(end = 6.dp).size(16.dp),
            )
            Text(title, fontSize = 13.sp, fontWeight = FontWeight.Medium, color = lead, maxLines = 1)
            if (summary.isNotEmpty()) {
                val dot = when (step.state) {
                    ChatStepState.Failed -> ThemeTokens.danger
                    ChatStepState.Succeeded -> ThemeTokens.success
                    else -> lead.copy(alpha = lead.alpha * 0.6f)
                }
                Box(Modifier.padding(horizontal = 8.dp).size(3.dp).clip(CircleShape).background(dot))
                Text(
                    summary, fontSize = 12.sp, fontFamily = FontFamily.Monospace, color = if (failed) ThemeTokens.danger else lead,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false),
                )
            }
            if (cue != null) {
                Text(
                    cue, fontSize = 11.sp, maxLines = 1, modifier = Modifier.padding(start = 8.dp),
                    color = when {
                        failed -> ThemeTokens.danger
                        step.state == ChatStepState.Incomplete -> lead.copy(alpha = lead.alpha * 0.8f)
                        else -> lead
                    },
                )
            }
        }
        if (open) {
            // `.chat-tool-io`: IN and OUT side by side with their labels, on the code colour in a hairline box.
            val shape = RoundedCornerShape(10.dp)
            Column(
                Modifier.fillMaxWidth().padding(start = 24.dp, top = 4.dp, bottom = 6.dp)
                    .clip(shape).background(t.codeBackground).border(1.dp, t.hairline, shape),
            ) {
                if (step.text.isNotEmpty()) ToolIO(stringResource(R.string.chat_step_in), step.text, t.text)
                if (step.output.isNotEmpty()) {
                    if (step.text.isNotEmpty()) HorizontalDivider(color = t.hairline)
                    ToolIO(
                        stringResource(R.string.chat_step_out), step.output, if (failed) ThemeTokens.danger else t.text,
                        note = if (step.output.length >= 12000) stringResource(R.string.chat_step_truncated) else null,
                    )
                }
            }
        }
    }
}

@Composable
private fun ToolIO(label: String, text: String, color: Color, note: String? = null) {
    val t = AiTheme.tokens
    Row(
        Modifier.fillMaxWidth().heightIn(max = 180.dp).verticalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(label, fontSize = 10.5.sp, lineHeight = 21.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.4.sp, color = t.secondaryText)
        Column(Modifier.weight(1f)) {
            SelectionContainer {
                Text(text, fontSize = 12.sp, lineHeight = 19.sp, fontFamily = FontFamily.Monospace, color = color)
            }
            if (note != null) Text(note, fontSize = 11.sp, color = t.secondaryText)
        }
    }
}

@Composable
private fun toolTitle(variant: ToolVariant, name: String): String = when (variant) {
    ToolVariant.Bash -> stringResource(R.string.chat_tool_bash)
    ToolVariant.Read -> stringResource(R.string.chat_tool_read)
    ToolVariant.Write -> stringResource(R.string.chat_tool_write)
    ToolVariant.Edit -> stringResource(R.string.chat_tool_edit)
    ToolVariant.Search -> stringResource(R.string.chat_tool_search)
    ToolVariant.Web -> stringResource(R.string.chat_tool_web)
    ToolVariant.Code -> stringResource(R.string.chat_tool_code)
    ToolVariant.Task -> stringResource(R.string.chat_tool_task)
    ToolVariant.Plan -> stringResource(R.string.chat_tool_plan)
    ToolVariant.Other -> ChatTools.title(name)
}

private fun toolIcon(variant: ToolVariant): ImageVector = when (variant) {
    ToolVariant.Bash -> Icons.Outlined.Terminal
    ToolVariant.Read -> Icons.Outlined.Description
    ToolVariant.Write, ToolVariant.Edit -> Icons.Outlined.EditNote
    ToolVariant.Search -> Icons.Outlined.Search
    ToolVariant.Web -> Icons.Outlined.Language
    ToolVariant.Code -> Icons.Outlined.Code
    ToolVariant.Task -> Icons.Outlined.AutoAwesome
    ToolVariant.Plan -> Icons.Outlined.Checklist
    ToolVariant.Other -> Icons.Outlined.Settings
}

/**
 * A question the agent asks while its turn runs: pick an option or type an answer. One question
 * with one choice goes back on the tap; otherwise the answers go back with Send. Skip answers
 * nothing and the agent goes on without it.
 */
@Composable
private fun QuestionCard(step: ChatStep, answer: (suspend (Boolean, Map<String, List<String>>?) -> String?)?) {
    val t = AiTheme.tokens
    val scope = rememberCoroutineScope()
    val questions = step.questions
    var picked by remember(step.id) { mutableStateOf<Map<String, List<String>>>(emptyMap()) }
    var typed by remember(step.id) { mutableStateOf<Map<String, String>>(emptyMap()) }
    var sending by remember(step.id) { mutableStateOf(false) }
    var error by remember(step.id) { mutableStateOf<String?>(null) }
    val waiting = step.state == ChatStepState.Waiting && answer != null
    fun answerOf(q: ChatQuestion, p: Map<String, List<String>> = picked, ty: Map<String, String> = typed): List<String> {
        val own = (ty[q.id] ?: "").trim()
        if (!q.multiSelect) return if (own.isNotEmpty()) listOf(own) else p[q.id] ?: emptyList()
        return (p[q.id] ?: emptyList()) + (if (own.isNotEmpty()) listOf(own) else emptyList())
    }
    fun all(p: Map<String, List<String>>, ty: Map<String, String>) = questions.associate { it.id to answerOf(it, p, ty) }
    fun reply(answers: Map<String, List<String>>?) {
        val send = answer ?: return
        sending = true
        error = null
        scope.launch {
            error = send(answers != null, answers)
            sending = false
        }
    }
    fun choose(q: ChatQuestion, label: String) {
        val current = picked[q.id] ?: emptyList()
        val next = picked + (q.id to if (q.multiSelect) (if (label in current) current - label else current + label) else listOf(label))
        val nextTyped = if (q.multiSelect) typed else typed + (q.id to "")
        picked = next
        typed = nextTyped
        if (questions.size == 1 && !q.multiSelect) reply(all(next, nextTyped))
    }
    val ready = questions.all { answerOf(it).isNotEmpty() }
    val status = when (step.state) {
        ChatStepState.Allowed -> stringResource(R.string.chat_question_answered)
        ChatStepState.Denied -> stringResource(R.string.chat_question_skipped)
        ChatStepState.Waiting -> stringResource(R.string.chat_waiting_state)
        else -> stringResource(R.string.chat_not_answered)
    }
    WorkCard(tone = ThemeTokens.link, waiting = waiting, fill = 0.08f, edge = 0.35f) {
        WorkHead(Icons.Outlined.HelpOutline, ThemeTokens.link, stringResource(R.string.chat_question), status, if (waiting) ThemeTokens.link else t.secondaryText)
        for (q in questions) {
            Column(Modifier.padding(top = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                if (q.header.isNotEmpty()) Text(q.header, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, color = t.secondaryText)
                if (q.question.isNotEmpty()) Text(q.question, style = MaterialTheme.typography.bodyMedium, color = t.text)
                if (waiting) {
                    for (option in q.options) {
                        val on = option.label in (picked[q.id] ?: emptyList()) && !(!q.multiSelect && (typed[q.id] ?: "").isNotBlank())
                        val optionShape = RoundedCornerShape(10.dp)
                        Column(
                            Modifier.fillMaxWidth().clip(optionShape)
                                .background(if (on) ThemeTokens.link.copy(alpha = 0.14f) else Color.Transparent)
                                .border(1.dp, if (on) ThemeTokens.link else t.secondaryText.copy(alpha = 0.3f), optionShape)
                                .clickable(enabled = !sending) { choose(q, option.label) }
                                .padding(horizontal = 12.dp, vertical = 7.dp),
                        ) {
                            Text(option.label, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = t.text)
                            if (option.description.isNotEmpty()) Text(option.description, style = MaterialTheme.typography.bodySmall, color = t.secondaryText)
                        }
                    }
                    OutlinedTextField(
                        value = typed[q.id] ?: "",
                        onValueChange = { typed = typed + (q.id to it) },
                        enabled = !sending,
                        placeholder = { Text(stringResource(if (q.options.isNotEmpty()) R.string.chat_question_other else R.string.chat_question_type)) },
                        textStyle = MaterialTheme.typography.bodyMedium,
                        singleLine = true,
                        shape = RoundedCornerShape(8.dp),
                        modifier = Modifier.fillMaxWidth(),
                    )
                } else {
                    val shown = step.answers[q.id]
                    if (!shown.isNullOrEmpty()) {
                        Text("→ " + shown.joinToString(", "), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = ThemeTokens.link)
                    }
                }
            }
        }
        if (waiting) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (questions.size > 1 || questions.any { it.multiSelect } || questions.any { (typed[it.id] ?: "").isNotBlank() }) {
                    Button(onClick = { reply(all(picked, typed)) }, enabled = !sending && ready) { Text(stringResource(R.string.chat_question_send)) }
                }
                OutlinedButton(onClick = { reply(null) }, enabled = !sending) { Text(stringResource(R.string.chat_question_skip)) }
            }
        }
        error?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = ThemeTokens.danger) }
    }
}

/** An action the agent waits on (docs/runtimes.md#live-chat): nothing is allowed without a tap. */
@Composable
private fun ApprovalCard(approval: ChatApproval, answer: (suspend (Boolean) -> String?)?) {
    val t = AiTheme.tokens
    val scope = rememberCoroutineScope()
    var sending by remember(approval.id) { mutableStateOf(false) }
    var error by remember(approval.id) { mutableStateOf<String?>(null) }
    val waiting = approval.state == ChatApprovalState.Waiting
    // Only a waiting request takes an answer, and only while its turn runs.
    val permit = if (waiting) answer else null
    val stateColor = when (approval.state) {
        ChatApprovalState.Waiting -> ThemeTokens.warning
        ChatApprovalState.Allowed -> ThemeTokens.success
        ChatApprovalState.Denied -> ThemeTokens.danger
        ChatApprovalState.Cancelled -> t.secondaryText
    }
    WorkCard(tone = ThemeTokens.warning, waiting = waiting, fill = 0.10f, edge = 0.40f) {
        WorkHead(Icons.Outlined.Shield, ThemeTokens.warning, approval.tool, approvalStateText(approval.state), stateColor)
        if (approval.title.isNotEmpty()) {
            Text(approval.title, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, color = t.text, maxLines = 4, overflow = TextOverflow.Ellipsis)
        }
        if (approval.detail.isNotEmpty()) {
            Text(approval.detail, style = MaterialTheme.typography.bodySmall, color = t.secondaryText)
        }
        if (permit != null) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = {
                        sending = true
                        error = null
                        scope.launch {
                            error = permit(true)
                            sending = false
                        }
                    },
                    enabled = !sending,
                ) { Text(stringResource(R.string.chat_allow)) }
                OutlinedButton(
                    onClick = {
                        sending = true
                        error = null
                        scope.launch {
                            error = permit(false)
                            sending = false
                        }
                    },
                    enabled = !sending,
                ) { Text(stringResource(R.string.chat_deny)) }
            }
        }
        error?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = ThemeTokens.danger) }
    }
}

@Composable
private fun approvalStateText(state: ChatApprovalState): String = when (state) {
    ChatApprovalState.Waiting -> stringResource(R.string.chat_waiting_state)
    ChatApprovalState.Allowed -> stringResource(R.string.chat_allowed)
    ChatApprovalState.Denied -> stringResource(R.string.chat_denied)
    ChatApprovalState.Cancelled -> stringResource(R.string.chat_not_answered)
}

/**
 * A card of the agent's work that waits on the person (`.chat-work`): glass without a border; while it
 * waits, tinted with [tone] and ringed in it.
 */
@Composable
private fun WorkCard(tone: Color, waiting: Boolean, fill: Float, edge: Float, content: @Composable ColumnScope.() -> Unit) {
    val t = AiTheme.tokens
    val shape = RoundedCornerShape(t.radiusSmall)
    Column(
        Modifier.fillMaxWidth().clip(shape)
            .background(if (waiting) tone.copy(alpha = fill).compositeOver(t.sheetGlass) else t.sheetGlass)
            .then(if (waiting) Modifier.border(1.dp, tone.copy(alpha = edge), shape) else Modifier)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        content = content,
    )
}

/** The head of a work card (`.chat-work-head`): its icon on a tinted square, its name, its state. */
@Composable
private fun WorkHead(icon: ImageVector, tone: Color, title: String, state: String, stateColor: Color) {
    val t = AiTheme.tokens
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(Modifier.clip(RoundedCornerShape(6.dp)).background(tone.copy(alpha = 0.14f)).padding(4.dp)) {
            Icon(icon, contentDescription = null, tint = tone, modifier = Modifier.size(14.dp))
        }
        Text(title, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = t.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        Spacer(Modifier.weight(1f))
        Text(state, fontSize = 11.sp, color = stateColor, maxLines = 1)
    }
}

/**
 * A message the person added while the turn ran (`.chat-steer`): a line in the link colour on its
 * leading edge, dashed and faded while the agent has not read it yet.
 */
@Composable
private fun SteerLine(text: String, pending: Boolean = false) {
    val t = AiTheme.tokens
    val you = stringResource(R.string.chat_you)
    val later = stringResource(R.string.chat_steer_pending)
    val line = buildAnnotatedString {
        withStyle(SpanStyle(color = ThemeTokens.link, fontWeight = FontWeight.SemiBold)) { append("↳ $you ") }
        append(text)
        if (pending) withStyle(SpanStyle(color = t.secondaryText)) { append(" · $later") }
    }
    Text(
        line, fontSize = 13.sp, lineHeight = 19.sp, color = t.text,
        modifier = Modifier.fillMaxWidth().alpha(if (pending) 0.6f else 1f)
            .drawBehind {
                val w = 2.dp.toPx()
                val x = if (layoutDirection == LayoutDirection.Rtl) size.width - w / 2 else w / 2
                drawLine(
                    ThemeTokens.link, Offset(x, 0f), Offset(x, size.height), strokeWidth = w,
                    pathEffect = if (pending) PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 3.dp.toPx())) else null,
                )
            }
            .padding(start = 12.dp, end = 10.dp, top = 6.dp, bottom = 6.dp),
    )
}

@Composable
private fun activityText(activity: ChatActivity): String = when (activity) {
    is ChatActivity.Starting -> stringResource(R.string.chat_starting)
    is ChatActivity.Reconnecting -> stringResource(R.string.chat_reconnecting)
    is ChatActivity.Thinking ->
        if (activity.model.isEmpty()) stringResource(R.string.chat_thinking) else stringResource(R.string.chat_thinking_model, activity.model)
    is ChatActivity.Running -> stringResource(R.string.chat_running, activity.tool)
}

/**
 * Inline Markdown (bold, italic, code, links) with the line breaks kept; blocks stay as written,
 * as the iOS client's `inlineOnlyPreservingWhitespace` reads it.
 */
internal fun inlineMarkdown(text: String, link: Color, code: Color): AnnotatedString = buildAnnotatedString {
    var i = 0
    val n = text.length
    while (i < n) {
        val c = text[i]
        // An escaped punctuation mark is itself.
        if (c == '\\' && i + 1 < n && text[i + 1] in "\\`*_[]()#+-.!~") {
            append(text[i + 1])
            i += 2
            continue
        }
        if (c == '`') {
            val end = text.indexOf('`', i + 1)
            if (end > i + 1) {
                withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = code)) { append(text.substring(i + 1, end)) }
                i = end + 1
                continue
            }
        }
        if ((c == '*' || c == '_') && i + 1 < n && text[i + 1] == c) {
            val marker = "$c$c"
            val end = text.indexOf(marker, i + 2)
            if (end > i + 2 && !text[i + 2].isWhitespace()) {
                withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(inlineMarkdown(text.substring(i + 2, end), link, code)) }
                i = end + 2
                continue
            }
        }
        if (c == '~' && i + 1 < n && text[i + 1] == '~') {
            val end = text.indexOf("~~", i + 2)
            if (end > i + 2) {
                withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) { append(inlineMarkdown(text.substring(i + 2, end), link, code)) }
                i = end + 2
                continue
            }
        }
        if ((c == '*' || c == '_') && i + 1 < n && !text[i + 1].isWhitespace() && (c == '*' || i == 0 || !text[i - 1].isLetterOrDigit())) {
            val end = text.indexOf(c, i + 1)
            if (end > i + 1 && !text[end - 1].isWhitespace() && text.substring(i + 1, end).none { it == '\n' }) {
                withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(inlineMarkdown(text.substring(i + 1, end), link, code)) }
                i = end + 1
                continue
            }
        }
        if (c == '[') {
            val close = text.indexOf(']', i + 1)
            if (close > i && close + 1 < n && text[close + 1] == '(') {
                val paren = text.indexOf(')', close + 2)
                val url = if (paren > close) text.substring(close + 2, paren).trim() else ""
                if (paren > close && url.isNotEmpty() && !url.contains(' ')) {
                    val label = text.substring(i + 1, close)
                    withLink(LinkAnnotation.Url(url, TextLinkStyles(style = SpanStyle(color = link, textDecoration = TextDecoration.Underline)))) {
                        append(inlineMarkdown(label, link, code))
                    }
                    i = paren + 1
                    continue
                }
            }
        }
        append(c)
        i += 1
    }
}
