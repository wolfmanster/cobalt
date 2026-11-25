package com.xmedia.archive

import android.os.Bundle
import androidx.activity.OnBackPressedCallback
import com.getcapacitor.BridgeActivity
import com.xmedia.archive.plugin.LocalArchivePlugin
import com.xmedia.archive.sync.ArchiveMediaClient

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(LocalArchivePlugin::class.java)
        super.onCreate(savedInstanceState)
        bridge?.let { it.setWebViewClient(ArchiveMediaClient(it, applicationContext)) }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val webView = bridge?.webView
                if (webView == null) {
                    returnToSystem()
                    return
                }
                webView.evaluateJavascript("Boolean(window.__cobaltGoBack && window.__cobaltGoBack())") { handled ->
                    if (handled != "true") returnToSystem()
                }
            }

            private fun returnToSystem() {
                isEnabled = false
                onBackPressedDispatcher.onBackPressed()
                isEnabled = true
            }
        })
    }
}
