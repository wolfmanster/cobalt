package com.xmedia.archive.storage

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.MediaStore
import androidx.documentfile.provider.DocumentFile

object DownloadDestination {
    const val DIRECTORY = "Download/X Media Archive"
    private const val PREFERENCES = "download-destination"
    private const val DOWNLOAD_PATH = "download-path"
    private const val TREE_URI = "tree-uri"

    data class Selection(val selected: Boolean, val mode: String, val label: String)
    data class TargetRoot(val downloadPath: String, val treeUri: Uri?)

    fun selection(context: Context): Selection {
        val tree = savedTree(context)
        if (tree != null) {
            val permitted = context.contentResolver.persistedUriPermissions.any {
                it.uri == tree && it.isReadPermission && it.isWritePermission
            }
            val documentId = runCatching { DocumentsContract.getTreeDocumentId(tree) }.getOrNull()
            val label = if (documentId?.startsWith("primary:") == true) {
                documentId.removePrefix("primary:").ifBlank { "内部存储" }
            } else {
                runCatching { DocumentFile.fromTreeUri(context, tree)?.name }.getOrNull()
                    ?: "已选文件夹"
            }
            return Selection(permitted, "folder", label)
        }
        return Selection(true, "downloads", downloadPath(context))
    }

    fun saveDownloadPath(context: Context, subfolder: String): Selection {
        val path = normalizeSubfolder(subfolder)
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit()
            .putString(DOWNLOAD_PATH, path)
            .remove(TREE_URI)
            .apply()
        return selection(context)
    }

    fun saveTreeUri(context: Context, uri: Uri): Selection {
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit()
            .putString(TREE_URI, uri.toString())
            .apply()
        return selection(context)
    }

    fun downloadPath(context: Context): String = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        .getString(DOWNLOAD_PATH, DIRECTORY) ?: DIRECTORY

    fun currentRoot(context: Context): TargetRoot {
        val tree = savedTree(context)
        if (tree != null) check(selection(context).selected) { "已选文件夹权限失效，请重新选择下载位置" }
        return TargetRoot(downloadPath(context), tree)
    }

    private fun savedTree(context: Context): Uri? = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        .getString(TREE_URI, null)?.let(Uri::parse)

    internal fun normalizeSubfolder(value: String): String {
        val trimmed = value.trim()
        val input = when {
            trimmed.equals("Download", ignoreCase = true) -> ""
            trimmed.startsWith("Download/", ignoreCase = true) -> trimmed.substring("Download/".length)
            else -> trimmed
        }
        if (input.isEmpty()) return "Download"
        val parts = input.split('/')
        require(parts.all { part ->
            part.isNotBlank() && part == part.trim() && part != "." && part != ".." &&
                part.toByteArray(Charsets.UTF_8).size <= 200 &&
                part.none { it.code < 32 || it in "<>:\"\\|?*" }
        }) { "文件夹名称不能包含空段、特殊字符或超过 200 字节" }
        return "Download/${parts.joinToString("/")}"
    }

    fun createTarget(context: Context, relativePostDirectory: String, filename: String, contentType: String,
                     targetRoot: TargetRoot = currentRoot(context)): Uri {
        val tree = targetRoot.treeUri
        if (tree != null) {
            val root = DocumentFile.fromTreeUri(context, tree)
                ?: throw IllegalStateException("已选文件夹不可用，请重新选择下载位置")
            val directory = relativePostDirectory.split('/').filter(String::isNotBlank).fold(root) { parent, name ->
                parent.findFile(name)?.takeIf { it.isDirectory }
                    ?: parent.createDirectory(name)
                    ?: throw IllegalStateException("无法创建存档文件夹：$name")
            }
            return directory.createFile(contentType, filename)?.uri
                ?: throw IllegalStateException("无法创建媒体文件：$filename")
        }
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, filename)
            put(MediaStore.MediaColumns.MIME_TYPE, contentType)
            put(MediaStore.MediaColumns.RELATIVE_PATH, "${targetRoot.downloadPath}/$relativePostDirectory")
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        return context.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: throw IllegalStateException("无法创建媒体文件")
    }

    fun finishTarget(context: Context, uri: Uri) {
        if (uri.authority != "media") return
        val values = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
        if (context.contentResolver.update(uri, values, null, null) <= 0) {
            throw IllegalStateException("无法完成媒体文件保存")
        }
    }

    fun deleteTarget(context: Context, uri: Uri) {
        if (uri.authority == "media") context.contentResolver.delete(uri, null, null)
        else DocumentFile.fromSingleUri(context, uri)?.delete()
    }
}
