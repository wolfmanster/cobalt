# iPhone PWA 私有入口

这份说明讲如何在仅本人可访问的网络中使用 iPhone PWA。PWA 的队列、媒体和 X 会话由私有服务端保存；Android 仍使用本机 WebView、Keystore 会话与本机归档流程。Cobalt 进程说明见 [NODE_DEPLOY_CN.md](./NODE_DEPLOY_CN.md)。

## 同源 HTTPS 与访问控制

生产环境通过同一个 HTTPS 源提供 PWA 页面和 `/api`。将服务部署在手机可访问的电脑或服务器上，并使用仅本人可访问的 VPN（如 WireGuard、Tailscale）或带认证的私有反向代理。不要将业务 API 或 Cobalt 端口直接暴露到公网；Cobalt 应只在服务端内部监听。

当前业务 API 包含队列、媒体预览和清空归档操作，没有独立用户账号。私有反向代理应保护整个应用和 `/api`，不能只保护首页。使用 PWA 登录时必须通过同源 HTTPS；不要在不受信任的 Wi-Fi 或未加密 HTTP 入口中提交会话 Cookie。

本地开发仍可使用 Vite `5173` 代理业务服务 `4100`。生产构建并启动：

```bash
pnpm build
pnpm start
```

默认值：

- `HOST=127.0.0.1`
- `PORT=4100`
- `COBALT_URL=http://127.0.0.1:9000`
- `DATA_DIR` 保存 `jobs.json`、`categories.json`、媒体文件和加密后的 `x-session.json`
- `CLIENT_DIST` 指向 `apps/client/dist`

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
- `index.html` 和 `sw.js`：不要设置长时间缓存。
- 不记录 `/api/x-session` 的请求体或 `Cookie`、`Authorization` 等敏感头。

## iPhone 验收

在 Safari 中打开私有 HTTPS 地址，添加到主屏幕，再从图标启动。确认主屏幕模式、会话状态刷新、移除会话、公开帖子和本人有权查看的受保护帖，以及图片、视频和 GIF 的保存。自动化 Chromium/WebKit 测试不能代替真实 iPhone、Safari 与“文件”App 验收。
