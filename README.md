# Open Assistant（独立项目）

Open Assistant 是一个“纯内网”的语音数字人助手项目：浏览器端采音与展示数字人，Gateway 负责实时编排（ASR/TTS/RAG/播放/打断），并通过 OpenCode Server（`opencode serve`）完成智能体推理与工具调用。

---

## 目录结构

- `apps/web/`：Web Client（Vite + SolidJS + Tailwind）
- `services/gateway/`：Open Assistant Gateway（Bun + Hono，WebSocket）
- `services/asr/`：ASR 服务（PoC 接口，WS 输入 PCM -> partial/final）
- `services/asr-mock/`：ASR mock（用于本地开发与 e2e）
- `services/tts/`：TTS 服务（PoC 接口，文本 -> audio chunks，支持 cancel）
- `services/tts-mock/`：TTS mock（用于本地开发与 e2e）
- `packages/protocol/`：WS 协议与工具 schema（Zod）
- `docs/`：技术方案与可执行 Backlog
- `docs/PRODUCTION_ROADMAP.md`：生产可用推进路线（Keycloak/OIDC + 多租户 tags + 断网运行）
- `.opencode/`：OpenCode agent 配置（供 OpenCode Server 加载）
- `opencode.jsonc`：OpenCode 项目级配置（权限/MCP 等）

---

## 依赖

- Bun（与 OpenCode 对齐，建议 `bun@1.3.5`）
- 一个可运行的 OpenCode Server（`opencode serve`）

---

## Docker Compose（一键启动）

详见 `infra/README.md`。

- 开发（mock）：`docker compose -f infra/docker-compose.yml up`
- 全量（真依赖：FunASR + CosyVoice）：`docker compose -f infra/docker-compose.full.yml up`

---

## 快速开始（开发环境）

1) 安装依赖：

```bash
cd open-assistant
bun install
```

2) 启动 Gateway（新终端）：

```bash
cd open-assistant
bun run dev:gateway
```

> 默认依赖 `asr-mock`（7002）与 `tts-mock`（7003）。建议先在其他终端启动它们：
>
> ```bash
> bun run dev:asr
> bun run dev:tts
> bun run dev:media
> bun run dev:rag
> ```
>
> 如需切到“真实接口 PoC”服务，可改用：
>
> ```bash
> # ASR（FunASR runtime 适配器；需先启动 FunASR websocket 服务）
> # 详见 docs/ASR_FUNASR.md
> OA_ASR_BACKEND=funasr OA_ASR_FUNASR_URL=ws://127.0.0.1:10095 bun run dev:asr:real
> # TTS（CosyVoice runtime 适配器；需先启动 CosyVoice fastapi 服务）
> # 详见 docs/TTS_COSYVOICE.md
> OA_TTS_BACKEND=cosyvoice OA_TTS_COSYVOICE_BASE_URL=http://127.0.0.1:50000 bun run dev:tts:real
> ```

3) 启动 Web（新终端）：

```bash
cd open-assistant
bun run dev:web
```

4) 启动 OpenCode Server（新终端，建议以 `open-assistant/` 作为工作目录运行，自动加载本项目的 `.opencode/` 与 `opencode.jsonc`）：

```bash
cd open-assistant
opencode serve --port 4096 --hostname 127.0.0.1 --cors http://localhost:5173
```

5) 打开 Web：

- `http://localhost:5173`

### PoC：触发一次视频播放（ui.present）

在 Web 的输入框里发送：

- `/present demo-video`（播放 demo）
- `/stop video`（停止视频）

> demo 资源默认来自 `services/media-mock/assets`（用于 Phase 0 mock）。
> demo 资源默认来自 `services/media-mock/assets`（用于 Phase 0 mock），可通过 `OA_MEDIA_MOCK_ASSETS_DIR` 或 `OA_MEDIA_MOCK_DEMO_*_FILE`（video/slides/model）替换为内网素材文件路径。
> 若使用 `services/media`（真实素材服务），其默认也会 seed 同一批 demo 资源；可通过 `OA_MEDIA_DEMO_*_FILE`（video/slides/model）覆盖。

---

## 开发就绪检查

一键跑通“gateway/web 联通 + OpenCode 健康检查 + CORS”：

```bash
cd open-assistant
bun run check:ready
```

> 该脚本会临时启动并在检查后自动关闭相关进程。

---

## 环境变量

复制示例并按需修改：

```bash
cp .env.example .env
```

### Gateway（`services/gateway`）

- `OA_GATEWAY_HOST`（默认 `0.0.0.0`）
- `OA_GATEWAY_PORT`（默认 `7001`）
- `OA_ASR_WS_URL`（默认 `ws://127.0.0.1:7002/asr`）
- `OA_GW_ASR_MAX_CONCURRENT_DECODE`（默认 `4`：ASR 解码并发上限）
- `OA_GW_ASR_QUEUE_MAX_FRAMES`（默认 `50`：排队音频帧上限，超过会丢弃旧帧）
- `OA_GW_ASR_IDLE_RELEASE_MS`（默认 `5000`：无音频后释放解码槽位）
- `OA_TTS_BASE_URL`（默认 `http://127.0.0.1:7003`）
- `OA_LLM_MODE`（默认 `opencode`，也可设为 `mock`）
- `OA_AUTH_MODE`（默认 `disabled`；可选 `static/oidc`，为 SSO/OIDC 预留）
- `OA_AUTH_TOKEN`（`OA_AUTH_MODE=static` 时必填）
  - `OA_OIDC_ISSUER/OA_OIDC_AUDIENCE/OA_OIDC_JWKS_URL`（`OA_AUTH_MODE=oidc` 时使用）
  - `OA_AUTH_SUB_CLAIM/OA_AUTH_TENANT_CLAIM/OA_AUTH_PROJECT_CLAIM`（OIDC claim 映射，默认 `sub/tenant/project`）
  - `OA_OPENCODE_MCP_TOKEN`（当 `OA_AUTH_MODE != disabled` 时，OpenCode Server 调用 Gateway `/mcp` 需要带的 token）
  - `OA_OPENCODE_MCP_TOKEN_PREVIOUS`（可选：`/mcp` 旧 token；用于平滑轮换，允许短暂双 token 并存）
  - `OA_METRICS_TOKEN`（可选：保护 Gateway `/metrics`）
  - `OA_ADMIN_TOKEN`（可选：保护 Gateway `/audit/*`、`/admin/api/*`、`/admin/assets/*`；未设置则兼容复用 `OA_METRICS_TOKEN`；同时作为 Media/RAG 管理接口的回退 token）
  - `OA_AUTH_TAGS_MODE`（默认 `disabled`；可设为 `enforce`，让 `rag.search/asset.search` 自动注入 tags 并限制越权检索）
  - `OA_AUTH_TAGS`（可选：静态标签列表，逗号分隔；可用于 `OA_AUTH_MODE=static/disabled`）
  - `OA_AUTH_TAGS_CLAIM` / `OA_OIDC_REQUIRE_TAGS`（OIDC 标签 claim 映射与是否强制要求）

### Web（`apps/web`）

- `VITE_GATEWAY_WS_URL`（默认 `ws://localhost:7001/ws`）
- `VITE_OA_TOKEN`（可选：默认注入到 Web 的 token；也可以直接在页面里填写后 Connect）
- （可选）`VITE_OA_OIDC_ISSUER` / `VITE_OA_OIDC_CLIENT_ID`（Keycloak OIDC；Web 侧将启用 Auth Code + PKCE 登录）
- （可选）`VITE_OA_OIDC_SCOPE`（默认 `openid profile email`）
- （可选）`VITE_OA_OIDC_REDIRECT_URI`（默认取当前页面 URL（不含 query/hash））

### Media（`services/media`）（可选：真实素材服务）

- `OA_MEDIA_ALLOW_HOSTS`（逗号分隔 host 列表；**默认不允许 remote source**，必须显式 allowlist 才可拉取远端 URL）
- `OA_MEDIA_ADMIN_TOKEN`（可选：保护 Media 的管理接口；未设置则回退使用 `OA_ADMIN_TOKEN`）
- `OA_MEDIA_DEMO_VIDEO_FILE/OA_MEDIA_DEMO_SLIDES_FILE/OA_MEDIA_DEMO_MODEL_FILE`（可选：覆盖 demo 素材文件路径）

### RAG（`services/rag`）（可选：内网检索服务）

- `OA_RAG_ADMIN_TOKEN`（可选：保护 RAG 的文档管理接口（`/doc/*`）与管理员检索（`/admin/search`）；未设置则回退使用 `OA_ADMIN_TOKEN`）

---

## OpenCode 配置与权限

本项目提供：

- `open-assistant/opencode.jsonc`：禁用高风险工具（如 `bash/edit/webfetch`），并启用 `openassistant` MCP（`http://127.0.0.1:7001/mcp`）
- `open-assistant/.opencode/agent/open-assistant.md`：数字人 agent（最小工具集）

Gateway 已提供 MCP 工具：`rag.search / asset.search / ui.present / ui.stop`。其中 `rag.search/asset.search/ui.present/ui.stop` 都需要携带 `sessionID`，并由 Gateway 绑定到会话 scope（tenant/project）。

---

## Phase 0 说明（当前实现）

- Web 端提供“输入文本（模拟 ASR final）”用于先打通 OpenCode 推理链路
- 默认使用 `tts.audio` 播放（可在页面切换为浏览器 `SpeechSynthesis` 兜底）
- 已实现 `ui.present(assetId)` 的 video 播放 PoC：资源通过 Gateway `/assets/:assetId` 拉取（不允许客户端直传 URL）
- slides 与 3D model 默认在 sandbox iframe 中渲染（降低 XSS 风险）

## 压测（Phase 1）

10 路并发脚本（输出 p50/p95、打断延迟、错误率，并写入 `test-results/perf-report-*.json`）：

```bash
cd open-assistant
OA_PERF_SPAWN_STACK=1 bun run perf:10
```
