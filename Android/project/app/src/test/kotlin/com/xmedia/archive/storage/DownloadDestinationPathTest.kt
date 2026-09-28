package com.xmedia.archive.storage

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class DownloadDestinationPathTest {
    @Test
    fun acceptsDownloadRootAndNestedFolders() {
        assertEquals("Download", DownloadDestination.normalizeSubfolder(" "))
        assertEquals("Download", DownloadDestination.normalizeSubfolder("Download"))
        assertEquals("Download/X Media Archive/收藏", DownloadDestination.normalizeSubfolder(" X Media Archive/收藏 "))
        assertEquals("Download/收藏", DownloadDestination.normalizeSubfolder("download/收藏"))
    }

    @Test
    fun rejectsUnsafeSegments() {
        listOf("../other", "a//b", "a/", "a\\b", "a: b", "a/.").forEach { path ->
            assertThrows(IllegalArgumentException::class.java) {
                DownloadDestination.normalizeSubfolder(path)
            }
        }
    }
}
