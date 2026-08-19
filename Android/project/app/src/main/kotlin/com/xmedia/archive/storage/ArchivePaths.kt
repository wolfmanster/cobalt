package com.xmedia.archive.storage

import com.xmedia.archive.resolver.ResolvedMetadata
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter

object ArchivePaths {
    private const val ROOT = "Download/X Media Archive"
    private val chinaTime = ZoneId.of("Asia/Shanghai")

    fun postDirectory(metadata: ResolvedMetadata, tweetId: String): String {
        val author = sanitize("${metadata.authorName}@${metadata.username}", tweetId)
        val date = publishedDate(metadata.publishedAt)
        val text = sanitize(metadata.text.ifBlank { tweetId }, tweetId, 140)
        val post = sanitize("${date}_${text}_${tweetId}", "${date}_${tweetId}_${tweetId}")
        return "$author/$post"
    }

    fun defaultDirectory(metadata: ResolvedMetadata, tweetId: String): String = "$ROOT/${postDirectory(metadata, tweetId)}"

    fun mediaFilename(filename: String, kind: String, position: Int): String {
        val extension = filename.substringAfterLast('.', "")
            .lowercase()
            .takeIf { it.matches(Regex("[a-z0-9]{2,5}")) }
            ?: if (kind == "video") "mp4" else "jpg"
        val suffix = if (kind == "video") "vdo" else "pic"
        return "${position + 1}-$suffix.$extension"
    }

    private fun publishedDate(value: String): String {
        val instant = runCatching { Instant.parse(value) }
            .recoverCatching { ZonedDateTime.parse(value, DateTimeFormatter.RFC_1123_DATE_TIME).toInstant() }
            .getOrNull()
        return instant?.atZone(chinaTime)?.toLocalDate()?.toString() ?: "unknown-date"
    }

    private fun sanitize(value: String, fallback: String, maxLength: Int = 180): String {
        var segment = value
            .replace(Regex("[\\u0000-\\u001F\\u007F-\\u009F]"), "")
            .replace(Regex("[<>:\"/\\\\|?*]"), "_")
            .trim()
            .replace(Regex("[. ]+$"), "")
        if (segment.isBlank()) segment = fallback
        if (segment.matches(Regex("(?i)CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]"))) segment = "_$segment"
        segment = segment.take(maxLength).replace(Regex("[. ]+$"), "")
        return segment.ifBlank { fallback }
    }
}
