plugins {
    id("com.android.library")
}

val capacitorJavaSource = file("../../../node_modules/@capacitor/android/capacitor/src/main/java")
val preparedJavaSource = layout.buildDirectory.dir("generated/capacitor/java")

val prepareCapacitorJavaSources = tasks.register<Sync>("prepareCapacitorJavaSources") {
    from(capacitorJavaSource)
    into(preparedJavaSource)
    doLast {
        val server = preparedJavaSource.get().asFile.resolve("com/getcapacitor/WebViewLocalServer.java")
        var source = server.readText()
        val start = source.indexOf("        return switch (code) {")
        val end = source.indexOf("        };", start)
        check(start >= 0 && end >= 0) { "Unable to locate the Java switch expression in WebViewLocalServer.java" }
        val cases = listOf(
            100 to "Continue", 101 to "Switching Protocols", 200 to "OK", 201 to "Created",
            202 to "Accepted", 203 to "Non-Authoritative Information", 204 to "No Content",
            205 to "Reset Content", 206 to "Partial Content", 300 to "Multiple Choices",
            301 to "Moved Permanently", 302 to "Found", 303 to "See Other", 304 to "Not Modified",
            400 to "Bad Request", 401 to "Unauthorized", 403 to "Forbidden", 404 to "Not Found",
            405 to "Method Not Allowed", 406 to "Not Acceptable", 407 to "Proxy Authentication Required",
            408 to "Request Timeout", 409 to "Conflict", 410 to "Gone", 500 to "Internal Server Error",
            501 to "Not Implemented", 502 to "Bad Gateway", 503 to "Service Unavailable",
            504 to "Gateway Timeout", 505 to "HTTP Version Not Supported"
        )
        val replacement = buildString {
            appendLine("        switch (code) {")
            cases.forEach { (code, label) -> appendLine("            case $code: return \"$label\";") }
            appendLine("            default: return \"Unknown\";")
            append("        }")
        }
        server.writeText(source.replaceRange(start, end + "        };".length, replacement))
    }
}

android {
    namespace = "com.getcapacitor.android"
    compileSdk = 36

    defaultConfig {
        minSdk = 23
        targetSdk = 36
        consumerProguardFiles("proguard-rules.pro")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }

    sourceSets["main"].java.srcDirs(preparedJavaSource)
    sourceSets["main"].assets.srcDirs("../../../node_modules/@capacitor/android/capacitor/src/main/assets")
    sourceSets["main"].res.srcDirs("../../../node_modules/@capacitor/android/capacitor/src/main/res")
    sourceSets["main"].manifest.srcFile("../../../node_modules/@capacitor/android/capacitor/src/main/AndroidManifest.xml")
}

tasks.withType<JavaCompile>().configureEach {
    dependsOn(prepareCapacitorJavaSources)
}

tasks.matching { it.name == "extractDebugAnnotations" || it.name == "extractReleaseAnnotations" }
    .configureEach { dependsOn(prepareCapacitorJavaSources) }

dependencies {
    api("androidx.appcompat:appcompat:1.7.0")
    api("androidx.core:core:1.15.0")
    api("androidx.activity:activity:1.9.2")
    api("androidx.fragment:fragment:1.8.4")
    api("androidx.coordinatorlayout:coordinatorlayout:1.2.0")
    api("androidx.webkit:webkit:1.12.1")
    api("org.apache.cordova:framework:10.1.1")
}
