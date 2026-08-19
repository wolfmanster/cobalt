package com.xmedia.archive.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import kotlinx.coroutines.flow.Flow

@Dao
interface ArchiveDao {
    @Query("SELECT * FROM jobs ORDER BY createdAt DESC")
    fun observeJobs(): Flow<List<JobEntity>>

    @Query("SELECT * FROM jobs ORDER BY createdAt DESC")
    suspend fun listJobs(): List<JobEntity>

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

    @Query("DELETE FROM jobs WHERE status IN ('completed', 'failed', 'canceled')")
    suspend fun deleteHistory(): Int

    @Query("DELETE FROM media WHERE jobId NOT IN (SELECT id FROM jobs)")
    suspend fun deleteOrphanMedia()

    @Query("UPDATE jobs SET status = 'queued', progress = 0, error = NULL, updatedAt = :updatedAt WHERE status IN ('resolving', 'downloading')")
    suspend fun requeueInterrupted(updatedAt: String): Int

    @Transaction
    suspend fun replaceMedia(jobId: String, media: List<MediaEntity>) {
        deleteMedia(jobId)
        upsertMedia(media)
    }
}
