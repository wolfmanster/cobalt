package com.xmedia.archive.storage

import com.xmedia.archive.resolver.ResolvedMetadata
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ArchivePathsTest {
    private val metadata = ResolvedMetadata(
        authorName = "A/B",
        username = "animal_kyawa_",
        userId = "1",
        avatarUrl = "",
        text = "hello world",
        language = "en",
        publishedAt = "2026-08-18T16:02:03.000Z",
    )

    @Test
    fun buildsDesktopCompatibleArchivePath() {
        assertEquals(
            "A_B@animal_kyawa_/2026-08-19_hello world_1234567890",
            ArchivePaths.postDirectory(metadata, "1234567890"),
        )
    }

    @Test
    fun namesMediaByPositionAndKind() {
        assertEquals("1-pic.jpg", ArchivePaths.mediaFilename("source.jpg", "image", 0))
        assertEquals("2-vdo.mp4", ArchivePaths.mediaFilename("source.mp4", "video", 1))
    }

    @Test
    fun limitsChinesePostDirectoryByUtf8BytesAndPreservesTweetId() {
        val tweetId = "2090069323121586210"
        val path = ArchivePaths.postDirectory(metadata.copy(text = "中文目录".repeat(100)), tweetId)
        val postSegment = path.substringAfter('/')

        assertTrue(postSegment.toByteArray(Charsets.UTF_8).size <= 200)
        assertTrue(postSegment.endsWith("_$tweetId"))
    }

    @Test
    fun doesNotSplitUnicodeCodePointsWhenTruncating() {
        val tweetId = "2090069323121586210"
        val path = ArchivePaths.postDirectory(metadata.copy(text = "😀".repeat(100)), tweetId)
        val postSegment = path.substringAfter('/')

        assertTrue(postSegment.toByteArray(Charsets.UTF_8).size <= 200)
        assertTrue(postSegment.endsWith("_$tweetId"))
        assertFalse(postSegment.contains('\uFFFD'))
    }
}
