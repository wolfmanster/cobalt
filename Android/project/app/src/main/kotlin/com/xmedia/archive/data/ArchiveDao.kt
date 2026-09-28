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
    suspend fun listDownloadedPosts(authorKey: String?, query: String, offset: Int, limit: Int): List<JobEntity>

    @Query("""
        SELECT COUNT(*) FROM jobs
        WHERE status = 'completed'
          AND (:authorKey IS NULL OR
            CASE WHEN TRIM(COALESCE(userId, '')) != '' THEN 'id:' || userId
                 WHEN TRIM(COALESCE(username, '')) != '' THEN 'name:' || lower(username)
                 ELSE 'unknown' END = :authorKey)
          AND (:query = '' OR instr(lower(COALESCE(text, '')), :query) > 0
            OR instr(lower(COALESCE(authorName, '')), :query) > 0
            OR instr(lower(COALESCE(username, '')), :query) > 0
            OR instr(lower(tweetId), :query) > 0)
    """)
    suspend fun downloadedPostCount(authorKey: String?, query: String): Int

    @Query("""
        SELECT authorGroups.authorKey, authorGroups.tweetCount, authorGroups.latestDownloadedAt,
               latest.authorName AS authorName, latest.username AS username, latest.avatarUrl AS avatarUrl
        FROM (
            SELECT authorKey, COUNT(*) AS tweetCount, MAX(downloadedAt) AS latestDownloadedAt
            FROM (
                SELECT CASE WHEN TRIM(COALESCE(userId, '')) != '' THEN 'id:' || userId
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
