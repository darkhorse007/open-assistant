# ADR: OA-OC-002 选择 MCP 作为工具接入形态

结论：**选择 MCP（由 Gateway 暴露 MCP Server），OpenCode 通过 MCP 调用 `rag.search/asset.search/ui.present/ui.stop` 等工具**。

## 背景

Open Assistant 需要让 OpenCode 在“可控工具集合”内完成检索与播放动作，并且：

- 不允许模型直接拼接/输出任意 URL（播放必须走 `assetId` → Gateway `/assets/:assetId`）
- 工具入参/出参必须可校验（schema），便于审计与回归
- 需要贯穿 tenant/project/tags 的强校验，避免越权

因此需要确定 OpenCode 的工具接入形态：

1) **MCP（推荐）**：Gateway 暴露 `/mcp`，OpenCode 以 MCP client 方式调用工具  
2) Gateway 代调用：OpenCode 不直接调用工具，由 Gateway 解析事件/指令后“代调用”并把结果回灌给 OpenCode

## 选择 MCP 的原因

### 1) 安全边界清晰、可最小权限

- 工具集合显式（只暴露 `rag/asset/ui` 等允许的能力）
- Gateway 在工具入口统一做：schema 校验、权限校验、tenant/project/tags 注入、审计关联

### 2) 可观测与可回归

- 工具调用天然是“结构化事件”，便于审计与指标埋点
- 更容易把“工具输入/输出样例”沉淀为回归用例（避免靠自然语言推断）

### 3) 解耦与可演进

- OpenCode 侧只需知道 MCP server 地址与 tool schema；工具实现可在 Gateway 内演进
- 后续如果要把某个能力下沉到独立服务（例如 Media/RAG），对 OpenCode 的影响更小

## 为什么不优先选 Gateway 代调用

Gateway 代调用在 PoC 阶段可行，但会带来：

- “模型意图 → Gateway 解析 → 工具调用 → 回灌” 的隐式协议，难以标准化与回归
- 审计/权限/输入校验的责任更容易分散（容易出现绕过）
- 对 OpenCode 的 event 格式/语义更敏感，升级时耦合更大

## 落点（实现）

- Gateway MCP Server：`services/gateway/src/mcp.ts`
- Open Assistant agent：`.opencode/agent/open-assistant.md`

## 后续演进

- 如果需要支持更多工具（例如工作流、审批、知识库管理），优先以 MCP tool 的方式扩展，并保持 schema 严格校验与审计贯穿。

