package dev.aispace.android.core

import java.io.File
import java.io.IOException
import java.util.UUID
import java.util.concurrent.Callable
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * The last catalogue answers of each Space, one file per connection in the app's caches.
 * It holds what the panel showed (titles, links, widget rows), never a cookie or a token.
 *
 * Every read and write goes through one serial background queue, shared by all caches, so
 * [saveInBackground] keeps its order and [load]/[remove] drain the writes queued before them:
 * a sign-out cannot be undone by a write still waiting.
 */
class CatalogueCache(val directory: File) {
    fun file(connection: UUID): File = File(directory, "catalogue-${connection.toString().uppercase()}.json")

    fun load(connection: UUID): CataloguePayload? = io.submit(Callable<CataloguePayload?> {
        TextFiles.read(file(connection))?.let { text -> Json.obj(text)?.let { CataloguePayload.from(it) } }
    }).get()

    fun save(payload: CataloguePayload, connection: UUID) {
        io.submit(Runnable { write(payload, connection) }).get()
    }

    /** Queues the write in order; [load] and [remove] wait for it. */
    fun saveInBackground(payload: CataloguePayload, connection: UUID) {
        io.execute(Runnable { write(payload, connection) })
    }

    fun remove(connection: UUID) {
        io.submit(Runnable { file(connection).delete() }).get()
    }

    private fun write(payload: CataloguePayload, connection: UUID) {
        try {
            TextFiles.writeAtomically(file(connection), payload.toJson().toString())
        } catch (e: IOException) {
            // A cache that cannot be written is only a slower next launch.
        }
    }

    private companion object {
        val io: ExecutorService = Executors.newSingleThreadExecutor { r ->
            Thread(r, "ai-space-catalogue-cache").apply { isDaemon = true }
        }
    }
}
