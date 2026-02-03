# 部署到服务器（fast-english + CLIProxyAPI）

目标：把 `fast-english`（网站）和 `CLIProxyAPI`（OpenAI-compatible 中转）一起跑在同一台服务器上，替代你本地“先开 CLIProxyAPI + 内网穿透”的方式。

> 说明：CLIProxyAPI 最新版本我这边看到是 `v6.7.45`（2026-02-03），你本地的是 `v6.7.27`。部署时建议用最新版（除非你想锁版本排查问题）。

## 0. 你需要准备

- 一台 Linux 服务器（推荐 Ubuntu 22.04/24.04，amd64）
- 能 SSH 登录（建议用密钥，不要用密码）
- 防火墙放行端口：
  - `8000`：fast-english 网页
  - `8317`：CLIProxyAPI（OpenAI-compatible）
  - `8085`：CLIProxyAPI 管理界面（本文默认只绑定 `127.0.0.1`，通过 SSH 转发访问）

## 1. 服务器安装 Docker（Ubuntu 示例）

如果你服务器已经装好了 Docker/Compose，跳过本节。

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker
docker version
docker compose version
```

## 2. 拉代码并准备配置

```bash
git clone https://github.com/chixi4/fast-english.git
cd fast-english
```

### 2.1 fast-english 的 `.env`

```bash
cp .env.example .env
```

至少需要（建议你在 `.env` 里改）：

- `APP_REQUIRE_LOGIN=1`（建议生产开启登录）
- `AI_BASE_URL=http://cli-proxy-api:8317/v1`
- `AI_API_KEY=你在 CLIProxyAPI 配的 key`

> 如果你只是先把网站跑起来，不需要 AI：可设置 `AI_MOCK=1`，并忽略 CLIProxyAPI。

### 2.2 CLIProxyAPI 的 `config.yaml`

```bash
mkdir -p deploy/cli-proxy-api/auths deploy/cli-proxy-api/logs
cp deploy/cli-proxy-api/config.yaml.example deploy/cli-proxy-api/config.yaml
```

编辑 `deploy/cli-proxy-api/config.yaml`：

- 把 `api-keys` 改成你自己的随机 key（长一点）
- 如果服务器无法访问 Google（Gemini/Antigravity），需要配置 `proxy-url`（支持 socks5/http/https）

## 3. 启动（Docker Compose）

```bash
docker compose up -d --build
docker compose ps
```

验证：

- 打开：`http://<服务器IP>:8000`
- 检查 CLIProxyAPI：
  ```bash
  curl http://127.0.0.1:8317/v1/models -H "Authorization: Bearer your-api-key-1"
  ```

## 4. 访问 CLIProxyAPI 管理界面（可选）

本文默认把管理端口绑定在服务器本机 `127.0.0.1:8085`，避免暴露到公网。

在你电脑上开 SSH 端口转发：

```bash
ssh -L 8085:127.0.0.1:8085 root@<服务器IP>
```

然后用浏览器打开：

- `http://127.0.0.1:8085`

## 5. 常见问题

### 5.1 服务器连不上 Google / Antigravity

这是最常见的阻塞点。处理方式：

1) 换到能直连 Google 的服务器机房（最省心）
2) 在 `deploy/cli-proxy-api/config.yaml` 里设置 `proxy-url` 指向可用的 socks5/http 代理

### 5.2 安全建议（强烈）

- 不要把 `8317` 暴露给不可信公网；至少要：
  - 使用强随机 `api-keys`
  - 或者只允许你的 IP 访问（安全组 / 防火墙）
- `8085` 管理端口不要直接暴露公网

