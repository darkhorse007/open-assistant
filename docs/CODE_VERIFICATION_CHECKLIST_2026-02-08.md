# Open Assistant 逐条（非抽样）代码核验清单

> 生成时间：2026-02-08
> 核验对象：`docs/EXECUTABLE_BACKLOG.md` 全部 59 条 OA 条目
> 本轮命令：`bun run typecheck`（通过）、`bun run test:e2e`（2/2 通过）、`bun run perf:asrtts`（未通过，原因见备注）

## 分级标准
- 代码已证实：已定位实现代码/配置，并与条目描述一致。
- 需联调：代码存在，但依赖外部系统/部署环境/真实数据链路才能完成最终确认。
- 未证实：未找到关键实现或证据不足。

## 统计结果
- 总条目：59
- 代码已证实：47
- 需联调：12
- 未证实：0

## 逐条核验明细
| ID | 结论 | 关键证据 | 说明 |
| --- | --- | --- | --- |
| OA-FOUND-001 | 代码已证实 | package.json、packages/protocol/package.json、services/gateway/package.json、apps/web/package.json | 已定位到对应实现与文档落点 |
| OA-FOUND-002 | 代码已证实 | packages/protocol/src/ws.ts | 已定位到对应实现与文档落点 |
| OA-FOUND-003 | 代码已证实 | apps/web/index.html、apps/web/model-frame.html、services/gateway/src/index.ts | 已定位到对应实现与文档落点 |
| OA-FOUND-004 | 代码已证实 | services/gateway/src/metrics.ts、infra/grafana/provisioning/dashboards/openassistant-gateway.json | 已定位到对应实现与文档落点 |
| OA-OC-001 | 代码已证实 | .opencode/agent/open-assistant.md | 已定位到对应实现与文档落点 |
| OA-OC-002 | 代码已证实 | docs/ADR_OA_OC_002_MCP.md | 已定位到对应实现与文档落点 |
| OA-PROTO-001 | 代码已证实 | packages/protocol/src/ws.ts | 已定位到对应实现与文档落点 |
| OA-PROTO-002 | 代码已证实 | services/gateway/src/mcp.ts | 已定位到对应实现与文档落点 |
| OA-GW-001 | 代码已证实 | services/gateway/src/index.ts | 已定位到对应实现与文档落点 |
| OA-GW-002 | 代码已证实 | services/gateway/src/index.ts | 已定位到对应实现与文档落点 |
| OA-GW-003 | 代码已证实 | services/gateway/src/index.ts | 已定位到对应实现与文档落点 |
| OA-GW-005 | 代码已证实 | services/gateway/src/asr.ts、services/gateway/src/index.ts | 已定位到对应实现与文档落点 |
| OA-GW-006 | 代码已证实 | services/gateway/src/tts.ts、services/gateway/src/tts-scheduler.ts、services/gateway/src/index.ts | 已定位到对应实现与文档落点 |
| OA-WEB-001 | 代码已证实 | apps/web/src/ui/App.tsx | 已定位到对应实现与文档落点 |
| OA-WEB-002 | 代码已证实 | apps/web/src/ui/App.tsx | 已定位到对应实现与文档落点 |
| OA-WEB-003 | 代码已证实 | apps/web/src/ui/App.tsx | 已定位到对应实现与文档落点 |
| OA-WEB-004 | 代码已证实 | apps/web/src/ui/App.tsx | 已定位到对应实现与文档落点 |
| OA-WEB-005 | 代码已证实 | apps/web/src/ui/App.tsx | 已定位到对应实现与文档落点 |
| OA-WEB-006 | 代码已证实 | apps/web/src/ui/App.tsx | 已定位到对应实现与文档落点 |
| OA-ASR-001 | 需联调 | services/asr | 真实 FunASR Runtime 端到端时延/稳定性需联调确认 |
| OA-TTS-001 | 需联调 | services/tts | 真实 CosyVoice Runtime 合成链路需联调确认 |
| OA-RAG-001 | 代码已证实 | services/rag-mock/src/index.ts | 已定位到对应实现与文档落点 |
| OA-MEDIA-001 | 代码已证实 | services/media-mock/src/index.ts | 已定位到对应实现与文档落点 |
| OA-GW-004 | 需联调 | services/gateway/src/opencode.ts、services/gateway/src/opencode-events.ts、services/gateway/src/index.ts | 依赖 OpenCode /global/event，本轮 e2e 走 mock LLM |
| OA-GW-101 | 代码已证实 | services/gateway/src/index.ts | 已定位到对应实现与文档落点 |
| OA-GW-102 | 代码已证实 | services/gateway/src/index.ts | 已定位到对应实现与文档落点 |
| OA-GW-103 | 代码已证实 | services/gateway/src/asr-scheduler.ts | 已定位到对应实现与文档落点 |
| OA-GW-104 | 代码已证实 | services/gateway/src/tts-scheduler.ts | 已定位到对应实现与文档落点 |
| OA-GW-105 | 代码已证实 | services/gateway/src/index.ts | 已定位到对应实现与文档落点 |
| OA-GW-106 | 代码已证实 | services/gateway/src/audit.ts、services/gateway/src/index.ts | 已定位到对应实现与文档落点 |
| OA-RAG-101 | 代码已证实 | services/rag/src/index.ts | 已定位到对应实现与文档落点 |
| OA-RAG-102 | 代码已证实 | services/rag、services/rag/src/cli.ts | 已定位到对应实现与文档落点 |
| OA-MEDIA-101 | 代码已证实 | services/media/src/index.ts | 已定位到对应实现与文档落点 |
| OA-MEDIA-102 | 代码已证实 | services/gateway/src/index.ts、services/media/src/index.ts | 已定位到对应实现与文档落点 |
| OA-MEDIA-103 | 代码已证实 | services/media/src/index.ts、services/gateway/src/index.ts | 已定位到对应实现与文档落点 |
| OA-WEB-101 | 代码已证实 | apps/web/src/ui/App.tsx | 已定位到对应实现与文档落点 |
| OA-WEB-104 | 代码已证实 | apps/web/src/ui/App.tsx | 已定位到对应实现与文档落点 |
| OA-WEB-102 | 代码已证实 | apps/web/index.html、apps/web/model-frame.html、apps/web/src/ui/App.tsx | 已定位到对应实现与文档落点 |
| OA-WEB-103 | 代码已证实 | apps/web/src/ui/App.tsx | 已定位到对应实现与文档落点 |
| OA-OC-101 | 代码已证实 | services/gateway/src/mcp.ts | 已定位到对应实现与文档落点 |
| OA-OC-102 | 代码已证实 | .opencode/agent/open-assistant.md | 已定位到对应实现与文档落点 |
| OA-OBS-101 | 代码已证实 | services/gateway/src/index.ts、infra/grafana/provisioning/dashboards/openassistant-gateway.json | 已定位到对应实现与文档落点 |
| OA-TEST-101 | 代码已证实 | scripts/e2e.ts | 已定位到对应实现与文档落点 |
| OA-PERF-101 | 需联调 | scripts/perf-10sessions.ts、test-results/ | 压测脚本与报告路径已实现，本轮未执行 10 会话压测 |
| OA-PERF-102 | 需联调 | scripts/perf-asrtts.ts、test-results/ | 脚本已实现；本轮执行因 /readyz 依赖未满足失败 |
| OA-OPS-101 | 需联调 | infra/docker-compose.full.yml、infra/README.md | compose 全栈编排文件存在，需容器环境联调 |
| OA-OPS-102 | 需联调 | infra/caddy/Caddyfile、infra/README.md | 反代/TLS 配置存在，需证书信任与内网域名联调 |
| OA-OPS-103 | 需联调 | infra/prometheus/alerts.yml | Prometheus/Grafana/告警规则存在，需实际监控栈联调 |
| OA-OPS-104 | 需联调 | infra/docker-compose.prod.yml、scripts/full-stack.ts | 生产镜像与 prod compose 存在，需断网/生产形态联调 |
| OA-AUTH-101 | 需联调 | services/gateway/src/auth.ts、services/gateway/src/index.ts | disabled/static/oidc 路径已实现，需真实 IdP/token 联调 |
| OA-AUTH-102 | 需联调 | services/gateway/src/mcp.ts、services/gateway/src/index.ts | 租户与标签强校验代码存在，需多租户真实数据联调 |
| OA-TTS-201 | 代码已证实 | services/tts/src/index.ts、services/tts-mock/src/index.ts、services/gateway/src/index.ts、packages/protocol/src/ws.ts | 已定位到对应实现与文档落点 |
| OA-WEB-201 | 需联调 | apps/web/src/ui/App.tsx、apps/web/src/model-frame.ts | viseme 主链路已实现；模型自定义 morph map 消息通道需联调复核 |
| OA-GW-201 | 代码已证实 | services/gateway/src/index.ts、apps/web/src/ui/App.tsx | 已定位到对应实现与文档落点 |
| OA-ADMIN-301 | 代码已证实 | apps/web/admin.html、apps/web/src/ui/AdminApp.tsx | 已定位到对应实现与文档落点 |
| OA-ADMIN-302 | 代码已证实 | apps/web/src/ui/AdminApp.tsx、services/rag/src/index.ts、services/rag/src/db.ts | 已定位到对应实现与文档落点 |
| OA-ADMIN-303 | 代码已证实 | apps/web/src/ui/AdminApp.tsx、services/media/src/index.ts、services/gateway/src/index.ts | 已定位到对应实现与文档落点 |
| OA-ADMIN-304 | 代码已证实 | services/gateway/src/index.ts、services/gateway/src/audit-db.ts、apps/web/src/ui/AdminApp.tsx | 已定位到对应实现与文档落点 |
| OA-ADMIN-305 | 代码已证实 | services/gateway/src/index.ts、services/gateway/src/audit-db.ts、apps/web/src/ui/AdminApp.tsx | 已定位到对应实现与文档落点 |

## 联调优先级建议（按风险）
- P0：`OA-ASR-001`、`OA-TTS-001`、`OA-GW-004`、`OA-AUTH-101`、`OA-AUTH-102`
- P1：`OA-OPS-101`、`OA-OPS-102`、`OA-OPS-103`、`OA-OPS-104`
- P1：`OA-PERF-101`、`OA-PERF-102`（补齐真实依赖后的压测与 SLA 断言）
- P2：`OA-WEB-201`（模型自定义 morph map 消息通道联调复核）
