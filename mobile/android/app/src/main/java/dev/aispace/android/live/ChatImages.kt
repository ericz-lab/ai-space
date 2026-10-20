package dev.aispace.android.live

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import dev.aispace.android.core.ChatImage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream

/**
 * Reads a picked photo as an image for an agent turn. PNG, JPEG, GIF and WebP go as they are; any
 * other format (a phone's HEIC) or a photo over 5 MB is drawn again as a JPEG no wider than 2,048
 * px, so the Space's limits hold without the person resizing it.
 */
object ChatImages {
    private const val MAX_READ = 40 * 1024 * 1024
    private const val LONG_SIDE = 2048

    suspend fun read(context: Context, uri: Uri): ChatImage? = withContext(Dispatchers.IO) {
        try {
            val resolver = context.contentResolver
            val name = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) c.getString(0) else null
            } ?: "image"
            val bytes = resolver.openInputStream(uri)?.use { input ->
                val out = ByteArrayOutputStream()
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val n = input.read(buffer)
                    if (n < 0) break
                    out.write(buffer, 0, n)
                    if (out.size() > MAX_READ) return@withContext null
                }
                out.toByteArray()
            } ?: return@withContext null
            val type = ChatImage.mediaType(bytes)
            if (type != null && bytes.size <= ChatImage.MAX_BYTES) return@withContext ChatImage(name.take(80), type, bytes)
            val jpeg = reencode(bytes) ?: return@withContext null
            ChatImage(name.substringBeforeLast('.').take(80) + ".jpg", "image/jpeg", jpeg)
        } catch (e: Exception) {
            null
        }
    }

    private fun reencode(bytes: ByteArray): ByteArray? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= LONG_SIDE) sample *= 2
        val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
            ?: return null
        val long = maxOf(decoded.width, decoded.height)
        val bitmap = if (long > LONG_SIDE) {
            val scale = LONG_SIDE.toFloat() / long
            Bitmap.createScaledBitmap(decoded, (decoded.width * scale).toInt().coerceAtLeast(1), (decoded.height * scale).toInt().coerceAtLeast(1), true)
        } else {
            decoded
        }
        var quality = 88
        while (true) {
            val out = ByteArrayOutputStream()
            bitmap.compress(Bitmap.CompressFormat.JPEG, quality, out)
            if (out.size() <= ChatImage.MAX_BYTES || quality <= 40) return out.toByteArray().takeIf { it.size <= ChatImage.MAX_BYTES }
            quality -= 16
        }
    }

    /** A small picture of the image for the field and the message, decoded at about [size] px. */
    fun thumbnail(image: ChatImage, size: Int): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(image.bytes, 0, image.bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (minOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= size) sample *= 2
        return BitmapFactory.decodeByteArray(image.bytes, 0, image.bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
    }
}
