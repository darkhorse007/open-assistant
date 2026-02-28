# Open Assistant 代码核验清单（更新版）

> 生成时间：2026-02-28  
> 说明：本文件用于替代 `docs/CODE_VERIFICATION_CHECKLIST_2026-02-08.md` 的阶段性快照，反映当前主干状态。

## 1) 核验范围

- 主干代码与执行脚本（Gateway/Web/ASR/TTS/RAG/Media/Infra）
- 生产任务对齐文档（`docs/EXECUTABLE_BACKLOG.md`、`docs/PRODUCTION_*`）
- 发布门禁与负例回归（typecheck / RC2-RC3 / staging perf evidence）

## 2) 统计结果（按 Backlog 状态）

- 状态条目总数：63
- 已落地：63
- 待落地：0

## 3) 本轮执行命令与结果

1. `bun run typecheck`：通过  
2. `bun run test:rc2rc3`：通过（负例回归 `ok=true`）  
3. `OA_FULL_COMPOSE_MODE=prod OA_FULL_BUILD=1 OA_GRAFANA_PORT=3300 bun run ops:full:up-perf:all`：通过  
   对应 runId：`1772263423939`  
4. `OA_PERF_SPAWN_STACK=1 OA_PERF_ASSERT=1 ... bun run perf:10`：通过（`SLA: OK`）
5. `OA_GATE_SKIP_E2E=1 bun run gate:release`：通过（聚合门禁命令）

## 4) 关键证据路径

- `test-results/perf-evidence-1772263423939.json`
- `test-results/perf-report-1772263423939.json`
- `test-results/perf-asrtts-report-1772263423939.json`
- `test-results/rc2-rc3-negative-script-20260228-165807.log`
- `test-results/perf-report-1772269108022.json`
- `docs/GO_NO_GO_RECORD_2026-02-28.md`

## 5) 发现与结论

1. 发布门禁已从“typecheck + e2e”扩展为“typecheck + RC2/RC3 负例 + e2e”。  
2. `/assets` 在 OIDC 错 token 场景已收敛为 `401`（不再是 `500`）。  
3. `/mcp` 支持 `OA_OPENCODE_MCP_TOKEN_PREVIOUS`，可做短窗口平滑轮换。

## 6) 剩余风险

1. 本机（Windows + Bun）`bun run test:e2e` 仍有 Playwright 兼容问题（`playwright.config.ts.esm.preflight`）。  
2. RC3 的网络隔离需要在目标环境落实（安全组/反代 ACL），不属于单纯代码问题。
