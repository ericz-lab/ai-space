package dev.aispace.android.ui.common

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.StopCircle
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import dev.aispace.android.R
import dev.aispace.android.core.SpaceApi
import dev.aispace.android.live.OmniboxVoice
import dev.aispace.android.ui.theme.AiTheme
import dev.aispace.android.ui.theme.ThemeTokens

/**
 * Voice input for a text field of [api]'s Space (the command box, the chat's message field): asks
 * the Space whether it can transcribe, and ends the recording when the app leaves the screen or
 * the field goes, so the microphone is never held in the background.
 */
@Composable
internal fun rememberVoice(api: SpaceApi): OmniboxVoice {
    val scope = rememberCoroutineScope()
    val voice = remember { OmniboxVoice(scope) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) voice.cancel() }
        lifecycle.addObserver(observer)
        onDispose {
            lifecycle.removeObserver(observer)
            voice.cancel()
        }
    }
    LaunchedEffect(api) {
        voice.cancel()
        voice.check(api)
    }
    return voice
}

/**
 * The microphone of a field: a tap records (asking for the permission first), a second tap stops,
 * and a spinner shows while the last words are transcribed. [prefix] is the field's text when
 * recording starts, [language] the code VoiceLanguage chose; what is said goes to [deliver], never
 * submitted. Nothing shows while the Space cannot transcribe. A failure is an alert.
 */
@Composable
internal fun VoiceButton(
    voice: OmniboxVoice,
    api: SpaceApi,
    prefix: () -> String,
    language: () -> String,
    deliver: (String) -> Unit,
    modifier: Modifier = Modifier,
    tint: Color = AiTheme.tokens.text,
    size: Dp = 24.dp,
) {
    val context = LocalContext.current
    val microphone = stringResource(R.string.omnibox_voice_microphone)
    val toggle = { voice.toggle(api, prefix(), language(), deliver) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) toggle() else voice.error = microphone
    }
    val listening = voice.recording || voice.starting
    when {
        voice.transcribing -> CircularProgressIndicator(modifier.size(size - 4.dp), strokeWidth = 2.dp, color = AiTheme.tokens.secondaryText)
        voice.available || voice.busy -> Icon(
            if (listening) Icons.Filled.StopCircle else Icons.Filled.Mic,
            contentDescription = stringResource(if (listening) R.string.omnibox_stop_recording else R.string.omnibox_voice),
            tint = if (listening) ThemeTokens.danger else tint,
            modifier = modifier.size(size).clip(RoundedCornerShape(size / 2)).clickable {
                val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
                if (voice.busy || granted) toggle() else permission.launch(Manifest.permission.RECORD_AUDIO)
            },
        )
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
