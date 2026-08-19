package com.xmedia.archive

import android.os.Bundle
import com.getcapacitor.BridgeActivity
import com.xmedia.archive.plugin.LocalArchivePlugin

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(LocalArchivePlugin::class.java)
        super.onCreate(savedInstanceState)
    }
}
