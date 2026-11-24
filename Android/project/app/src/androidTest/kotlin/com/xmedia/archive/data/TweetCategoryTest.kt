package com.xmedia.archive.data

import android.database.sqlite.SQLiteDatabase
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.xmedia.archive.repository.ArchiveRepository
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class TweetCategoryTest {
    private lateinit var database: ArchiveDatabase
    private lateinit var dao: ArchiveDao
    private lateinit var repository: ArchiveRepository

    @Before
    fun createDatabase() {
        database = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), ArchiveDatabase::class.java).build()
        dao = database.dao()
        repository = ArchiveRepository(ApplicationProvider.getApplicationContext(), dao)
    }

    @After
    fun closeDatabase() = database.close()

    @Test
    fun trimsNamesAndRejectsCaseInsensitiveDuplicates() = runBlocking {
        val category = repository.createTweetCategory("  Travel  ")
        assertEquals("Travel", category.getString("name"))
        try {
            repository.createTweetCategory(" travel ")
            throw AssertionError("Expected duplicate category name to fail")
        } catch (expected: IllegalArgumentException) {
            assertEquals("分类名已存在", expected.message)
        }
        try {
            repository.createTweetCategory("   ")
            throw AssertionError("Expected blank category name to fail")
        } catch (expected: IllegalArgumentException) {
            assertEquals("分类名需为 1–30 个字符", expected.message)
        }
        val other = repository.createTweetCategory("摄影").getString("id")
        try {
            repository.renameTweetCategory(other, " travel ")
            throw AssertionError("Expected rename to reject duplicate category name")
        } catch (expected: IllegalArgumentException) {
            assertEquals("分类名已存在", expected.message)
        }
    }

    @Test
    fun multiCategoryAssignmentsAreTweetScopedAndBatchRemovalPreservesOtherCategories() = runBlocking {
        dao.upsertJob(job("copy-a", "tweet-1"))
        dao.upsertJob(job("copy-b", "tweet-1"))
        dao.upsertJob(job("other", "tweet-2"))
        val travel = repository.createTweetCategory("旅行").getString("id")
        val photos = repository.createTweetCategory("摄影").getString("id")
        val saved = repository.createTweetCategory("稍后整理").getString("id")

        repository.updateTweetCategories(listOf("tweet-1", "tweet-2"), listOf(travel, photos, saved), emptyList())
        repository.updateTweetCategories(listOf("tweet-1"), emptyList(), listOf(travel))
        val assignments = repository.tweetCategoryAssignments(listOf("tweet-1", "tweet-2")).getJSONObject("assignments")

        assertEquals(setOf(photos, saved), jsonStrings(assignments.getJSONArray("tweet-1")))
        assertEquals(setOf(travel, photos, saved), jsonStrings(assignments.getJSONArray("tweet-2")))
        assertEquals(2, dao.listDownloadedPosts(null, photos, "", 0, 25).size)
        assertEquals(2, dao.downloadedPostCount(null, photos, ""))
    }

    @Test
    fun deletingCategoryCascadesAssignmentsAndClearingHistoryKeepsCategories() = runBlocking {
        dao.upsertJob(job("done", "tweet-done"))
        dao.upsertJob(job("queued", "tweet-active", status = "queued"))
        val category = repository.createTweetCategory("收藏").getString("id")
        repository.updateTweetCategories(listOf("tweet-done", "tweet-active"), listOf(category), emptyList())

        assertTrue(repository.deleteTweetCategory(category))
        assertEquals(0, repository.tweetCategoryAssignments(listOf("tweet-done")).getJSONObject("assignments").getJSONArray("tweet-done").length())

        val persistent = repository.createTweetCategory("长期保留").getString("id")
        repository.updateTweetCategories(listOf("tweet-done"), listOf(persistent), emptyList())
        assertEquals(1, repository.clearHistory())
        assertEquals(1, repository.categoriesJson().getJSONArray("categories").length())
        assertEquals(0, repository.tweetCategoryAssignments(listOf("tweet-done")).getJSONObject("assignments").getJSONArray("tweet-done").length())
        assertEquals("长期保留", repository.categoriesJson().getJSONArray("categories").getJSONObject(0).getString("name"))
    }

    @Test
    fun categorySearchAndUncategorizedCountsUseTheSameFiltersAsTheirPages() = runBlocking {
        repeat(27) { index -> dao.upsertJob(job("post-$index", "tweet-$index", text = if (index == 4) "日落海边" else "旅行记录")) }
        dao.upsertJob(job("failed", "failed-tweet", status = "failed", text = "日落海边"))
        val category = repository.createTweetCategory("旅行").getString("id")
        repository.updateTweetCategories((0..25).map { "tweet-$it" }, listOf(category), emptyList())

        assertEquals(26, dao.downloadedPostCount(null, category, "旅行"))
        assertEquals(1, dao.listDownloadedPosts(null, category, "海边", 0, 25).size)
        assertEquals(1, dao.downloadedPostCount(null, category, "海边"))
        assertEquals(1, dao.downloadedPostCount(null, "__uncategorized__", "旅行"))
        assertEquals(25, dao.listDownloadedPosts(null, "__uncategorized__", "旅行", 0, 25).size)
        assertEquals(1, dao.listDownloadedPosts(null, "__uncategorized__", "旅行", 25, 25).size)
    }

    @Test
    fun categoryAndTweetAssignmentsSurviveDatabaseReopen() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val name = "archive-category-persistence-test.db"
        context.deleteDatabase(name)
        var persistent = Room.databaseBuilder(context, ArchiveDatabase::class.java, name)
            .addMigrations(ArchiveDatabase.MIGRATION_1_2)
            .build()
        val persistentRepository = ArchiveRepository(context, persistent.dao())
        persistent.dao().upsertJob(job("persisted-job", "persisted-tweet"))
        val categoryId = persistentRepository.createTweetCategory("持久分类").getString("id")
        persistentRepository.updateTweetCategories(listOf("persisted-tweet"), listOf(categoryId), emptyList())
        persistent.close()

        persistent = Room.databaseBuilder(context, ArchiveDatabase::class.java, name)
            .addMigrations(ArchiveDatabase.MIGRATION_1_2)
            .build()
        try {
            val reopened = ArchiveRepository(context, persistent.dao())
            assertEquals("持久分类", reopened.categoriesJson().getJSONArray("categories").getJSONObject(0).getString("name"))
            assertEquals(setOf(categoryId), jsonStrings(reopened.tweetCategoryAssignments(listOf("persisted-tweet")).getJSONObject("assignments").getJSONArray("persisted-tweet")))
        } finally {
            persistent.close()
            context.deleteDatabase(name)
        }
    }

    @Test
    fun versionOneDatabaseMigratesWithoutDroppingJobsMediaOrDownloadUris() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val name = "archive-category-migration-test.db"
        context.deleteDatabase(name)
        val path = context.getDatabasePath(name)
        path.parentFile?.mkdirs()
        val old = SQLiteDatabase.openOrCreateDatabase(path, null)
        old.execSQL("CREATE TABLE jobs (id TEXT NOT NULL, tweetId TEXT NOT NULL, sourceUrl TEXT NOT NULL, canonicalUrl TEXT NOT NULL, status TEXT NOT NULL, progress INTEGER NOT NULL, authorName TEXT, username TEXT, userId TEXT, avatarUrl TEXT, text TEXT, language TEXT, publishedAt TEXT, error TEXT, attempts INTEGER NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, completedAt TEXT, PRIMARY KEY(id))")
        old.execSQL("CREATE TABLE media (id TEXT NOT NULL, jobId TEXT NOT NULL, kind TEXT NOT NULL, filename TEXT NOT NULL, contentType TEXT, size INTEGER, downloadedBytes INTEGER NOT NULL, totalBytes INTEGER, sourceUrl TEXT NOT NULL, mediaStoreUri TEXT, position INTEGER NOT NULL, PRIMARY KEY(id))")
        old.execSQL("INSERT INTO jobs VALUES ('legacy', 'tweet-legacy', 'https://x.com/a/status/legacy', 'https://x.com/a/status/legacy', 'completed', 100, '作者', 'author', '1', NULL, '正文', NULL, NULL, NULL, 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')")
        old.execSQL("INSERT INTO media VALUES ('media-legacy', 'legacy', 'image', 'saved.jpg', 'image/jpeg', 123, 123, 123, 'https://cdn.example/saved.jpg', 'content://saved-location', 0)")
        old.version = 1
        old.close()

        val upgraded = Room.databaseBuilder(context, ArchiveDatabase::class.java, name)
            .addMigrations(ArchiveDatabase.MIGRATION_1_2)
            .build()
        try {
            assertEquals("legacy", upgraded.dao().getJob("legacy")?.id)
            assertEquals("content://saved-location", upgraded.dao().mediaForJob("legacy").single().mediaStoreUri)
            assertTrue(upgraded.dao().listTweetCategories().isEmpty())
            assertFalse(upgraded.openHelper.readableDatabase.query("SELECT name FROM sqlite_master WHERE type='table' AND name='tweet_category_assignments'").use { it.count == 0 })
        } finally {
            upgraded.close()
            context.deleteDatabase(name)
        }
    }

    private fun jsonStrings(array: org.json.JSONArray) = (0 until array.length()).map { array.getString(it) }.toSet()

    private fun job(id: String, tweetId: String, status: String = "completed", text: String = "正文") = JobEntity(
        id = id,
        tweetId = tweetId,
        sourceUrl = "https://x.com/example/status/$tweetId",
        canonicalUrl = "https://x.com/example/status/$tweetId",
        status = status,
        text = text,
        createdAt = "2026-09-30T00:00:00Z",
        updatedAt = "2026-09-30T00:00:00Z",
        completedAt = if (status == "completed") "2026-09-30T00:00:00Z" else null,
    )
}
