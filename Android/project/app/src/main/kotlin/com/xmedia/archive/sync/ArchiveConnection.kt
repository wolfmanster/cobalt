package com.xmedia.archive.sync

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.io.IOException
import java.security.KeyStore
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import okhttp3.Call
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject

internal class ArchiveHttpException(val status: Int, message: String) : IOException(message)

internal class ArchiveConnection(context: Context) {
    private val prefs = context.getSharedPreferences("archive-device-sessions", Context.MODE_PRIVATE)
    private val http = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(35, TimeUnit.SECONDS).build()

    fun origin(value: String): String {
        val url = value.toHttpUrl()
        require(url.isHttps && url.username.isEmpty() && url.password.isEmpty() &&
            url.encodedPath == "/" && url.query == null && url.fragment == null) { "请输入 HTTPS 归档服务地址" }
        return url.toString().removeSuffix("/")
    }

    fun request(server: String, method: String, path: String, payload: String?): Pair<Int, JSONObject> {
        val login = method == "POST" && path == "/api/account/login"
        val body = when {
            login -> JSONObject(payload.orEmpty()).put("bearer", true).toString().toRequestBody(jsonType)
            payload != null -> payload.toRequestBody(jsonType)
            method == "POST" || method == "PUT" || method == "PATCH" -> "".toRequestBody(null)
            else -> null
        }
        val token = if (login) null else readToken(server)
        if (!login && token == null && path != "/api/health") {
            return 401 to JSONObject().put("error", "请登录归档账号")
        }
        val request = requestBuilder(server, path, token).method(method, body).build()
        return http.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            val data = runCatching { JSONObject(text) }.getOrElse { JSONObject() }
            if (login && response.isSuccessful) {
                val newToken = data.getString("token")
                require(newToken.matches(Regex("[a-f0-9]{64}"))) { "服务器会话无效" }
                saveToken(server, newToken)
                data.remove("token")
            }
            response.code to data
        }
    }

    fun json(server: String, method: String, path: String, payload: JSONObject? = null): JSONObject {
        val (status, data) = request(server, method, path, payload?.toString())
        if (status !in 200..299) throw ArchiveHttpException(status, data.optString("error", "归档请求失败（HTTP $status）"))
        return data
    }

    fun upload(server: String, path: String, bytes: ByteArray): JSONObject {
        val token = readToken(server) ?: throw ArchiveHttpException(401, "请登录归档账号")
        return http.newCall(requestBuilder(server, path, token)
            .put(bytes.toRequestBody("application/octet-stream".toMediaType())).build()).execute().use { response ->
            val data = JSONObject(response.body?.string().orEmpty())
            if (!response.isSuccessful) throw ArchiveHttpException(response.code, data.optString("error", "媒体上传失败"))
            data
        }
    }

    fun range(server: String, path: String, first: Long, last: Long, size: Long): Response {
        val token = readToken(server) ?: throw ArchiveHttpException(401, "请登录归档账号")
        val call = http.newCall(requestBuilder(server, path, token).header("Range", "bytes=$first-$last").build())
        val response = call.execute()
        if (response.code != 206 || response.header("Content-Range") != "bytes $first-$last/$size") {
            response.close()
            throw ArchiveHttpException(response.code, "媒体分段读取失败（HTTP ${response.code}）")
        }
        return response
    }

    fun eventCall(server: String): Call {
        val token = readToken(server) ?: throw ArchiveHttpException(401, "请登录归档账号")
        return http.newCall(requestBuilder(server, "/api/events", token).header("Accept", "text/event-stream").build())
    }

    private fun requestBuilder(server: String, path: String, token: String?): Request.Builder {
        require(path.startsWith("/api/") && !path.contains('\\')) { "归档接口无效" }
        val base = origin(server).toHttpUrl()
        val url = requireNotNull(base.resolve(path))
        require(url.host == base.host && url.port == base.port && url.isHttps && url.encodedPath.startsWith("/api/"))
        return Request.Builder().url(url).header("Accept", "application/json").apply {
            if (token != null) header("Authorization", "Bearer $token")
        }
    }

    private fun saveToken(server: String, token: String) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        cipher.updateAAD(server.toByteArray())
        val encrypted = cipher.iv + cipher.doFinal(token.toByteArray())
        check(prefs.edit().putString(server, Base64.encodeToString(encrypted, Base64.NO_WRAP)).commit()) { "无法保存归档登录" }
    }

    private fun readToken(server: String): String? {
        val stored = prefs.getString(server, null) ?: return null
        return runCatching {
            val bytes = Base64.decode(stored, Base64.NO_WRAP)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
            cipher.updateAAD(server.toByteArray())
            String(cipher.doFinal(bytes, 12, bytes.size - 12), Charsets.UTF_8)
        }.getOrNull()
    }

    private fun key(): SecretKey = synchronized(KEY_LOCK) {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(KEY_ALIAS, null) as? SecretKey) ?: KeyGenerator.getInstance("AES", "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).build())
            generateKey()
        }
    }

    private companion object {
        val jsonType = "application/json; charset=utf-8".toMediaType()
        val KEY_LOCK = Any()
        const val KEY_ALIAS = "cobalt-shared-archive-device"
    }
}
