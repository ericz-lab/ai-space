package dev.aispace.android.ui.shell

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.aispace.android.AppModel
import dev.aispace.android.R
import dev.aispace.android.core.Connection
import dev.aispace.android.core.SpaceState
import dev.aispace.android.core.Urls
import dev.aispace.android.ui.theme.AiTheme
import dev.aispace.android.web.WebSession

/**
 * The Space's web panel over the pages, with a way back: the sign-in, package installs, and whatever
 * the app does not draw itself. The panel leaves its own dock, edges and hint out here (by the
 * `AISpaceMobile/` user agent, or the style the session adds for an older Space).
 */
@Composable
fun WebPanelView(model: AppModel, connection: Connection, session: WebSession) {
    val t = AiTheme.tokens
    val currentUrl by session.currentUrl.collectAsState()
    val canGoBack by session.canGoBack.collectAsState()
    BackHandler {
        if (canGoBack) session.goBack() else model.showingWebPanel = false
    }
    Column(Modifier.fillMaxSize().background(t.ground)) {
        Row(
            Modifier.fillMaxWidth().background(t.solid.copy(alpha = 0.92f)).statusBarsPadding().padding(horizontal = 4.dp, vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = { model.showingWebPanel = false }) {
                Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.shell_close), tint = t.text)
            }
            Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(stringResource(R.string.shell_web_panel), fontSize = 15.sp, fontWeight = FontWeight.SemiBold, color = t.text, maxLines = 1)
                Text(
                    currentUrl?.let { Urls.host(it) } ?: Urls.host(connection.url) ?: "",
                    fontSize = 11.sp, color = t.secondaryText, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
            IconButton(onClick = { session.reload() }) {
                Icon(Icons.Filled.Refresh, contentDescription = stringResource(R.string.shell_reload), tint = t.text)
            }
        }
        PanelView(session, Modifier.weight(1f).navigationBarsPadding().imePadding())
    }
}

/**
 * The Space's own web panel: what the browser has and the app does not draw. It is also where a
 * sign-in to the Space's access layer happens.
 */
@Composable
fun PanelView(session: WebSession, modifier: Modifier = Modifier) {
    val t = AiTheme.tokens
    val state by session.state.collectAsState()
    val currentUrl by session.currentUrl.collectAsState()
    val isLoading by session.isLoading.collectAsState()
    val progress by session.progress.collectAsState()
    val showsSpacePage = currentUrl?.let { session.hosts().contains(it) } ?: false
    Column(modifier) {
        val host = currentUrl?.let { Urls.host(it) }
        if (!showsSpacePage && host != null) SignInBar(host)
        Box(Modifier.weight(1f).fillMaxWidth()) {
            WebContainer(session, Modifier.fillMaxSize().alpha(if (state.isFailure) 0f else 1f))
            WebFailure(session, Modifier.background(t.ground))
            if (state == SpaceState.Connecting && currentUrl == null) {
                CircularProgressIndicator(Modifier.align(Alignment.Center), color = t.accent)
            }
            if (isLoading) {
                LinearProgressIndicator(
                    progress = { progress },
                    modifier = Modifier.fillMaxWidth().height(2.dp),
                    color = t.accent,
                    trackColor = Color.Transparent,
                )
            }
        }
    }
    // The panel downloads too (a theme export, an attachment).
    DownloadOutcome(session)
}
