package com.xmedia.archive.sync

import android.content.Context
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import com.getcapacitor.Bridge
import com.getcapacitor.BridgeWebViewClient
import java.io.ByteArrayInputStream
import java.io.FilterInputStream
import java.io.InputStream
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking

internal class ArchiveMediaClient(bridge: Bridge, private val context: Context) : BridgeWebViewClient(bridge) {
    private val local = Uri.parse(bridge.localUrl)
    private val archive = SharedArchive(context)

    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
        val uri = request.url
        val path = uri.path.orEmpty()
        if (uri.scheme != local.scheme || uri.authority != local.authority || !path.startsWith(PREFIX)) {
            return super.shouldInterceptRequest(view, request)
        }
        val hash = path.removePrefix(PREFIX)
        val server = runCatching { archive.network.origin(uri.getQueryParameter("server").orEmpty()) }.getOrNull()
        if (server == null || !hash.matches(HASH) || request.method !in listOf("GET", "HEAD")) return missing()
        val file = runBlocking(Dispatchers.IO) { archive.copy(server, hash) } ?: return missing()
        val range = request.requestHeaders.entries.firstOrNull { it.key.equals("Range", ignoreCase = true) }?.value
        val bounds = parseRange(range, file.size) ?: return response(file.contentType, 416, "Range Not Satisfiable", mapOf(
            "Content-Range" to "bytes */" + file.size,
        ))
        val length = bounds.last - bounds.first + 1
        val headers = mutableMapOf("Accept-Ranges" to "bytes", "Content-Length" to length.toString())
        if (range != null) headers["Content-Range"] = "bytes " + bounds.first + "-" + bounds.last + "/" + file.size
        val status = if (range == null) 200 else 206
        val reason = if (range == null) "OK" else "Partial Content"
        if (request.method == "HEAD") return response(file.contentType, status, reason, headers)
        return try {
            val input = context.contentResolver.openInputStream(file.uri) ?: return missing()
            try {
                seek(input, bounds.first)
                response(file.contentType, status, reason, headers, LimitedInput(input, length))
            } catch (error: Exception) {
                input.close()
                missing()
            }
        } catch (_: Exception) { missing() }
    }

    private fun missing() = response("text/plain", 404, "Not Found", emptyMap())

    private fun response(type: String, status: Int, reason: String, headers: Map<String, String>, stream: InputStream? = null) =
        WebResourceResponse(type, null, status, reason, headers + mapOf(
            "Cache-Control" to "no-store", "X-Content-Type-Options" to "nosniff", "Content-Security-Policy" to "sandbox",
        ), stream ?: ByteArrayInputStream(byteArrayOf()))

    private fun seek(input: InputStream, start: Long) {
        var remaining = start
        while (remaining > 0) {
            val skipped = input.skip(remaining)
            if (skipped > 0) remaining -= skipped
            else if (input.read() >= 0) remaining--
            else error("媒体文件不完整")
        }
    }

    private class LimitedInput(input: InputStream, private var remaining: Long) : FilterInputStream(input) {
        override fun read(): Int {
            if (remaining == 0L) return -1
            return super.read().also { if (it >= 0) remaining-- }
        }
        override fun read(bytes: ByteArray, offset: Int, length: Int): Int {
            if (length == 0) return 0
            if (remaining == 0L) return -1
            return super.read(bytes, offset, minOf(length.toLong(), remaining).toInt()).also { if (it > 0) remaining -= it }
        }
        override fun skip(length: Long) = super.skip(minOf(length, remaining)).also { remaining -= it }
        override fun available() = minOf(super.available().toLong(), remaining).toInt()
    }

    companion object {
        private const val PREFIX = "/__archive-android-media/"
        private val HASH = Regex("[a-f0-9]{64}")
        private val RANGE = Regex("^bytes=(\\d*)-(\\d*)$", RegexOption.IGNORE_CASE)

        internal fun parseRange(header: String?, size: Long): LongRange? {
            if (size <= 0) return null
            if (header == null) return 0 until size
            val match = RANGE.matchEntire(header.trim()) ?: return null
            val (start, end) = match.destructured
            if (start.isEmpty()) {
                val suffix = end.toLongOrNull()?.takeIf { it > 0 } ?: return null
                return maxOf(0, size - suffix) until size
            }
            val first = start.toLongOrNull()?.takeIf { it in 0 until size } ?: return null
            val last = if (end.isEmpty()) size - 1 else end.toLongOrNull()?.takeIf { it >= first } ?: return null
            return first..minOf(last, size - 1)
        }
    }
}
