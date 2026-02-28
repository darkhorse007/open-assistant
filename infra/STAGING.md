# Staging 联调与 perf 留证（OA-OPS-105）

目标：在 **真实依赖（FunASR + CosyVoice + OpenCode）** 下，先以低并发跑通全链路，并产出可追溯的 perf 留证文件（用于 Go/No-Go）。

## 1) 准备（建议）

1. 生成并编辑 staging 配置：

```bash
cd open-assistant
cp infra/.env.staging.example infra/.env
```

2. 按需修改 `infra/.env`：
   - 镜像来源（内网 registry / 离线环境）
   - `COSYVOICE_MODEL_DIR`（首次联网预热后建议保持不变）
   - 低并发参数（`OA_GW_MAX_SESSIONS` 等）
   - `OA_OPENCODE_MCP_TOKEN`（启用鉴权时必需；建议 staging 也启用）

## 2) 一键联调 + 留证（首次联网初始化）

```bash
cd open-assistant
OA_FULL_COMPOSE_MODE=prod OA_FULL_BUILD=1 bun run ops:full:up-perf:all
```

说明：
- `OA_FULL_BUILD=1`：会 build 生产镜像（适合“首次联网初始化”阶段）。
- `infra/.env.staging.example` 默认开启 `OA_PERF_ASSERT=1`，会对 `perf:10` 与 `perf:asrtts` 执行 SLA 断言（错误率/p95/打断延迟等）。
- 为避免 `perf:10` 在短语料场景下出现“无打断样本”抖动，`perf:10` 的打断阈值默认留空；打断延迟门禁默认由 `perf:asrtts` 的 `OA_PERF_P95_INTERRUPT_MS` 承担。
- 任一断言失败会返回非零退出码（发布 gate 失败），并在报告里写入 `assert.failures`。
- 产物会写入 `open-assistant/test-results/`（默认被 gitignore；请自行归档/上传到发布附件）。

## 3) 断网复启（上线形态演练）

断网后（或在“禁止 pull/build”的上线策略下）再次启动：

```bash
cd open-assistant
OA_FULL_COMPOSE_MODE=prod bun run ops:full:up
```

## 4) 留证文件（必交付）

同一次执行会共享同一个 `runId`，输出：

- `open-assistant/test-results/perf-evidence-<runId>.json`（包含 readyz + compose ps + 报告路径）
- `open-assistant/test-results/perf-report-<runId>.json`（perf:10）
- `open-assistant/test-results/perf-asrtts-report-<runId>.json`（perf:asrtts）

如 staging 部署不包含 `.git`，建议在 `infra/.env` 填写：
- `OA_BUILD_VERSION`（例如 `2026.02.28-rc1`）
- `OA_BUILD_SHA`（例如你们 CI 的 commit sha）

## 5) 常见问题（排障）

- `readyz` 长时间不通过：
  - 先看 `GET http://127.0.0.1:7001/readyz` 的 `checks.*.detail`
  - 常见原因：模型未预热下载完 / CosyVoice 冷启动过慢 / GPU runtime 未就绪
  - 可临时把 `OA_GW_TURN_TIMEOUT_MS` 调大，再重新跑一遍 `up-perf:all`

- 镜像拉取失败（断网或外网受限）：
  - 在 `infra/.env` 覆盖 `FUNASR_IMAGE` / `COSYVOICE_IMAGE` / `KEYCLOAK_IMAGE` 指向内网 registry

- `/mcp` 报错 `mcp_token_required`：
  - 说明启用了鉴权，但未配置 `OA_OPENCODE_MCP_TOKEN`（OpenCode -> Gateway 服务间 token）

## 6) 回滚策略（最小）

1. **不清卷优先**：避免删除模型/缓存（不要轻易 `down -v`）。

2. 回滚到上一次可用的镜像：
   - 找到旧镜像 ID：`docker image ls | rg openassistant-app`
   - 重新打回 `:prod` 标签（示例）：

```bash
docker tag <old-image-id> openassistant-app:prod
docker tag <old-image-id> openassistant-caddy:prod
docker tag <old-image-id> openassistant-opencode:prod
```

3. 用“禁止 pull/build”的方式重新拉起：

```bash
cd open-assistant
OA_FULL_COMPOSE_MODE=prod bun run ops:full:up
```
