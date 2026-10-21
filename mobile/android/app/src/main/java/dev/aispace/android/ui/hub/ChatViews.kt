package dev.aispace.android.ui.hub

import androidx.activity.compose.rememberLauncherForActivityResult
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
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
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
import androidx.compose.material.icons.filled.ArrowCircleUp
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.StopCircle
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.outlined.AddPhotoAlternate
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.Checklist
import androidx.compose.material.icons.outlined.Code
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
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
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
import dev.aispace.android.core.Reach
import dev.aispace.android.live.CatalogueLoader
import dev.aispace.android.live.ChatImages
import dev.aispace.android.live.ChatStore
import dev.aispace.android.live.IconImages
import dev.aispace.android.ui.common.EntryIcon
import dev.aispace.android.ui.theme.AiTheme
import dev.aispace.android.ui.theme.ThemeTokens
import kotlinx.coroutines.launch

/** The agents of the Space, each leading to its conversation. */
@Composable
internal fun AgentsPage(model: AppModel, connection: Connection, loader: CatalogueLoader, icons: IconImages) {
    val nav = LocalHubNav.current
    val catalogue by loader.catalogue.collectAsState()
    val listState = rememberLazyListState()
    val top = nav.top
    if (top is HubDest.Agent) {
        val agent = catalogue?.agents?.firstOrNull { it.key == top.key }
        val base = agent?.let { ChatRoute.base(it.ref, it.peer) }
        if (agent != null && base != null) {
            ChatPage(agent, model.chat(connection, base), icons)
            return
        }
    }
    HubScaffold(stringResource(R.string.hub_chat)) { padding ->
        val agents = catalogue?.agents ?: emptyList()
        HubList(padding, onRefresh = { loader.refresh() }, state = listState) {
            if (agents.isEmpty()) group(key = "none") { NoteCell(stringResource(R.string.hub_no_agents)) }
            groupItems(agents.filter { ChatRoute.base(it.ref, it.peer) != null }, key = { "agent:${it.key}" }) { agent ->
                Cell(onClick = { nav.push(HubDest.Agent(agent.key)) }, enabled = agent.reach != Reach.peerOffline, chevron = true) {
                    EntryIcon(agent.icon, Icons.Filled.Person, icons, size = 40.dp, isRound = true)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(agent.displayTitle(), color = AiTheme.tokens.text)
                        agent.displayDetail()?.let {
                            Text(it, style = MaterialTheme.typography.bodySmall, color = AiTheme.tokens.secondaryText, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
        }
    }
}

/**
 * One agent's conversation: the messages, the reply as it streams in, and the field to write in.
 * The model and the permission mode are the agent's defaults; the web panel's chat can pick them.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun ChatPage(agent: CatalogueEntry, store: ChatStore, icons: IconImages) {
    val scope = rememberCoroutineScope()
    val t = AiTheme.tokens
    val draft by store.draft.collectAsState()
    val bubbles = store.bubbles
    val running = store.isRunning
    val listState = rememberLazyListState()
    var menu by remember { mutableStateOf(false) }
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

    HubScaffold(
        agent.displayTitle(),
        actions = {
            Box {
                IconButton(onClick = { menu = true }, enabled = !running && reading == 0) {
                    Icon(Icons.Filled.History, contentDescription = stringResource(R.string.chat_chats))
                }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.chat_new)) },
                        leadingIcon = { Icon(Icons.Filled.Edit, contentDescription = null) },
                        onClick = {
                            menu = false
                            store.newChat()
                        },
                    )
                    val sessions = store.sessions
                    if (sessions.isNotEmpty()) {
                        HorizontalDivider()
                        Text(
                            stringResource(R.string.chat_earlier),
                            style = MaterialTheme.typography.labelMedium,
                            color = t.secondaryText,
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                        )
                        for (session in sessions.take(20)) {
                            DropdownMenuItem(
                                text = { Text(session.title?.takeIf { it.isNotEmpty() }?.take(60) ?: session.sid, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                                onClick = {
                                    menu = false
                                    scope.launch { store.open(session) }
                                },
                            )
                        }
                    }
                }
            }
        },
    ) { padding ->
        Column(
            Modifier.fillMaxSize()
                .padding(padding)
                .consumeWindowInsets(padding)
                .imePadding(),
        ) {
            LazyColumn(
                Modifier.weight(1f).fillMaxWidth(),
                state = listState,
                contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 14.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
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
                    modifier = Modifier.padding(horizontal = 14.dp).padding(bottom = 6.dp),
                )
            }
            store.imageError?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodySmall,
                    color = ThemeTokens.danger,
                    modifier = Modifier.padding(horizontal = 14.dp).padding(bottom = 6.dp),
                )
            }
            if (store.images.isNotEmpty()) {
                Row(
                    Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 6.dp),
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
            Row(
                Modifier.fillMaxWidth().background(t.solid.copy(alpha = 0.9f)).padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.Bottom,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                IconButton(
                    onClick = { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
                    enabled = reading == 0 && store.images.size < ChatImage.MAX_COUNT,
                ) {
                    Icon(Icons.Outlined.AddPhotoAlternate, contentDescription = stringResource(R.string.chat_add_images), tint = t.secondaryText)
                }
                OutlinedTextField(
                    value = draft,
                    onValueChange = { store.draft.value = it },
                    placeholder = { Text(stringResource(R.string.chat_message)) },
                    maxLines = 6,
                    shape = RoundedCornerShape(18.dp),
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedContainerColor = t.solid,
                        unfocusedContainerColor = t.solid,
                        focusedBorderColor = t.accent,
                        unfocusedBorderColor = t.hairline,
                    ),
                    modifier = Modifier.weight(1f),
                )
                if (running) {
                    IconButton(onClick = { store.stop() }) {
                        Icon(Icons.Filled.StopCircle, contentDescription = stringResource(R.string.chat_stop), tint = ThemeTokens.danger, modifier = Modifier.size(32.dp))
                    }
                }
                // A message written during a turn joins it; Send stays beside Stop while the field
                // has something to add.
                if (!running || draft.isNotBlank() || store.images.isNotEmpty()) {
                    val canSend = store.canSend && reading == 0
                    IconButton(onClick = { store.send() }, enabled = canSend) {
                        Icon(
                            Icons.Filled.ArrowCircleUp,
                            contentDescription = stringResource(R.string.chat_send),
                            tint = if (canSend) t.accent else t.secondaryText,
                            modifier = Modifier.size(32.dp),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun Intro(agent: CatalogueEntry, icons: IconImages) {
    Column(
        Modifier.fillMaxWidth().padding(top = 40.dp, start = 20.dp, end = 20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        EntryIcon(agent.icon, Icons.Filled.Person, icons, size = 64.dp, isRound = true)
        Text(agent.displayTitle(), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, color = AiTheme.tokens.text)
        agent.displayDetail()?.let {
            Text(it, style = MaterialTheme.typography.bodyMedium, color = AiTheme.tokens.secondaryText, textAlign = TextAlign.Center)
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ChatBubble(bubble: ChatStore.Bubble, answer: (suspend (String, Boolean, Map<String, List<String>>?) -> String?)?) {
    val t = AiTheme.tokens
    val shape = RoundedCornerShape(16.dp)
    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (bubble.isUser) Arrangement.End else Arrangement.Start) {
        if (bubble.isUser) Spacer(Modifier.size(40.dp, 1.dp))
        Column(
            Modifier.weight(1f, fill = false)
                .clip(shape)
                .background(if (bubble.isUser) t.accent else t.solid)
                .then(if (bubble.isUser) Modifier else Modifier.hairline(t.hairline, shape))
                .padding(horizontal = 12.dp, vertical = 9.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (bubble.isUser) {
                if (bubble.images.isNotEmpty()) {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        for (image in bubble.images) ImageThumb(image, 88.dp)
                    }
                }
                if (bubble.text.isNotEmpty()) RichText(bubble.text, Color.White, Color.White)
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
                val words = if (steps.any { it.kind == ChatStepKind.Text }) bubble.note else bubble.text
                if (!words.isNullOrEmpty()) RichText(words, t.text, ThemeTokens.link)
                for (text in bubble.pending) SteerLine(text, pending = true)
                val waiting = steps.filter { it.kind == ChatStepKind.Approval && it.state == ChatStepState.Waiting }
                if (bubble.live && waiting.isNotEmpty()) {
                    Text(
                        stringResource(if (waiting.any { it.questions.isNotEmpty() }) R.string.chat_waiting_answer else R.string.chat_waiting_approval),
                        style = MaterialTheme.typography.labelSmall, color = t.secondaryText,
                    )
                }
            }
            bubble.activity?.let { activity ->
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp, color = t.secondaryText)
                    Text(activityText(activity), style = MaterialTheme.typography.bodySmall, color = t.secondaryText)
                }
            }
        }
        if (!bubble.isUser) Spacer(Modifier.size(24.dp, 1.dp))
    }
}

@Composable
private fun RichText(text: String, color: Color, link: Color) {
    val t = AiTheme.tokens
    val rendered = remember(text, color, link) { inlineMarkdown(text, link = link, code = t.hairline) }
    SelectionContainer { Text(rendered, color = color) }
}

@Composable
private fun ImageThumb(image: ChatImage, size: androidx.compose.ui.unit.Dp) {
    val t = AiTheme.tokens
    val bitmap = remember(image.id) { ChatImages.thumbnail(image, 256)?.asImageBitmap() }
    val shape = RoundedCornerShape(8.dp)
    Box(Modifier.size(size).clip(shape).background(t.hairline).semantics { contentDescription = image.name }) {
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
                .clip(RoundedCornerShape(6.dp))
                .clickable { open = !open }
                .padding(vertical = 3.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(
                if (open) Icons.Outlined.ExpandMore else Icons.Outlined.ChevronRight,
                contentDescription = null, tint = tint, modifier = Modifier.size(15.dp),
            )
            Text(
                stringResource(if (ChatTools.allCommands(steps)) R.string.chat_tools_commands else R.string.chat_tools_called),
                style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = tint, maxLines = 1,
            )
            Text("${steps.size}", style = MaterialTheme.typography.labelSmall, color = t.secondaryText.copy(alpha = 0.7f), maxLines = 1)
        }
        if (open) Box(Modifier.padding(start = 21.dp)) { ToolRows(steps) }
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
    val tint = if (failed) ThemeTokens.danger else t.secondaryText
    val cue = when (step.state) {
        ChatStepState.Failed -> stringResource(R.string.chat_step_failed)
        ChatStepState.Incomplete -> stringResource(R.string.chat_step_incomplete)
        ChatStepState.Running -> stringResource(R.string.chat_step_running)
        else -> null
    }
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth()
                .clip(RoundedCornerShape(6.dp))
                .clickable(enabled = expandable) { open = !open }
                .padding(vertical = 3.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(toolIcon(variant), contentDescription = null, tint = tint, modifier = Modifier.size(15.dp))
            Text(title, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = tint, maxLines = 1)
            if (summary.isNotEmpty()) {
                val dot = when (step.state) {
                    ChatStepState.Failed -> ThemeTokens.danger
                    ChatStepState.Succeeded -> ThemeTokens.success
                    else -> tint.copy(alpha = 0.6f)
                }
                Box(Modifier.size(3.dp).clip(CircleShape).background(dot))
                Text(
                    summary, style = MaterialTheme.typography.labelMedium, fontFamily = FontFamily.Monospace, color = tint,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false),
                )
            }
            if (cue != null) Text(cue, style = MaterialTheme.typography.labelSmall, color = tint, maxLines = 1)
            Spacer(Modifier.weight(1f))
            if (expandable) {
                Icon(if (open) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, contentDescription = null, tint = t.secondaryText, modifier = Modifier.size(16.dp))
            }
        }
        if (open) {
            val shape = RoundedCornerShape(8.dp)
            Column(
                Modifier.fillMaxWidth().clip(shape).background(t.ground).padding(8.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                if (step.text.isNotEmpty()) ToolIO(stringResource(R.string.chat_step_in), step.text, t.text)
                if (step.output.isNotEmpty()) {
                    ToolIO(stringResource(R.string.chat_step_out), step.output, if (failed) ThemeTokens.danger else t.text)
                    if (step.output.length >= 12000) {
                        Text(stringResource(R.string.chat_step_truncated), style = MaterialTheme.typography.labelSmall, color = t.secondaryText)
                    }
                }
            }
        }
    }
}

@Composable
private fun ToolIO(label: String, text: String, color: Color) {
    val t = AiTheme.tokens
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, color = t.secondaryText)
        SelectionContainer {
            Text(text, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, color = color)
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
    val shape = RoundedCornerShape(10.dp)
    Column(
        Modifier.fillMaxWidth().clip(shape).background(t.ground)
            .then(Modifier.hairline(if (waiting) ThemeTokens.link.copy(alpha = 0.5f) else t.hairline, shape))
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Icon(Icons.Outlined.HelpOutline, contentDescription = null, tint = ThemeTokens.link, modifier = Modifier.size(16.dp))
            Text(stringResource(R.string.chat_question), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, color = t.text)
            Spacer(Modifier.weight(1f))
            Text(status, style = MaterialTheme.typography.labelSmall, color = if (waiting) ThemeTokens.link else t.secondaryText)
        }
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
    val shape = RoundedCornerShape(10.dp)
    Column(
        Modifier.fillMaxWidth().clip(shape).background(t.ground).then(Modifier.hairline(t.hairline, shape))
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Icon(Icons.Outlined.Shield, contentDescription = null, tint = t.accent, modifier = Modifier.size(16.dp))
            Text(approval.tool, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, color = t.text)
            Spacer(Modifier.weight(1f))
            Text(approvalStateText(approval.state), style = MaterialTheme.typography.labelSmall, color = t.secondaryText)
        }
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

/** A message the person added while the turn ran, waiting for the agent to read it or already read. */
@Composable
private fun SteerLine(text: String, pending: Boolean = false) {
    val t = AiTheme.tokens
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.Top) {
        Text(stringResource(R.string.chat_you), style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, color = t.text)
        if (text.isNotEmpty()) {
            Text(text, style = MaterialTheme.typography.bodySmall, color = t.text)
        }
        if (pending) {
            Text(stringResource(R.string.chat_steer_pending), style = MaterialTheme.typography.labelSmall, color = t.secondaryText)
        }
    }
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
