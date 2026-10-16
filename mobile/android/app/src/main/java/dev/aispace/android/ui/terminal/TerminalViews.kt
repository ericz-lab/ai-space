package dev.aispace.android.ui.terminal

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.History
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.aispace.android.R
import dev.aispace.android.core.HubFormat
import dev.aispace.android.core.TerminalMachine
import dev.aispace.android.core.TerminalRecent
import dev.aispace.android.live.TerminalSession
import dev.aispace.android.live.TerminalStore
import dev.aispace.android.live.TerminalTab
import dev.aispace.android.terminal.TerminalPalette
import dev.aispace.android.terminal.TerminalSurface
import dev.aispace.android.ui.hub.Cell
import dev.aispace.android.ui.hub.Dot
import dev.aispace.android.ui.hub.Header
import dev.aispace.android.ui.hub.HubList
import dev.aispace.android.ui.hub.HubNotice
import dev.aispace.android.ui.hub.HubScaffold
import dev.aispace.android.ui.hub.group
import dev.aispace.android.ui.hub.groupItems
import dev.aispace.android.ui.theme.AiTheme
import dev.aispace.android.ui.theme.ThemeTokens
import kotlinx.coroutines.delay

/**
 * The Space's terminal: a shell on the Space's machine or on a peer, one tab per session, drawn
 * by the phone over the routes the panel's page uses (docs/terminal.md). The Space decides what
 * runs; the phone sends keystrokes and the window size. The shell's window is the area above the
 * keyboard (the surface pads for the IME itself), so the size the Space is told is what is seen.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun TerminalPage(store: TerminalStore) {
    LaunchedEffect(store) { store.refresh() }
    val tab = store.currentTab
    val dark = AiTheme.tokens.dark
    var adding by remember { mutableStateOf(false) }
    val machines = store.machines
    HubScaffold(
        stringResource(R.string.terminal_title),
        actions = {
            if (store.tabs.isNotEmpty()) {
                IconButton(onClick = { store.showingRecent = true }) {
                    Icon(Icons.Filled.History, contentDescription = stringResource(R.string.terminal_recent))
                }
            }
            Box {
                IconButton(onClick = { adding = true }, enabled = machines.any { it.canOpen }) {
                    Icon(Icons.Filled.Add, contentDescription = stringResource(R.string.terminal_new_session))
                }
                DropdownMenu(expanded = adding, onDismissRequest = { adding = false }) {
                    for (machine in machines) {
                        DropdownMenuItem(
                            text = { Text(machineLabel(machine)) },
                            onClick = {
                                adding = false
                                store.open(machine)
                            },
                            enabled = machine.canOpen,
                        )
                    }
                }
            }
        },
    ) { padding ->
        if (tab != null) {
            Column(
                Modifier.fillMaxSize()
                    .background(Color(TerminalPalette.ground(dark)))
                    .padding(padding)
                    .consumeWindowInsets(padding),
            ) {
                TabStrip(store)
                // A surface per tab: each keeps its own emulator and scrollback in its session.
                TerminalSurface(tab.screen, dark, Modifier.weight(1f).fillMaxWidth())
            }
            LaunchedEffect(tab.id) {
                // The view is in place after this frame.
                delay(150)
                tab.focus()
            }
        } else {
            TerminalStart(store, padding)
        }
    }
    if (store.showingRecent) RecentSheet(store)
    store.asking?.let { ask -> PassphraseDialog(store, ask) }
}

/** The page before a session is open: where a shell can start, and what ran before. */
@Composable
private fun TerminalStart(store: TerminalStore, padding: androidx.compose.foundation.layout.PaddingValues) {
    val machines = store.machines
    val loaded = store.loaded
    val recent = store.status?.recent ?: emptyList()
    HubList(padding, onRefresh = { store.refresh() }) {
        group(
            key = "machines",
            headerContent = { Header(stringResource(R.string.terminal_open_on)) },
            footer = {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (loaded && machines.none { it.canOpen }) Text(stringResource(R.string.terminal_none_enabled))
                    Text(stringResource(R.string.terminal_about))
                }
            },
        ) {
            HubNotice(store)
            for (machine in machines) {
                Cell(onClick = { store.open(machine) }, enabled = machine.canOpen) {
                    Dot(if (machine.canOpen) ThemeTokens.success else AiTheme.tokens.secondaryText)
                    Text(machine.name, color = AiTheme.tokens.text, modifier = Modifier.weight(1f))
                    Text(machineState(machine), style = MaterialTheme.typography.bodyMedium, color = AiTheme.tokens.secondaryText)
                }
            }
        }
        recentRows(recent)
    }
}

@Composable
private fun machineState(machine: TerminalMachine): String = when {
    machine.isDown -> stringResource(R.string.terminal_offline)
    machine.enabled -> stringResource(R.string.terminal_on)
    else -> stringResource(R.string.terminal_off)
}

@Composable
private fun machineLabel(machine: TerminalMachine): String =
    if (machine.canOpen) machine.name else "${machine.name} (${machineState(machine)})"

/** The Space's audit rows for its own machine: when a session ran and how it ended. */
private fun LazyListScope.recentRows(recent: List<TerminalRecent>) {
    if (recent.isEmpty()) return
    groupItems(recent, key = { "recent:${it.id}" }, headerContent = { Header(stringResource(R.string.terminal_recent)) }) { row ->
        Cell {
            Dot(if (row.isOpen) ThemeTokens.success else AiTheme.tokens.secondaryText)
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(HubFormat.relative(row.started), color = AiTheme.tokens.text)
                Text(recentDetail(row), style = MaterialTheme.typography.bodySmall, color = AiTheme.tokens.secondaryText)
            }
        }
    }
}

@Composable
private fun recentDetail(row: TerminalRecent): String {
    val seconds = row.duration ?: return stringResource(R.string.terminal_state_open)
    val parts = arrayListOf(HubFormat.duration(seconds * 1000))
    val reason = row.reason
    when (reason) {
        "exit" -> parts.add(row.exitCode?.let { stringResource(R.string.terminal_exit_code, it) } ?: stringResource(R.string.terminal_ended_signal))
        "closed" -> parts.add(stringResource(R.string.terminal_client_left))
        "idle" -> parts.add(stringResource(R.string.terminal_idle))
        "killed" -> parts.add(stringResource(R.string.terminal_killed))
        "lost" -> parts.add(stringResource(R.string.terminal_lost))
        null -> {}
        else -> parts.add(reason ?: "")
    }
    return parts.joinToString(" · ")
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RecentSheet(store: TerminalStore) {
    val state = rememberModalBottomSheetState()
    LaunchedEffect(Unit) { store.refresh() }
    ModalBottomSheet(onDismissRequest = { store.showingRecent = false }, sheetState = state, containerColor = AiTheme.tokens.ground) {
        Text(
            stringResource(R.string.terminal_recent),
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold,
            color = AiTheme.tokens.text,
            modifier = Modifier.align(Alignment.CenterHorizontally).padding(bottom = 8.dp),
        )
        val recent = store.status?.recent ?: emptyList()
        LazyColumn(Modifier.fillMaxWidth().navigationBarsPadding()) {
            if (recent.isEmpty()) group(key = "none") { HubNotice(store) }
            recentRows(recent)
        }
    }
}

/** One chip per session: a dot for its state, its name, and a way to end it. */
@Composable
private fun TabStrip(store: TerminalStore) {
    val t = AiTheme.tokens
    Row(
        Modifier.fillMaxWidth()
            .background(t.solid)
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 10.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        for (tab in store.tabs) {
            TabChip(tab, tab.session, selected = tab.id == store.current, select = { store.current = tab.id }, close = { store.close(tab) })
        }
    }
}

@Composable
private fun TabChip(tab: TerminalTab, session: TerminalSession, selected: Boolean, select: () -> Unit, close: () -> Unit) {
    val t = AiTheme.tokens
    val colour = when (session.state) {
        TerminalSession.State.connecting -> ThemeTokens.warning
        TerminalSession.State.open -> ThemeTokens.success
        TerminalSession.State.closed -> t.secondaryText
    }
    val state = when (session.state) {
        TerminalSession.State.connecting -> stringResource(R.string.terminal_state_connecting)
        TerminalSession.State.open -> stringResource(R.string.terminal_state_open)
        TerminalSession.State.closed -> stringResource(R.string.terminal_state_closed)
    }
    Row(
        Modifier.clip(RoundedCornerShape(50)).background(if (selected) t.ground else t.hairline),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            Modifier.clickable(onClick = select)
                .semantics { stateDescription = state }
                .padding(start = 10.dp, top = 5.dp, bottom = 5.dp, end = 2.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Dot(colour, size = 7.dp)
            Text(
                tab.title,
                style = MaterialTheme.typography.bodySmall,
                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                color = t.text,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        IconButton(onClick = close, modifier = Modifier.size(30.dp)) {
            Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.terminal_end_session), tint = t.secondaryText, modifier = Modifier.size(14.dp))
        }
        Spacer(Modifier.size(2.dp))
    }
}

/** The machine asks for its passphrase before a shell opens; it is kept in memory only. */
@Composable
private fun PassphraseDialog(store: TerminalStore, ask: TerminalStore.Ask) {
    AlertDialog(
        onDismissRequest = {
            store.passphraseDraft = ""
            store.asking = null
        },
        title = { Text(stringResource(R.string.terminal_passphrase_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(
                    ask.message?.let { "${ask.machine.name}: $it" }
                        ?: stringResource(R.string.terminal_passphrase_ask, ask.machine.name),
                )
                OutlinedTextField(
                    value = store.passphraseDraft,
                    onValueChange = { store.passphraseDraft = it },
                    label = { Text(stringResource(R.string.terminal_passphrase)) },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Go),
                    keyboardActions = KeyboardActions(onGo = { store.submit(ask.machine) }),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = {
            TextButton(onClick = { store.submit(ask.machine) }) { Text(stringResource(R.string.terminal_open)) }
        },
        dismissButton = {
            TextButton(onClick = {
                store.passphraseDraft = ""
                store.asking = null
            }) { Text(stringResource(R.string.hub_cancel)) }
        },
    )
}
