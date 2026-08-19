# 项目内 Android 开发环境

本目录用于保存 Android 开发工具、构建缓存和 APK 产物，避免写入用户目录。

已安装：

- Node.js 24.19.0
- pnpm 9.6.0
- Temurin JDK 17
- Android SDK Platform 36
- Android SDK Build Tools 36.1.0
- Android SDK Platform Tools 37.0.1
- Android NDK 28.2.13676358
- CMake 3.31.6
- Gradle 9.7.0

Android 应用工程位于 `Android/project`，使用 Capacitor 复用 React 界面，并在 Kotlin 中运行本地任务队列、X 解析和下载服务。

## 启用环境

在项目根目录执行：

```powershell
. .\Android\env.ps1
```

然后验证：

```powershell
java -version
adb version
sdkmanager --version
gradle --version
```

## 目录约定

- `sdk/`：Android SDK
- `toolchain/`：JDK
- `gradle/current/`：项目内 Gradle
- `gradle-cache/`：Gradle 下载和构建缓存
- `build-cache/`：APK/NDK 构建中间缓存
- `artifacts/`：APK、AAB 等产物
- `tmp/`：下载包和临时文件
- `project/`：Android 工程源码
- 项目根目录 `.pnpm-store/`、`.pnpm-cache/`、`.npm-cache/`：Node 依赖缓存

## 构建 Android 应用

在仓库根目录执行：

```powershell
. .\Android\env.ps1
pnpm --dir apps/client build
Push-Location .\Android\project
& '..\gradle\current\bin\gradle.bat' assembleDebug --no-daemon
Pop-Location
```

Debug APK 位于 `Android/project/app/build/outputs/apk/debug/app-debug.apk`；发布产物应复制到 `Android/artifacts`，签名文件不得提交到仓库。

工具包、缓存和构建产物已通过本目录 `.gitignore` 排除，不会提交到 Git。
