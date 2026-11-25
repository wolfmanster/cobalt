package com.xmedia.archive.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import kotlinx.coroutines.flow.Flow

data class AuthorAggregate(
    val authorKey: String,
    val tweetCount: Int,
    val latestDownloadedAt: String,
    val authorName: String?,
    val username: String?,
    val avatarUrl: String?,
)

data class CategorySummary(
    val id: String,
    val name: String,
    val createdAt: String,
    val tweetCount: Int,
)

data class TweetCategoryAssignment(
    val tweetId: String,
    val categoryId: String,
)

@Dao
interface ArchiveDao {
    @Query("SELECT * FROM jobs ORDER BY createdAt DESC")
    fun observeJobs(): Flow<List<JobEntity>>

    @Query("SELECT * FROM jobs ORDER BY createdAt DESC")
    suspend fun listJobs(): List<JobEntity>

    @Query("SELECT * FROM jobs WHERE status NOT IN ('completed', 'failed', 'canceled') ORDER BY createdAt DESC")
    suspend fun listActiveJobs(): List<JobEntity>

    @Query("SELECT * FROM jobs WHERE status IN ('completed', 'failed', 'canceled') ORDER BY createdAt DESC LIMIT :limit OFFSET :offset")
    suspend fun listHistoryJobs(offset: Int, limit: Int): List<JobEntity>

    @Query("SELECT COUNT(*) FROM jobs WHERE status IN ('completed', 'failed', 'canceled')")
    suspend fun historyCount(): Int

    @Query("SELECT COUNT(*) FROM jobs WHERE status = 'completed' AND substr(completedAt, 1, 10) = :utcDate")
    suspend fun completedOnDate(utcDate: String): Int

    @Query("""
        SELECT * FROM jobs
        WHERE status = 'completed'
          AND id = (SELECT candidate.id FROM jobs AS candidate WHERE candidate.status = 'completed' AND candidate.tweetId = jobs.tweetId ORDER BY COALESCE(candidate.completedAt, candidate.createdAt) DESC, candidate.id DESC LIMIT 1)
          AND (:categoryId IS NULL
            OR (:categoryId = '__uncategorized__' AND NOT EXISTS (
                SELECT 1 FROM tweet_category_assignments AS assignment WHERE assignment.tweetId = jobs.tweetId
            ))
            OR (:categoryId != '__uncategorized__' AND EXISTS (
                SELECT 1 FROM tweet_category_assignments AS assignment
                WHERE assignment.tweetId = jobs.tweetId AND assignment.categoryId = :categoryId
            )))
          AND (:authorKey IS NULL OR
            CASE WHEN TRIM(COALESCE(userId, '')) != '' THEN 'id:' || userId
                 WHEN TRIM(COALESCE(username, '')) != '' THEN 'name:' || lower(username)
                 ELSE 'unknown' END = :authorKey)
          AND (:query = '' OR instr(lower(COALESCE(text, '')), :query) > 0
            OR instr(lower(COALESCE(authorName, '')), :query) > 0
            OR instr(lower(COALESCE(username, '')), :query) > 0
            OR instr(lower(tweetId), :query) > 0)
        ORDER BY COALESCE(completedAt, createdAt) DESC, id DESC
        LIMIT :limit OFFSET :offset
    """)
    suspend fun listDownloadedPosts(authorKey: String?, categoryId: String?, query: String, offset: Int, limit: Int): List<JobEntity>

    @Query("""
        SELECT COUNT(DISTINCT tweetId) FROM jobs
        WHERE status = 'completed'
          AND id = (SELECT candidate.id FROM jobs AS candidate WHERE candidate.status = 'completed' AND candidate.tweetId = jobs.tweetId ORDER BY COALESCE(candidate.completedAt, candidate.createdAt) DESC, candidate.id DESC LIMIT 1)
          AND (:categoryId IS NULL
            OR (:categoryId = '__uncategorized__' AND NOT EXISTS (
                SELECT 1 FROM tweet_category_assignments AS assignment WHERE assignment.tweetId = jobs.tweetId
            ))
            OR (:categoryId != '__uncategorized__' AND EXISTS (
                SELECT 1 FROM tweet_category_assignments AS assignment
                WHERE assignment.tweetId = jobs.tweetId AND assignment.categoryId = :categoryId
            )))
          AND (:authorKey IS NULL OR
            CASE WHEN TRIM(COALESCE(userId, '')) != '' THEN 'id:' || userId
                 WHEN TRIM(COALESCE(username, '')) != '' THEN 'name:' || lower(username)
                 ELSE 'unknown' END = :authorKey)
          AND (:query = '' OR instr(lower(COALESCE(text, '')), :query) > 0
            OR instr(lower(COALESCE(authorName, '')), :query) > 0
            OR instr(lower(COALESCE(username, '')), :query) > 0
            OR instr(lower(tweetId), :query) > 0)
    """)
    suspend fun downloadedPostCount(authorKey: String?, categoryId: String?, query: String): Int

    @Query("SELECT category.id AS id, category.name AS name, category.createdAt AS createdAt, COUNT(DISTINCT jobs.tweetId) AS tweetCount FROM tweet_categories AS category LEFT JOIN tweet_category_assignments AS assignment ON assignment.categoryId = category.id LEFT JOIN jobs ON jobs.tweetId = assignment.tweetId AND jobs.status = 'completed' GROUP BY category.id ORDER BY category.createdAt, category.name COLLATE NOCASE")
    suspend fun listTweetCategories(): List<CategorySummary>

    @Query("SELECT COUNT(DISTINCT tweetId) FROM jobs WHERE status = 'completed'")
    suspend fun completedTweetRecordCount(): Int

    @Query("SELECT COUNT(DISTINCT tweetId) FROM jobs WHERE status = 'completed' AND NOT EXISTS (SELECT 1 FROM tweet_category_assignments AS assignment WHERE assignment.tweetId = jobs.tweetId)")
    suspend fun uncategorizedTweetRecordCount(): Int

    @Query("SELECT * FROM tweet_categories WHERE normalizedName = :normalizedName LIMIT 1")
    suspend fun findTweetCategoryByName(normalizedName: String): TweetCategoryEntity?

    @Query("SELECT * FROM tweet_categories WHERE id = :id LIMIT 1")
    suspend fun getTweetCategory(id: String): TweetCategoryEntity?

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertTweetCategory(category: TweetCategoryEntity): Long

    @Query("UPDATE tweet_categories SET name = :name, normalizedName = :normalizedName WHERE id = :id")
    suspend fun renameTweetCategory(id: String, name: String, normalizedName: String): Int

    @Query("DELETE FROM tweet_categories WHERE id = :id")
    suspend fun deleteTweetCategory(id: String): Int

    @Query("SELECT tweetId, categoryId FROM tweet_category_assignments WHERE tweetId IN (:tweetIds)")
    suspend fun tweetCategoryAssignments(tweetIds: List<String>): List<TweetCategoryAssignment>

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun addTweetCategoryAssignments(assignments: List<TweetCategoryAssignmentEntity>)

    @Query("DELETE FROM tweet_category_assignments WHERE tweetId IN (:tweetIds) AND categoryId IN (:categoryIds)")
    suspend fun removeTweetCategoryAssignments(tweetIds: List<String>, categoryIds: List<String>)

    @Query("DELETE FROM tweet_category_assignments WHERE tweetId NOT IN (SELECT tweetId FROM jobs WHERE status = 'completed')")
    suspend fun deleteOrphanTweetCategoryAssignments()

    @Transaction
    suspend fun updateTweetCategories(
        tweetIds: List<String>,
        addCategoryIds: List<String>,
        removeCategoryIds: List<String>,
    ) {
        if (tweetIds.isEmpty()) return
        tweetIds.distinct().chunked(400).forEach { tweetBatch ->
            addCategoryIds.distinct().chunked(200).forEach { categoryBatch ->
                addTweetCategoryAssignments(tweetBatch.flatMap { tweetId ->
                    categoryBatch.map { categoryId -> TweetCategoryAssignmentEntity(tweetId, categoryId) }
                })
            }
            removeCategoryIds.distinct().chunked(400).forEach { categoryBatch ->
                removeTweetCategoryAssignments(tweetBatch, categoryBatch)
            }
        }
    }

    @Transaction
    suspend fun deleteHistoryAndOrphanMetadata(): Int {
        val removed = deleteAllTerminalJobs()
        deleteOrphanMedia()
        deleteOrphanTweetCategoryAssignments()
        return removed
    }

    @Query("""
        SELECT authorGroups.authorKey, authorGroups.tweetCount, authorGroups.latestDownloadedAt,
               latest.authorName AS authorName, latest.username AS username, latest.avatarUrl AS avatarUrl
        FROM (
            SELECT authorKey, COUNT(DISTINCT tweetId) AS tweetCount, MAX(downloadedAt) AS latestDownloadedAt
            FROM (
                SELECT tweetId, CASE WHEN TRIM(COALESCE(userId, '')) != '' THEN 'id:' || userId
                            WHEN TRIM(COALESCE(username, '')) != '' THEN 'name:' || lower(username)
                            ELSE 'unknown' END AS authorKey,
                       COALESCE(completedAt, createdAt) AS downloadedAt,
                       authorName, username
                FROM jobs WHERE status = 'completed'
            )
            GROUP BY authorKey
            HAVING :query = '' OR SUM(CASE WHEN instr(lower(COALESCE(authorName, '')), :query) > 0
                OR instr(lower(COALESCE(username, '')), :query) > 0 THEN 1 ELSE 0 END) > 0
        ) AS authorGroups
        JOIN jobs AS latest ON latest.id = (
            SELECT candidate.id FROM jobs AS candidate
            WHERE candidate.status = 'completed'
              AND CASE WHEN TRIM(COALESCE(candidate.userId, '')) != '' THEN 'id:' || candidate.userId
                       WHEN TRIM(COALESCE(candidate.username, '')) != '' THEN 'name:' || lower(candidate.username)
                       ELSE 'unknown' END = authorGroups.authorKey
            ORDER BY COALESCE(candidate.completedAt, candidate.createdAt) DESC, candidate.id DESC
            LIMIT 1
        )
        ORDER BY authorGroups.latestDownloadedAt DESC, authorGroups.authorKey
        LIMIT :limit OFFSET :offset
    """)
    suspend fun listAuthors(query: String, offset: Int, limit: Int): List<AuthorAggregate>

    @Query("""
        SELECT COUNT(*) FROM (
            SELECT authorKey FROM (
                SELECT CASE WHEN TRIM(COALESCE(userId, '')) != '' THEN 'id:' || userId
                            WHEN TRIM(COALESCE(username, '')) != '' THEN 'name:' || lower(username)
                            ELSE 'unknown' END AS authorKey,
                       authorName, username
                FROM jobs WHERE status = 'completed'
            )
            GROUP BY authorKey
            HAVING :query = '' OR SUM(CASE WHEN instr(lower(COALESCE(authorName, '')), :query) > 0
                OR instr(lower(COALESCE(username, '')), :query) > 0 THEN 1 ELSE 0 END) > 0
        )
    """)
    suspend fun authorCount(query: String): Int

    @Query("SELECT * FROM jobs WHERE status = 'completed' AND CASE WHEN TRIM(COALESCE(userId, '')) != '' THEN 'id:' || userId WHEN TRIM(COALESCE(username, '')) != '' THEN 'name:' || lower(username) ELSE 'unknown' END = :authorKey ORDER BY COALESCE(completedAt, createdAt) DESC, id DESC LIMIT 1")
    suspend fun latestCompletedByAuthor(authorKey: String): JobEntity?

    @Query("SELECT * FROM jobs WHERE id = :id")
    suspend fun getJob(id: String): JobEntity?

    @Query("SELECT * FROM jobs WHERE tweetId = :tweetId AND status != 'canceled' LIMIT 1")
    suspend fun findByTweetId(tweetId: String): JobEntity?

    @Query("SELECT * FROM media WHERE jobId = :jobId ORDER BY position")
    suspend fun mediaForJob(jobId: String): List<MediaEntity>

    @Query("SELECT * FROM media WHERE id = :id")
    suspend fun getMedia(id: String): MediaEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertJob(job: JobEntity)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertMedia(media: List<MediaEntity>)

    @Query("DELETE FROM media WHERE jobId = :jobId")
    suspend fun deleteMedia(jobId: String)

    @Query("DELETE FROM jobs WHERE id IN (:ids) AND status IN ('completed', 'failed', 'canceled')")
    suspend fun deleteTerminalJobs(ids: List<String>): Int

    @Query("DELETE FROM jobs WHERE status IN ('completed', 'failed', 'canceled')")
    suspend fun deleteAllTerminalJobs(): Int

    @Query("DELETE FROM media WHERE jobId NOT IN (SELECT id FROM jobs)")
    suspend fun deleteOrphanMedia()

    @Query("UPDATE jobs SET status = 'queued', progress = 0, error = NULL, updatedAt = :updatedAt WHERE status IN ('resolving', 'downloading')")
    suspend fun requeueInterrupted(updatedAt: String): Int

    @Query("SELECT * FROM jobs WHERE status IN ('resolving', 'downloading')")
    suspend fun interruptedJobs(): List<JobEntity>

    @Query("SELECT EXISTS(SELECT 1 FROM jobs WHERE status IN ('queued', 'resolving', 'downloading'))")
    suspend fun hasPendingJobs(): Boolean

    @Transaction
    suspend fun replaceMedia(jobId: String, media: List<MediaEntity>) {
        deleteMedia(jobId)
        upsertMedia(media)
    }
}
