package dev.aispace.android.web

import android.content.Intent
import android.net.Uri
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout

/**
 * What a web page needs from the activity on show: a window to draw in, a file picker, the runtime
 * permission prompt. Sessions outlive activities (they belong to AppModel, so a rotation keeps the
 * pages), so they reach the activity through here. MainActivity attaches itself in onCreate and
 * detaches in onDestroy; a request made while no activity is there is answered "no", never left hanging.
 */
object WebHost {
    interface Host {
        val activity: android.app.Activity

        /** Starts the picker [intent]; [done] gets the chosen files, or null when cancelled. */
        fun chooseFiles(intent: Intent, done: (Array<Uri>?) -> Unit)

        /** Asks for the runtime [permissions]; [done] gets each one's answer. */
        fun requestPermissions(permissions: Array<String>, done: (Map<String, Boolean>) -> Unit)
    }

    var current: Host? = null
        private set

    /** Called when a host attaches, so drawings waiting for a window can start. */
    private val waiting = ArrayList<() -> Unit>()

    fun attach(host: Host) {
        current = host
        val run = ArrayList(waiting)
        waiting.clear()
        run.forEach { it() }
    }

    fun detach(host: Host) {
        if (current === host) current = null
    }

    val activity: android.app.Activity? get() = current?.activity?.takeUnless { it.isFinishing || it.isDestroyed }

    /** Runs [block] once an activity is attached (at once when one is). */
    fun whenAttached(block: () -> Unit) {
        if (activity != null) block() else waiting.add(block)
    }

    /**
     * Puts a web view that draws offscreen into the activity's window, behind the app's content: a web
     * view outside a window may never paint. It stays at full opacity: a faded view also fades the
     * snapshot taken of it (the iOS "SVG rendering regression"). False when there is no window.
     */
    fun attachOffscreen(view: View, width: Int, height: Int): Boolean {
        val content = activity?.findViewById<ViewGroup>(android.R.id.content) ?: return false
        (view.parent as? ViewGroup)?.removeView(view)
        view.alpha = 1f
        content.addView(view, 0, FrameLayout.LayoutParams(width, height))
        return true
    }

    fun detachOffscreen(view: View) {
        (view.parent as? ViewGroup)?.removeView(view)
    }
}
