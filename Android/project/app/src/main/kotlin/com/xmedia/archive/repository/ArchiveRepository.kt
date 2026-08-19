package com.xmedia.archive.repository

import android.content.Context
import com.xmedia.archive.data.ArchiveDatabase
import com.xmedia.archive.data.ArchiveDao
import com.xmedia.archive.data.JobEntity
import com.xmedia.archive.data.JobStatus
import com.xmedia.archive.data.MediaEntity
import com.xmedia.archive.resolver.XPostResolver
import kotlinx.coroutines.flow.Flow
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.UUID

class ArchiveRepository(context: Context) {
    private val appContext = context.applicationContext
    private val dao: ArchiveDao = ArchiveDatabase.get(context).dao()
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

    suspend fun requeueInterrupted() = dao.requeueInterrupted(Instant.now().toString())

    suspend fun hasPendingJobs() = dao.hasPendingJobs()

    suspend fun replaceMedia(jobId: String, media: List<MediaEntity>) = dao.replaceMedia(jobId, media)

    suspend fun clearHistory(): Int {
        val terminal = dao.listJobs().filter { it.status in setOf("completed", "failed", "canceled") }
        terminal.flatMap { dao.mediaForJob(it.id) }.mapNotNull { it.mediaStoreUri }.forEach { uri ->
            runCatching { appContext.contentResolver.delete(android.net.Uri.parse(uri), null, null) }
        }
        val removed = dao.deleteHistory()
        dao.deleteOrphanMedia()
        return removed
    }

    suspend fun retry(id: String): Boolean {
        val job = dao.getJob(id) ?: return false
        if (job.status != JobStatus.FAILED.name.lowercase() && job.status != JobStatus.CANCELED.name.lowercase()) return false
        dao.deleteMedia(id)
        update(job.copy(status = JobStatus.QUEUED.name.lowercase(), progress = 0, error = null, completedAt = null))
        return true
    }

    suspend fun cancel(id: String): Boolean {
        val job = dao.getJob(id) ?: return false
        if (job.status in setOf("completed", "failed", "canceled")) return false
        update(job.copy(status = JobStatus.CANCELED.name.lowercase(), error = null))
        return true
    }

    suspend fun jobsJson(): JSONArray = JSONArray(dao.listJobs().map { job -> toJson(job, dao.mediaForJob(job.id)) })

    suspend fun jobJson(id: String): JSONObject? = dao.getJob(id)?.let { toJson(it, dao.mediaForJob(id)) }

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
