package com.xmedia.archive.data

import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.PrimaryKey

enum class JobStatus { QUEUED, RESOLVING, DOWNLOADING, COMPLETED, FAILED, CANCELED }

@Entity(tableName = "jobs")
data class JobEntity(
    @PrimaryKey val id: String,
    val tweetId: String,
    val sourceUrl: String,
    val canonicalUrl: String,
    val status: String = JobStatus.QUEUED.name.lowercase(),
    val progress: Int = 0,
    val authorName: String? = null,
    val username: String? = null,
    val userId: String? = null,
    val avatarUrl: String? = null,
    val text: String? = null,
    val language: String? = null,
    val publishedAt: String? = null,
    val error: String? = null,
    val attempts: Int = 0,
    val createdAt: String,
    val updatedAt: String,
    val completedAt: String? = null,
)

@Entity(tableName = "media")
data class MediaEntity(
    @PrimaryKey val id: String,
    val jobId: String,
    val kind: String,
    val filename: String,
    val contentType: String? = null,
    val size: Long? = null,
    val downloadedBytes: Long = 0,
    val totalBytes: Long? = null,
    val sourceUrl: String,
    val mediaStoreUri: String? = null,
    val position: Int = 0,
)

@Entity(tableName = "tweet_categories", indices = [Index(value = ["normalizedName"], unique = true)])
data class TweetCategoryEntity(
    @PrimaryKey val id: String,
    val name: String,
    val normalizedName: String,
    val createdAt: String,
)

@Entity(
    tableName = "tweet_category_assignments",
    primaryKeys = ["tweetId", "categoryId"],
    foreignKeys = [ForeignKey(
        entity = TweetCategoryEntity::class,
        parentColumns = ["id"],
        childColumns = ["categoryId"],
        onDelete = ForeignKey.CASCADE,
    )],
    indices = [Index("tweetId"), Index("categoryId")],
)
data class TweetCategoryAssignmentEntity(
    val tweetId: String,
    val categoryId: String,
)
