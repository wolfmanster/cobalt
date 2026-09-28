package com.xmedia.archive.plugin

import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.os.StrictMode
import android.provider.DocumentsContract
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.ActivityCallback
import com.xmedia.archive.XLoginActivity
import com.xmedia.archive.data.JobStatus
import com.xmedia.archive.repository.ArchiveRepository
import com.xmedia.archive.resolver.XAuthSessionStore
import com.xmedia.archive.service.DownloadForegroundService
import com.xmedia.archive.storage.DownloadDestination
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

@CapacitorPlugin(name = "LocalArchive")
class LocalArchivePlugin : Plugin() {
    private lateinit var repository: ArchiveRepository
    private lateinit var sessionStore: XAuthSessionStore
    private val scope = CoroutineScope(Dispatchers.Main.immediate + Job())
    private var pendingSharedText: String? = null

    override fun load() {
        super.load()
        pendingSharedText = sharedTextFromIntent(activity?.intent)
        repository = ArchiveRepository(context)
        sessionStore = XAuthSessionStore(context)
        scope.launch {
            repository.observeJobs().collectLatest {
                notifyListeners("jobsChanged", JSObject())
            }
        }
        scope.launch {
            if (repository.hasPendingJobs()) DownloadForegroundService.start(context)
        }
    }

    override fun handleOnNewIntent(intent: Intent) {
        val sharedText = sharedTextFromIntent(intent) ?: return
        pendingSharedText = sharedText
        notifyListeners(
            "sharedContent",
            JSObject().put("text", sharedText),
            true,
        )
    }

    @PluginMethod
    fun consumeSharedContent(call: PluginCall) {
        val sharedText = pendingSharedText
        pendingSharedText = null
        call.resolve(JSObject().put("text", sharedText ?: ""))
    }

    @PluginMethod
    fun listJobs(call: PluginCall) {
        val historyOffset = (call.getInt("historyOffset") ?: 0).coerceAtLeast(0)
        val historyLimit = (call.getInt("historyLimit") ?: 25).coerceIn(1, 50)
        scope.launch { call.resolve(JSObject(repository.jobListJson(historyOffset, historyLimit).toString())) }
    }

    @PluginMethod
    fun createJobs(call: PluginCall) {
        val urls = call.getArray("urls")?.let { array -> (0 until array.length()).mapNotNull { array.optString(it).takeIf(String::isNotBlank) } }
        if (urls.isNullOrEmpty() || urls.size > 200) {
            call.reject("请提供 1–200 条帖子链接")
            return
        }
        scope.launch {
            val result = repository.createJobs(urls)
            DownloadForegroundService.start(context)
            call.resolve(JSObject()
                .put("created", result.optJSONArray("created"))
                .put("duplicates", result.optJSONArray("duplicates"))
                .put("rejected", result.optJSONArray("rejected")))
        }
    }

    @PluginMethod
    fun cancelJob(call: PluginCall) = changeStatus(call, "cancel")

    @PluginMethod
    fun retryJob(call: PluginCall) = changeStatus(call, "retry")

    @PluginMethod
    fun clearHistory(call: PluginCall) {
        scope.launch { call.resolve(JSObject().put("removed", repository.clearHistory())) }
    }

    @PluginMethod
    fun getHealth(call: PluginCall) {
        scope.launch {
            val healthy = runCatching { repository.hasPendingJobs() }.isSuccess
            call.resolve(JSObject().put("ok", healthy).put("cobalt", true).put("local", true))
        }
    }

    @PluginMethod
    fun getXSessionStatus(call: PluginCall) {
        scope.launch {
            val configured = withContext(Dispatchers.IO) { sessionStore.read() != null }
            call.resolve(JSObject().put("configured", configured))
        }
    }

    @PluginMethod
    fun startXLogin(call: PluginCall) {
        startActivityForResult(call, Intent(context, XLoginActivity::class.java), "onXLoginFinished")
    }

    @ActivityCallback
    private fun onXLoginFinished(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        scope.launch {
            val configured = withContext(Dispatchers.IO) { sessionStore.read() != null }
            call.resolve(JSObject()
                .put("configured", configured)
                .put("canceled", result.resultCode != android.app.Activity.RESULT_OK))
        }
    }

    @PluginMethod
    fun clearXSession(call: PluginCall) {
        scope.launch {
            runCatching { withContext(Dispatchers.IO) { sessionStore.clear() } }
                .onSuccess { call.resolve(JSObject().put("configured", false)) }
                .onFailure { error -> call.reject(error.message ?: "无法移除 X 会话") }
        }
    }

    @PluginMethod
    fun readClipboard(call: PluginCall) {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
        val text = clipboard?.primaryClip
            ?.takeIf { it.itemCount > 0 }
            ?.getItemAt(0)
            ?.coerceToText(context)
            ?.toString()
            .orEmpty()
        call.resolve(JSObject().put("text", text))
    }

    @PluginMethod
    fun openMedia(call: PluginCall) {
        val id = call.getString("id")
        if (id.isNullOrBlank()) {
            call.reject("缺少媒体 ID")
            return
        }
        scope.launch {
            val media = repository.mediaUri(id)
            if (media == null) {
                call.reject("媒体文件不存在")
                return@launch
            }
            val mediaUri = Uri.parse(media.first)
            val miuiIntent = miuiFileExplorerIntent(mediaUri)
            val intent = when {
                miuiIntent != null -> miuiIntent
                else -> Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(mediaUri, media.second)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                }
            }
            runCatching {
                if (miuiIntent != null) {
                    startMiuiFileExplorer(intent)
                } else {
                    context.startActivity(intent)
                }
            }.onSuccess {
                call.resolve()
            }.onFailure { error ->
                call.reject(error.message ?: "无法打开文件位置")
            }
        }
    }

    @PluginMethod
    fun listDownloadedPosts(call: PluginCall) {
        val offset = (call.getInt("offset") ?: 0).coerceAtLeast(0)
        val limit = (call.getInt("limit") ?: 25).coerceIn(1, 25)
        val query = call.getString("query").orEmpty()
        val authorKey = call.getString("authorKey")?.takeIf(String::isNotBlank)
        scope.launch {
            try {
                call.resolve(JSObject(repository.downloadedPostsJson(authorKey, query, offset, limit).toString()))
            } catch (error: Exception) {
                call.reject(error.message ?: "无法读取已下载推文")
            }
        }
    }

    @PluginMethod
    fun listAuthors(call: PluginCall) {
        val offset = (call.getInt("offset") ?: 0).coerceAtLeast(0)
        val limit = (call.getInt("limit") ?: 25).coerceIn(1, 25)
        scope.launch {
            try {
                call.resolve(JSObject(repository.authorsJson(call.getString("query").orEmpty(), offset, limit).toString()))
            } catch (error: Exception) {
                call.reject(error.message ?: "无法读取作者列表")
            }
        }
    }

    private fun miuiFileExplorerIntent(mediaUri: Uri): Intent? {
        val installed = runCatching {
            context.packageManager.getPackageInfo("com.android.fileexplorer", 0)
        }.isSuccess
        if (!installed || mediaUri.authority != "com.android.externalstorage.documents") return null

        val documentId = runCatching { DocumentsContract.getDocumentId(mediaUri) }.getOrNull() ?: return null
        val separator = documentId.indexOf(':')
        if (separator < 1 || documentId.substring(0, separator) != "primary") return null

        val relativePath = documentId.substring(separator + 1)
        val parent = File(Environment.getExternalStorageDirectory(), relativePath).parentFile ?: return null
        return Intent(Intent.ACTION_VIEW, Uri.fromFile(parent)).apply {
            component = ComponentName("com.android.fileexplorer", "com.android.fileexplorer.FileExplorerTabActivity")
        }
    }

    private fun startMiuiFileExplorer(intent: Intent) {
        val originalPolicy = StrictMode.getVmPolicy()
        try {
            // Xiaomi File Explorer needs file:// for folder navigation. Suppress URI exposure
            // checks only while starting this explicit system component.
            StrictMode.setVmPolicy(StrictMode.VmPolicy.Builder().build())
            context.startActivity(intent)
        } finally {
            StrictMode.setVmPolicy(originalPolicy)
        }
    }

    @PluginMethod
    fun selectDownloadFolder(call: PluginCall) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        }
        startActivityForResult(call, intent, "onDownloadFolderSelected")
    }

    @PluginMethod
    fun getDownloadFolder(call: PluginCall) {
        val selection = DownloadDestination.selection(context)
        call.resolve(JSObject().put("selected", selection.selected).put("mode", selection.mode).put("label", selection.label))
    }

    @PluginMethod
    fun setDownloadPath(call: PluginCall) {
        val path = call.getString("path") ?: ""
        runCatching { DownloadDestination.saveDownloadPath(context, path) }
            .onSuccess { selection ->
                call.resolve(JSObject().put("selected", selection.selected).put("mode", selection.mode).put("label", selection.label))
            }
            .onFailure { error -> call.reject(error.message ?: "无法设置下载位置") }
    }

    @ActivityCallback
    private fun onDownloadFolderSelected(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        val uri = result.data?.data
        if (result.resultCode != android.app.Activity.RESULT_OK || uri == null) {
            call.resolve(JSObject().put("selected", false))
            return
        }
        val flags = result.data?.flags?.and(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            ?: (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        if (flags != (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)) {
            call.reject("所选文件夹未授予读写权限")
            return
        }
        runCatching {
            context.contentResolver.takePersistableUriPermission(uri, flags)
            DownloadDestination.saveTreeUri(context, uri)
        }.onSuccess { selection ->
            call.resolve(JSObject().put("selected", selection.selected).put("mode", selection.mode).put("label", selection.label))
        }.onFailure { error ->
            call.reject(error.message ?: "无法保存下载文件夹权限")
        }
    }

    private fun changeStatus(call: PluginCall, action: String) {
        val id = call.getString("id")
        if (id.isNullOrBlank()) {
            call.reject("缺少任务 ID")
            return
        }
        scope.launch {
            if (action == "cancel") DownloadForegroundService.cancel(id) else DownloadForegroundService.clearCancellation(id)
            val changed = if (action == "cancel") repository.cancel(id) else repository.retry(id)
            if (!changed) {
                call.reject("该任务无法${if (action == "cancel") "取消" else "重试"}")
                return@launch
            }
            if (action == "retry" && !DownloadForegroundService.start(context)) {
                repository.getJob(id)?.let { job ->
                    repository.update(job.copy(
                        status = JobStatus.FAILED.name.lowercase(),
                        error = "系统暂不允许后台启动下载；请解锁设备并保持应用在前台后重试",
                    ))
                }
                call.reject("请解锁设备并保持应用在前台后重试")
                return@launch
            }
            val result = repository.jobJson(id)
            if (result == null) call.reject("任务不存在") else call.resolve(JSObject(result.toString()))
        }
    }

    private fun sharedTextFromIntent(intent: Intent?): String? {
        if (intent?.action != Intent.ACTION_SEND) return null
        return intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()?.trim()?.takeIf(String::isNotBlank)
    }
}
