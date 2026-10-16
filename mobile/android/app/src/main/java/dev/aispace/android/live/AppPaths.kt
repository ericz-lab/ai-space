package dev.aispace.android.live

import android.content.Context
import java.io.File
import java.util.UUID

/**
 * Where the app keeps its own files: saved Spaces and screens in the app's files directory, the last
 * catalogue, icons and drawn backdrops under its cache directory (the system may reclaim those). Nothing
 * here is a Space workspace. [init] runs first thing in `AISpaceApplication.onCreate`.
 */
object AppPaths {
    private lateinit var files: File
    private lateinit var cache: File

    fun init(context: Context) {
        files = context.applicationContext.filesDir
        cache = context.applicationContext.cacheDir
    }

    val connections: File get() = File(files, "connections.json")
    val screens: File get() = File(files, "screens.json")

    /** The last catalogue of each Space (CatalogueCache). */
    val caches: File get() = File(cache, "catalogues")

    /**
     * Files a page downloaded, on their way to the share sheet; emptied at launch. The FileProvider
     * (`res/xml/file_paths.xml`, cache-path `downloads/`) serves this directory and nothing else.
     */
    val downloads: File get() = File(cache, "downloads")

    fun icons(id: UUID): File = File(File(cache, "icons"), id.toString().uppercase())

    /** The themes' artwork as it was last drawn for a Space (BackdropStore). */
    fun backdrops(id: UUID): File = File(File(cache, "backdrops"), id.toString().uppercase())
}
