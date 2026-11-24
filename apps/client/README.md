# Android 前端

`src/App.tsx` 协调任务刷新、原生桥接、页面状态与 Android 返回键。界面职责拆分如下：

| 模块 | 职责 |
| --- | --- |
| `components/NativeShell.tsx` | 安卓顶部栏、导航与下载统计 |
| `components/LinkComposer.tsx` | 链接输入、粘贴入口、文件导入与提交 |
| `components/SessionPanel.tsx` | X 登录管理入口 |
| `components/JobCard.tsx` | 帖子内容、下载状态、单帖媒体轮播 |
| `components/Media.tsx` | 图片与视频渲染、最多七个可见圆点 |
| `components/HistoryMediaViewer.tsx` | 全屏媒体预览界面与键盘焦点 |
| `hooks/useMediaViewer.ts` | 预览状态、滑动过渡、关闭与滚动位置恢复 |
| `components/ArchiveDialogs.tsx` | 下载位置和清除历史确认弹窗 |
| `HistoryBrowser.tsx` | 作者、内容搜索、分页与作者详情 |
| `native.css` | 安卓专用配色、布局、系统深色主题与媒体尺寸 |
| `styles.css` | 通用和已有浏览器布局 |

安卓样式以 `.is-native` 和 `html[data-platform="android"]` 为作用域。媒体预览保留自然比例、等高多图横向滑动和单帖圆点；搜索组件保持挂载，切换页面后搜索词仍然保留。

## 验证

在仓库根目录运行：

```powershell
pnpm --filter @x-media/client build
pnpm --filter @x-media/client exec playwright install chromium
pnpm --filter @x-media/client test:ui
```

UI 测试自动启动本地 Vite，使用隔离的模拟 Capacitor 桥接。覆盖窄屏与平板、浅色与深色、下载与重试、搜索返回、历史分页、1/2/7/8 个媒体的圆点、全屏滑动与位置恢复、登录入口、下载位置和清除确认。截图保存在仓库 `tmp/native-ui/`，不参与 APK 打包。

这些浏览器测试不能代替 Android 原生登录、视频解码、文件选择器或手机手势的实机验证。

前端构建完成后，更新 APK：

```powershell
Set-Location Android/project
. ../env.ps1
& ../gradle/current/bin/gradle.bat --no-daemon :app:prepareWebAssets :app:assembleDebug
```

产物为 `Android/project/app/build/outputs/apk/debug/app-debug.apk`。`prepareWebAssets` 从 `apps/client/dist` 同步最新界面资源。
