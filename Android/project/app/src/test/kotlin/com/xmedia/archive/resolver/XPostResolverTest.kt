package com.xmedia.archive.resolver

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class XPostResolverTest {
    private val resolver = XPostResolver()

    @Test
    fun parsesSupportedPostUrls() {
        assertEquals("123456789", resolver.parseUrl("https://x.com/user/status/123456789").first)
        assertEquals("123456789", resolver.parseUrl("https://twitter.com/i/status/123456789").first)
        assertEquals("https://x.com/i/status/123456789", resolver.parseUrl("https://x.com/user/status/123456789").second)
    }

    @Test
    fun rejectsUnsupportedUrls() {
        assertThrows(IllegalArgumentException::class.java) {
            resolver.parseUrl("https://example.com/user/status/123456789")
        }
        assertThrows(IllegalArgumentException::class.java) {
            resolver.parseUrl("https://x.com/user/post/not-a-number")
        }
    }

    @Test
    fun ranksDirectVariantsByResolutionThenMuxedAudioVideoBitrate() {
        val variants = listOf(
            XPostResolver.VideoVariant("https://video.example/vid/avc1/1280x720/low.mp4", 1280, 720, null, 2_000_000),
            XPostResolver.VideoVariant("https://video.example/vid/avc1/1920x1080/low.mp4", 1920, 1080, 128_000, 3_000_000),
            XPostResolver.VideoVariant("https://video.example/vid/avc1/1920x1080/high.mp4", 1920, 1080, 192_000, 1_000_000),
        )

        assertEquals(
            listOf(
                "https://video.example/vid/avc1/1920x1080/high.mp4",
                "https://video.example/vid/avc1/1920x1080/low.mp4",
                "https://video.example/vid/avc1/1280x720/low.mp4",
            ),
            resolver.rankVideoCandidates(variants),
        )
    }

    @Test
    fun excludesHlsManifestsFromDirectDownloadCandidates() {
        assertTrue(resolver.isDirectMp4Variant("video/mp4", "https://video.example/file.mp4"))
        assertFalse(resolver.isDirectMp4Variant("application/x-mpegURL", "https://video.example/master.m3u8"))
    }

    @Test
    fun choosesTheHighestResolutionAcrossSupportedUrlFormats() {
        val candidates = listOf(
            XPostResolver.RawVideoVariant("video/mp4; codecs=avc1", "https://video.example/vid_1280x720.mp4", 4_000_000),
            XPostResolver.RawVideoVariant("video/mp4", "https://video.example/file.mp4?resolution=1920x1080", 1_000_000),
            XPostResolver.RawVideoVariant("video/mp4", "https://video.example/no-resolution.mp4", 9_000_000),
            XPostResolver.RawVideoVariant("video/mp4", "https://1920x1080.cdn.example/file.mp4", 10_000_000),
        )

        assertEquals(
            listOf(
                "https://video.example/file.mp4?resolution=1920x1080",
                "https://video.example/vid_1280x720.mp4",
            ),
            resolver.directVideoCandidates(candidates),
        )
    }

    @Test
    fun prefersHigherAudioBitrateBeforeMuxedBitrateAtTheSameResolution() {
        val variants = listOf(
            XPostResolver.RawVideoVariant("video/mp4", "https://video.example/vid/1920x1080/video-heavy.mp4", 5_000_000, 96_000),
            XPostResolver.RawVideoVariant("video/mp4", "https://video.example/vid/1920x1080/audio-best.mp4", 3_000_000, 192_000),
        )

        assertEquals(
            listOf(
                "https://video.example/vid/1920x1080/audio-best.mp4",
                "https://video.example/vid/1920x1080/video-heavy.mp4",
            ),
            resolver.directVideoCandidates(variants),
        )
    }
}
