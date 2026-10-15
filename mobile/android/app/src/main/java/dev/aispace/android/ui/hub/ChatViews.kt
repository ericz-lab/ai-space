package dev.aispace.android.ui.hub

import androidx.compose.foundation.background
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowCircleUp
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.StopCircle
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
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
import dev.aispace.android.core.ChatRoute
import dev.aispace.android.core.Connection
import dev.aispace.android.core.Reach
import dev.aispace.android.live.CatalogueLoader
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

    LaunchedEffect(store) { if (store.isRunning) store.loadSessions() }
    LaunchedEffect(running) { if (!running) store.loadSessions() }
    // The end of the conversation stays in view as the reply grows.
    LaunchedEffect(bubbles.size, bubbles.lastOrNull()?.text) {
        // The intro (when there are no messages), the bubbles, then the end.
        listState.scrollToItem((if (bubbles.isEmpty()) 1 else 0) + bubbles.size)
    }

    HubScaffold(
        agent.displayTitle(),
        actions = {
            Box {
                IconButton(onClick = { menu = true }, enabled = !running) {
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
                items(bubbles, key = { it.id }) { ChatBubble(it) }
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
            Row(
                Modifier.fillMaxWidth().background(t.solid.copy(alpha = 0.9f)).padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.Bottom,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
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
                } else {
                    val canSend = draft.trim().isNotEmpty()
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

@Composable
private fun ChatBubble(bubble: ChatStore.Bubble) {
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
            if (bubble.tools.isNotEmpty()) {
                Text(bubble.tools.takeLast(6).joinToString(" · "), style = MaterialTheme.typography.labelSmall, color = t.secondaryText, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            if (bubble.text.isNotEmpty()) {
                val color = if (bubble.isUser) Color.White else t.text
                val rendered = remember(bubble.text, color) {
                    inlineMarkdown(bubble.text, link = if (bubble.isUser) Color.White else ThemeTokens.link, code = t.hairline)
                }
                SelectionContainer { Text(rendered, color = color) }
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
