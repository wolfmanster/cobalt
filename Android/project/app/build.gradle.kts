plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.kapt")
}

val releaseStoreFile = providers.environmentVariable("ANDROID_RELEASE_STORE_FILE").orNull
val releaseStorePassword = providers.environmentVariable("ANDROID_RELEASE_STORE_PASSWORD").orNull
val releaseKeyAlias = providers.environmentVariable("ANDROID_RELEASE_KEY_ALIAS").orNull
val releaseKeyPassword = providers.environmentVariable("ANDROID_RELEASE_KEY_PASSWORD").orNull
val releaseTaskRequested = gradle.startParameter.taskNames.any { it.contains("Release", ignoreCase = true) }

if (releaseTaskRequested) {
    check(listOf(releaseStoreFile, releaseStorePassword, releaseKeyAlias, releaseKeyPassword).all { !it.isNullOrBlank() }) {
        "Release signing requires ANDROID_RELEASE_STORE_FILE, ANDROID_RELEASE_STORE_PASSWORD, ANDROID_RELEASE_KEY_ALIAS, and ANDROID_RELEASE_KEY_PASSWORD."
    }
}

android {
    namespace = "com.xmedia.archive"
    compileSdk = 36
    buildToolsVersion = "36.1.0"

    defaultConfig {
        applicationId = "com.xmedia.archive"
        minSdk = 29
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"
    }

    signingConfigs {
        if (!releaseStoreFile.isNullOrBlank()) {
            create("release") {
                storeFile = file(releaseStoreFile)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.findByName("release")
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }

    kotlinOptions { jvmTarget = "1.8" }

    val clientDist = file("../../../apps/client/dist")
    val webAssets = layout.buildDirectory.dir("generated/web-assets")
    val prepareWebAssets = tasks.register<Sync>("prepareWebAssets") {
        from(clientDist)
        into(webAssets.map { it.dir("public") })
        doFirst {
            check(clientDist.isDirectory) {
                "Client assets are missing. Run 'pnpm --dir apps/client build' first."
            }
        }
    }

    sourceSets["main"].assets.srcDir(webAssets)
    tasks.matching { it.name.startsWith("merge") && it.name.endsWith("Assets") }
        .configureEach { dependsOn(prepareWebAssets) }
    tasks.matching { it.name.contains("lint", ignoreCase = true) }
        .configureEach { dependsOn(prepareWebAssets) }
}

dependencies {
    implementation(project(":capacitor-android"))
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.documentfile:documentfile:1.0.1")
    implementation("androidx.room:room-runtime:2.7.0")
    implementation("androidx.room:room-ktx:2.7.0")
    kapt("androidx.room:room-compiler:2.7.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.1")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
