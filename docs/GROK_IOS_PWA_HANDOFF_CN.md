# Grok Bot 开发任务：将 Veo Downloader 安卓应用移植为 iOS PWA

请在现有仓库里完成移植并交付可测试的代码。用户应能在 iPhone 上通过 HTTPS 打开应用，在 Safari 中添加到主屏幕后独立启动，并完成从粘贴公开 X 帖子链接、查看进度到预览和保存媒体的流程。下载队列和归档由用户部署的服务端管理。 [Apple 主屏幕 Web App 指南](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios)

## 仓库和开发基线

仓库为 `wolfmanster/cobalt`，基线为 `codex/history-media-preview-review` 上的 `11671612`。从该基线创建 `codex/ios-pwa` 开发分支。若当前工作区已包含基线之后的相关改动，在现有成果上继续并记录实际起始提交。 [GitHub 仓库](https://github.com/wolfmanster/cobalt)

| 路径 | 用途 |
| --- | --- |
| `apps/client/` | 当前安卓应用共用的 React 客户端，也是 PWA 的实现入口。 |
| `apps/client/src/App.tsx`、`api.ts`、`nativeArchive.ts` | 页面和平台能力目前由 `xLoginSupported` 等条件控制。浏览器已有任务 HTTP/SSE 入口，搜索、作者、分类等接口还直接调用 `LocalArchive`。 |
| `Android/project/` | 当前完整行为的参考。包含 Capacitor 桥接、Kotlin 下载队列、Room 历史和分类、系统文件和分享、X 登录。 |
| `apps/server/`、`api/` | 复用现有 Express 业务 API、归档和 Cobalt 媒体解析服务。生产模式由 Express 同源提供客户端静态文件和 `/api`。 |
| `web/` | 上游 Svelte 站点，按 `PRODUCT_README_CN.md` 的现行项目约定作为参考。 |

## 首版范围

- **链接与队列。** 保留公开 X 单帖的单条和批量提交、手动粘贴、TXT/CSV 导入、每批最多 200 条、按 Tweet ID 去重、进度、取消和重试。图片、视频和 GIF 都要在目标设备验证。
- **历史与分类。** 延续首页、搜索、历史导航。支持已完成帖子的正文和作者搜索、作者详情、分页、分类管理、单帖与批量归类、全部和未分类计数。删除分类只解除分类关联，保留帖子和媒体。清除历史沿用用户确认流程，文案明确会删除服务端归档。
- **媒体预览与保存。** 保留单帖内的多媒体滑动、全屏预览、关闭后返回原滚动位置。提供可操作的“保存文件”入口，使用同源下载 URL，并在 iPhone 上验证从主屏幕启动后能够在“文件”App 找到媒体。若分享文件能够通过能力检测，可将其作为辅助入口。 [Apple 下载文件指南](https://support.apple.com/en-us/102440)
- **账号与现有数据。** 首版使用已有公开帖子解析链路。受保护帖子和 X 登录需要单独设计授权会话，在完成设计前，PWA 界面只提供公开帖子能力。首版兼容现有 Node 历史文件；安卓 Room 历史、媒体和分类的跨设备导入属于后续功能，有需求时另行确定导出格式。安卓现有本地数据和会话通过原应用继续访问。

## 实现要求

1. **拆分界面和平台能力。** 复用当前组件和交互，将移动端导航、卡片、预览与 X 登录、Android 返回键、文件选择等能力分开控制，避免沿用 `xLoginSupported` 同时决定界面和功能。在浏览器中用 HTTP/SSE 适配任务、搜索、作者和分类，在安卓端继续用 `LocalArchive`。移植 PWA 的返回与关闭行为，使用户能依次退出预览和详情，并保留搜索词与列表位置。安卓构建与 UI 测试必须继续通过。
2. **补全归档服务。** 在现有业务后端补搜索、作者、分类和分类分配接口，沿用 Android 当前的数据结构与规则。用服务端持久化保存分类和关系，兼容旧 `jobs.json`。处理并发分类修改、关联清理和分页一致性。让 PWA 从 `/api/health` 读取真实服务状态，并在 SSE 重连、从后台返回或页面重新打开后刷新队列。服务端解析和下载应在 PWA 关闭后继续运行，回到前台后恢复可见进度。
3. **实现 iOS 媒体链路。** 以服务端返回的 `previewUrl` 和 `downloadUrl` 为准。当前 `openMedia(id)` 在浏览器中拼成 `/api/jobs/media/:id`，与后端 `/api/jobs/:jobId/media/:mediaId` 不一致。改用正确 URL，并为媒体预览验证 HTTP Range、`206 Partial Content`、文件长度和媒体类型。下载端提供正确的 `Content-Disposition` 文件名，在 Safari 和主屏幕 PWA 分别验证保存。大文件通过服务端流式传输，避免把整个视频读入浏览器内存。
4. **实现安装和更新。** 交付 Web App Manifest，包括应用名、`id`、`start_url`、`scope`、`display: standalone`、图标和主题色，提供 `apple-touch-icon`。处理刘海和底部安全区、动态视口、软键盘、深色模式和主屏幕启动。Service Worker 仅在 Web 构建中注册，用于静态资源、离线提示和版本更新。任务 API、SSE 和用户媒体保持网络访问。照顾权限被拒绝的场景，仍可手动粘贴链接和选择 TXT/CSV。 [WebKit 主屏幕 Web App 说明](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
5. **提供私有 HTTPS 部署说明。** 在用户控制的服务器或手机可达的电脑上运行 Node 与 Cobalt，通过同一 HTTPS 入口提供 PWA 与 `/api`。当前业务 API 没有用户认证且能读取和清除历史，手机实测使用受访问控制的私有入口。Cobalt 服务端口保持在内部网络。说明反向代理如何转发 SSE、视频 Range 和应用静态资源。

## 验收流程

| 场景 | 通过条件 |
| --- | --- |
| iPhone 安装 | 在 Safari 打开实测 HTTPS 地址，走“添加到主屏幕”和“作为网页 App 打开”的流程。图标正确，从主屏幕独立启动，底部导航和输入框可用。 |
| 下载队列 | 粘贴含重复链接的批次并导入一份 TXT/CSV。验证只创建一条同帖任务。任务有可见进度，能取消和重试。下载中把 PWA 切到后台或关掉，重开后能从服务端刷新进度或结果。 |
| 历史与分类 | 用已下载帖子验证正文和作者搜索、翻页、多图滑动和全屏预览。建立分类，批量归类，刷新页面和重启服务后验证记录保留。重命名、删除分类后验证计数和归档一致。 |
| 预览和文件 | 至少用一条多图帖和一条 MP4 帖验证。测试视频拖动进度、返回列表和 iOS“文件”App中的实际文件名及可打开性。另用 GIF 样本确认可预览和保存。 |
| 离线和更新 | 离线时出现可恢复的提示。联网后重新同步。部署新版本后重新启动用户能加载新版本，原归档仍可访问。 |
| 安卓回归 | 安卓现有的队列、分类、预览、下载位置、返回键和 X 登录入口通过 UI 回归。Android Debug APK 可构建。 |

## 交付物

- 交付实现分支或补丁、改动清单和可复现的本地/私有 HTTPS 启动步骤。写明使用的 Node/pnpm 版本、数据目录及配置项，示例配置使用占位值。
- 运行 `pnpm build`、`pnpm test`、`pnpm --filter @x-media/client test:ui`。按 `Android/README.md` 执行安卓单测和 Debug APK 构建。增加能覆盖新浏览器适配和后台恢复的自动化用例，至少验证 Chromium 和 WebKit。
- 附上测试结果，分别注明自动化浏览器与 iPhone 真机。真机记录包含 iOS 版本、Safari 与主屏幕模式的安装、预览、下载和前后台恢复结果。设备不可用时逐项标记待验证，继续交付可测试构建和复现步骤。
