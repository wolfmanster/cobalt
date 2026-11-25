package com.xmedia.archive.storage

import android.provider.MediaStore
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class DownloadDestinationTest {
    @Test
    fun savesIntoDownloadsWithoutFolderPicker() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val uri = DownloadDestination.createTarget(context, "test-author/test-post", "cobalt-storage-test.txt", "text/plain")
        try {
            context.contentResolver.openOutputStream(uri)!!.use { it.write("ok".toByteArray()) }
            DownloadDestination.finishTarget(context, uri)
            context.contentResolver.query(
                uri,
                arrayOf(MediaStore.MediaColumns.RELATIVE_PATH, MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.IS_PENDING),
                null,
                null,
                null,
            )!!.use { cursor ->
                assertTrue(cursor.moveToFirst())
                assertEquals("Download/X Media Archive/test-author/test-post/", cursor.getString(0))
                assertEquals("cobalt-storage-test.txt", cursor.getString(1))
                assertEquals(0, cursor.getInt(2))
                assertFalse(cursor.moveToNext())
            }
        } finally {
            context.contentResolver.delete(uri, null, null)
        }
    }
}
