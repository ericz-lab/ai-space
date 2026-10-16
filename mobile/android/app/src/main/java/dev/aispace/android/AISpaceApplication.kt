package dev.aispace.android

import android.app.Application
import dev.aispace.android.live.AppPaths
import dev.aispace.android.live.CatalogueLoader

/** Holds the one [AppModel] of the process, so a recreated activity finds its Spaces, tabs and shells. */
class AISpaceApplication : Application() {
    lateinit var model: AppModel
        private set

    override fun onCreate() {
        super.onCreate()
        AppPaths.init(this)
        CatalogueLoader.notASpaceText = getString(R.string.shell_not_ai_space_response)
        model = AppModel(this)
    }
}
