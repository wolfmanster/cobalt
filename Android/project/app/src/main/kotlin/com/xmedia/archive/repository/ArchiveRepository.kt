package com.xmedia.archive.repository

import android.content.Context
import android.database.sqlite.SQLiteConstraintException
import com.xmedia.archive.data.ArchiveDatabase
import com.xmedia.archive.data.ArchiveDao
import com.xmedia.archive.data.JobEntity
import com.xmedia.archive.data.JobStatus
import com.xmedia.archive.data.MediaEntity
import com.xmedia.archive.data.TweetCategoryEntity
import com.xmedia.archive.resolver.XPostResolver
import kotlinx.coroutines.flow.Flow
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.Locale
import java.util.UUID

class ArchiveRepository(context: Context, daoOverride: ArchiveDao? = null) {
    private val appContext = context.applicationContext
    private val dao: ArchiveDao = daoOverride ?: ArchiveDatabase.get(context).dao()
    private val resolver = XPostResolver()

    fun observeJobs(): Flow<List<JobEntity>> = dao.observeJobs()
    suspend fun getJob(id: String): JobEntity? = dao.getJob(id)
    suspend fun mediaForJob(id: String): List<MediaEntity> = dao.mediaForJob(id)
    suspend fun mediaUri(id: String): Pair<String, String>? = dao.getMedia(id)?.let { media ->
        media.mediaStoreUri?.let { uri -> uri to (media.contentType ?: "application/octet-stream") }
    }

    suspend fun createJobs(urls: List<String>): JSONObject {
        val created = JSONArray()
        val duplicates = JSONArray()
        val rejected = JSONArray()
        val seen = mutableSetOf<String>()
        urls.forEach { raw ->
            try {
                val (tweetId, canonicalUrl) = resolver.parseUrl(raw)
                if (!seen.add(tweetId)) return@forEach
                val existing = dao.findByTweetId(tweetId)
                if (existing != null) {
                    duplicates.put(toJson(existing, dao.mediaForJob(existing.id)))
                    return@forEach
                }
                val now = Instant.now().toString()
                val job = JobEntity(UUID.randomUUID().toString(), tweetId, raw.trim(), canonicalUrl, createdAt = now, updatedAt = now)
                dao.upsertJob(job)
                created.put(toJson(job, emptyList()))
            } catch (error: Exception) {
                rejected.put(JSONObject().put("url", raw).put("error", error.message ?: "链接无效"))
            }
        }
        return JSONObject().put("created", created).put("duplicates", duplicates).put("rejected", rejected)
    }

    suspend fun update(job: JobEntity) = dao.upsertJob(job.copy(updatedAt = Instant.now().toString()))

    suspend fun requeueInterrupted(): Int {
        dao.interruptedJobs().forEach { job -> removeMedia(job.id) }
        return dao.requeueInterrupted(Instant.now().toString())
    }

    suspend fun hasPendingJobs() = dao.hasPendingJobs()

    suspend fun replaceMedia(jobId: String, media: List<MediaEntity>) = dao.replaceMedia(jobId, media)

    suspend fun clearHistory(): Int {
        return dao.deleteHistoryAndOrphanMetadata()
    }

    suspend fun retry(id: String): Boolean {
        val job = dao.getJob(id) ?: return false
        if (job.status != JobStatus.FAILED.name.lowercase() && job.status != JobStatus.CANCELED.name.lowercase()) return false
        removeMedia(id)
        update(job.copy(status = JobStatus.QUEUED.name.lowercase(), progress = 0, error = null, completedAt = null))
        return true
    }

    suspend fun cancel(id: String): Boolean {
        val job = dao.getJob(id) ?: return false
        if (job.status in setOf("completed", "failed", "canceled")) return false
        update(job.copy(status = JobStatus.CANCELED.name.lowercase(), error = null))
        return true
    }

    suspend fun jobListJson(historyOffset: Int, historyLimit: Int): JSONObject {
        val active = dao.listActiveJobs()
        val history = dao.listHistoryJobs(historyOffset, historyLimit)
        return JSONObject()
            .put("jobs", JSONArray((active + history).map { job -> toJson(job, dao.mediaForJob(job.id)) }))
            .put("historyTotal", dao.historyCount())
            .put("completedToday", dao.completedOnDate(Instant.now().toString().take(10)))
    }

    suspend fun downloadedPostsJson(authorKey: String?, categoryId: String?, rawQuery: String, offset: Int, limit: Int): JSONObject {
        val query = rawQuery.trim().removePrefix("@").lowercase(Locale.ROOT)
        val jobs = dao.listDownloadedPosts(authorKey, categoryId, query, offset, limit)
        return JSONObject()
            .put("jobs", JSONArray(jobs.map { job -> toJson(job, dao.mediaForJob(job.id)) }))
            .put("total", dao.downloadedPostCount(authorKey, categoryId, query))
    }

    suspend fun categoriesJson(): JSONObject {
        val categories = dao.listTweetCategories().map { category ->
            JSONObject().put("id", category.id).put("name", category.name).put("createdAt", category.createdAt).put("tweetCount", category.tweetCount)
        }
        return JSONObject()
            .put("categories", JSONArray(categories))
            .put("allTotal", dao.completedTweetRecordCount())
            .put("uncategorizedTotal", dao.uncategorizedTweetRecordCount())
    }

    suspend fun createTweetCategory(rawName: String): JSONObject {
        val (name, normalizedName) = TweetCategoryNames.normalize(rawName)
        if (dao.findTweetCategoryByName(normalizedName) != null) throw IllegalArgumentException("分类名已存在")
        val category = TweetCategoryEntity(UUID.randomUUID().toString(), name, normalizedName, Instant.now().toString())
        if (dao.insertTweetCategory(category) == -1L) throw IllegalArgumentException("分类名已存在")
        return categoryJson(category, 0)
    }

    suspend fun renameTweetCategory(id: String, rawName: String): JSONObject {
        val category = dao.getTweetCategory(id) ?: throw IllegalArgumentException("分类不存在")
        val (name, normalizedName) = TweetCategoryNames.normalize(rawName)
        val duplicate = dao.findTweetCategoryByName(normalizedName)
        if (duplicate != null && duplicate.id != id) throw IllegalArgumentException("分类名已存在")
        val updated = try {
            dao.renameTweetCategory(id, name, normalizedName)
        } catch (_: SQLiteConstraintException) {
            throw IllegalArgumentException("分类名已存在")
        }
        if (updated == 0) throw IllegalArgumentException("分类不存在")
        return categoryJson(category.copy(name = name, normalizedName = normalizedName), categoryTweetCount(id))
    }

    suspend fun deleteTweetCategory(id: String): Boolean = dao.deleteTweetCategory(id) > 0

    suspend fun tweetCategoryAssignments(tweetIds: List<String>): JSONObject {
        val assignments = tweetIds.distinct().chunked(400).flatMap { batch -> dao.tweetCategoryAssignments(batch) }
        val byTweet = assignments.groupBy({ it.tweetId }, { it.categoryId })
        val result = JSONObject()
        tweetIds.distinct().forEach { tweetId -> result.put(tweetId, JSONArray(byTweet[tweetId].orEmpty())) }
        return JSONObject().put("assignments", result)
    }

    suspend fun updateTweetCategories(tweetIds: List<String>, addCategoryIds: List<String>, removeCategoryIds: List<String>) {
        val distinctIds = tweetIds.map(String::trim).filter(String::isNotEmpty).distinct()
        val addIds = addCategoryIds.map(String::trim).filter(String::isNotEmpty).distinct()
        val removeIds = removeCategoryIds.map(String::trim).filter(String::isNotEmpty).distinct()
        if (distinctIds.isEmpty()) throw IllegalArgumentException("请选择至少一条推文")
        val categoryIds = (addIds + removeIds).distinct()
        val existingIds = dao.listTweetCategories().map { it.id }.toSet()
        if (categoryIds.any { it !in existingIds }) throw IllegalArgumentException("分类已不存在，请刷新后重试")
        dao.updateTweetCategories(distinctIds, addIds, removeIds)
    }

    private suspend fun categoryTweetCount(categoryId: String) = dao.listTweetCategories().firstOrNull { it.id == categoryId }?.tweetCount ?: 0

    private fun categoryJson(category: TweetCategoryEntity, count: Int) = JSONObject()
        .put("id", category.id).put("name", category.name).put("createdAt", category.createdAt).put("tweetCount", count)

    suspend fun authorsJson(rawQuery: String, offset: Int, limit: Int): JSONObject {
        val query = rawQuery.trim().removePrefix("@").lowercase(Locale.ROOT)
        val authors = dao.listAuthors(query, offset, limit).map { group ->
            JSONObject()
                .put("authorKey", group.authorKey)
                .put("authorName", group.authorName?.takeIf(String::isNotBlank) ?: group.username?.takeIf(String::isNotBlank) ?: "作者未知")
                .put("username", group.username?.takeIf(String::isNotBlank) ?: "")
                .put("avatarUrl", group.avatarUrl?.takeIf(String::isNotBlank) ?: "")
                .put("tweetCount", group.tweetCount)
                .put("latestDownloadedAt", group.latestDownloadedAt)
        }
        return JSONObject().put("authors", JSONArray(authors)).put("total", dao.authorCount(query))
    }

    suspend fun jobJson(id: String): JSONObject? = dao.getJob(id)?.let { toJson(it, dao.mediaForJob(id)) }

    private suspend fun removeMedia(jobId: String) {
        dao.mediaForJob(jobId).mapNotNull { it.mediaStoreUri }.forEach { uri ->
            runCatching { appContext.contentResolver.delete(android.net.Uri.parse(uri), null, null) }
        }
        dao.deleteMedia(jobId)
    }

    private fun toJson(job: JobEntity, media: List<MediaEntity>): JSONObject {
        val result = JSONObject()
            .put("id", job.id).put("tweetId", job.tweetId).put("sourceUrl", job.sourceUrl)
            .put("canonicalUrl", job.canonicalUrl).put("status", job.status).put("progress", job.progress)
            .put("error", job.error).put("attempts", job.attempts).put("createdAt", job.createdAt)
            .put("updatedAt", job.updatedAt).put("completedAt", job.completedAt)
        if (job.username != null) result.put("metadata", JSONObject()
            .put("authorName", job.authorName).put("username", job.username).put("userId", job.userId)
            .put("avatarUrl", job.avatarUrl).put("text", job.text).put("language", job.language).put("publishedAt", job.publishedAt))
        result.put("media", JSONArray(media.map { item ->
            JSONObject().put("id", item.id).put("kind", item.kind).put("filename", item.filename)
                .put("contentType", item.contentType).put("size", item.size).put("downloadedBytes", item.downloadedBytes)
                .put("totalBytes", item.totalBytes).put("previewUrl", item.mediaStoreUri).put("downloadUrl", item.mediaStoreUri)
        }))
        return result
    }
}

object TweetCategoryNames {
    fun normalize(rawName: String): Pair<String, String> {
        val name = rawName.trim()
        val characters = name.codePointCount(0, name.length)
        require(characters in 1..30) { "分类名需为 1–30 个字符" }
        return name to name.lowercase(Locale.ROOT)
    }
}
