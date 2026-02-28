# Open Assistant Infra Runbook (docker compose)

本目录提供两套启动方式：

- **开发（默认）**：ASR/TTS 使用 mock，适合本地开发与 e2e
- **全量（真依赖）**：ASR=FunASR runtime + TTS=CosyVoice runtime，适合内网服务器联调/压测

## 1) 开发（mock，推荐本机）

```bash
cd open-assistant
docker compose -f infra/docker-compose.yml up
```

入口：
- Web（dev server）：`http://localhost:5173`
- Admin（管理后台）：`http://localhost:5173/admin.html`（或 `https://localhost:7443/admin.html`）
- 反代（Caddy，HTTPS）：`https://localhost:7443`
- Grafana：`http://localhost:3000`（admin/admin）

### 证书信任（Caddy `tls internal`）

本仓库的 Caddy 使用 `tls internal` 自动签发本地证书，因此浏览器首次访问 `https://localhost:7443` 会提示“不受信任”。

你可以把 Caddy 的本地根证书导出并加入系统信任：

```bash
cd open-assistant
docker compose -f infra/docker-compose.yml cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-local-root.crt
```

随后将 `caddy-local-root.crt` 导入到你系统/浏览器的“受信任的根证书颁发机构”。（生产环境建议替换为你们内网 CA 证书，而不是使用 `tls internal`。）

## 2) 全量（真依赖，推荐内网服务器）

前置：
- FunASR runtime 镜像可拉取（或设置 `FUNASR_IMAGE` 指向内网镜像）
- CosyVoice runtime 镜像需要你们先构建（或设置 `COSYVOICE_IMAGE` 指向内网镜像）
- GPU：CosyVoice 建议用 NVIDIA runtime（按你们的 Docker/NVIDIA Container Toolkit 配置）

### 开发式全量 vs 生产式全量

- **开发式全量（默认）**：`infra/docker-compose.full.yml` 里 Bun 服务使用源码挂载 + `--watch`，便于快速联调。
- **生产式全量（推荐断网运行）**：在 `infra/docker-compose.full.yml` 基础上叠加 `infra/docker-compose.prod.yml`：
  - Web 静态资源在镜像构建阶段打包进 Caddy（不再依赖 `apps/web dev server`）
    - Web 产物资源目录为 `/web-assets/*`（避免与 Gateway 的 `/assets/:assetId` 冲突）
  - Bun 服务从镜像启动（不再需要 `..:/app` 源码挂载）
  - OpenCode server 通过 `bunx --no-install` 离线启动（依赖在 build 阶段预热）

### 环境变量（可选）

compose 的项目目录是 `infra/`，因此 env 文件也放在 `infra/.env`：

```bash
cd open-assistant
cp infra/.env.example infra/.env
```

### 可选：Keycloak（OIDC 登录联调）

如果你们暂时还没有现成的 OIDC/SSO，可先用本仓库提供的 Keycloak overlay 快速跑通“Web 登录 -> WS 鉴权 -> 多租户 claims”全链路。
更完整说明见：`infra/keycloak/README.md`。

启动 Keycloak（可与 full/prod 叠加使用）：

```bash
cd open-assistant
docker compose -f infra/docker-compose.full.yml -f infra/docker-compose.full.keycloak.yml up -d keycloak
```

默认导入 realm：`openassistant`，并创建 demo 用户：`demo/demo`（含属性：`tenant/project/tags`，见 `infra/keycloak/realm-openassistant.json`）。

备份/恢复建议见：`infra/keycloak/README.md`（含 `backup-db.sh` / `restore-db.sh`）。

建议在 `infra/.env` 配置（注意 `/mcp` token 在启用鉴权时是必需的）：

```bash
OA_AUTH_MODE=oidc
OA_OIDC_ISSUER=http://host.docker.internal:8080/realms/openassistant
# OA_OIDC_AUDIENCE=open-assistant-web
OA_AUTH_TAGS_MODE=enforce
OA_OIDC_REQUIRE_TAGS=true
OA_OPENCODE_MCP_TOKEN=change-me
# OA_OPENCODE_MCP_TOKEN_PREVIOUS=old-token-during-rotation
```

`/mcp` token 轮换与网络隔离策略请见：`infra/SECURITY_MCP_OIDC.md`。

Web 侧（Vite dev）配置示例（`apps/web/.env`；或在 docker compose 环境中直接写到 `infra/.env` 的 `VITE_*` 变量）：

```bash
VITE_OA_OIDC_ISSUER=http://host.docker.internal:8080/realms/openassistant
VITE_OA_OIDC_CLIENT_ID=open-assistant-web
```

准备目录（FunASR 模型缓存 + 热词文件）：

```bash
cd open-assistant
mkdir -p infra/funasr-runtime-resources/models
```

启动全量栈：

```bash
cd open-assistant
docker compose -f infra/docker-compose.full.yml up
```

如果需要启用 NVIDIA GPU（CosyVoice 推理），加一层覆盖文件：

```bash
cd open-assistant
docker compose -f infra/docker-compose.full.yml -f infra/docker-compose.gpu.yml up
```

也可以用脚本一键拉起并等待 readyz：

```bash
cd open-assistant
bun run ops:full:up
```

> 说明：当 `OA_FULL_COMPOSE_MODE=prod` 且未开启 `OA_FULL_BUILD=1` 时，脚本默认以“断网运行”方式启动（等价于 `docker compose up -d --pull never --no-build`）。
> 如需覆盖可使用：`OA_FULL_PULL=missing|always|never`、`OA_FULL_NO_BUILD=1`。
> 可选：设置 `OA_FULL_KEYCLOAK=1` 会额外叠加 Keycloak overlay（`infra/docker-compose.full.keycloak.yml`）。

说明：
- FunASR：默认暴露 `ws://localhost:10096`（容器内 `10095`）
- CosyVoice：默认暴露 `http://localhost:50000`
- ASR/TTS 适配器分别暴露 `7002/7003`，Gateway 通过它们统一对接
- Gateway 默认 `OA_LLM_MODE=opencode` + `OA_OPENCODE_EVENTS_MODE=sse`（如需单测 ASR/TTS 性能，可运行时注入 `OA_LLM_MODE=mock`）
- Gateway `turn timeout`：全量 compose 默认放宽为 `300000ms`（避免真实 ASR/TTS 冷启动/下载模型时误触发 abort）；可通过 `OA_GW_TURN_TIMEOUT_MS` 调小

### 可选：mock ASR/TTS（不启用 FunASR/CosyVoice）
如果当前还没准备好真实 ASR/TTS（或暂不部署 GPU），可以启用 mock backends，让全量栈在不依赖 FunASR/CosyVoice 的情况下跑通（便于先把 Gateway/Web/Admin/审计链路上线验收）。

- 脚本方式（推荐）：设置 `OA_FULL_MOCK_BACKENDS=1`，会自动叠加 `infra/docker-compose.full.mock-backends.yml`
- 手动 compose：叠加 `infra/docker-compose.full.mock-backends.yml`（FunASR/CosyVoice 默认变为 profile=real，不会启动；ASR/TTS 适配器切到 `mock` backend）
- 如需切回真实依赖：去掉该 overlay/环境变量，或在手动 compose 时加 `--profile real`

示例（联网构建 + 生产式启动）：
```bash
cd open-assistant
OA_FULL_COMPOSE_MODE=prod OA_FULL_BUILD=1 OA_FULL_LLM_MODE=mock OA_FULL_MOCK_BACKENDS=1 bun run ops:full
```

### CosyVoice 镜像构建（一次性）

请按 `docs/TTS_COSYVOICE.md` 的官方方式在服务器上构建 `cosyvoice:v1.0`（或推送到内网 registry 并设置 `COSYVOICE_IMAGE`）。

### 模型下载/离线

FunASR 与 CosyVoice 默认会从 ModelScope 拉模型；若是“纯内网无外网”，需要提前离线准备模型权重/搭镜像站点。

补充：本仓库已为 CosyVoice 增加 `cosyvoice_modelscope_cache` 持久卷（ModelScope cache），便于“先联网跑一次下载/或从其他机器拷贝 cache 后离线运行”。

### 初始化联网 → 生产断网（推荐流程）

如果你的生产机允许“首次初始化联网”，但上线后会断网：

1) 初始化联网阶段（一次性）：

```bash
cd open-assistant
OA_FULL_COMPOSE_MODE=prod OA_FULL_BUILD=1 OA_FULL_LLM_MODE=mock OA_FULL_GPU=1 bun run ops:full:up-perf:all
```

这会：`docker compose build` → `up -d` → 等待 Gateway `/readyz`（会检查 FunASR/CosyVoice 可用）→ 跑一次 `perf:10` + `perf:asrtts`（分别覆盖 text-in 与 audio-in，全链路触发 ASR/TTS 调用，从而把模型/缓存拉齐）。

2) 确认后断网，再次启动：

```bash
cd open-assistant
OA_FULL_COMPOSE_MODE=prod OA_FULL_GPU=1 bun run ops:full:up
```

> 如果断网后 `readyz` 仍失败，通常是：模型没缓存完整/镜像未提前拉取。可在联网阶段重复第 1 步直到 `readyz` 稳定通过。

### Staging 联调与 perf 留证（OA-OPS-105）

如需把“真实依赖 + 低并发先跑通 + 可追溯留证”固化为发布证据，请参考：

- `infra/STAGING.md`（命令、最小参数集、留证文件与回滚策略）
- `infra/.env.staging.example`（staging 环境变量模板）

### Ubuntu 主机一键部署脚本（推荐）

仓库内已提供部署脚本：`infra/scripts/deploy-ubuntu.sh`（建议固定放在 `infra/scripts/`，便于与 compose/runbook 一起维护）。

如果你要先做 Docker/NVIDIA 依赖预检查（或安装），可先执行：

```bash
cd open-assistant
chmod +x infra/scripts/deploy-ubuntu.install.sh

# 仅预检查（推荐先跑）
OA_INSTALL_WITH_GPU=1 ./infra/scripts/deploy-ubuntu.install.sh check

# 安装并校验（需要 sudo/root）
OA_INSTALL_WITH_GPU=1 ./infra/scripts/deploy-ubuntu.install.sh all
```

首次使用：

```bash
cd open-assistant
chmod +x infra/scripts/deploy-ubuntu.sh
```

建议先准备参数文件（团队协作更稳定）：

```bash
cd open-assistant
cp infra/scripts/deploy-ubuntu.env.example infra/scripts/deploy-ubuntu.env
```

然后按需修改 `infra/scripts/deploy-ubuntu.env`，启动前加载：

```bash
cd open-assistant
set -a; source infra/scripts/deploy-ubuntu.env; set +a
./infra/scripts/deploy-ubuntu.sh up
```

也可以直接使用预置场景模板：

```bash
# 方案 A：mock（快速验收）
cp infra/scripts/deploy-ubuntu.mock.env.example infra/scripts/deploy-ubuntu.env

# 方案 B：real + GPU（真依赖联调）
cp infra/scripts/deploy-ubuntu.real-gpu.env.example infra/scripts/deploy-ubuntu.env

set -a; source infra/scripts/deploy-ubuntu.env; set +a
./infra/scripts/deploy-ubuntu.sh up
```

常用命令：

```bash
# mock 模式（不依赖 FunASR/CosyVoice）
OA_DEPLOY_MODE=mock OA_DEPLOY_USE_GPU=0 ./infra/scripts/deploy-ubuntu.sh up

# real 模式（启用 GPU + 真依赖）
OA_DEPLOY_MODE=real OA_DEPLOY_USE_GPU=1 OA_DEPLOY_BUILD=1 ./infra/scripts/deploy-ubuntu.sh up

# 运行状态 / 日志 / 下线
./infra/scripts/deploy-ubuntu.sh status
./infra/scripts/deploy-ubuntu.sh logs
./infra/scripts/deploy-ubuntu.sh down
```

### 从开发机上传代码到 Ubuntu（rsync 一键）

在开发机执行（将 `<user>@<host>` 替换为你的 SSH 目标）：

```bash
ssh <user>@<host> "mkdir -p /opt/open-assistant"
rsync -az --delete \
  --exclude ".git" \
  --exclude "node_modules" \
  --exclude ".bun-tmp" \
  --exclude ".bun-cache" \
  --exclude "test-results" \
  ./open-assistant/ <user>@<host>:/opt/open-assistant/
```

上传后在 Ubuntu 主机执行：

```bash
cd /opt/open-assistant
chmod +x infra/scripts/deploy-ubuntu.sh
OA_DEPLOY_MODE=mock OA_DEPLOY_USE_GPU=0 ./infra/scripts/deploy-ubuntu.sh up
```

## 3) 导入知识库/素材（可选）

如果你使用 docker compose 跑 `rag/media`（默认是 sqlite 文件在容器卷里），建议用 `docker compose run` 直接把数据导入对应的 volume：

导入 RAG 文档（只处理 `.txt/.md/.markdown`）：

```bash
cd open-assistant
docker compose -f infra/docker-compose.full.yml run --rm -v "<HOST_RAG_DIR>:/ingest" rag \
  bun run --cwd services/rag ingest --dir /ingest --dbPath /app/services/rag/data/rag.sqlite --tenant default --project open-assistant
```

导入素材（按扩展名识别 type：video/slides/model）：

```bash
cd open-assistant
docker compose -f infra/docker-compose.full.yml run --rm -v "<HOST_MEDIA_DIR>:/ingest" media \
  bun run --cwd services/media ingest --dir /ingest --dbPath /app/services/media/data/media.sqlite --tenant default --project open-assistant
```

> Windows PowerShell 路径示例：`-v "D:\\data\\rag-docs:/ingest"`；Linux/macOS：`-v "/data/rag-docs:/ingest"`。

## 4) 压测（并发）

全量栈跑起来后（不需要额外起 mock），可选两类压测：

- `perf:10`：用 `text.in` 模拟用户输入（不走 ASR），覆盖：Gateway+OpenCode+TTS
- `perf:asrtts`：用固定音频走 `audio.in`（走 ASR），覆盖：Gateway+ASR+OpenCode+TTS（并统计 asr.final / 首包 / turn total）

```bash
cd open-assistant
bun run perf:10
```

```bash
cd open-assistant
bun run perf:asrtts
```

### 可选：SLA 断言（用于回归门禁）

`perf:asrtts` 支持可配置阈值并在失败时返回非零退出码（用于 CI）。常用环境变量：

- `OA_PERF_ASSERT=1`：开启断言
- `OA_PERF_MAX_ERROR_RATE=0.05`：允许的错误率上限（默认 0）
- `OA_PERF_REQUIRE_ALIGN=1`：要求观察到 `tts.align` 并与 `tts.audio.segmentId` 绑定成功
- `OA_PERF_P95_FIRST_AUDIO_MS=...` / `OA_PERF_P95_FIRST_ALIGN_MS=...`：首包/对齐 P95 上限
- `OA_PERF_MAX_ALIGN_MISSING_SEGMENTS=0`：允许缺失对齐的 segment 数上限

如果你想“只测 ASR/TTS/网关”，可先用 `OA_LLM_MODE=mock` 启动全量栈，再跑 `perf:asrtts`。

或用脚本：

```bash
cd open-assistant
# up + readyz + perf:10
bun run ops:full

# stack running + readyz + perf:asrtts
bun run ops:full:perf:asrtts

# up + readyz + perf:10 + perf:asrtts
bun run ops:full:up-perf:all
```

## 5) 监控与告警

- Prometheus：`http://localhost:9090`
- Grafana：`http://localhost:3000`（admin/admin）

本仓库提供了基础 Prometheus 告警规则：`infra/prometheus/alerts.yml`，可在 Prometheus 的 Alerts 页面查看触发情况。

### 可选：审计查询（sqlite）

全量栈默认会把 Gateway 的结构化审计日志写入 sqlite（`OA_AUDIT_DB_PATH`），并提供查询/导出接口：

- `GET /audit/healthz`
- `POST /audit/search`
- `POST /audit/sessions`
- `GET/POST /audit/export`

鉴权：若你设置了 `OA_ADMIN_TOKEN`，则需要在 query 或 header 里携带该 token；否则若设置了 `OA_METRICS_TOKEN`，则沿用同一个 token（兼容旧行为）。

