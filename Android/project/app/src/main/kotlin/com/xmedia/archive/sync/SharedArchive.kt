package com.xmedia.archive.sync

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import com.xmedia.archive.data.ArchiveDatabase
import com.xmedia.archive.data.ArchiveImportEntity
import com.xmedia.archive.data.JobEntity
import com.xmedia.archive.data.MediaEntity
import com.xmedia.archive.data.SyncedCatalogEntity
import com.xmedia.archive.data.SyncedMediaEntity
import com.xmedia.archive.resolver.ResolvedMetadata
import com.xmedia.archive.storage.ArchivePaths
import com.xmedia.archive.storage.DownloadDestination
import java.io.EOFException
import java.io.File
import java.io.FileNotFoundException
import java.io.InputStream
import java.io.RandomAccessFile
import java.security.MessageDigest
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject

internal class SharedArchive(private val context: Context) {
    private val dao = ArchiveDatabase.get(context).dao()
    private val resolver = context.contentResolver
    private val importLock = Mutex()
    private val copyLock = Mutex()
    val network = ArchiveConnection(context)

    suspend fun loadCatalog(server: String): JSONObject? {
        val rows = dao.syncedCatalog(server)
        val header = rows.firstOrNull { it.key == "catalog" } ?: return null
        return JSONObject(header.json).put("posts", JSONArray(rows.filter { it.key != "catalog" }.map { JSONObject(it.json) }))
    }

    suspend fun saveCatalog(server: String, catalog: JSONObject) {
        val posts = catalog.getJSONArray("posts")
        val header = JSONObject().put("version", catalog.getString("version"))
            .put("chunkSize", catalog.getInt("chunkSize")).put("categories", catalog.getJSONArray("categories"))
        val rows = mutableListOf(SyncedCatalogEntity(server, "catalog", header.toString()))
        for (index in 0 until posts.length()) {
            val post = posts.getJSONObject(index)
            rows.add(SyncedCatalogEntity(server, post.getString("tweetId"), post.toString()))
        }
        dao.replaceSyncedCatalog(server, rows)
    }

    suspend fun importDownloads(server: String, retry: Boolean): JSONObject = importLock.withLock {
        val previous = dao.archiveImports(server).associateBy { it.jobId }
        val localCategories = dao.listTweetCategories()
        val categoryNames = localCategories.associate { it.id to it.name }
        for (job in dao.legacyDownloads()) {
            currentCoroutineContext().ensureActive()
            val record = previous[job.id]
            if (record != null && (!retry || (record.missing == "[]" && record.permissions == "[]"))) continue
            val names = dao.tweetCategoryAssignments(listOf(job.tweetId)).mapNotNull { categoryNames[it.categoryId] }.distinct()
            importPost(server, job, names)
        }
        if (CATEGORY_STEP !in previous) {
            for (names in localCategories.filter { it.tweetCount == 0 }.map { it.name }.chunked(500)) {
                network.json(server, "POST", "/api/import/categories", JSONObject().put("categories", JSONArray(names)))
            }
            dao.saveArchiveImport(ArchiveImportEntity(server, CATEGORY_STEP, "", "[]", "[]"))
        }
        val records = dao.archiveImports(server).filter { it.jobId != CATEGORY_STEP }
        fun issues(select: (ArchiveImportEntity) -> String) = JSONArray().also { result ->
            records.forEach { record ->
                val names = JSONArray(select(record))
                for (index in 0 until names.length()) result.put(JSONObject()
                    .put("tweetId", record.tweetId).put("filename", names.getString(index)))
            }
        }
        JSONObject().put("merged", JSONArray(records.map { it.tweetId }.distinct()))
            .put("missing", issues { it.missing }).put("permissions", issues { it.permissions })
    }

    private suspend fun importPost(server: String, job: JobEntity, categoryNames: List<String>) {
        val merged = JSONArray()
        val missing = JSONArray()
        val permissions = JSONArray()
        for (media in dao.mediaForJob(job.id)) {
            currentCoroutineContext().ensureActive()
            val uri = media.mediaStoreUri?.let(Uri::parse)
            if (uri == null) { missing.put(media.filename); continue }
            try {
                val readable = currentUri(uri)
                val identity = open(readable).use(::identify)
                if (identity.size == 0L || media.size?.let { it > 0 && it != identity.size } == true) {
                    missing.put(media.filename)
                    continue
                }
                val type = mimeType(media)
                upload(server, readable, identity)
                dao.saveSyncedMedia(SyncedMediaEntity(server, identity.hash, identity.size, readable.toString(), type, ready = true))
                merged.put(JSONObject().put("sha256", identity.hash).put("size", identity.size)
                    .put("filename", media.filename).put("contentType", type).put("kind", media.kind))
            } catch (_: SecurityException) {
                permissions.put(media.filename)
            } catch (_: FileNotFoundException) {
                missing.put(media.filename)
            }
        }
        val payload = JSONObject().put("tweetId", job.tweetId)
            .put("createdAt", job.createdAt).put("completedAt", job.completedAt ?: job.updatedAt)
            .put("categories", JSONArray(categoryNames)).put("media", merged)
            .put("unavailableMedia", missing.length() + permissions.length())
        if (job.username != null || job.authorName != null) {
            payload.put("metadata", JSONObject().put("authorName", job.authorName.orEmpty()).put("username", job.username.orEmpty())
                .put("userId", job.userId.orEmpty()).put("avatarUrl", job.avatarUrl.orEmpty()).put("text", job.text.orEmpty())
                .put("language", job.language.orEmpty()).put("publishedAt", job.publishedAt.orEmpty()))
        }
        payload.put("importRevision", digest(payload.toString().toByteArray()))
        network.json(server, "POST", "/api/import/posts", payload)
        dao.saveArchiveImport(ArchiveImportEntity(server, job.id, job.tweetId, missing.toString(), permissions.toString()))
    }

    private suspend fun upload(server: String, uri: Uri, identity: Identity) {
        val path = "/api/import/media/" + identity.hash + "?size=" + identity.size
        var status = network.json(server, "GET", path)
        if (status.getBoolean("complete")) return
        open(uri).use { input ->
            var position = 0L
            while (!status.getBoolean("complete")) {
                currentCoroutineContext().ensureActive()
                val offset = status.getLong("offset")
                check(offset in position until identity.size) { "服务器返回的导入进度无效" }
                skip(input, offset - position)
                val bytes = ByteArray(minOf(CHUNK_SIZE.toLong(), identity.size - offset).toInt())
                read(input, bytes)
                position = offset + bytes.size
                status = network.upload(server, "$path&offset=$offset", bytes)
                check(status.getLong("offset") >= position) { "原文件上传进度未保存" }
            }
        }
    }

    suspend fun copies(server: String, hashes: Set<String>): JSONObject {
        val available = JSONObject()
        for (file in dao.syncedCopies(server)) {
            if (file.sha256 !in hashes) continue
            val uri = availableUri(file) ?: continue
            available.put(file.sha256, uri.toString())
        }
        return JSONObject().put("copies", available)
    }

    data class LocalCopy(val uri: Uri, val contentType: String, val size: Long)

    suspend fun copy(server: String, hash: String): LocalCopy? {
        val file = dao.syncedMedia(server, hash)?.takeIf { it.ready } ?: return null
        return availableUri(file)?.let { LocalCopy(it, file.contentType, file.size) }
    }

    suspend fun download(server: String, tweetId: String, metadata: JSONObject?, media: JSONObject, chunkSize: Int): Uri = copyLock.withLock {
        val hash = media.getString("sha256")
        val size = media.getLong("size")
        val path = media.getString("previewUrl")
        require(hash.matches(Regex("[a-f0-9]{64}")) && size > 0 && chunkSize == CHUNK_SIZE &&
            path.matches(Regex("/api/jobs/[^/]+/media/[^/]+"))) { "同步清单无效" }
        require(tweetId.matches(Regex("[0-9]{1,30}"))) { "帖子编号无效" }
        val type = media.optString("contentType", "application/octet-stream")
        val record = dao.syncedMedia(server, hash)
        if (record?.ready == true) availableUri(record)?.let { return it }
        val root = DownloadDestination.currentRoot(context)
        val staging = File(context.filesDir, "archive-transfer/" + digest(server.toByteArray()))
        check(staging.isDirectory || staging.mkdirs()) { "无法创建媒体暂存目录" }
        val part = File(staging, "$hash.part")
        val existingTarget = record?.takeUnless { it.ready }?.let { Uri.parse(it.uri) }
        if (existingTarget != null && runCatching { open(existingTarget).use(::identify) == Identity(hash, size) }.getOrDefault(false)) {
            DownloadDestination.finishTarget(context, existingTarget)
            dao.saveSyncedMedia(SyncedMediaEntity(server, hash, size, existingTarget.toString(), type, ready = true))
            part.delete()
            return existingTarget
        }

        RandomAccessFile(part, "rw").use { output ->
            val length = output.length()
            val checkpoint = when {
                length == size -> length
                length > size -> 0L
                else -> length - length % chunkSize
            }
            output.setLength(checkpoint)
            var offset = checkpoint
            while (offset < size) {
                currentCoroutineContext().ensureActive()
                val end = minOf(offset + chunkSize, size) - 1
                val bytes = ByteArray((end - offset + 1).toInt())
                network.range(server, path, offset, end, size).use { response ->
                    requireNotNull(response.body).byteStream().use { input -> read(input, bytes) }
                }
                val expected = media.optJSONArray("chunkHashes")?.optString((offset / chunkSize).toInt())
                check(expected == digest(bytes)) { "媒体分段校验失败" }
                output.seek(offset)
                output.write(bytes)
                output.fd.sync()
                offset = end + 1
            }
        }
        if (part.inputStream().use(::identify) != Identity(hash, size)) {
            part.delete()
            error("媒体原文件校验失败")
        }
        val post = ResolvedMetadata(metadata.string("authorName"), metadata.string("username"), metadata.string("userId"),
            metadata.string("avatarUrl"), metadata.string("text"), metadata.string("language"), metadata.string("publishedAt"))
        val filename = media.getString("filename").map { char ->
            if (char.isISOControl() || char in "<>:\"/\\|?*") '_' else char
        }.joinToString("").take(150).ifBlank { "$hash.media" }
        val folder = ArchivePaths.postDirectory(post, tweetId)
        val target = existingTarget?.takeIf { candidate ->
            runCatching { resolver.openFileDescriptor(candidate, "rw")?.use { true } ?: false }.getOrDefault(false)
        } ?: DownloadDestination.createTarget(context, folder, filename, type, root)
        val pending = SyncedMediaEntity(server, hash, size, target.toString(), type, ready = false)
        dao.saveSyncedMedia(pending)
        val output = resolver.openOutputStream(target, "wt") ?: error("无法保存媒体副本")
        output.use { destination -> part.inputStream().use { it.copyTo(destination) } }
        check(open(target).use(::identify) == Identity(hash, size)) { "保存后的本机文件校验失败" }
        DownloadDestination.finishTarget(context, target)
        dao.saveSyncedMedia(pending.copy(ready = true))
        part.delete()
        target
    }

    private fun availableUri(file: SyncedMediaEntity): Uri? = runCatching {
        val uri = currentUri(Uri.parse(file.uri))
        resolver.openAssetFileDescriptor(uri, "r")?.use { handle ->
            uri.takeIf { handle.length < 0 || handle.length == file.size }
        }
    }.getOrNull()

    private fun currentUri(uri: Uri): Uri {
        if (!DocumentsContract.isTreeUri(uri)) return uri
        val document = DocumentsContract.getDocumentId(uri)
        val original = DocumentsContract.getTreeDocumentId(uri)
        val permission = resolver.persistedUriPermissions.firstOrNull {
            if (!it.isReadPermission || it.uri.authority != uri.authority || !DocumentsContract.isTreeUri(it.uri)) return@firstOrNull false
            val granted = DocumentsContract.getTreeDocumentId(it.uri)
            granted == original || (uri.authority == "com.android.externalstorage.documents" &&
                (document == granted || document.startsWith(if (granted.endsWith(':')) granted else "$granted/")))
        } ?: throw SecurityException("请重新授权原下载目录")
        return DocumentsContract.buildDocumentUriUsingTree(permission.uri, document)
    }

    private fun open(uri: Uri) = resolver.openInputStream(uri) ?: throw FileNotFoundException(uri.toString())

    private fun mimeType(media: MediaEntity): String {
        media.contentType?.substringBefore(';')?.lowercase()?.takeIf { it in SUPPORTED_TYPES }?.let { return it }
        return when (media.filename.substringAfterLast('.').lowercase()) {
            "png" -> "image/png"
            "gif" -> "image/gif"
            "webp" -> "image/webp"
            "avif" -> "image/avif"
            "mp4" -> "video/mp4"
            "webm" -> "video/webm"
            "mov" -> "video/quicktime"
            else -> if (media.kind == "video") "video/mp4" else "image/jpeg"
        }
    }

    private data class Identity(val hash: String, val size: Long)

    private fun identify(input: InputStream): Identity {
        val hash = MessageDigest.getInstance("SHA-256")
        val bytes = ByteArray(128 * 1024)
        var size = 0L
        while (true) {
            val count = input.read(bytes)
            if (count < 0) break
            hash.update(bytes, 0, count)
            size += count
        }
        return Identity(hex(hash.digest()), size)
    }

    private fun read(input: InputStream, bytes: ByteArray) {
        var filled = 0
        while (filled < bytes.size) {
            val count = input.read(bytes, filled, bytes.size - filled)
            if (count < 0) throw EOFException("媒体分段不完整")
            filled += count
        }
    }

    private fun skip(input: InputStream, bytes: Long) {
        var remaining = bytes
        while (remaining > 0) {
            val skipped = input.skip(remaining)
            if (skipped > 0) remaining -= skipped
            else if (input.read() >= 0) remaining--
            else throw EOFException("原文件读取不完整")
        }
    }

    private fun JSONObject?.string(key: String) = this?.optString(key).orEmpty()
    private fun digest(bytes: ByteArray) = hex(MessageDigest.getInstance("SHA-256").digest(bytes))
    private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }

    private companion object {
        const val CATEGORY_STEP = "empty-categories"
        const val CHUNK_SIZE = 2 * 1024 * 1024
        val SUPPORTED_TYPES = setOf("image/jpeg", "image/png", "image/webp", "image/gif", "image/avif", "video/mp4", "video/webm", "video/quicktime")
    }
}
