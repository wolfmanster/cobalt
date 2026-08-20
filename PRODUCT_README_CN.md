# Veo Downloader

面向公开 X 单帖链接的本地媒体归档工具。React + TypeScript 前端负责批量输入、预览和队列交互；Node.js + TypeScript 后端负责任务、元数据、下载和历史；仓库内的 Cobalt Node 服务只负责媒体解析。

## 已实现范围

- 单条或多行粘贴，TXT/CSV 文件导入，单批最多 200 条。
- 只接受 `https://x.com/<user>/status/<id>` 和对应的 `twitter.com` 单帖链接。
- 下载视频、图片和 GIF；多条帖子并行解析，多媒体文件并行保存。
- 每帖元数据只保留：作者名称、用户名、用户 ID、头像、正文、语言、发布时间。
- 下载队列、实时进度、取消、重试、按 Tweet ID 去重、持久化历史和媒体预览。
- 不支持主页、搜索、线程、Cookie、私密帖子和 X 官方 API。

## 元数据补充方案

后端对每条任务并行执行两条链路：

1. 向本地 Cobalt `POST /` 请求媒体列表，并强制通过 Cobalt 代理媒体。
2. 请求 X 的公开嵌入数据端点 `cdn.syndication.twimg.com/tweet-result`，补齐 7 个元数据字段。

公开嵌入端点无需 Cookie、账号和官方 API key，但不是 X 承诺稳定的正式 API。它不可用时任务会明确失败并允许重试，避免生成缺字段的半成品记录。博主头像只使用元数据中的远程地址，不下载到项目内。

任务采用解析、下载两级并行队列：默认同时解析 4 条帖子、同时下载 2 条帖子，并在每条帖子内同时保存 2 个媒体文件。可通过 `RESOLVE_CONCURRENCY`、`DOWNLOAD_CONCURRENCY` 和 `MEDIA_DOWNLOAD_CONCURRENCY` 调整；任一媒体失败时，同帖的其他并行传输会停止并清理临时文件。

## 目录

```text
apps/client/       React + TypeScript 前端
apps/server/       Node.js + TypeScript 业务后端
api/               Cobalt Node 媒体解析服务
data/              运行时历史、头像和媒体（首次运行创建）
.runtime/          项目内 Node 运行时
.pnpm-store/       项目内 pnpm store
.pnpm-cache/       项目内 pnpm cache
.npm-cache/        项目内 npm cache
.cache/            项目内临时文件和日志
```

所有依赖、缓存、构建产物、日志、临时文件和业务数据都在项目目录内。前端没有外部字体依赖。

## 安装与构建

PowerShell：

```powershell
$projectRoot = (Get-Location).Path
$env:Path = "$(Join-Path $projectRoot '.runtime\node-v24.19.0-win-x64');$env:Path"
$env:TEMP = Join-Path $projectRoot '.cache\temp'
$env:TMP = $env:TEMP
$env:XDG_CACHE_HOME = Join-Path $projectRoot '.cache'
$env:npm_config_cache = Join-Path $projectRoot '.npm-cache'
$env:npm_config_devdir = Join-Path $projectRoot '.cache\node-gyp'

pnpm install
pnpm build
pnpm test
```

如需修改配置，复制 `apps/server/.env.example` 为 `apps/server/.env`。Cobalt 配置见 `api/.env.example`。

## 启动

生产模式会由业务后端同时托管已构建的 React 静态文件：

```powershell
.\start-all.ps1
```

访问 `http://127.0.0.1:4100`。Cobalt 只监听 `127.0.0.1:9000`，不应直接暴露到公网。

开发模式需要三个终端：

```powershell
pnpm dev:cobalt
pnpm --filter @x-media/server dev
pnpm --filter @x-media/client dev
```

前端开发地址为 `http://127.0.0.1:5173`，Vite 会把 `/api` 代理到业务后端。

## 业务 API

- `GET /api/health`：业务服务和 Cobalt 状态。
- `GET /api/jobs`：队列与历史。
- `POST /api/jobs`：批量创建，body 为 `{ "urls": ["..."] }`。
- `POST /api/jobs/:id/cancel`：取消。
- `POST /api/jobs/:id/retry`：重试。
- `GET /api/events`：SSE 队列进度。
- `GET /api/jobs/:jobId/media/:mediaId`：预览；加 `?download=1` 下载。
- `DELETE /api/history`：清除终态记录及对应的项目内媒体目录。

## 生产注意事项

- 业务后端默认只监听 `127.0.0.1:4100`；公网使用时应放在 HTTPS 反向代理后。
- Cobalt 与业务后端应在同一受信网络内，公网不要开放 9000 端口。
- 若 Cobalt 配置 API key，在 `apps/server/.env` 同时设置 `COBALT_API_KEY`。
- 历史使用项目内 `data/jobs.json` 持久化；清除历史会同时删除对应媒体，不可恢复。
