package com.xmedia.archive.data

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ArchiveSearchTest {
    private lateinit var database: ArchiveDatabase
    private lateinit var dao: ArchiveDao

    @Before
    fun createDatabase() {
        database = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), ArchiveDatabase::class.java).build()
        dao = database.dao()
    }

    @After
    fun closeDatabase() = database.close()

    @Test
    fun authorsGroupByStableIdAndSearchOldNames() = runBlocking {
        dao.upsertJob(job("old", "42", "old_handle", "旧名字", "旧正文", "2026-01-01"))
        dao.upsertJob(job("new", "42", "new_handle", "新名字", "中文正文", "2026-01-02"))
        dao.upsertJob(job("missing", null, null, null, null, "2026-01-03"))
        dao.upsertJob(job("failed", "42", "old_handle", "旧名字", "中文正文", "2026-01-04", "failed"))

        assertEquals(2, dao.authorCount(""))
        assertEquals(1, dao.authorCount("旧名字"))
        assertEquals(1, dao.authorCount("old_handle"))
        assertEquals(1, dao.authorCount("new_handle"))
        assertEquals(2, dao.listAuthors("", 0, 25).size)
        assertEquals(2, dao.listAuthors("old_handle", 0, 25).single().tweetCount)
        assertEquals("new_handle", dao.latestCompletedByAuthor("id:42")?.username)
        assertEquals("missing", dao.latestCompletedByAuthor("unknown")?.id)
        assertNull(dao.latestCompletedByAuthor("id:999"))
    }

    @Test
    fun downloadedPostsSearchAllPagesAndExcludeFailed() = runBlocking {
        repeat(130) { index ->
            dao.upsertJob(job("post-$index", "42", "writer", "作者", if (index == 0) "中文正文" else "post text", "2026-01-${(index / 30 + 1).toString().padStart(2, '0')}"))
        }
        dao.upsertJob(job("failed", "42", "writer", "作者", "中文正文", "2026-09-01", "failed"))

        assertEquals(130, dao.downloadedPostCount("id:42", ""))
        assertEquals(25, dao.listDownloadedPosts("id:42", "", 100, 25).size)
        assertEquals(5, dao.listDownloadedPosts("id:42", "", 125, 25).size)
        assertEquals(1, dao.downloadedPostCount(null, "中文"))
        assertEquals("post-0", dao.listDownloadedPosts(null, "中文", 0, 25).single().id)
        assertEquals(0, dao.downloadedPostCount(null, "不存在"))
    }

    private fun job(
        id: String,
        userId: String?,
        username: String?,
        authorName: String?,
        text: String?,
        date: String,
        status: String = "completed",
    ) = JobEntity(
        id = id,
        tweetId = id,
        sourceUrl = "https://x.com/example/status/$id",
        canonicalUrl = "https://x.com/example/status/$id",
        status = status,
        authorName = authorName,
        username = username,
        userId = userId,
        text = text,
        createdAt = "${date}T00:00:00Z",
        updatedAt = "${date}T00:00:00Z",
        completedAt = if (status == "completed") "${date}T00:00:00Z" else null,
    )
}
