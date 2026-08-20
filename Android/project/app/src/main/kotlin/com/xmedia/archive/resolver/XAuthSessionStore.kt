package com.xmedia.archive.resolver

import android.content.Context
import android.util.Base64
import android.util.AtomicFile
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class XAuthSession(val authToken: String, val csrfToken: String)

/** Stores a user's X session encrypted with a non-exportable Android Keystore key. */
class XAuthSessionStore(context: Context) {
    // A file is used instead of SharedPreferences because the isolated login Activity runs in a
    // secondary process. AtomicFile prevents partial writes; a file lock serializes both processes.
    private val sessionFile = AtomicFile(File(context.applicationContext.noBackupFilesDir, SESSION_FILE))
    private val lockFile = File(context.applicationContext.noBackupFilesDir, LOCK_FILE)
    private val legacyPreferences = context.applicationContext.getSharedPreferences(LEGACY_PREFERENCES, Context.MODE_PRIVATE)

    fun read(): XAuthSession? = runCatching {
        withSessionLock(::readLocked)
    }.getOrElse {
        runCatching { withSessionLock(::clearLocked) }
        null
    }

    private fun readLocked(): XAuthSession? {
        if (!sessionFile.baseFile.exists()) return migrateLegacySessionLocked()
        val plaintext = decrypt(sessionFile.openRead().use { input ->
            String(input.readBytes(), StandardCharsets.US_ASCII)
        })
        val separator = plaintext.indexOf('\n')
        require(separator > 0) { "会话存储已损坏" }
        val authToken = plaintext.substring(0, separator)
        val csrfToken = plaintext.substring(separator + 1)
        require(isValidSessionValue(authToken) && isValidSessionValue(csrfToken)) { "会话存储已损坏" }
        if (hasLegacySession()) check(clearLegacySession()) { "无法清理旧版 X 会话" }
        return XAuthSession(authToken, csrfToken)
    }

    fun save(authToken: String, csrfToken: String) {
        require(isValidSessionValue(authToken)) { "auth_token 格式无效" }
        require(isValidSessionValue(csrfToken)) { "ct0 格式无效" }
        withSessionLock { saveLocked(authToken, csrfToken) }
    }

    private fun saveLocked(authToken: String, csrfToken: String) {
        val encrypted = encrypt("$authToken\n$csrfToken").toByteArray(StandardCharsets.US_ASCII)
        var output: FileOutputStream? = null
        try {
            val stream = sessionFile.startWrite()
            output = stream
            stream.write(encrypted)
            sessionFile.finishWrite(stream)
            output = null
        } finally {
            output?.let(sessionFile::failWrite)
        }
    }

    fun clear() {
        withSessionLock(::clearLocked)
    }

    private fun clearLocked() {
        sessionFile.delete()
        check(clearLegacySession()) { "无法清理旧版 X 会话" }
    }

    private fun migrateLegacySessionLocked(): XAuthSession? {
        val encryptedAuthToken = legacyPreferences.getString(LEGACY_AUTH_TOKEN, null)
        val encryptedCsrfToken = legacyPreferences.getString(LEGACY_CSRF_TOKEN, null)
        if (encryptedAuthToken == null && encryptedCsrfToken == null) return null
        require(encryptedAuthToken != null && encryptedCsrfToken != null) { "旧版会话存储不完整" }
        val authToken = decrypt(encryptedAuthToken)
        val csrfToken = decrypt(encryptedCsrfToken)
        require(isValidSessionValue(authToken) && isValidSessionValue(csrfToken)) { "旧版会话存储已损坏" }
        saveLocked(authToken, csrfToken)
        check(clearLegacySession()) { "无法清理旧版 X 会话" }
        return XAuthSession(authToken, csrfToken)
    }

    private fun hasLegacySession(): Boolean =
        legacyPreferences.contains(LEGACY_AUTH_TOKEN) || legacyPreferences.contains(LEGACY_CSRF_TOKEN)

    private fun clearLegacySession(): Boolean = legacyPreferences.edit()
        .remove(LEGACY_AUTH_TOKEN)
        .remove(LEGACY_CSRF_TOKEN)
        .commit()

    private fun <T> withSessionLock(action: () -> T): T = synchronized(PROCESS_LOCK) {
        lockFile.parentFile?.mkdirs()
        RandomAccessFile(lockFile, "rw").use { lockAccess ->
            lockAccess.channel.use { channel ->
                channel.lock().use { action() }
            }
        }
    }

    private fun encrypt(value: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val encrypted = cipher.doFinal(value.toByteArray(StandardCharsets.UTF_8))
        return "${Base64.encodeToString(cipher.iv, Base64.NO_WRAP)}:${Base64.encodeToString(encrypted, Base64.NO_WRAP)}"
    }

    private fun decrypt(value: String): String {
        val parts = value.split(':', limit = 2)
        require(parts.size == 2) { "会话存储已损坏" }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(
            Cipher.DECRYPT_MODE,
            key(),
            GCMParameterSpec(TAG_LENGTH_BITS, Base64.decode(parts[0], Base64.NO_WRAP)),
        )
        return String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8)
    }

    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance("AES", ANDROID_KEY_STORE)
        generator.init(android.security.keystore.KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            android.security.keystore.KeyProperties.PURPOSE_ENCRYPT or android.security.keystore.KeyProperties.PURPOSE_DECRYPT,
        ).setBlockModes(android.security.keystore.KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(android.security.keystore.KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build())
        return generator.generateKey()
    }

    private fun isValidSessionValue(value: String): Boolean =
        value.length in 8..512 && value.none { it == '\r' || it == '\n' || it == ';' || it.isWhitespace() }

    companion object {
        private const val SESSION_FILE = "x-authorized-session-v1"
        private const val LOCK_FILE = "x-authorized-session.lock"
        private const val LEGACY_PREFERENCES = "x-authorized-session"
        private const val LEGACY_AUTH_TOKEN = "auth-token"
        private const val LEGACY_CSRF_TOKEN = "csrf-token"
        private const val ANDROID_KEY_STORE = "AndroidKeyStore"
        private const val KEY_ALIAS = "x-media-archive-session-v1"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val TAG_LENGTH_BITS = 128
        private val PROCESS_LOCK = Any()
    }
}
