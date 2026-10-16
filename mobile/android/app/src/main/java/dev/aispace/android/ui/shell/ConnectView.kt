package dev.aispace.android.ui.shell

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Error
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.aispace.android.AppModel
import dev.aispace.android.BuildConfig
import dev.aispace.android.R
import dev.aispace.android.core.ConnectionRules
import dev.aispace.android.core.ConnectionUrlError
import dev.aispace.android.core.ConnectionUrlException
import dev.aispace.android.ui.theme.AiTheme
import dev.aispace.android.ui.theme.Backdrop
import dev.aispace.android.ui.theme.Logo
import dev.aispace.android.ui.theme.ThemeTokens
import dev.aispace.android.ui.theme.glass

/**
 * Add a Space by the address of its panel. Nothing is installed or started; the app only opens a
 * Space that already runs.
 */
@Composable
fun ConnectView(model: AppModel, isFirst: Boolean, modifier: Modifier = Modifier) {
    val t = AiTheme.tokens
    val context = LocalContext.current
    var address by rememberSaveable { mutableStateOf("") }
    var name by rememberSaveable { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }

    fun message(e: ConnectionUrlError): String = context.getString(
        when (e) {
            ConnectionUrlError.empty -> R.string.shell_error_empty
            ConnectionUrlError.invalid -> R.string.shell_error_invalid
            ConnectionUrlError.unsupportedScheme -> R.string.shell_error_scheme
            ConnectionUrlError.credentials -> R.string.shell_error_credentials
            ConnectionUrlError.insecureRemote -> R.string.shell_error_insecure
        },
    )

    fun connect() {
        val url = try {
            ConnectionRules.normalize(address).also { error = null }
        } catch (e: ConnectionUrlException) {
            error = message(e.error)
            return
        } catch (e: Exception) {
            error = context.getString(R.string.shell_error_invalid)
            return
        }
        if (model.store.connections.value.any { ConnectionRules.sameOrigin(it.url, url) }) {
            error = context.getString(R.string.shell_error_saved)
            return
        }
        model.add(name, url)
    }

    Box(modifier.fillMaxSize()) {
        Backdrop()
        Column(
            Modifier
                .fillMaxSize()
                .safeDrawingPadding()
                .imePadding()
                .verticalScroll(rememberScrollState()),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            if (!isFirst) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp)) {
                    TextButton(onClick = { model.showingAdd = false }) { Text(stringResource(R.string.shell_cancel)) }
                }
            }
            Column(
                Modifier.widthIn(max = 480.dp).fillMaxWidth().padding(horizontal = 24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(18.dp),
            ) {
                Spacer(Modifier.height(if (isFirst) 48.dp else 12.dp))
                Logo(size = 84.dp)
                Text(stringResource(R.string.shell_connect_title), fontSize = 22.sp, fontWeight = FontWeight.SemiBold, color = t.text)
                Text(
                    stringResource(R.string.shell_connect_intro),
                    fontSize = 15.sp, color = t.secondaryText, textAlign = TextAlign.Center,
                )
                val addressLabel = stringResource(R.string.shell_connect_address_label)
                val colors = TextFieldDefaults.colors(
                    focusedContainerColor = Color.Transparent,
                    unfocusedContainerColor = Color.Transparent,
                    focusedIndicatorColor = Color.Transparent,
                    unfocusedIndicatorColor = Color.Transparent,
                    focusedTextColor = t.text,
                    unfocusedTextColor = t.text,
                    cursorColor = t.accent,
                )
                Column(Modifier.fillMaxWidth().glass()) {
                    TextField(
                        value = address,
                        onValueChange = { address = it },
                        placeholder = { Text("space.example.com") },
                        singleLine = true,
                        colors = colors,
                        keyboardOptions = KeyboardOptions(
                            capitalization = KeyboardCapitalization.None,
                            keyboardType = KeyboardType.Uri,
                            imeAction = ImeAction.Go,
                        ),
                        keyboardActions = KeyboardActions(onGo = { connect() }),
                        modifier = Modifier.fillMaxWidth().semantics { contentDescription = addressLabel },
                    )
                    HorizontalDivider(color = t.hairline)
                    TextField(
                        value = name,
                        onValueChange = { name = it },
                        placeholder = { Text(stringResource(R.string.shell_connect_name_hint)) },
                        singleLine = true,
                        colors = colors,
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Go),
                        keyboardActions = KeyboardActions(onGo = { connect() }),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                error?.let { text ->
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Filled.Error, contentDescription = null, tint = ThemeTokens.danger, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.size(6.dp))
                        Text(text, fontSize = 13.sp, color = ThemeTokens.danger)
                    }
                }
                Button(
                    onClick = { connect() },
                    shape = RoundedCornerShape(t.radiusSmall),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(stringResource(R.string.shell_connect_button), fontSize = 17.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(vertical = 6.dp))
                }
                if (BuildConfig.DEBUG) {
                    // A Space on the computer the phone is plugged into, through `adb reverse tcp:8700 tcp:8700`.
                    TextButton(onClick = { address = ConnectionRules.localDefault }) {
                        Text(stringResource(R.string.shell_connect_local, ConnectionRules.localDefault), fontSize = 13.sp)
                    }
                }
                Spacer(Modifier.height(24.dp))
            }
        }
    }
}
