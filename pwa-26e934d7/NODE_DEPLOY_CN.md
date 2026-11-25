# Cobalt Node 部署

> 完整产品请阅读 [PRODUCT_README_CN.md](./PRODUCT_README_CN.md)，并使用 `start-all.ps1` 同时启动 React 产品服务与 Cobalt。本页仅说明独立启动 Cobalt。

当前项目已包含官方 Cobalt monorepo。下面的命令会启动 Node API，默认只监听本机 `127.0.0.1:9000`。

## 启动

```powershell
pnpm install
.\start-node.ps1
```

当前 Windows 环境已准备项目内 Node 24 运行时，启动脚本会优先使用它，避免 Node 25 与 `isolated-vm` 原生依赖不兼容。

健康检查：

```powershell
Invoke-WebRequest http://localhost:9000/ -UseBasicParsing
```

如果要让局域网或反向代理访问，把 `api/.env` 中的 `API_LISTEN_ADDRESS` 改为 `0.0.0.0`，并把 `API_URL` 改成实际的公网 URL（结尾保留 `/`）。

## 生产环境安全

公开部署前请按 `docs/protect-an-instance.md` 配置 API key 或 Cloudflare Turnstile，并使用 HTTPS 反向代理。不要把 `api/.env`、`cookies.json` 或 `keys.json` 提交到 Git。

停止服务：在运行窗口按 `Ctrl+C`。
