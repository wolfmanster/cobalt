# iPhone PWA 私有入口

这份说明只讲怎么在自己控制的网络里打开 Veo Downloader。它不申请证书，不开公网端口，也不创建云资源。Android 的产品方向仍以 `PRODUCT_README_CN.md` 为准。Cobalt 进程本身的说明见 `NODE_DEPLOY_CN.md`。

## 同一个 HTTPS 源

浏览器里的页面和 `/api` 必须来自同一个源。开发时 Vite 在 `5173`，把 `/api` 代理到业务进程 `4100`。生产时先构建再启动，由业务进程同时提供 `apps/client/dist` 和 `/api`：

```bash
pnpm build
pnpm start
```

默认值：

- `HOST=127.0.0.1`
- `PORT=4100`
- `COBALT_URL=http://127.0.0.1:9000`
- `DATA_DIR` 放 `jobs.json` 和 `categories.json`
- `CLIENT_DIST` 指向构建后的前端目录

占位键只写在 `apps/server/.env.example`。不要把真实的 `COBALT_API_KEY` 写进仓库或这份文档。

## 没有登录的 API

当前 API 没有认证。知道地址的人可以读取队列、预览媒体，也可以调用 `DELETE /api/history` 清掉归档。启动时如果 `HOST` 不是 `127.0.0.1`、`localhost` 或 `::1`，进程会打印警告，然后仍然启动。这只是提醒，不是访问控制。

给 iPhone 用的入口必须是你自己控制的私有 HTTPS，例如 WireGuard、Tailscale、仅内网，或者你在反代上自己加上的 Basic 或 mTLS。不要把 `4100` 或 Cobalt 的 `9000` 暴露到公网。Cobalt 继续只听本机。

## 反代

证书在私有入口上终止。下面只是要点，不绑定某一家云：

- `/api/events`：关掉响应缓冲，把读超时拉长，使用 HTTP/1.1，不要缓存 SSE。
- 媒体：原样转发 `Range`，不要对媒体做 gzip 以免丢掉 `Content-Length`，允许 `206`。
- `sw.js` 和 `index.html`：不要做长时间缓存。

## iPhone

用私有 HTTPS 在 Safari 打开站点，选择添加到主屏幕，再从图标启动。独立模式不应再出现浏览器地址栏。文件保存、文件名、视频拖动、刘海和键盘是否挡住输入，都要在真机上再看一遍。自动化浏览器不能代替这一步。
