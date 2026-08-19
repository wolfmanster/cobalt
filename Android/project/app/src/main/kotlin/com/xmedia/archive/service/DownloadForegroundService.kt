package com.xmedia.archive.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.provider.MediaStore
import androidx.core.app.NotificationCompat
import com.xmedia.archive.MainActivity
import com.xmedia.archive.R
import com.xmedia.archive.data.ArchiveDatabase
import com.xmedia.archive.data.JobEntity
import com.xmedia.archive.data.JobStatus
import com.xmedia.archive.data.MediaEntity
import com.xmedia.archive.repository.ArchiveRepository
import com.xmedia.archive.resolver.XPostResolver
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import java.time.Instant
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.coroutineContext

class DownloadForegroundService : Service() {
    private val serviceJob = SupervisorJob()
    private val scope = CoroutineScope(Dispatchers.IO + serviceJob)
    private val running = AtomicBoolean(false)
    private lateinit var repository: ArchiveRepository
    private val resolver = XPostResolver()
    private val client = OkHttpClient()

    override fun onCreate() {
        super.onCreate()
        repository = ArchiveRepository(this)
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, notification("准备下载任务", 0))
        if (running.compareAndSet(false, true)) scope.launch { runQueue() }
        return START_NOT_STICKY
    }

    private suspend fun runQueue() {
        try {
            while (true) {
                val jobs = ArchiveDatabase.get(this).dao().listJobs().filter { it.status == JobStatus.QUEUED.name.lowercase() }
                if (jobs.isEmpty()) break
                coroutineScope {
                    jobs.chunked(MAX_CONCURRENCY).forEach { batch ->
                        batch.map { job -> async { process(job) } }.awaitAll()
                    }
                }
            }
        } finally {
            running.set(false)
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    private suspend fun process(initial: JobEntity) {
        var job = initial
        try {
            job = job.copy(
                status = JobStatus.RESOLVING.name.lowercase(),
                progress = 4,
                error = null,
                attempts = job.attempts + 1,
                updatedAt = Instant.now().toString(),
            )
            repository.update(job)
            val resolved = resolver.resolve(job.tweetId) { canceledJobs.contains(job.id) }
            coroutineContext.ensureActive()
            val media = resolved.media.map {
                MediaEntity(it.id, job.id, it.kind, it.filename, sourceUrl = it.sourceUrl, position = it.position)
            }
            job = job.copy(
                status = JobStatus.DOWNLOADING.name.lowercase(),
                progress = 12,
                authorName = resolved.metadata.authorName,
                username = resolved.metadata.username,
                userId = resolved.metadata.userId,
                avatarUrl = resolved.metadata.avatarUrl,
                text = resolved.metadata.text,
                language = resolved.metadata.language,
                publishedAt = resolved.metadata.publishedAt,
            )
            repository.update(job)
            repository.replaceMedia(job.id, media)
            media.forEachIndexed { index, item -> download(job, item, index, media.size) }
            job = repository.getJob(job.id) ?: job
            if (job.status != JobStatus.CANCELED.name.lowercase() && !canceledJobs.contains(job.id)) {
                repository.update(job.copy(status = JobStatus.COMPLETED.name.lowercase(), progress = 100, completedAt = Instant.now().toString()))
            }
        } catch (_: CancellationException) {
            repository.getJob(job.id)?.let { repository.update(it.copy(status = JobStatus.CANCELED.name.lowercase())) }
            canceledJobs.remove(job.id)
        } catch (error: Exception) {
            val current = repository.getJob(job.id) ?: job
            if (current.status != JobStatus.CANCELED.name.lowercase()) {
                repository.update(current.copy(status = JobStatus.FAILED.name.lowercase(), error = error.message ?: "下载失败"))
            }
        }
    }

    private suspend fun download(job: JobEntity, item: MediaEntity, index: Int, count: Int) {
        val request = Request.Builder().url(item.sourceUrl).header("User-Agent", "x-media-archive/0.1 Android").build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IllegalStateException("媒体下载失败（HTTP ${response.code}）")
            val body = response.body ?: throw IllegalStateException("媒体响应为空")
            val total = body.contentLength().takeIf { it > 0 }
            val collection = when (item.kind) {
                "image", "gif" -> MediaStore.Images.Media.EXTERNAL_CONTENT_URI
                else -> MediaStore.Video.Media.EXTERNAL_CONTENT_URI
            }
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, item.filename)
                put(MediaStore.MediaColumns.MIME_TYPE, item.contentType ?: mimeFor(item.filename))
                put(MediaStore.MediaColumns.RELATIVE_PATH, "Download/X Media Archive")
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
            val uri = contentResolver.insert(collection, values) ?: throw IllegalStateException("无法创建媒体文件")
            try {
                contentResolver.openOutputStream(uri)?.use { output ->
                    body.byteStream().use { input ->
                        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                        var received = 0L
                        var read: Int
                        while (input.read(buffer).also { read = it } >= 0) {
                            coroutineContext.ensureActive()
                            if (canceledJobs.contains(job.id)) throw CancellationException("任务已取消")
                            if (read == 0) continue
                            output.write(buffer, 0, read)
                            received += read
                            val fraction = total?.let { received.toDouble() / it } ?: (received.toDouble() / (5 * 1024 * 1024))
                            val progress = (12 + ((index + fraction.coerceIn(0.0, 0.99)) / count) * 87).toInt()
                            val current = repository.getJob(job.id) ?: job
                            repository.update(current.copy(progress = progress, status = JobStatus.DOWNLOADING.name.lowercase()))
                            updateNotification("正在保存 ${index + 1}/$count", progress)
                        }
                        val updated = item.copy(size = received, downloadedBytes = received, totalBytes = total, mediaStoreUri = uri.toString())
                        ArchiveDatabase.get(this).dao().upsertMedia(listOf(updated))
                    }
                } ?: throw IllegalStateException("无法写入媒体文件")
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    contentResolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
                }
            } catch (error: Exception) {
                contentResolver.delete(uri, null, null)
                throw error
            }
        }
    }

    private fun mimeFor(filename: String): String = when (filename.substringAfterLast('.', "").lowercase()) {
        "jpg", "jpeg" -> "image/jpeg"
        "png" -> "image/png"
        "webp" -> "image/webp"
        "gif" -> "image/gif"
        else -> "video/mp4"
    }

    private fun notification(text: String, progress: Int): Notification = NotificationCompat.Builder(this, CHANNEL_ID)
        .setSmallIcon(android.R.drawable.stat_sys_download)
        .setContentTitle("X 媒体存档")
        .setContentText(text)
        .setContentIntent(PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        .setOngoing(true)
        .setProgress(100, progress, false)
        .build()

    private fun updateNotification(text: String, progress: Int) = getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(text, progress))

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel(CHANNEL_ID, "媒体下载", NotificationManager.IMPORTANCE_LOW))
        }
    }

    override fun onDestroy() {
        serviceJob.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val CHANNEL_ID = "media-downloads"
        private const val NOTIFICATION_ID = 1001
        private const val MAX_CONCURRENCY = 2
        private val canceledJobs = ConcurrentHashMap.newKeySet<String>()

        fun start(context: android.content.Context) {
            val intent = Intent(context, DownloadForegroundService::class.java)
            androidx.core.content.ContextCompat.startForegroundService(context, intent)
        }

        fun cancel(id: String) {
            canceledJobs.add(id)
        }

        fun clearCancellation(id: String) {
            canceledJobs.remove(id)
        }
    }
}
