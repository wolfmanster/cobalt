package com.xmedia.archive.resolver

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
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
}
