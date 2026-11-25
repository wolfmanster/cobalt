package com.xmedia.archive

import android.app.Application
import android.webkit.WebView

/** Keeps the X login WebView in a data directory isolated from Capacitor's WebView. */
class ArchiveApplication : Application() {
    override fun onCreate() {
        if (getProcessName().endsWith(":x_login")) {
            WebView.setDataDirectorySuffix("x_login")
        }
        super.onCreate()
    }
}
