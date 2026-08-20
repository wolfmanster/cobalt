package com.xmedia.archive.storage

import android.content.Context
import android.net.Uri
import androidx.documentfile.provider.DocumentFile

object DownloadDestination {
    private const val PREFERENCES = "download-destination"
    private const val TREE_URI = "tree-uri"

    fun saveTreeUri(context: Context, uri: Uri) {
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
            .edit()
            .putString(TREE_URI, uri.toString())
            .apply()
    }

    fun hasSelectedFolder(context: Context): Boolean =
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).contains(TREE_URI)

    @Synchronized
    fun createTarget(context: Context, relativePostDirectory: String, filename: String, contentType: String): Uri {
        val savedTree = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).getString(TREE_URI, null)
            ?: throw IllegalStateException("请先选择下载文件夹")
        val root = DocumentFile.fromTreeUri(context, Uri.parse(savedTree))
            ?: throw IllegalStateException("已选择的下载文件夹不可用，请重新选择")
        val directory = relativePostDirectory.split('/').filter(String::isNotBlank).fold(root) { parent, name ->
            parent.findFile(name)?.takeIf { it.isDirectory }
                ?: parent.createDirectory(name)
                ?: throw IllegalStateException("无法创建存档文件夹，请重新选择下载文件夹后重试")
        }
        directory.findFile(filename)?.let { existing ->
            if (!existing.delete()) throw IllegalStateException("无法替换已有文件：$filename")
        }
        return directory.createFile(contentType, filename)?.uri
            ?: throw IllegalStateException("无法创建媒体文件：$filename")
    }
}
