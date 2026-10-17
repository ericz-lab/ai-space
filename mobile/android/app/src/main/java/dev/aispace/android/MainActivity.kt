package dev.aispace.android

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.WebChromeClient
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import dev.aispace.android.ui.shell.RootView
import dev.aispace.android.web.SpaceProfile
import dev.aispace.android.web.WebHost

/**
 * The one activity. It draws [RootView] edge to edge, hands `aispace://` links and launcher shortcuts to
 * the model, and serves the web pages' file pickers and permission prompts ([WebHost]). System back is
 * handled where it applies: an app page goes back in the page and then closes, a cover closes, a sheet
 * closes, the pager returns to the first screen.
 */
class MainActivity : ComponentActivity(), WebHost.Host {
    private val model: AppModel get() = (application as AISpaceApplication).model

    private var filesDone: ((Array<Uri>?) -> Unit)? = null
    private var permissionsDone: ((Map<String, Boolean>) -> Unit)? = null

    private val files = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val done = filesDone
        filesDone = null
        done?.invoke(WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data))
    }

    private val permissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        val done = permissionsDone
        permissionsDone = null
        done?.invoke(result)
    }

    override val activity: android.app.Activity get() = this

    override fun chooseFiles(intent: Intent, done: (Array<Uri>?) -> Unit) {
        // One picker at a time: an earlier one still waiting is answered "nothing chosen".
        filesDone?.invoke(null)
        filesDone = done
        try {
            files.launch(intent)
        } catch (e: RuntimeException) {
            filesDone = null
            done(null)
        }
    }

    override fun requestPermissions(permissions: Array<String>, done: (Map<String, Boolean>) -> Unit) {
        permissionsDone?.invoke(emptyMap())
        permissionsDone = done
        this.permissions.launch(permissions)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // The page's own background shows behind the navigation bar (0bbbb62), not a scrim.
            window.isNavigationBarContrastEnforced = false
        }
        WebHost.attach(this)
        setContent { RootView(model) }
        // WebView loads once the first frame is drawn, not before it (SpaceProfile.warmUp).
        window.decorView.post { window.decorView.post { SpaceProfile.warmUp() } }
        if (savedInstanceState == null) receive(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        receive(intent)
    }

    private fun receive(intent: Intent?) {
        if (BuildConfig.DEBUG) DebugLaunch.apply(model, intent)
        model.handle(intent)
    }

    override fun onResume() {
        super.onResume()
        model.setUsageActive(true)
        model.becameActive()
    }

    override fun onPause() {
        model.setUsageActive(false)
        super.onPause()
    }

    override fun onDestroy() {
        WebHost.detach(this)
        filesDone?.invoke(null)
        filesDone = null
        permissionsDone?.invoke(emptyMap())
        permissionsDone = null
        super.onDestroy()
    }
}
