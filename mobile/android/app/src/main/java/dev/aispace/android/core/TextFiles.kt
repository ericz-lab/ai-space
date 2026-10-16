package dev.aispace.android.core

import java.io.File
import java.io.IOException
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/** Small files written whole: a temporary file next to the target, then moved over it. */
object TextFiles {
    fun read(file: File): String? = try {
        if (file.isFile) file.readText(StandardCharsets.UTF_8) else null
    } catch (e: IOException) {
        null
    }

    @Throws(IOException::class)
    fun writeAtomically(file: File, text: String) {
        val dir = file.absoluteFile.parentFile
        if (dir != null && !dir.isDirectory && !dir.mkdirs() && !dir.isDirectory) throw IOException("cannot create $dir")
        val tmp = File(dir, ".${file.name}.${System.nanoTime()}.tmp")
        try {
            tmp.writeText(text, StandardCharsets.UTF_8)
            try {
                Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
            } catch (e: Exception) {
                Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING)
            }
        } finally {
            if (tmp.exists()) tmp.delete()
        }
    }
}
