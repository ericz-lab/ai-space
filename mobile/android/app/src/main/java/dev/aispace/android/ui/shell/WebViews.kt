package dev.aispace.android.ui.shell

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.MutableContextWrapper
import android.view.ViewGroup
import android.webkit.MimeTypeMap
import android.widget.FrameLayout
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.VpnKey
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.filled.WifiOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.FileProvider
import dev.aispace.android.R
import dev.aispace.android.core.SpaceState
import dev.aispace.android.ui.theme.AiTheme
import dev.aispace.android.web.WebSession
import java.io.File

/** The activity a context stands for, through its wrappers. */
fun Context.findActivity(): Activity? {
    var c: Context? = this
    while (c != null) {
        if (c is Activity) return c
        c = (c as? ContextWrapper)?.baseContext
    }
    return null
}

/**
 * Hosts a session's web view. The view belongs to the session, not to the composition, so it keeps its
 * page while tabs switch and the views around it are made again: it is moved into this container (out
 * of wherever it was) and taken out again when the container goes.
 */
@Composable
fun WebContainer(session: WebSession, modifier: Modifier = Modifier) {
    val web by session.views.collectAsState()
    val activity = LocalContext.current.findActivity()
    AndroidView(
        factory = { FrameLayout(it) },
        modifier = modifier,
        onRelease = { container -> container.removeAllViews() },
        update = { container ->
            if (web.parent !== container) {
                (web.parent as? ViewGroup)?.removeView(web)
                container.removeAllViews()
                // Pop-ups of the page (a <select> list, a date picker) need the activity on show.
                if (activity != null) (web.context as? MutableContextWrapper)?.baseContext = activity
                container.addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            }
        },
    )
    LaunchedEffect(session) { session.start() }
}

/** Says whose page is on show while the view is off the Space, on an access layer's sign-in. */
@Composable
fun SignInBar(host: String, modifier: Modifier = Modifier) {
    val t = AiTheme.tokens
    Row(
        modifier.fillMaxWidth().background(t.solid.copy(alpha = 0.92f)).padding(vertical = 6.dp, horizontal = 12.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Filled.VpnKey, contentDescription = null, tint = t.secondaryText, modifier = Modifier.size(14.dp))
        Spacer(Modifier.width(6.dp))
        Text(stringResource(R.string.shell_signing_in_at, host), fontSize = 13.sp, color = t.secondaryText, maxLines = 1)
    }
}

/** What a page shows in place of its content when it could not be loaded. */
@Composable
fun WebFailure(session: WebSession, modifier: Modifier = Modifier) {
    val state by session.state.collectAsState()
    val (icon, title, reason) = when (val s = state) {
        is SpaceState.Unreachable -> Triple(Icons.Filled.WifiOff, stringResource(R.string.shell_cannot_load), s.message)
        is SpaceState.Incompatible -> Triple(Icons.Filled.Warning, stringResource(R.string.shell_not_panel), s.message)
        else -> return
    }
    Unavailable(icon, title, reason, modifier) {
        Button(onClick = { session.reload() }) { Text(stringResource(R.string.shell_retry)) }
    }
}

/** An empty state: a symbol, a title, why, and what can be done. */
@Composable
fun Unavailable(icon: ImageVector, title: String, reason: String, modifier: Modifier = Modifier, actions: @Composable () -> Unit = {}) {
    val t = AiTheme.tokens
    Column(
        modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(icon, contentDescription = null, tint = t.secondaryText, modifier = Modifier.size(44.dp))
        Spacer(Modifier.height(14.dp))
        Text(
            title, fontSize = 20.sp, fontWeight = FontWeight.SemiBold, color = t.text, textAlign = TextAlign.Center,
            modifier = Modifier.semantics { heading() },
        )
        if (reason.isNotEmpty()) {
            Spacer(Modifier.height(6.dp))
            Text(reason, fontSize = 15.sp, color = t.secondaryText, textAlign = TextAlign.Center)
        }
        Spacer(Modifier.height(18.dp))
        actions()
    }
}

/**
 * What a page's download ends in, on whichever screen shows the page: the share sheet for the file
 * (through the app's FileProvider; the file is not kept), or a word on why there is none.
 */
@Composable
fun DownloadOutcome(session: WebSession) {
    val context = LocalContext.current
    val file by session.downloaded.collectAsState()
    val failure by session.downloadFailure.collectAsState()
    LaunchedEffect(file) {
        val f = file ?: return@LaunchedEffect
        session.downloaded.value = null
        share(context, f)
    }
    val reason = failure
    if (reason != null) {
        AlertDialog(
            onDismissRequest = { session.downloadFailure.value = null },
            confirmButton = { TextButton(onClick = { session.downloadFailure.value = null }) { Text(stringResource(R.string.shell_ok)) } },
            title = { Text(stringResource(R.string.shell_download_failed)) },
            text = { Text(reason) },
        )
    }
}

private fun share(context: Context, file: File) {
    val uri = try {
        FileProvider.getUriForFile(context, "${context.packageName}.files", file)
    } catch (e: IllegalArgumentException) {
        return
    }
    val type = MimeTypeMap.getSingleton().getMimeTypeFromExtension(file.extension.lowercase()) ?: "application/octet-stream"
    val send = Intent(Intent.ACTION_SEND)
        .setType(type)
        .putExtra(Intent.EXTRA_STREAM, uri)
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    val chooser = Intent.createChooser(send, file.name)
    if (context.findActivity() == null) chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
        context.startActivity(chooser)
    } catch (e: ActivityNotFoundException) {
        // Nothing on the phone takes a file; the download is dropped as an unshared one would be.
    }
}

/** The system share sheet for an address. */
fun shareLink(context: Context, url: String) {
    val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, url)
    val chooser = Intent.createChooser(send, null)
    if (context.findActivity() == null) chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
        context.startActivity(chooser)
    } catch (e: ActivityNotFoundException) {
    }
}
