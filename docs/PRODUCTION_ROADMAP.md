# Open Assistant 生产可用推进路线（Keycloak / OIDC + 多租户 tags + 可断网运行）

> 更新时间：2026-02-28  
> 目标：允许“首次联网初始化”，上线后可断网运行；必须支持 OIDC + 多租户 tags；初期并发可小，但必须跑通全链路。

> 任务清单：见 `docs/PRODUCTION_TASKS.md`（按 RC0–RC3 拆解，含产出与验收）

## 0) “生产可用”验收口径（建议作为 Go/No-Go）

### 0.1 部署形态（断网运行）
- 允许 **首次联网**：构建镜像 + 预热下载模型/缓存。
- 上线后 **断网可启动**：`prod` 模式默认 `--pull never --no-build` 也能稳定启动（详见 `scripts/full-stack.ts` 的默认策略）。
- 生产 Web 静态资源由 Caddy 提供，不依赖 `vite dev server`（`infra/docker-compose.prod.yml`）。

### 0.2 鉴权与租户隔离（Keycloak）
- Web 客户端访问 `/ws`（以及 `/assets/:assetId`）必须携带用户 OIDC JWT。
- Gateway 必须把 WS 会话绑定到 `sub/tenant/project/tags`，并在重连时强校验身份一致（防止 sessionID 劫持）。
- `rag.search / asset.search / ui.present` 只能在 **会话 scope** 内工作，且在 `OA_AUTH_TAGS_MODE=enforce` 时必须做 tags 强校验与注入（在 MCP 层完成）。

### 0.3 OpenCode 工具调用（/mcp）
- `/mcp` 是 **服务间接口**（OpenCode → Gateway），不应该要求携带用户 OIDC token。
- 当 `OA_AUTH_MODE != disabled` 时，`/mcp` 必须使用 `OA_OPENCODE_MCP_TOKEN` 做鉴权（OpenCode 配置在 `opencode.jsonc` 中已按此设计）。

### 0.4 可观测与可追溯
- `GET /readyz` 可以准确反映依赖状态（OpenCode / ASR / TTS / RAG / Media）。
- Prometheus 指标 + 告警规则生效；关键审计事件可落库（hash/full）并可按 tenant/project/sessionID 查询。

## 1) 里程碑（RC 分阶段）

> 建议从 RC0 → RC3 逐个把“不确定性”变成可自动验收的结论。

### RC0：生产形态空跑（不追求真实依赖性能）
目标：先把 **prod overlay + 断网运行链路**跑通，避免后面把“功能 bug”和“运维/镜像问题”混在一起排查。

操作建议：
- 联网环境执行一次构建与预热（可选 GPU）：
  - `OA_FULL_COMPOSE_MODE=prod OA_FULL_BUILD=1 OA_FULL_LLM_MODE=mock OA_FULL_MOCK_BACKENDS=1 bun run ops:full:up-perf:all`
- 断网后再次启动（不 build、不 pull）：
  - `OA_FULL_COMPOSE_MODE=prod bun run ops:full:up`

验收：
- `GET http://127.0.0.1:7001/readyz` 返回 `200` 且 `ok=true`
- `GET /metrics` 可采集到 Gateway 指标（必要时设置 `OA_METRICS_TOKEN`）
- 审计库落盘（设置 `OA_AUDIT_DB_PATH`）并可通过管理页检索

### RC1：真实 ASR/TTS 全链路联调（先低并发）
目标：在“并发很小”的前提下，用真实 ASR/TTS 跑通一轮 turn（含打断），并得到初版性能数据。

操作建议：
- 先从 `OA_GW_MAX_SESSIONS=2` 起步（以及更低的 ASR/TTS 并发上限），确保系统稳定，再逐步加压。
- 运行性能脚本与报告落盘：
  - `bun run perf:asrtts`
  - `bun run perf:10`

验收：
- `perf` 报告错误率为 0（或可解释且可修复）
- `readyz` 在真实依赖冷启动/模型加载阶段不会误判（必要时调大 `OA_GW_TURN_TIMEOUT_MS`）

### RC2：Keycloak OIDC + 多租户 tags（强制模式）
目标：把“生产必须的安全边界”打开，并完成端到端联调与越权测试。

本仓库提供本地联调用的 Keycloak overlay（可选）：

- `infra/docker-compose.full.keycloak.yml`：Keycloak + Postgres（导入 `infra/keycloak/realm-openassistant.json`）
- 脚本模式：`OA_FULL_KEYCLOAK=1 bun run ops:full:up`（会叠加上述 overlay）

Keycloak 最小要求（建议）：
- access token 中包含 claims：
  - `tenant`: string
  - `project`: string
  - `tags`: string[]（或逗号分隔 string）
- Gateway 对应配置：
  - `OA_AUTH_MODE=oidc`
  - `OA_OIDC_ISSUER=http(s)://<keycloak>/realms/<realm>`
  - `OA_OIDC_AUDIENCE=<client-id>`（可选，若你们启用 aud 校验）
  - `OA_AUTH_TENANT_CLAIM=tenant` / `OA_AUTH_PROJECT_CLAIM=project` / `OA_AUTH_TAGS_CLAIM=tags`
  - `OA_AUTH_TAGS_MODE=enforce`
  - `OA_OIDC_REQUIRE_TAGS=true`

验收（必须做负例）：
- 错 tenant/project/tags 的 token 无法建立 WS 会话或无法调用受限能力
- `rag.search / asset.search` 不能越权检索（MCP 层会对 filters 注入/强校验）

### RC3：/mcp 服务间鉴权（OpenCode → Gateway）与最小暴露面
目标：确保 OpenCode 工具调用不依赖用户 token，并将 `/mcp` 作为“内网服务间接口”保护起来。

操作建议：
- 设置 `OA_OPENCODE_MCP_TOKEN`（在 `infra/.env` 或运行环境变量中）。
- 轮换窗口可选配置 `OA_OPENCODE_MCP_TOKEN_PREVIOUS`（旧 token，短暂并存后清理）。
- 确认 OpenCode 配置已携带该 token（`opencode.jsonc` / `infra/opencode/opencode.jsonc`）。
- 网络侧建议：仅允许 OpenCode 所在网段访问 `/mcp`（或只在内网反代暴露）。
- 具体运维流程见：`infra/SECURITY_MCP_OIDC.md`。

验收：
- `OA_AUTH_MODE=oidc` 开启后，OpenCode 仍可调用 `rag.search/asset.search/ui.present/ui.stop`
- 未携带 `OA_OPENCODE_MCP_TOKEN` 调用 `/mcp` 必须返回 401

## 2) 最小回归命令集（建议纳入 CI / 发布 gate）

- `bun run typecheck`
- `bun run test:e2e`（mock LLM，用于回归 UI/WS/播放/打断）
- `bun run test:rc2rc3`（OIDC + `/mcp` + tags 强校验负例回归）
- `bun run gate:release`（聚合门禁：typecheck + rc2rc3 + e2e）
- staging（真实依赖）：
  - `OA_FULL_COMPOSE_MODE=prod OA_FULL_BUILD=1 OA_FULL_LLM_MODE=opencode ... bun run ops:full:up-perf:all`
  - 验证 `readyz` + Prometheus 告警阈值 + 审计检索
