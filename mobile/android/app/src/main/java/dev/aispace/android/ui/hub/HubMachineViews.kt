package dev.aispace.android.ui.hub

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import dev.aispace.android.core.CliInfo
import dev.aispace.android.core.ISO8601
import dev.aispace.android.core.Inventory
import dev.aispace.android.core.MachineInventory
import dev.aispace.android.core.SpaceApi
import dev.aispace.android.core.Times
import dev.aispace.android.live.MachineClisStore
import dev.aispace.android.ui.theme.AiTheme
import dev.aispace.android.ui.theme.ThemeTokens
import kotlinx.coroutines.launch

/**
 * Settings → Models → AI CLIs by machine (src/web/MachineClis.tsx): which agent CLIs each machine
 * has, its version, whether it is signed in and which runtime uses it. The panel's table is one card
 * per machine here. A CLI found on the Space's own machine that no runtime uses can be added to
 * runtimes.yaml; a peer's is only shown, it is changed there.
 */
@Composable
internal fun MachineClisPage(api: SpaceApi) {
    val scope = rememberCoroutineScope()
    val store = remember(api) { MachineClisStore(api, scope) }
    LaunchedEffect(store) { store.refresh() }
    HubScaffold(stringResource(R.string.clis_title)) { padding ->
        val machines = store.machines
        HubList(padding, onRefresh = { store.refresh() }) {
            group(key = "notice", footer = { Text(stringResource(R.string.clis_help)) }) {
                HubNotice(store)
                store.added?.let { NoteCell(stringResource(R.string.clis_added, it)) }
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    val checked = Inventory.lastChecked(machines)?.let { ISO8601.parse(it) }
                    Text(
                        checked?.let { stringResource(R.string.clis_checked, Times.ago(it)) } ?: "",
                        style = MaterialTheme.typography.bodySmall, color = AiTheme.tokens.secondaryText, modifier = Modifier.weight(1f),
                    )
                    OutlinedButton(enabled = !store.isSaving, onClick = { scope.launch { store.recheck() } }) {
                        Text(stringResource(if (store.isSaving) R.string.clis_checking else R.string.clis_recheck))
                    }
                }
            }
            val names = Inventory.cliNames(machines)
            for (m in machines) {
                group(key = "machine:${m.machine}", headerContent = { MachineHead(m) }) {
                    Column(Modifier.alpha(if (m.isOff) 0.6f else 1f)) {
                        if (m.old == true) {
                            NoteCell(stringResource(R.string.clis_old))
                        } else {
                            for (name in names) {
                                CliRow(name, m.cli(name), canAdd = m.cli(name)?.let { m.canAdd(it, store.pending) } == true, busy = store.isSaving) { kind ->
                                    scope.launch { store.add(kind) }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/** The machine's name, and how it is reached or why its figures are not live. */
@Composable
private fun MachineHead(m: MachineInventory) {
    val name = m.machine.ifEmpty { stringResource(R.string.chat_this_machine) }
    val note = when (m.note) {
        MachineInventory.Note.None -> null
        MachineInventory.Note.Ssh -> "ssh"
        MachineInventory.Note.Peer -> stringResource(R.string.clis_peer)
        MachineInventory.Note.Unreachable -> stringResource(R.string.clis_unreachable)
        MachineInventory.Note.Offline -> stringResource(R.string.clis_offline)
        MachineInventory.Note.Old -> stringResource(R.string.clis_old)
    }
    Header(listOfNotNull(name, note).joinToString(" · "))
}

/** One CLI on one machine: its version, whether it is signed in, and the runtime that uses it, or Add. */
@Composable
private fun CliRow(name: String, c: CliInfo?, canAdd: Boolean, busy: Boolean, add: (String) -> Unit) {
    val t = AiTheme.tokens
    Cell {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(name, color = t.text, fontWeight = FontWeight.Medium)
                val version = if (c?.installed == true) c.version else null
                if (version != null) {
                    Text(version, style = MaterialTheme.typography.bodySmall, color = t.secondaryText, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            val state = c?.state ?: CliInfo.State.Unknown
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                when (state) {
                    CliInfo.State.SignedIn -> Dot(ThemeTokens.success)
                    CliInfo.State.SignedOut -> Dot(ThemeTokens.warning)
                    else -> {}
                }
                Text(
                    stringResource(
                        when (state) {
                            CliInfo.State.Unknown, CliInfo.State.Installed -> R.string.clis_unknown
                            CliInfo.State.Missing -> R.string.clis_missing
                            CliInfo.State.SignedIn -> R.string.clis_signed_in
                            CliInfo.State.SignedOut -> R.string.clis_signed_out
                        },
                    ),
                    style = MaterialTheme.typography.bodySmall, color = t.secondaryText,
                )
            }
            if (c != null && c.installed == true) {
                when {
                    c.configured -> Text(stringResource(R.string.clis_runtime, c.runtimes.joinToString(", ")), style = MaterialTheme.typography.bodySmall, color = t.secondaryText)
                    !canAdd -> Text(stringResource(R.string.clis_not_configured), style = MaterialTheme.typography.bodySmall, color = t.secondaryText)
                }
            }
            listOfNotNull(c?.path, c?.detail).filter { it.isNotEmpty() }.takeIf { it.isNotEmpty() }?.let {
                Text(it.joinToString(" · "), style = MaterialTheme.typography.labelSmall, color = t.secondaryText, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
        if (canAdd && c != null) {
            OutlinedButton(enabled = !busy, onClick = { add(c.kind) }) { Text(stringResource(R.string.clis_add), maxLines = 1) }
        }
    }
}
