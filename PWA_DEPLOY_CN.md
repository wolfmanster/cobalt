# iPhone PWA 与 Android 共享归档

两端用同一个归档账号连接同一个 HTTPS 地址。队列、分类、原文件和加密 X 会话由远程电脑保存。iPhone 主屏幕 PWA 保存离线清单及媒体，Android 把本机副本保存到当前下载位置，并在原有 Room 数据库记录清单、文件和导入进度。

## 部署与接入

1. 备份现有 PWA 的数据目录。构建新版时将 `DATA_DIR` 指向原来使用的目录，继续使用原来的 `X_SESSION_ENCRYPTION_KEY`。如果旧 PWA 是从单独的快照目录启动的，沿用那个实例实际使用的绝对数据路径。
2. 在 `apps/server/.env` 或服务进程环境设置 `ARCHIVE_USERNAME` 和 `ARCHIVE_PASSWORD`。应用使用一个私有归档账号，每次登录创建一个独立的 30 天设备会话。已登录设备可在「归档账号」撤销其他设备会话。
3. 使用同一 HTTPS 源提供页面与 `/api`。后端默认监听 `127.0.0.1:4100`，在同一电脑配置可信的 HTTPS 反向代理，保留原始 `Host`，设置 `X-Forwarded-Proto: https`。在手机可访问的私有网络或 VPN 上提供该入口。Cobalt 继续使用内部地址。
4. 执行 `pnpm build` 与 `pnpm start`，或在 Windows 上构建后使用 `start-all.ps1` 同时启动 Cobalt 与业务服务。仅在回环地址开发时设置 `ARCHIVE_INSECURE_LOOPBACK=1`，可通过 `http://127.0.0.1:4100` 或 Vite 代理调试。Android 归档连接使用 HTTPS。
5. iPhone 从 Safari 添加到主屏幕，从主屏幕打开后登录。Android 更新保留本机数据的同签名 APK 后，在首页点「归档账号」，输入相同的 HTTPS 地址和账号。首轮连接会自动处理原有下载。

`DATA_DIR` 中原有的 `jobs.json`、`categories.json`、`media` 和 `x-session.json` 继续使用。备份时同时保留新增的 `archive-sessions.json`、`archive-import` 与 `media/.objects`，以及既有 X 会话密钥。示例配置见 [apps/server/.env.example](./apps/server/.env.example)。

## 导入与离线状态

- 安卓导入读取 Room 的完成记录和记录关联的原文件。合并使用帖子 ID 和 SHA-256，分类取并集。重复帖保留最早下载时间，内容不同的媒体分别保留。Android 中可读且已校验的原有文件直接作为本机副本使用。
- 在安卓「归档账号」可展开已合并、缺失和需要重新授权的项目。通过「重新授权原下载目录」选回原文件夹可继续导入，当前下载位置保持原设置。原有文件保留在设备上。iPhone 参与合并的是服务器已有的应用归档。
- 「已归档」表示服务器已有帖子记录。「本机可离线播放」表示该帖的媒体都已写入当前设备并通过校验。两端打开或重新联网后会补齐，Wi-Fi 和移动网络均可用。iPhone 在前台继续传输，触碰配额时显示剩余文件数，释放空间并回到应用后可继续。WebKit 回收站点存储后，需要重新联网打开主屏幕应用补齐。[WebKit 存储策略](https://webkit.org/blog/14403/updates-to-storage-policy/)
- 「清除失败记录」只清除服务器失败任务，两端会收到更新。

## PWA X 会话加密

PWA 的 X 登录只接受本人提供的 `auth_token` 和 `ct0`，不要求也不收集 X 密码。浏览器只在点“保存会话”时把输入发送到同源服务端；页面不把 Cookie 写入 Local Storage、Session Storage、任务记录或状态响应。服务端使用 AES-256-GCM 加密会话文件，HTTP 状态只返回是否已配置。

首次部署生成 32 字节密钥（64 位十六进制字符）：

```bash
openssl rand -hex 32
```

将生成值作为 `X_SESSION_ENCRYPTION_KEY` 注入业务服务环境。不要把真实密钥写入仓库、前端配置或日志。Windows PowerShell 可使用 Node 生成：

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

示例环境变量见 [`apps/server/.env.example`](./apps/server/.env.example)。不配置密钥时，PWA 会明确禁用登录表单，但公开帖子下载仍通过原有公开解析和 Cobalt 流程工作。

`DATA_DIR` 必须放在持久化、仅服务账号可访问的磁盘位置。备份会话时同时保护此目录和密钥。服务重启后必须继续使用同一密钥。密钥丢失或更换后，旧会话无法解密：恢复原密钥，或在 PWA 中移除不可读取的旧会话，再用新密钥重新登录。删除或丢失会话后，需要重新配置本人账号的 `auth_token` 与 `ct0`。

会话只发送到 X 的 TweetDetail GraphQL 请求。服务端不会把授权 Cookie 传给 Cobalt、公开帖子接口或媒体源；授权 GraphQL 请求遇到重定向会停止，不跟随跳转。账号仍只能访问 X 本身允许其查看的帖子。

## 反向代理

- `/api/events`：关闭响应缓冲，延长读超时，使用 HTTP/1.1，不缓存 SSE。
- 媒体：原样转发 `Range`，允许 `206 Partial Content`，不要对媒体压缩或改写 `Content-Length`。
- 导入：允许 `PUT` 与至少 2 MiB 的单次请求体，允许应用回传已保存的上传偏移量。
- `index.html` 和 `sw.js`：不要设置长时间缓存。
- 不记录 `/api/x-session` 的请求体或 `Cookie`、`Authorization` 等敏感头。

## 双设备验收

1. 准备安卓独有、PWA 独有和两端重复但分类不同的各一条旧归档。登录后核对唯一帖子、分类和文件 SHA-256，并检查安卓报告中已导入、缺失及重新授权项目。
2. 在安卓提交视频，在 iPhone 提交多图帖。等待两端都显示「本机可离线播放」。两台设备同时断网、关闭并重开，从历史里打开图片以及播放、拖动视频。
3. 在传输大文件时断网、重启后端及切换 iPhone 前后台。空间不足时确认剩余数量，释放后回到前台并等待补齐。检查部分文件期间的状态、完整文件的哈希及记录数量。
4. 两端登录在线时准备完成、失败、已取消和进行中任务。在其中一端清除失败记录，在另一端确认只有失败任务消失。

使用真实 iPhone 主屏幕 PWA 与真实 Android 升级 APK 执行这四步。

本地浏览器回归可执行 `pnpm build` 和 `pnpm --dir apps/client test:pwa`。该测试使用 Playwright Chromium 和 PATH 上的 FFmpeg 生成多分段视频。
