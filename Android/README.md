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

任务队列默认同时解析 4 条帖子，并在所有帖子之间共享 4 个媒体下载槽位。解析和下载使用独立调度器，因此长视频下载不会阻塞后续帖子的解析；同一帖包含多个媒体时也会并行保存。

## X 登录与受保护帖子

Android 版可在应用内打开独立的 X 登录 WebView。用户自行完成密码、验证码和 2FA；应用只提取 `auth_token` 与 `ct0`，使用 Android Keystore 的 AES-GCM 密钥加密到 `noBackupFilesDir`。登录 Activity 运行在 `:x_login` 进程及独立 WebView 数据目录中，保存完成后会清除该目录的 Cookie、缓存和网页存储，不会把凭据传给 React 页面。

登录后可下载当前 X 账号本身有权查看的受保护帖子；账号未关注、权限被撤回或会话过期时仍会失败。此功能依赖 X 网页登录及内部 GraphQL 行为，X 改版后可能需要同步更新。

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

## CI

`.github/workflows/android-ci.yml` 是 Android 的完整 GitHub CI，会在 push 到 `main`、Pull Request 和手动触发时执行：

- 构建 `apps/client` Web 资源
- 运行 Android 单元测试
- 运行 `lintDebug`
- 构建并上传 Debug APK
- 上传测试和 lint 报告

GitHub Actions 会缓存 pnpm store、Gradle 依赖和 Gradle build cache。普通 CI 不执行 Release 签名构建；Release 构建需要配置签名密钥和密码，只应在受信任的发布流程中执行。

本地快速检查可以只运行客户端构建和单元测试：

```powershell
. .\Android\env.ps1
pnpm --dir apps/client build
& .\Android\gradle\current\bin\gradle.bat -p Android/project test --no-daemon
```

## 构建正式版

正式版签名只从环境变量读取，密钥和密码不得写入仓库：

```powershell
$env:ANDROID_RELEASE_STORE_FILE = '<签名文件绝对路径>'
$env:ANDROID_RELEASE_STORE_PASSWORD = '<签名库密码>'
$env:ANDROID_RELEASE_KEY_ALIAS = '<密钥别名>'
$env:ANDROID_RELEASE_KEY_PASSWORD = '<密钥密码>'

Push-Location .\Android\project
gradle assembleRelease bundleRelease --no-daemon
Pop-Location
```

签名 APK 和 AAB 分别位于 `Android/project/app/build/outputs/apk/release/` 与 `Android/project/app/build/outputs/bundle/release/`。

工具包、缓存和构建产物已通过本目录 `.gitignore` 排除，不会提交到 Git。
