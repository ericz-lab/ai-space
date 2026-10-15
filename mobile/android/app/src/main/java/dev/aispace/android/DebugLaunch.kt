package dev.aispace.android

import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log
import dev.aispace.android.core.ChatRoute
import dev.aispace.android.core.ConnectionRules
import dev.aispace.android.core.DeepLink
import dev.aispace.android.ui.theme.Appearance

/**
 * Launch switches of a debug build, for reaching screens without touching the device (iOS
 * DebugLaunch.swift). They are intent extras, so adb can set them:
 *
 *     adb shell am start -n dev.aispace.android/.MainActivity --es aispace.tab settings
 *
 *   aispace.connect      add this Space when none is saved (aispace.connect_name its name)
 *   aispace.tab          home | panel | settings, or web for the Space's web panel over them
 *   aispace.screen       the screen on show, by id; aispace.edit_screen=1 opens its editor
 *   aispace.screen_menu  1 opens the actions a long press on a screen brings up
 *   aispace.search       the search text on Home
 *   aispace.hub          a page of the Space: inbox | tasks | modelUsage | appUsage | appModels | events |
 *                        packages | terminal | chat, or chat:<agent key>
 *   aispace.chat_send    with aispace.hub=chat:<agent key>: this message is sent three seconds later
 *   aispace.open_url     an aispace:// link, handled as if another app had opened it
 *   aispace.sign_out     1 signs the selected Space out two seconds later
 *   aispace.log_external 1 logs the addresses that would go to the browser instead of opening them
 *   aispace.app_menu     1 opens the app page's menu, for layout checks
 *   aispace.page_js      a script run in the open app page three seconds later
 *   aispace.style        light | dark (saved, as the Settings choice is)
 *   aispace.theme        a theme's id, for this launch only
 *
 * Left out: the window PNG and quitting (use `adb exec-out screencap -p`), the scroll bench, the layer
 * audit and the terminal typing switch (the terminal store has no typing entry point for it).
 * Nothing here runs in a release build: MainActivity calls it only when BuildConfig.DEBUG.
 */
object DebugLaunch {
    private const val TAG = "ai-space"

    private var appMenu = false

    /** Whether the next app page opens with its menu showing; true once per launch switch. */
    fun takeAppMenu(): Boolean = appMenu.also { appMenu = false }

    fun apply(model: AppModel, intent: Intent?) {
        if (!BuildConfig.DEBUG || intent == null) return
        val extras = intent.extras ?: return
        fun s(name: String): String? = extras.getString("aispace.$name")
        if (extras.keySet().none { it.startsWith("aispace.") }) return
        val later = Handler(Looper.getMainLooper())

        s("connect")?.let { address ->
            if (model.store.connections.value.isEmpty()) {
                runCatching { ConnectionRules.normalize(address) }.getOrNull()?.let { model.add(s("connect_name") ?: "", it) }
            }
        }
        s("screen")?.let { screen ->
            model.pagerID = screen
            if (s("edit_screen") == "1") model.editingScreen = screen
        }
        if (s("screen_menu") == "1") model.showingScreenMenu = true
        s("theme")?.let { model.overrideTheme(it) }
        s("style")?.let { model.updateAppearance(if (it == "dark") Appearance.Dark else Appearance.Light) }
        s("search")?.let { model.query = it }
        if (s("app_menu") == "1") appMenu = true
        val hub = s("hub")
        s("chat_send")?.let { message ->
            val key = hub?.takeIf { it.startsWith("chat:") }?.removePrefix("chat:") ?: return@let
            later.postDelayed({
                val c = model.selected ?: return@postDelayed
                val agent = model.loader(c).catalogue.value?.agents?.firstOrNull { it.key == key } ?: return@postDelayed
                val base = ChatRoute.base(agent.ref, agent.peer) ?: return@postDelayed
                val chat = model.chat(c, base)
                chat.draft.value = message
                chat.send()
            }, 3000)
        }
        hub?.let {
            model.hubPage = when (it) {
                "inbox" -> HubPage.Inbox
                "tasks" -> HubPage.Tasks
                "modelUsage" -> HubPage.ModelUsage
                "appUsage" -> HubPage.AppUsage
                "appModels" -> HubPage.AppModels
                "events" -> HubPage.Events
                "packages" -> HubPage.Packages
                "terminal" -> HubPage.Terminal
                "chat" -> HubPage.Chat(null)
                else -> if (it.startsWith("chat:")) HubPage.Chat(it.removePrefix("chat:")) else null
            }
        }
        when (s("tab")) {
            "home" -> model.tab = MainTab.Home
            "panel" -> model.tab = MainTab.Panel
            "settings" -> model.tab = MainTab.Settings
            "web" -> model.openWebPanel()
        }
        if (s("log_external") == "1") model.openInBrowser = { Log.i(TAG, "to the browser $it") }
        s("page_js")?.let { js ->
            later.postDelayed({
                model.page?.session?.webView?.evaluateJavascript(js) { Log.i(TAG, "page script: $it") }
            }, 3000)
        }
        s("open_url")?.let { text -> DeepLink.parse(text)?.let { model.handle(it) } }
        if (s("sign_out") == "1") {
            later.postDelayed({ model.selected?.let { model.signOut(it) } }, 2000)
        }
    }
}
