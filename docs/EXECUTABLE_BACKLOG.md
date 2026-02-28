# Open Assistant 可执行 Backlog（对齐 OpenCode 技术栈）

> 更新时间：2026-02-28  
> 参考：`open-assistant/docs/TECHNICAL_SOLUTION.md`

本文件把《技术方案》落成可执行的交付 Backlog（按 Phase/Epic/Story 拆分），用于直接录入 Jira/Linear/飞书项目等。

---

## 0. 技术栈对齐（以 OpenCode 为准）

为降低集成成本，本产品默认与 OpenCode（OpenCode Server / OpenCode CLI）技术栈保持一致（但 **Open Assistant 项目独立存在**）：

- **语言/运行时**：TypeScript（ESM）+ Bun（同 OpenCode）
- **Web Client**：Vite + SolidJS + TailwindCSS（同 `opencode/packages/app`）
- **Gateway（实时编排层）**：Bun + Hono + Zod 校验（同 OpenCode 生态）
- **共享协议/Schema**：Zod（运行时校验）+ JSON Schema（可选，用于审计与协议版本管理）
- **测试**：Bun test（单元/集成）+ Playwright（端到端）
- **部署形态**：docker-compose 起步，后续可迁移 K8s；监控以 Prometheus/Grafana 为基线

### 推荐目录结构（独立项目）
> 本 Backlog 以 **`open-assistant/` 独立项目**为默认路径；若你们选择将其合并进 `opencode/` monorepo，可按相同层级平移目录。

- `open-assistant/packages/protocol/`：WS 协议 + MCP 工具 schema + TS types（Zod）
- `open-assistant/services/gateway/`：实时编排层（WS、状态机、队列、取消、审计）
- `open-assistant/apps/web/`：网页端数字人/播放器
- `open-assistant/infra/`：docker-compose、反代、证书与运行手册
- `open-assistant/.opencode/agent/open-assistant.md`：数字人 agent（最小权限，默认 deny 高风险工具）

> 说明：OpenCode Server 建议以 `open-assistant/` 为工作目录启动（让其自动加载 `open-assistant/.opencode`）。若 OpenCode Server 在其他目录运行，则需把 `.opencode` 目录以“复制/挂载”的方式提供给它。

---

## 1. Backlog 约定

### 1.1 优先级
- **P0**：阻塞“闭环可演示/可打断/可并发”的能力
- **P1**：稳定性、安全、可观测、可运维（MVP 必要）
- **P2**：观感增强与产品化能力（可选，或后置）

### 1.2 Definition of Done（DoD）
- 代码合入主干、通过 typecheck/test（若该包有测试）
- 协议/接口有 schema 校验与错误码（至少 P0/P1）
- 关键链路有指标（至少延迟/队列长度/abort 计数）
- 文档更新：对外接口/配置/本地启动方式

### 1.3 交付里程碑（与技术方案一致）
- **Phase -1**：项目准备（1 周）
- **Phase 0**：闭环 PoC（1–2 周）
- **Phase 1**：10 路并发稳定 + 安全合规（2–4 周）
- **Phase 2**：观感增强（可选）
- **Phase 3**：产品化（可选）

---

## Phase -1：项目准备（建议 1 周）

### Epic OA-E0：项目底座（Repo/CI/运行）

#### OA-FOUND-001 建立 Open Assistant 项目骨架（对齐 OpenCode 技术栈）
- 优先级：P0｜估时：1d｜负责人：BE
- 产出：新增 `open-assistant/packages/protocol`、`open-assistant/services/gateway`、`open-assistant/apps/web` 与基本脚本（dev/build/typecheck）
- 状态：✅ 已落地（补齐状态标记 2026-02-04）：monorepo + workspace scripts（`open-assistant/package.json`，`open-assistant/packages/*`，`open-assistant/services/*`，`open-assistant/apps/*`）
- 验收：
  - `bun run typecheck`（或 `bun turbo typecheck`）覆盖新增 workspace
  - `bun run dev` 可分别启动 gateway/web（哪怕暂时是空页面/healthz）
  - README/运行说明具备“本地起步”步骤

#### OA-FOUND-002 冻结接口清单与协议版本（WS + MCP + 内部 HTTP）
- 优先级：P0｜估时：0.5d｜负责人：BE+FE
- 依赖：无
- 产出：`open-assistant-protocol` 内的 `v0` 版本协议（消息类型/字段/错误码/版本号）
- 状态：✅ 已落地（补齐状态标记 2026-02-04）：WS schema v0 + 文档（`open-assistant/packages/protocol/src/ws.ts`，`open-assistant/docs/PROTOCOL.md`）
- 验收：
  - WS 消息类型与技术方案一致：`audio.in/asr.partial/asr.final/tts.audio/ui.present/ui.stop/state/interrupt`
  - 所有消息都有 Zod schema 与版本字段（例如 `v: 0`）
  - 文档中明确“向后兼容/破坏性变更”规则

#### OA-FOUND-003 安全基线决策（CSP、assetId 白名单、URL 禁止策略）
- 优先级：P0｜估时：0.5d｜负责人：BE+FE+Sec
- 产出：安全策略清单（CSP/iframe sandbox/allowlist/审计字段）
- 状态：✅ 已落地（补齐状态标记 2026-02-04）：CSP + sandbox iframe + assetId allowlist（`open-assistant/apps/web/index.html`，`open-assistant/apps/web/model-frame.html`，`open-assistant/services/gateway/src/index.ts`，`open-assistant/services/media/src/index.ts`）
- 验收：
  - 明确“模型不能输出任意 URL”的强制策略与落点（Gateway schema + media-library 映射）
  - 明确浏览器端 CSP 白名单域名策略
  - 明确 3D/Slides 资源隔离方案（sandbox iframe 或隔离域）

#### OA-FOUND-004 可观测最小指标定义（端到端 + 分段）
- 优先级：P0｜估时：0.5d｜负责人：BE+Ops
- 产出：指标字典（metric name、label、采集点）
- 状态：✅ 已落地（补齐状态标记 2026-02-04）：Gateway 指标 + Grafana 看板（`open-assistant/services/gateway/src/metrics.ts`，`open-assistant/infra/grafana/provisioning/dashboards/openassistant-gateway.json`）
- 验收：
  - 至少定义：`e2e_latency_ms`、`tts_first_audio_ms`、`asr_final_latency_ms`、`queue_depth`、`abort_total`、`errors_total`
  - 指标与 sessionID 关联方式明确（注意脱敏/采样）

### Epic OA-E1：OpenCode 集成方式确定

#### OA-OC-001 定义 Open Assistant agent（最小权限）
- 优先级：P0｜估时：0.5d｜负责人：BE
- 产出：`open-assistant/.opencode/agent/open-assistant.md`
- 状态：✅ 已落地（补齐状态标记 2026-02-04）：Open Assistant agent 权限与提示词（`open-assistant/.opencode/agent/open-assistant.md`）
- 验收：
  - 默认 deny 高风险工具（`bash/edit` 等）
  - 仅允许：`rag.search/asset.search/ui.present/ui.stop`（以及必要的只读工具如需）
  - 提示词明确“只用内网检索与素材库”

#### OA-OC-002 选择工具接入形态：MCP（推荐） vs Gateway 代调用
- 优先级：P0｜估时：0.5d｜负责人：BE
- 产出：一页决策记录（为何选 MCP/为何代调用；风险与后续迁移策略）
- 状态：✅ 已落地（补齐状态标记 2026-02-04）：选择 MCP 作为 OpenCode 工具接入（`open-assistant/docs/ADR_OA_OC_002_MCP.md`）
- 验收：
  - 若选 MCP：明确 OpenCode 侧如何配置 MCP server 地址、工具名与 schema
  - 若选代调用：明确 Gateway 如何把结果“回灌”为工具输出（事件格式/traceId）

---

## Phase 0：闭环 PoC（建议 1–2 周）

### Epic OA-E2：Protocol（协议与共享类型）

#### OA-PROTO-001 定义 WS 消息 schema（v0）
- 优先级：P0｜估时：1d｜负责人：BE
- 依赖：OA-FOUND-002
- 产出：`audio.in/asr.partial/asr.final/tts.audio/ui.present/ui.stop/state/interrupt` 的 Zod schema 与 TS types
- 状态：✅ 已落地（补齐状态标记 2026-02-04）：WS schema 校验 + types（`open-assistant/packages/protocol/src/ws.ts`）
- 验收：
  - 任何入站消息都必须通过 schema 校验，否则返回结构化错误
  - 每类消息包含 `sessionID` 与 `seq`（适用时）
  - 提供最小示例（docs 中的示例 JSON）

#### OA-PROTO-002 定义 MCP 工具 schema（rag.search/asset.search/ui.present/ui.stop）
- 优先级：P0｜估时：1d｜负责人：BE
- 依赖：OA-FOUND-002
- 状态：✅ 已落地（补齐状态标记 2026-02-04）：Gateway MCP tools/schema（`open-assistant/services/gateway/src/mcp.ts`）
- 验收：
  - 参数/返回结构与技术方案一致，并补齐错误码与校验规则
  - `ui.present` 只接受 `assetId`，不接受 URL

### Epic OA-E3：Gateway（实时编排层 PoC）

#### OA-GW-001 Gateway 服务骨架（Bun + Hono）
- 优先级：P0｜估时：1d｜负责人：BE
- 依赖：OA-FOUND-001
- 状态：✅ 已落地（补齐状态标记 2026-02-04）：Gateway 健康检查 + WS 入口（`open-assistant/services/gateway/src/index.ts`）
- 验收：
  - 提供 `/healthz` 与基础日志
  - 提供 WS 入口（例如 `/ws`）并做连接鉴权占位（可先放行）
  - 接入 `open-assistant-protocol` 校验入站消息

#### OA-GW-002 单会话状态机（idle/listening/thinking/speaking/presenting）
- 优先级：P0｜估时：1d｜负责人：BE
- 依赖：OA-GW-001
- 状态：✅ 已落地（补齐状态标记 2026-02-04）：单会话状态机 + turn 生命周期（`open-assistant/services/gateway/src/index.ts`）
- 验收：
  - 状态变更通过 `state` 消息推送到客户端
  - 任何时刻只允许一个“当前活动轮次”（turnId）用于取消
  - 非法状态转移会记录审计并拒绝执行

#### OA-GW-003 打断（barge-in）最小闭环
- 优先级：P0｜估时：1d｜负责人：BE
- 依赖：OA-GW-002，OA-OC-001
- 状态：✅ 已落地（补齐状态标记 2026-02-04）：interrupt -> stop TTS + abort turn（`open-assistant/services/gateway/src/index.ts`）
- 验收：
  - 收到 `interrupt` 后：立即停止向客户端发送 `tts.audio`
  - 同步触发 OpenCode `POST /session/:sessionID/abort`
  - 状态回到 `listening`，并允许新一轮输入

#### OA-GW-005 ASR 语音流接入（audio.in -> ASR -> asr.partial/final）
- 优先级：P0｜估时：1–2d｜负责人：BE
- 依赖：OA-GW-001，OA-ASR-001，OA-PROTO-001
- 状态：✅ 已落地（补齐状态标记 2026-02-04）：audio.in 路由 + ASR partial/final 回传（`open-assistant/services/gateway/src/asr.ts`，`open-assistant/services/gateway/src/index.ts`）
- 验收：
  - Gateway 接收 `audio.in` 后按 `sessionID` 转发到 ASR（或复用单连接并标注 session）
  - ASR 的 `partial/final` 能被路由回对应客户端（WS 下行）
  - `final` 会触发 OpenCode `POST /session/:id/message`（进入 thinking）

#### OA-GW-006 TTS 流式播报接入（文本分段 -> TTS -> tts.audio）
- 优先级：P0｜估时：2–3d｜负责人：BE
- 依赖：OA-GW-001，OA-OC-001，OA-TTS-001，OA-PROTO-001
- 状态：✅ 已落地（补齐状态标记 2026-02-04）：文本分段 + TTS 流式 NDJSON + abort/cancel（`open-assistant/services/gateway/src/tts.ts`，`open-assistant/services/gateway/src/tts-scheduler.ts`，`open-assistant/services/gateway/src/index.ts`）
- 验收：
  - Gateway 从 OpenCode 输出中抽取“可播报文本”，进行最小分段并调用 TTS
  - TTS 音频 chunk 以 `tts.audio` 下行推送到客户端并可连续播放
  - `interrupt/abort` 会立刻取消：未出音分段 + 正在进行的 TTS 合成

### Epic OA-E4：Web Client（数字人 + 播放器 PoC）

#### OA-WEB-001 Web 应用骨架（Vite + Solid + Tailwind）
- 优先级：P0｜估时：1d｜负责人：FE
- 依赖：OA-FOUND-001
- 状态：✅ 已落地（补齐状态标记 2026-02-04）：Web 主界面 + WS 连接（`open-assistant/apps/web/src/ui/App.tsx`）
- 验收：
  - 页面包含：连接状态、字幕区、打断按钮、播放器区域占位
  - 与 Gateway 建立 WS，并能收发心跳/状态

#### OA-WEB-002 采音与上行（getUserMedia -> PCM frames -> audio.in）
- 优先级：P0｜估时：1–2d｜负责人：FE
- 依赖：OA-WEB-001，OA-PROTO-001
- 状态：✅ 已落地（补齐状态标记 2026-02-04）：getUserMedia + PCM frames（`open-assistant/apps/web/src/ui/App.tsx`）
- 验收：
  - 麦克风权限/设备切换可用
  - 上行格式符合 `16kHz/16-bit/mono PCM`（或明确在协议中标注编码）
  - 断线重连后能恢复采音/发送

#### OA-WEB-003 字幕与状态展示（asr.partial/asr.final/state）
- 优先级：P0｜估时：1d｜负责人：FE
- 依赖：OA-WEB-001
- 状态：✅ 已落地（补齐状态标记 2026-02-04）：字幕与状态机展示（`open-assistant/apps/web/src/ui/App.tsx`）
- 验收：
  - partial 字幕实时刷新，final 追加到对话记录
  - 状态机可视化（listening/thinking/speaking/presenting）

#### OA-WEB-004 TTS 音频流播放（tts.audio chunk）
- 优先级：P0｜估时：1–2d｜负责人：FE
- 依赖：OA-PROTO-001
- 状态：✅ 已落地（补齐状态标记 2026-02-04）：AudioContext chunk 播放 + stop 清理（`open-assistant/apps/web/src/ui/App.tsx`）
- 验收：
  - 支持流式追加播放（不等待全部音频）
  - 打断时立即停止本地播放并清空缓冲
  - 音频设备/音量控制可用

#### OA-WEB-005 口型同步 MVP（RMS 能量驱动 mouthOpen）
- 优先级：P0｜估时：1d｜负责人：FE
- 依赖：OA-WEB-004
- 状态：✅ 已落地（补齐状态标记 2026-02-04）：RMS -> mouthOpen（并可升级为 timestamps lipsync）（`open-assistant/apps/web/src/ui/App.tsx`）
- 验收：
  - 播放音频时 mouthOpen 随节奏变化（避免纯随机）
  - 口型驱动与渲染解耦（后续可替换为 viseme）

#### OA-WEB-006 播放器 PoC（video + ui.present/ui.stop）
- 优先级：P0｜估时：1–2d｜负责人：FE
- 依赖：OA-PROTO-001
- 状态：✅ 已落地（补齐状态标记 2026-02-04）：ui.present/ui.stop 播放控制（`open-assistant/apps/web/src/ui/App.tsx`）
- 验收：
  - 接收 `ui.present` 后加载内网视频并播放
  - 接收 `ui.stop` 停止播放
  - 失败时有可读错误提示（而不是静默）

### Epic OA-E5：ASR（PoC）

#### OA-ASR-001 ASR 服务接口 PoC（WS 输入 PCM -> partial/final）
- 优先级：P0｜估时：2–4d｜负责人：ML/BE
- 依赖：OA-FOUND-002
- 状态：✅ 已落地（2026-01-27）：`services/asr` 对接 FunASR runtime（`docs/ASR_FUNASR.md`）
- 验收：
  - 支持 WS 流式输入，输出 `partial/final`（含时间戳/置信度可选）
  - 有 VAD/端点检测，避免长时间无意义解码
  - 支持 `cancel(sessionID)` 并在 200ms 内停止当前解码

### Epic OA-E6：TTS（PoC）

#### OA-TTS-001 CosyVoice 流式合成接口 PoC（文本 -> audio chunks）
- 优先级：P0｜估时：2–4d｜负责人：ML/BE
- 依赖：OA-FOUND-002
- 状态：✅ 已落地（2026-01-27）：`services/tts` 对接 CosyVoice runtime fastapi（`docs/TTS_COSYVOICE.md`）
- 验收：
  - 支持分句/分段输出音频 chunk
  - 支持 `cancel(sessionID)` 停止后续出音
  - 输出音频格式在协议中可识别（mime/sampleRate）

### Epic OA-E7：RAG/素材库（PoC 先 mock）

#### OA-RAG-001 RAG mock（固定 passages + filters 占位）
- 优先级：P0｜估时：0.5d｜负责人：BE
- 状态：✅ 已落地（补齐状态标记 2026-02-04）：RAG mock 服务（`open-assistant/services/rag-mock/src/index.ts`）
- 验收：
  - `rag.search` 返回固定 passages（含 sourceId/meta）
  - 保留 filters 结构并在服务端校验字段存在（不做真实鉴权也可）

#### OA-MEDIA-001 素材库 mock（asset.search + assetId->url）
- 优先级：P0｜估时：0.5d｜负责人：BE
- 状态：✅ 已落地（补齐状态标记 2026-02-04）：Media mock 服务（`open-assistant/services/media-mock/src/index.ts`）
- 验收：
  - `asset.search` 返回固定 `assetId`
  - `ui.present` 只能通过 `assetId` 获取 URL（禁止客户端直传 URL）

---

## Phase 1：MVP + 10 路并发稳定（建议 2–4 周）

### Epic OA-E8：Gateway（并发、队列、取消、审计）

#### OA-GW-004 OpenCode 对接（message + SSE 订阅 global/event）【从 Phase 0 并入】
- 优先级：P0｜估时：1–2d｜负责人：BE
- 依赖：OA-GW-001，OA-OC-001
- 状态：✅ 已落地（2026-01-27）：OpenCode prompt + SSE global/event 路由（`services/gateway/src/opencode.ts`，`services/gateway/src/opencode-events.ts`，`services/gateway/src/index.ts`）
- 验收：
  - Gateway 可 `POST /session/:id/message` 发送 ASR final 文本
  - Gateway 可订阅 `GET /global/event` 并按 `sessionID` 路由事件
  - 能从事件中抽取：可播报文本（用于 TTS）与工具动作（用于 UI）

#### OA-GW-101 多会话管理与隔离（最多 10 路）
- 优先级：P0｜估时：2d｜负责人：BE
- 依赖：OA-GW-002
- 状态：✅ 已落地（2026-01-27）：Gateway 会话隔离/重连/超时回收（`services/gateway/src/index.ts`）
- 验收：
  - 每路会话独立：状态机/队列/取消令牌/播放状态
  - 并发 10 路连接不互相串线（sessionID 强校验）
  - 支持会话超时回收与资源释放

#### OA-GW-102 端到端取消令牌贯穿（ASR/RAG/OpenCode/TTS/播放队列）
- 优先级：P0｜估时：2–3d｜负责人：BE
- 依赖：OA-GW-003
- 状态：✅ 已落地（2026-01-27）：turn AbortController 贯穿 RAG/OpenCode/TTS，并记录 abort reason（`services/gateway/src/index.ts`）
- 验收：
  - 任意阶段 abort 后，后续阶段不再继续
  - 取消不会导致“后台仍在跑”的队列堆积
  - 记录 abort 原因（barge-in/用户按钮/超时/错误）

#### OA-GW-103 ASR 限并发与按需解码（maxConcurrentDecode）
- 优先级：P0｜估时：2–3d｜负责人：BE+ML
- 依赖：OA-ASR-001
- 状态：✅ 已落地（2026-01-27）：ASR scheduler 限并发 + 队列上限/丢帧指标（`services/gateway/src/asr-scheduler.ts`）
- 验收：
  - 支持 `maxConcurrentDecode` 配置并可热更新（可选）
  - 非活跃会话仅进行轻量 VAD（或排队），避免 GPU/CPU 抖动
  - 压测下不会出现无限排队（有队列上限/拒绝策略）

#### OA-GW-104 TTS worker 池与公平调度（maxConcurrentSynthesis）
- 优先级：P0｜估时：2–3d｜负责人：BE+ML
- 依赖：OA-TTS-001
- 状态：✅ 已落地（2026-01-27）：TTS scheduler worker pool + round-robin 公平调度（`services/gateway/src/tts-scheduler.ts`）
- 验收：
  - 支持 `maxConcurrentSynthesis` 与队列
  - 公平策略可解释（round-robin/加权）；避免某会话长期饥饿
  - 优先保证 first audio（首包）延迟

#### OA-GW-105 文本分段策略（首包优先 + 语义断句）
- 优先级：P1｜估时：1–2d｜负责人：BE
- 依赖：OA-GW-004，OA-TTS-001
- 状态：✅ 已落地（2026-01-27）：按中英文标点/长度阈值分段（`services/gateway/src/index.ts` 的 `segmentForTts`）
- 验收：
  - 分段不会破坏基本语义（避免把实体切碎）
  - 长段落拆成短句队列，首段优先出音
  - 支持中英文标点与长度阈值配置

#### OA-GW-106 审计日志（会话级：query/命中/播放动作/回答摘要）
- 优先级：P1｜估时：2d｜负责人：BE
- 状态：✅ 已落地（2026-01-27）：结构化审计日志（hash/full）+ 关键事件埋点（`services/gateway/src/audit.ts`，`services/gateway/src/index.ts`）
- 验收：
  - 结构化日志可按 sessionID/tenant/project 检索
  - 支持脱敏（可配置：不落原文，仅落摘要/哈希）
  - 关键事件必落：interrupt/abort/ui.present/rag.search

### Epic OA-E9：RAG（真实检索 + 过滤）

#### OA-RAG-101 实现 `/search`（向量检索 + filters 强校验）
- 优先级：P0｜估时：3–5d｜负责人：BE+ML
- 依赖：OA-RAG-001
- 状态：✅ 已落地（2026-01-27）：sqlite FTS5 检索 + tenant/project 强校验（`services/rag/src/index.ts`）
- 验收：
  - `tenant/project` 缺失直接拒绝
  - 返回 passages 附带 sourceId/title/url(可选)/score
  - 具备最小回归集（固定 query 命中固定文档）

#### OA-RAG-102 入库流水线 v0（文档切分 -> embedding -> index）
- 优先级：P1｜估时：3–5d｜负责人：ML/BE
- 依赖：OA-RAG-101
- 状态：✅ 已落地（2026-01-27）：`services/rag` 提供 `ingest` CLI（txt/md）写入 sqlite（`services/rag/src/cli.ts`）
- 验收：
  - 提供脚本/CLI：导入一个目录的文档
  - 切分策略可配置（chunk size/overlap）
  - 记录每条 passage 的 sourceId 与权限标签

### Epic OA-E10：素材库（真实索引 + allowlist）

#### OA-MEDIA-101 素材库索引与检索（asset.search）
- 优先级：P0｜估时：3–5d｜负责人：BE
- 依赖：OA-MEDIA-001
- 状态：✅ 已落地（2026-01-27）：sqlite 索引 + `asset.search`（`services/media/src/index.ts`）
- 验收：
  - 支持 type（video/slides/model）、tags、title 模糊搜索
  - 强制 tenant/project 过滤
  - 返回的 `assetId` 可稳定复现与可追溯（包含元数据）

#### OA-MEDIA-102 assetId -> url 映射服务与 URL allowlist
- 优先级：P0｜估时：2–3d｜负责人：BE
- 依赖：OA-MEDIA-101
- 状态：✅ 已落地（2026-01-27）：assetId 仅映射到内网 URL，Gateway 反代 `/assets/:assetId`（`services/gateway/src/index.ts`，`services/media/src/index.ts`）
- 验收：
  - Gateway/客户端拿不到任意 URL，只能拿到 `assetId`
  - 映射输出 URL 必须命中 allowlist（域名/路径）
  - 记录审计：谁在何时播放了哪个 assetId

#### OA-MEDIA-103 Range 支持与媒体可用性校验（video）
- 优先级：P1｜估时：1–2d｜负责人：BE+Ops
- 依赖：OA-MEDIA-102
- 状态：✅ 已落地（2026-01-27）：支持 HTTP Range（video 快进/拖动）（`services/media/src/index.ts`，`services/gateway/src/index.ts`）
- 验收：
  - 视频在线播放支持快进/拖动（HTTP Range）
  - 定时任务检测资源可达性并告警（可选）

### Epic OA-E11：Web Client（稳定性与安全）

#### OA-WEB-101 断线重连与状态恢复（WS + 播放队列）
- 优先级：P0｜估时：2–3d｜负责人：FE
- 依赖：OA-WEB-004
- 状态：✅ 已落地（2026-01-27）：自动重连 + 重连后清理旧播放/字幕（`apps/web/src/ui/App.tsx`）
- 验收：
  - WS 断开后自动重连，并恢复到可交互状态
  - 重连后不会继续播放“旧音频/旧动作”
  - UI 明确展示当前连接状态与错误

#### OA-WEB-104 客户端 VAD/阈值检测自动触发 interrupt（barge-in 体验）
- 优先级：P1｜估时：1–2d｜负责人：FE
- 依赖：OA-WEB-002，OA-GW-003
- 状态：✅ 已落地（2026-01-27）：客户端 RMS 阈值 + hangover + 冷却时间触发 `interrupt(vad)`（`apps/web/src/ui/App.tsx`）
- 验收：
  - 检测到用户开始说话时自动发送 `interrupt`（带 sessionID/时间戳）
  - 有抑制策略避免误触发（最小：冷却时间 + 音量阈值）
  - 可配置开关（在嘈杂环境可关闭自动打断）

#### OA-WEB-105 Web 侧 OIDC 登录（Auth Code + PKCE）与 token 生命周期
- 优先级：P1｜估时：2–4d｜负责人：FE+BE
- 依赖：OA-AUTH-101，OA-OPS-106
- 状态：✅ 已落地（2026-02-28）：Keycloak OIDC（Auth Code + PKCE）登录/登出/刷新闭环（`apps/web/src/oidc.ts`，`apps/web/src/ui/App.tsx`，`apps/web/.env.example`，`README.md`）
- 产出：
  - Web 侧“登录/登出/刷新”闭环（Keycloak OIDC：Auth Code + PKCE）
  - Token 存储策略说明（默认 sessionStorage；明确禁止 localStorage 的场景与原因）
  - OIDC 配置模板（issuer/clientId/redirectUri/scope）与 Keycloak Web Origins 配置说明
- 验收：
  - 登录成功后，Web 自动把 `Authorization: Bearer <access_token>` 以 `?token=` 方式带到 `/ws` 与 `/assets/:assetId`
  - access_token 过期前可自动刷新（refresh_token），刷新失败会清理本地状态并提示重新登录
  - 支持登出（清理本地 token，并可选跳转到 OIDC end_session_endpoint）
  - UI 可展示解析后的 `sub/tenant/project/tags`（仅用于调试展示，不作为鉴权依据）

#### OA-WEB-102 CSP 落地与资源隔离（slides/3D sandbox）
- 优先级：P0｜估时：2–3d｜负责人：FE+Sec
- 依赖：OA-FOUND-003，OA-MEDIA-102
- 状态：✅ 已落地（2026-01-27）：CSP meta + slides/model sandbox iframe（`apps/web/index.html`，`apps/web/model-frame.html`，`apps/web/src/ui/App.tsx`）
- 验收：
  - CSP 限制媒体源只允许内网域名
  - slides/3D 在 sandbox iframe 或隔离域加载，降低 XSS 风险
  - 资源加载失败不影响语音对话主链路

#### OA-WEB-103 播放器支持 slides 与 3D（MVP 版）
- 优先级：P1｜估时：3–5d｜负责人：FE
- 依赖：OA-MEDIA-101
- 状态：✅ 已落地（2026-01-27）：`ui.present(type=slides/model)` 渲染与 `ui.stop`（`apps/web/src/ui/App.tsx`）
- 验收：
  - `ui.present(type=slides/model)` 可展示并支持 `ui.stop`
  - 不允许外部 URL 注入（只消费 assetId）
  - 关键错误可观测（上报到 Gateway/日志）

### Epic OA-E12：OpenCode 集成（工具/事件/权限）

#### OA-OC-101 MCP Server 落地（在 Gateway 暴露 rag/asset/ui 工具）
- 优先级：P0｜估时：2–4d｜负责人：BE
- 依赖：OA-PROTO-002，OA-OC-002
- 状态：✅ 已落地（2026-01-27）：Gateway `/mcp` + 工具 schema 强校验 + 审计关联（`services/gateway/src/mcp.ts`）
- 验收：
  - OpenCode 可发现并调用 `rag.search/asset.search/ui.present/ui.stop`
  - 工具输入输出全量校验（schema）
  - 工具调用与会话审计关联（traceId/sessionID）

#### OA-OC-102 Agent 提示词与行为约束迭代（只用内网工具）
- 优先级：P1｜估时：1–2d｜负责人：BE+PM
- 依赖：OA-OC-101
- 状态：✅ 已落地（2026-01-27）：最小工具集 + 禁止 URL/外网（`open-assistant/.opencode/agent/open-assistant.md`）
- 验收：
  - 不出现“直接输出 URL/外网搜索”行为（失败则由 Gateway 拒绝）
  - 播放动作可控：仅在有明确意图时触发 `ui.present`

### Epic OA-E13：可观测与压测

#### OA-OBS-101 指标与链路埋点（端到端 + 分段）
- 优先级：P0｜估时：2–3d｜负责人：BE+Ops
- 依赖：OA-FOUND-004
- 状态：✅ 已落地（2026-01-27）：Gateway 指标 + Grafana 看板（`services/gateway/src/index.ts`，`infra/grafana/provisioning/dashboards/openassistant-gateway.json`）
- 验收：
  - 端到端延迟与首包时间可在 Grafana 看板展示
  - abort/queue depth/errors 有清晰可读的指标
  - 支持按 tenant/project 聚合（注意权限与脱敏）

#### OA-TEST-101 端到端自动化（Playwright：说话->字幕->播报->打断->再说话）
- 优先级：P1｜估时：3–5d｜负责人：FE+BE
- 依赖：OA-WEB-004，OA-GW-003
- 状态：✅ 已落地（2026-01-27）：Playwright e2e 覆盖 interrupt 与 ui.present（`scripts/e2e.ts`）
- 验收：
  - 提供可重复的 e2e 测试（mock ASR/TTS 亦可）
  - 覆盖关键用例：interrupt 必须停止播放与 abort 成功

#### OA-TEST-102 发布门禁（CI gate：typecheck + RC2/RC3 + e2e + staging perf 留证）
- 优先级：P1｜估时：1–2d｜负责人：BE+Ops
- 依赖：OA-TEST-101，OA-PERF-101，OA-PERF-102，OA-OPS-104
- 状态：✅ 已落地（2026-02-28）：GitHub Actions CI gate（typecheck + RC2/RC3 负例 + e2e）（`.github/workflows/ci.yml`）
- 产出：
  - CI 流水线（或等价发布 gate）：
    - 必跑：`bun run typecheck`、`bun run test:rc2rc3`、`bun run test:e2e`
    - 一键命令：`bun run gate:release`（可本机用 `OA_GATE_SKIP_E2E=1` 调试）
    - staging（真依赖）可选/手动 gate：`bun run ops:full:up-perf:all` 并保存 perf 报告
  - 失败阻断策略与留证路径（`open-assistant/test-results/` 作为默认产物目录）
- 验收：
  - typecheck/e2e 失败会阻断合入或发布
  - staging perf 报告可追溯到 commit（包含时间戳/版本信息/环境参数）

#### OA-PERF-101 10 路并发压测脚本与报告
- 优先级：P0｜估时：2–4d｜负责人：BE+Ops
- 依赖：OA-GW-101，OA-GW-104
- 状态：✅ 已落地（2026-01-27）：`scripts/perf-10sessions.ts` 输出 JSON 报告（`open-assistant/test-results/`）
- 验收：
  - 生成报告：P50/P95（首包、打断延迟、错误率）
  - 可配置并发数/说话比例/打断频率
  - 发现瓶颈并形成调参建议（maxConcurrentDecode/Synthesis）

#### OA-PERF-102 ASR+TTS 全链路并发压测脚本与报告
- 优先级：P1｜估时：1–2d｜负责人：BE+Ops
- 依赖：OA-ASR-001，OA-TTS-001，OA-GW-005，OA-GW-006
- 状态：✅ 已落地（2026-02-03）：`scripts/perf-asrtts.ts` 输出 JSON 报告（`open-assistant/test-results/`）；补充（2026-02-04）：采集 `tts.align`/`segmentId` 绑定指标 + SLA 断言（`OA_PERF_ASSERT`）
- 验收：
  - 生成报告：P50/P95（asr.final、tts.text、首包、turn total、错误率）
  - 支持配置并发数/音频来源（TTS 生成/本地文件/音频 base64）/帧大小/是否 real-time

### Epic OA-E14：部署与运维（MVP 必要）

#### OA-OPS-101 docker-compose 一键启动（Gateway/Web/OpenCode/ASR/TTS/RAG/Library）
- 优先级：P1｜估时：2–4d｜负责人：Ops+BE
- 依赖：Phase 0 基础闭环完成
- 状态：✅ 已落地（2026-01-27）：`infra/docker-compose.full.yml` + `infra/README.md`（真依赖：FunASR + CosyVoice）
- 验收：
  - 单条命令可拉起全套服务（含必要的环境变量模板）
  - 关键端口与网络策略与技术方案一致（Gateway 443、OpenCode 4096 等可配置）
  - 提供最小运行手册（本地/内网服务器）

#### OA-OPS-102 反向代理与 TLS 终止（内网 HTTPS）
- 优先级：P1｜估时：1–2d｜负责人：Ops
- 依赖：OA-OPS-101
- 状态：✅ 已落地（2026-01-27）：Caddy 反代 + `tls internal` + 信任说明（`infra/caddy/Caddyfile`，`infra/README.md`）
- 验收：
  - Gateway 对浏览器提供 HTTPS + WS（wss）
  - 支持内网证书/自签证书与浏览器信任说明

#### OA-OPS-103 日志与监控接入（Prometheus + Grafana）
- 优先级：P1｜估时：2–4d｜负责人：Ops+BE
- 依赖：OA-OBS-101
- 状态：✅ 已落地（2026-01-27）：Prometheus+Grafana + 基础告警规则（`infra/prometheus/alerts.yml`）
- 验收：
  - 指标采集与 Grafana 看板可开箱即用
  - 基础告警规则具备（错误率、队列深度、首包时间劣化）

#### OA-OPS-104 生产化容器镜像与断网运行（Init 联网 → Prod 断网）
- 优先级：P1｜估时：1–2d｜负责人：Ops+BE
- 依赖：OA-OPS-101
- 状态：✅ 已落地（2026-01-28）：`infra/docker-compose.prod.yml` + 生产 `Dockerfile`/`Caddyfile.prod`/`Dockerfile.prod`（Caddy/OpenCode）+ `scripts/full-stack.ts` 支持 `OA_FULL_COMPOSE_MODE=prod` 与 `OA_FULL_BUILD=1`；补充（2026-02-02）：支持 `OA_FULL_MOCK_BACKENDS=1` 以 mock ASR/TTS 跑通全量栈（不依赖 FunASR/CosyVoice），便于先做断网链路验收。
- 验收：
  - `docker compose -f infra/docker-compose.full.yml -f infra/docker-compose.prod.yml build` 可在联网阶段构建镜像
  - 断网后 `docker compose -f infra/docker-compose.full.yml -f infra/docker-compose.prod.yml up -d` 可启动（不依赖源码挂载/在线安装）
  - Runbook 明确“初始化联网阶段预热模型/依赖”的流程（`infra/README.md`）
  - 可选：`OA_FULL_MOCK_BACKENDS=1` 跳过 FunASR/CosyVoice，仍能通过 `/readyz` 与管理后台审计链路验收

#### OA-OPS-105 staging 真实依赖联调与 perf 留证（发布证据）
- 优先级：P1｜估时：1–2d｜负责人：Ops+BE
- 依赖：OA-OPS-104，OA-PERF-101，OA-PERF-102
- 状态：✅ 已落地（2026-02-28）：已执行真依赖生产形态联调与留证：`OA_FULL_COMPOSE_MODE=prod OA_FULL_BUILD=1 OA_GRAFANA_PORT=3300 bun run ops:full:up-perf:all`；runId=`1772263423939`；产物：`test-results/perf-evidence-1772263423939.json`、`test-results/perf-report-1772263423939.json`、`test-results/perf-asrtts-report-1772263423939.json`（`readyz` 全绿，错误率 0）。
- 产出：
  - staging 环境“一键联调”命令与最小参数集（低并发先跑通）
  - `test-results/perf-report-*.json`（真依赖）作为发布证据（包含环境信息/版本）
  - 已知问题清单与回滚策略（比如模型下载失败、冷启动超时）
- 验收：
  - `OA_FULL_COMPOSE_MODE=prod OA_FULL_BUILD=1 ... bun run ops:full:up-perf:all` 在 staging 可稳定跑通并生成报告
  - 报告错误率为 0（或有明确可复现的已知问题与修复计划）

#### OA-OPS-106 Keycloak 部署与备份（Realm/Client 初始化脚本 + 升级策略）
- 优先级：P1｜估时：2–4d｜负责人：Ops+Sec
- 依赖：OA-AUTH-101
- 状态：✅ 已落地（2026-02-28）：Keycloak overlay + realm import + 运维脚本（`infra/docker-compose.full.keycloak.yml`，`infra/keycloak/realm-openassistant.json`，`infra/keycloak/README.md`，`infra/keycloak/backup-db.sh`，`infra/keycloak/restore-db.sh`，`scripts/full-stack.ts`）
- 产出：
  - Keycloak 部署方式定版（容器/Helm/HA 可选其一）与运行手册（断网可用）
  - Realm/Client 初始化脚本（包含：Web Client + Gateway audience/claims 约定）
  - 备份/恢复/升级策略（Realm 导出、DB 备份、证书与密钥轮换）
- 验收：
  - Keycloak 在内网可用，OIDC discovery/jwks 可访问
  - 可一键重建 realm/client，并能签发包含 `tenant/project/tags` 的 access token（通过协议 mapper）

### Epic OA-E15：鉴权与多租户（MVP 建议）

#### OA-AUTH-101 WS 连接鉴权（与 OpenCode 统一身份体系预留）
- 优先级：P1｜估时：2–3d｜负责人：BE
- 依赖：OA-GW-001
- 状态：✅ 已落地（2026-01-27）：支持 disabled/static/oidc，WS 绑定 identity 防劫持（`services/gateway/src/auth.ts`，`services/gateway/src/index.ts`）
- 验收：
  - WS 建连必须携带 token（或 cookie），未授权拒绝
  - sessionID 与用户身份绑定（禁止伪造/越权访问其他 session）
  - 鉴权方式可替换（为 SSO/OIDC 预留）

#### OA-AUTH-102 tenant/project 绑定与强校验贯穿（RAG/Media/Audit）
- 优先级：P1｜估时：1–2d｜负责人：BE
- 依赖：OA-AUTH-101
- 状态：✅ 已落地（2026-01-27）：MCP/资产访问 tenant/project 强校验；审计字段贯穿（`services/gateway/src/mcp.ts`，`services/gateway/src/index.ts`）
- 验收：
  - tenant/project 来源明确（来自 token claim 或用户选择后服务端确认）
  - Gateway 强制为每次 `rag.search/asset.search` 注入并校验 tenant/project
  - 审计日志按 tenant/project 分区/过滤

---

## Phase 2：观感增强（可选）

### Epic OA-E20：口型精度（viseme/phoneme）

#### OA-TTS-201 TTS 输出 phoneme/word timestamps
- 优先级：P2｜估时：3–6d｜负责人：ML
- 依赖：OA-TTS-001
- 状态：✅ 已落地（2026-02-03）：对齐数据走独立 `tts.align`：TTS（CosyVoice/Mock）通过 `POST /align` 返回 `segments[]`（`startMs/endMs/viseme/phoneme/word`），由 Gateway 以 `tts.align` 下发；`tts.audio` 的 `marks[]` 仅保留 `tMs/open`（用于 mouth-open）（`services/tts/src/index.ts`，`services/tts-mock/src/index.ts`，`services/gateway/src/index.ts`，协议见 `packages/protocol/src/ws.ts`）
- 验收：
  - 输出包含时间戳并与音频 chunk 对齐
  - 延迟不显著劣化（定义可接受阈值）

#### OA-WEB-201 Viseme 驱动口型（替换 RMS）
- 优先级：P2｜估时：3–6d｜负责人：FE
- 依赖：OA-TTS-201
- 状态：✅ 已落地（2026-02-03）：Web 优先消费 `tts.align`（viseme/phoneme/word）驱动口型；mouth-open 优先消费 `tts.audio.marks[].open`，缺失时回退到 analyser RMS；模型预览支持 blendshape 自动探测 + 可选映射（`apps/web/src/ui/App.tsx`，`apps/web/src/model-frame.ts`）
- 验收：
  - 口型与语音更一致（主观评测 + 简单客观指标）
  - 仍保留 RMS 兜底（无 timestamps 时）

### Epic OA-E21：播放编排增强

#### OA-GW-201 播放时间轴与旁白同步（最小实现）
- 优先级：P2｜估时：4–8d｜负责人：BE+FE
- 依赖：OA-WEB-103
- 状态：✅ 已落地（2026-02-02）：`ui.present` 增加 `sync=tts`，Web 侧按首个 `tts.audio` 对齐播放时间轴并提供 timeline/offset 调试；Gateway 增强 presenting 状态保护与 turn phase。
- 验收：
  - 支持在同一轮里同时触发“播报 + 播放素材”的对齐策略
  - 提供可视化调试信息（timeline/offset）

---

## Phase 3：产品化（可选）

### Epic OA-E30：管理后台（RAG/素材/审计）

#### OA-ADMIN-301 管理后台骨架（对齐 opencode UI 体系）
- 优先级：P2｜估时：3–6d｜负责人：FE
- 依赖：OA-FOUND-001
- 状态：✅ 已落地（补齐状态标记 2026-02-04）：Admin 页面骨架 + 素材/文档/审计入口（`open-assistant/apps/web/admin.html`，`open-assistant/apps/web/src/ui/AdminApp.tsx`）
- 验收：
  - 登录后可查看：素材、文档、会话审计（占位页亦可）
  - 组件与样式复用 `@opencode-ai/ui`（或同等规范）

#### OA-ADMIN-302 文档入库与权限标签管理
- 优先级：P2｜估时：5–10d｜负责人：FE+BE+ML
- 依赖：OA-RAG-102
- 状态：✅ 已落地（2026-02-02）：文档 upload/list/update/delete；上传可设置 tags；入库改为异步任务（queued/running/succeeded/failed）并在文档列表展示进度/错误；支持失败重试并写审计 reason。
- 验收：
  - 支持上传/选择文档，配置 tenant/project/标签并触发入库
  - 入库进度可见，失败可重试

#### OA-ADMIN-303 素材上传/标注/审批流（可简化）
- 优先级：P2｜估时：5–10d｜负责人：FE+BE
- 依赖：OA-MEDIA-101
- 状态：✅ 已落地（2026-02-02）：素材 upload/list/update/delete；remote 素材 create/update + allowlist 校验；remote URL 变更自动打回 draft；审批/变更原因写入审计；Admin UI 形成完整 CRUD+审批流。
- 验收：
  - 资产可上传、打标签、设置权限、生成 assetId
  - 可配置 allowlist 规则并提示违规资源

#### OA-ADMIN-304 审计检索与导出（脱敏）
- 优先级：P2｜估时：3–6d｜负责人：BE
- 依赖：OA-GW-106
- 状态：✅ 已落地（2026-02-02）：sqlite 审计 DB（字段列化 + 自动补列）；`/audit/search` 与 `/audit/export`（csv/ndjson）支持 tenant/project/sessionID/时间/assetId/file/reason 过滤；Admin UI 支持查询与导出。
- 验收：
  - 可按 tenant/project/sessionID/时间过滤
  - 导出字段遵守脱敏策略

#### OA-ADMIN-305 会话审计汇总与回放（按 sessionID 聚合）
- 优先级：P2｜估时：2–3d｜负责人：FE+BE
- 依赖：OA-GW-106，OA-ADMIN-304
- 状态：✅ 已落地（2026-02-02）：Gateway 增加 `/audit/sessions`（按 sessionID 汇总）；Admin 增加“会话”页支持筛选与分页，并可一键回放（跳转审计明细按 `order=asc` 加载），支持复制带 token 的审计链接。
- 验收：
  - 会话列表可按 tenant/project/时间/关键字查询并分页
  - “回放”可按时间顺序展示该 session 的审计事件

---

## 附录：建议先落地的“验收脚本”（用于每次演示/回归）

1) 启动：Gateway + Web +（mock 或真实）ASR/TTS + OpenCode  
2) 用例 A：说一句话 -> 出字幕 -> 有播报  
3) 用例 B：播报中插话/点“打断” -> 立刻停播报 -> 再说一句 -> 新一轮正常  
4) 用例 C：触发一次 `ui.present(video)` -> 能播放 -> `ui.stop` 停止  
5) 用例 D：并发 10 路连接 -> 不串会话 -> abort 不影响其他会话  

