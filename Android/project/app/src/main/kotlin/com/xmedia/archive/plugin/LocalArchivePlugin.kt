package com.xmedia.archive.plugin

import android.content.Intent
import android.net.Uri
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.ActivityCallback
import com.xmedia.archive.repository.ArchiveRepository
import com.xmedia.archive.service.DownloadForegroundService
import com.xmedia.archive.storage.DownloadDestination
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

@CapacitorPlugin(name = "LocalArchive")
class LocalArchivePlugin : Plugin() {
    private lateinit var repository: ArchiveRepository
    private val scope = CoroutineScope(Dispatchers.Main.immediate + Job())

    override fun load() {
        super.load()
        repository = ArchiveRepository(context)
        scope.launch {
            repository.observeJobs().collectLatest {
                notifyListeners("jobsChanged", JSObject().put("jobs", repository.jobsJson()))
            }
        }
        scope.launch {
            if (repository.hasPendingJobs()) DownloadForegroundService.start(context)
        }
    }

    @PluginMethod
    fun listJobs(call: PluginCall) {
        scope.launch { call.resolve(JSObject().put("jobs", repository.jobsJson())) }
    }

    @PluginMethod
    fun createJobs(call: PluginCall) {
        val urls = call.getArray("urls")?.let { array -> (0 until array.length()).mapNotNull { array.optString(it).takeIf(String::isNotBlank) } }
        if (urls.isNullOrEmpty() || urls.size > 200) {
            call.reject("请提供 1–200 条帖子链接")
            return
        }
        if (!DownloadDestination.hasSelectedFolder(context)) {
            call.reject("请先选择下载文件夹")
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
        scope.launch { call.resolve(JSObject().put("ok", true).put("cobalt", true).put("local", true)) }
    }

    @PluginMethod
    fun openMedia(call: PluginCall) = launchMediaIntent(call, Intent.ACTION_VIEW)

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
        call.resolve(JSObject().put("selected", DownloadDestination.hasSelectedFolder(context)))
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
        runCatching {
            context.contentResolver.takePersistableUriPermission(uri, flags)
            DownloadDestination.saveTreeUri(context, uri)
        }.onSuccess {
            call.resolve(JSObject().put("selected", true).put("uri", uri.toString()))
        }.onFailure { error ->
            call.reject(error.message ?: "无法保存下载文件夹权限")
        }
    }

    @PluginMethod
    fun shareMedia(call: PluginCall) = launchMediaIntent(call, Intent.ACTION_SEND)

    private fun launchMediaIntent(call: PluginCall, action: String) {
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
            val intent = Intent(action).apply {
                data = if (action == Intent.ACTION_VIEW) Uri.parse(media.first) else null
                type = media.second
                if (action == Intent.ACTION_SEND) putExtra(Intent.EXTRA_STREAM, Uri.parse(media.first))
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            val launchIntent = if (action == Intent.ACTION_SEND) Intent.createChooser(intent, "分享媒体") else intent
            runCatching {
                context.startActivity(launchIntent)
            }.onSuccess {
                call.resolve()
            }.onFailure { error ->
                call.reject(error.message ?: "无法打开媒体文件")
            }
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
            if (action == "retry") DownloadForegroundService.start(context)
            val result = repository.jobJson(id)
            if (result == null) call.reject("任务不存在") else call.resolve(JSObject(result.toString()))
        }
    }
}
