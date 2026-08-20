package com.xmedia.archive

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import com.xmedia.archive.resolver.XAuthSession
import com.xmedia.archive.resolver.XAuthSessionStore
import com.xmedia.archive.resolver.xAuthSessionFromCookieHeaders

/**
 * A deliberately small login-only browser. This Activity runs in :x_login, whose WebView data
 * directory is isolated by [ArchiveApplication], so clearing it cannot affect the app UI.
 */
class XLoginActivity : Activity() {
    private lateinit var webView: WebView
    private lateinit var statusView: TextView
    private lateinit var saveButton: Button
    private var completing = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        setContentView(buildContent())
        configureWebView()
        clearLoginBrowserData { webView.loadUrl(LOGIN_URL) }
    }

    private fun buildContent(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.rgb(247, 247, 255))
        }
        val toolbar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER_VERTICAL
            setPadding(dp(10), dp(8), dp(10), dp(8))
            setBackgroundColor(Color.WHITE)
        }
        val closeButton = Button(this).apply {
            setText(R.string.x_login_cancel)
            isAllCaps = false
            setOnClickListener { cancelLogin() }
        }
        statusView = TextView(this).apply {
            setText(R.string.x_login_opening)
            setTextColor(Color.rgb(70, 65, 82))
            textSize = 13f
            setPadding(dp(10), 0, dp(10), 0)
        }
        saveButton = Button(this).apply {
            setText(R.string.x_login_save)
            isAllCaps = false
            isEnabled = false
            setOnClickListener { captureSession(showMissingMessage = true) }
        }
        toolbar.addView(closeButton, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(48)))
        toolbar.addView(statusView, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        toolbar.addView(saveButton, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(48)))
        webView = WebView(this)
        root.addView(toolbar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(64)))
        root.addView(webView, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        return root
    }

    @SuppressLint("SetJavaScriptEnabled") // X login is a JavaScript application; no JS bridge is installed.
    private fun configureWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            mediaPlaybackRequiresUserGesture = true
            safeBrowsingEnabled = true
            userAgentString = "$userAgentString VeoXLogin/1"
        }
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, true)
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, progress: Int) {
                if (!completing && progress < 100) statusView.text = getString(R.string.x_login_loading, progress)
            }
        }
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (isAllowedTopLevelUrl(request.url)) return false
                Toast.makeText(this@XLoginActivity, R.string.x_login_external_blocked, Toast.LENGTH_SHORT).show()
                return true
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                if (completing) return
                statusView.setText(R.string.x_login_instruction)
                captureSession(showMissingMessage = false)
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame && !completing) {
                    statusView.setText(R.string.x_login_load_failed)
                }
            }
        }
    }

    private fun captureSession(showMissingMessage: Boolean) {
        if (completing) return
        val cookies = CookieManager.getInstance()
        val session = xAuthSessionFromCookieHeaders(COOKIE_ORIGINS.map(cookies::getCookie))
        if (session == null) {
            saveButton.isEnabled = false
            if (showMissingMessage) {
                Toast.makeText(this, R.string.x_login_not_detected, Toast.LENGTH_SHORT).show()
            }
            return
        }
        saveButton.isEnabled = true
        completeLogin(session)
    }

    private fun completeLogin(session: XAuthSession) {
        completing = true
        saveButton.isEnabled = false
        statusView.setText(R.string.x_login_saving)
        runCatching { XAuthSessionStore(applicationContext).save(session.authToken, session.csrfToken) }
            .onFailure { error ->
                completing = false
                saveButton.isEnabled = true
                statusView.setText(R.string.x_login_save_failed)
                Toast.makeText(this, error.message ?: getString(R.string.x_login_save_failed_detail), Toast.LENGTH_LONG).show()
            }
            .onSuccess {
                clearLoginBrowserData {
                    setResult(RESULT_OK)
                    finish()
                }
            }
    }

    private fun cancelLogin() {
        if (completing) return
        completing = true
        statusView.setText(R.string.x_login_cleaning)
        clearLoginBrowserData {
            setResult(RESULT_CANCELED)
            finish()
        }
    }

    private fun clearLoginBrowserData(done: () -> Unit) {
        webView.stopLoading()
        webView.clearHistory()
        webView.clearFormData()
        webView.clearCache(true)
        WebStorage.getInstance().deleteAllData()
        CookieManager.getInstance().removeAllCookies {
            CookieManager.getInstance().flush()
            webView.post(done)
        }
    }

    private fun isAllowedTopLevelUrl(uri: Uri): Boolean {
        if (uri.scheme != "https") return false
        val host = uri.host?.lowercase() ?: return false
        return host == "x.com" || host.endsWith(".x.com") || host == "twitter.com" || host.endsWith(".twitter.com")
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        when {
            completing -> Unit
            webView.canGoBack() -> webView.goBack()
            else -> cancelLogin()
        }
    }

    override fun onDestroy() {
        webView.stopLoading()
        webView.removeAllViews()
        webView.destroy()
        super.onDestroy()
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    companion object {
        private const val LOGIN_URL = "https://x.com/i/flow/login"
        private val COOKIE_ORIGINS = listOf("https://x.com/", "https://api.x.com/", "https://twitter.com/")
    }
}
