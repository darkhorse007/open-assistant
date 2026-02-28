# Open Assistant 生产可用任务清单（对齐 `docs/EXECUTABLE_BACKLOG.md`）

> 更新时间：2026-02-28  
> 目标来源：`docs/PRODUCTION_ROADMAP.md`  
> 对齐对象：`docs/EXECUTABLE_BACKLOG.md` 的 OA-* 条目（本文件主要补齐“生产联调/留证/运维流程”任务）。

## 1) RC0：生产形态空跑（mock backends + 断网运行骨架）

### OA-OPS-101 / OA-OPS-104：环境模板 + 断网演练（Init 联网 → Prod 断网）
- 目标：把“能 build、能预热、断网能 up”的流程固化成可复用脚本/模板。
- 产出：
  - `infra/.env` 的 staging/prod 模板（域名/端口/卷/镜像源/各类 token）
  - 一份演练记录（命令、耗时、失败点、修复项）
- 验收（建议留证）：
  - 联网：`OA_FULL_COMPOSE_MODE=prod OA_FULL_BUILD=1 OA_FULL_LLM_MODE=mock OA_FULL_MOCK_BACKENDS=1 bun run ops:full:up-perf:all`
  - 断网：`OA_FULL_COMPOSE_MODE=prod bun run ops:full:up`
  - `GET http://127.0.0.1:7001/readyz` 为 200 且 `ok=true`

### OA-OPS-102：生产证书/域名策略定版（替换或豁免 tls internal）
- 目标：明确生产是否允许 `tls internal`，若不允许则落地内网 CA/证书下发流程。
- 产出：证书与域名策略说明（含回滚/轮换），以及 Caddy/反代的最终配置约束。
- 验收：浏览器访问反代域名无告警（或有明确豁免路径），wss 可用。

### OA-OBS-101 / OA-OPS-103：监控与告警联调（可观测最小闭环）
- 目标：指标可采、看板可看、告警可触发/可静默。
- 产出：Prometheus/Grafana 的“上线必看面板”清单 + 告警接收策略（飞书/邮件/值班）。
- 验收（建议留证）：
  - `/metrics` 可采集（必要时设置 `OA_METRICS_TOKEN`）
  - 告警规则在压测/故障注入下能触发（例如 errors/queue/latency）

### OA-GW-106 / OA-ADMIN-304 / OA-ADMIN-305：审计落盘与检索闭环
- 目标：关键链路（rag/search、asset/search、ui.present、abort、鉴权事件）可追溯，且可按租户隔离检索。
- 产出：审计落盘策略（`hash/full`、保留周期、脱敏要求）+ 导出流程。
- 验收（建议留证）：管理后台可按 `tenant/project/sessionID` 检索并导出。

## 2) RC1：真实 ASR/TTS 全链路（先低并发）

### OA-ASR-001 / OA-TTS-001：真实依赖可用性 + 离线准备
- 目标：FunASR/CosyVoice 在“预热后断网”仍可通过 `/readyz`，并能稳定跑完一轮 turn。
- 产出：镜像与模型/缓存策略（volume、离线拷贝流程、首次联网预热步骤）。
- 验收：断网后 `GET /readyz` 仍为 200（前提：已完成联网预热）。

### OA-PERF-101 / OA-PERF-102：perf 基线与阈值（SLA）
- 目标：把“可跑通”变成“可量化”的稳定性门禁（低并发先过，再逐步加压）。
- 产出：`test-results/perf-report-*.json`（staging）+ 初版阈值（p95/错误率/打断延迟）。
- 验收：`bun run perf:asrtts`、`bun run perf:10` 在低并发下错误率为 0（或有明确可复现的已知问题清单）。

### OA-GW-103 / OA-GW-104 / OA-GW-105：并发/队列/超时参数收敛
- 目标：基于 perf 报告，把默认参数收敛为可复用“硬件档位配置”（CPU/GPU、并发上限）。
- 产出：参数推荐表（`OA_GW_MAX_SESSIONS`、ASR/TTS 并发、`OA_GW_TURN_TIMEOUT_MS` 等）与调参指南。
- 验收：同一硬件上重复压测波动在可接受范围内（定义 p95 抖动阈值）。

## 3) RC2：Keycloak OIDC + 多租户 tags（强制模式）

### OA-AUTH-101：WS 连接鉴权（OIDC）生产联调
- 目标：Web → Gateway 的 `/ws` 必须携带用户 JWT，且会话绑定 identity 防劫持。
- 产出：Keycloak → Gateway 的配置模板（issuer/audience/claim 映射）与联调用例。
- 验收（必须负例）：缺 token、错 issuer/aud 的 token 必须被拒绝。

### OA-AUTH-102：tenant/project/tags 强校验贯穿（MCP / RAG / Media / Audit）
- 目标：`OA_AUTH_TAGS_MODE=enforce` 后，`rag.search/asset.search/ui.present` 必须按 tags 做越权约束与注入。
- 产出：多租户/多标签的联调用例集（正例+负例）+ 审计证据（事件里带 tenant/project/tags）。
- 验收（必须负例）：请求 tags 不在 identity.tags 中必须失败或被收敛。

## 4) RC3：OpenCode → Gateway `/mcp` 服务间鉴权与暴露面收敛

### OA-OC-101（补充生产验收）：/mcp 服务间 token + 网络隔离
- 目标：OpenCode 调 `/mcp` 不依赖用户 OIDC token；只依赖服务间 token（`OA_OPENCODE_MCP_TOKEN`）。
- 产出：
  - `OA_OPENCODE_MCP_TOKEN` 的生成/分发/轮换策略
  - 网络策略：仅允许 OpenCode 网段访问 `/mcp`
  - 运维手册：`infra/SECURITY_MCP_OIDC.md`
- 验收：
  - 未带 token 调 `/mcp` 返回 401
  - `OA_AUTH_MODE=oidc` 开启后，OpenCode 仍可调用 `rag.search/asset.search/ui.present/ui.stop`

### RC2/RC3 负例留证命令（建议纳入回归）
- 命令：`bun run test:rc2rc3`
- 输出：可通过 `OA_RC23_OUTPUT_FILE=test-results/rc2-rc3-negative-<runId>.log` 指定留证文件。
- 覆盖：WS 缺失/错误 token 拒绝、`/assets` 鉴权拒绝、`/mcp` 服务 token 校验、`rag.search` tags 越权拦截。

### 统一门禁命令（建议）
- 命令：`bun run gate:release`
- 默认串行：`typecheck` -> `test:rc2rc3` -> `test:e2e`
- 本机临时跳过 e2e：`OA_GATE_SKIP_E2E=1 bun run gate:release`

## 5) 发布 gate（已补充到 Backlog）

### OA-TEST-102 / OA-OPS-105：CI 回归 + staging perf 留证
- 已补充到 `docs/EXECUTABLE_BACKLOG.md`：
  - `OA-TEST-102`：CI gate（`bun run typecheck` + `bun run test:rc2rc3` + `bun run test:e2e`）
  - `OA-OPS-105`：staging 真依赖 `ops:full:up-perf:all` + 保存 perf 报告作为发布证据

## 6) Backlog 补齐（已补充条目）

> 下列内容是 `PRODUCTION_ROADMAP` 的“生产必做”，已补充到 `docs/EXECUTABLE_BACKLOG.md` 以便跟踪。

- OA-OPS-106：Keycloak 部署与备份（Realm/Client 初始化脚本、数据备份/恢复、升级策略）
- OA-WEB-105：Web 侧 OIDC 登录（Auth Code + PKCE）与 token 生命周期（刷新/登出/存储策略）
